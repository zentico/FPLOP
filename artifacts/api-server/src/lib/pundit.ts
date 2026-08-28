import { parseCsv } from "./csv";
import { getBootstrap, getGameweekInfo, getSeasonName, type Bootstrap } from "./fpl";
import { fetchFfhRows } from "./ffh";
import {
  buildCanonicalCsv,
  enrichCanonicalRowsWithBootstrap,
  importedProjectionFilename,
  saveProjectionSnapshot,
  type CanonicalPlayerRow,
} from "./projections";
import type { ProjectionMeta } from "./store";

/**
 * Public CSV feed behind fantasyfootballpundit.com/fpl-points-predictor/
 * (the page's own table loads this published Google Sheet).
 */
const PUNDIT_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRaiTmUKjtQ7MxiGibN2GAZ8m9NHF3IA2U-yE0PhBpCOXHewhs57PrjZO7GQzZvrEGGBW7HFEE43yX0/pub?output=csv";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class PunditUpstreamError extends Error {}

const POS_MAP: Record<string, string> = {
  GK: "G",
  DEF: "D",
  MID: "M",
  FWD: "F",
};

const ELEMENT_TYPE_TO_POS: Record<number, string> = {
  1: "G",
  2: "D",
  3: "M",
  4: "F",
};

/**
 * One parsed feed row. `startPoints` holds the six assume-starting
 * per-gameweek values for the published horizon: index 0 is the current
 * gameweek ("StartingPredicted"), indexes 1-5 are the "GW2".."GW6" columns
 * (the 2nd..6th gameweek of the window — the labels are horizon-relative,
 * not absolute gameweek numbers).
 */
export interface PunditRow {
  name: string;
  team: string;
  /** One of G, D, M, F. */
  position: string;
  price: number;
  ownership: number;
  /** Start probability (0-1) for the current gameweek. */
  startPct: number;
  /** Assume-starting points for the 6-gameweek horizon (index 0 = current GW). */
  startPoints: number[];
  /** Cumulative assume-starting totals: Next2GWsStart..Next6GWsStart. */
  cumulativeStart: number[];
}

/**
 * Required feed columns. If the sheet's schema drifts, we refuse the import
 * with a clear error instead of misreading columns.
 */
const REQUIRED_COLUMNS = [
  "Name",
  "Team",
  "Position",
  "Ownership",
  "Start",
  "Price",
  "StartingPredicted",
  "Predicted",
  "GW2",
  "GW3",
  "GW4",
  "GW5",
  "GW6",
  "Next2GWsStart",
  "Next3GWsStart",
  "Next4GWsStart",
  "Next5GWsStart",
  "Next6GWsStart",
];

function num(raw: string, what: string, rowName: string): number {
  const cleaned = raw.replace(/[£%]/g, "").replace(/m$/i, "").trim();
  const n = Number(cleaned);
  if (cleaned === "" || !Number.isFinite(n)) {
    throw new PunditUpstreamError(
      `Fantasy Football Pundit row "${rowName}" has a non-numeric ${what} value ("${raw}"); the feed's format may have changed.`,
    );
  }
  return n;
}

/** Parse and strictly validate the published Pundit CSV. */
export function parsePunditCsv(content: string): PunditRow[] {
  const rows = parseCsv(content);
  if (rows.length === 0) {
    throw new PunditUpstreamError(
      "Fantasy Football Pundit returned an empty CSV.",
    );
  }
  const header = Object.keys(rows[0]!);
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new PunditUpstreamError(
      `Fantasy Football Pundit feed is missing expected columns (${missing.join(", ")}); its format may have changed.`,
    );
  }

  const out: PunditRow[] = [];
  for (const r of rows) {
    const name = (r["Name"] ?? "").trim();
    if (!name) continue;
    const rawPos = (r["Position"] ?? "").trim();
    const position = POS_MAP[rawPos];
    if (!position) {
      throw new PunditUpstreamError(
        `Fantasy Football Pundit reported unknown position "${rawPos}" for "${name}"; the feed's format may have changed.`,
      );
    }
    out.push({
      name,
      team: (r["Team"] ?? "").trim(),
      position,
      price: num(r["Price"] ?? "", "price", name),
      ownership: num(r["Ownership"] ?? "", "ownership", name),
      startPct: num(r["Start"] ?? "", "start probability", name) / 100,
      startPoints: [
        num(r["StartingPredicted"] ?? "", "StartingPredicted", name),
        num(r["GW2"] ?? "", "GW2", name),
        num(r["GW3"] ?? "", "GW3", name),
        num(r["GW4"] ?? "", "GW4", name),
        num(r["GW5"] ?? "", "GW5", name),
        num(r["GW6"] ?? "", "GW6", name),
      ],
      cumulativeStart: [
        num(r["Next2GWsStart"] ?? "", "Next2GWsStart", name),
        num(r["Next3GWsStart"] ?? "", "Next3GWsStart", name),
        num(r["Next4GWsStart"] ?? "", "Next4GWsStart", name),
        num(r["Next5GWsStart"] ?? "", "Next5GWsStart", name),
        num(r["Next6GWsStart"] ?? "", "Next6GWsStart", name),
      ],
    });
  }
  if (out.length < 100) {
    throw new PunditUpstreamError(
      `Fantasy Football Pundit returned only ${out.length} players; refusing a suspiciously small import.`,
    );
  }
  return out;
}

/**
 * Verify that our reading of the per-gameweek columns matches the feed's own
 * cumulative columns: NextKGWsStart must equal the sum of the first K
 * per-gameweek assume-starting values (within display rounding). If the
 * feed's column semantics ever change, this fails the import instead of
 * silently importing misaligned gameweeks.
 */
export function validatePunditCumulative(rows: PunditRow[]): void {
  let bad = 0;
  for (const r of rows) {
    let sum = r.startPoints[0]!;
    for (let k = 2; k <= 6; k++) {
      sum += r.startPoints[k - 1]!;
      // Each displayed value is rounded to 0.1, so allow rounding slack.
      if (Math.abs(sum - r.cumulativeStart[k - 2]!) > 0.05 * (k + 1) + 0.2) {
        bad++;
        break;
      }
    }
  }
  if (bad / rows.length > 0.02) {
    throw new PunditUpstreamError(
      `Fantasy Football Pundit per-gameweek columns no longer add up to its cumulative columns (${bad} of ${rows.length} rows inconsistent); the feed's gameweek layout may have changed. Import aborted.`,
    );
  }
}

/** The six gameweeks covered by the published horizon, capped at GW38. */
export function punditGameweekWindow(currentGw: number): number[] {
  const gws: number[] = [];
  for (let gw = currentGw; gw <= Math.min(currentGw + 5, 38); gw++) gws.push(gw);
  return gws;
}

const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Pundit team spellings that differ from FPL's after normalization. */
const TEAM_ALIASES: Record<string, string> = {
  "notts forest": "nott m forest",
  "nottingham forest": "nott m forest",
  "tottenham": "spurs",
  "tottenham hotspur": "spurs",
  "manchester city": "man city",
  "manchester united": "man utd",
  "man united": "man utd",
  "newcastle united": "newcastle",
  "leeds united": "leeds",
  "west ham united": "west ham",
  "wolverhampton wanderers": "wolves",
  "brighton and hove albion": "brighton",
  "afc bournemouth": "bournemouth",
};

export interface MatchablePlayer {
  id: number;
  webName: string;
  firstName: string;
  secondName: string;
  teamId: number;
  position: string;
}

export interface MatchableTeam {
  id: number;
  name: string;
  shortName: string;
}

export interface MatchOutcome {
  /** Official FPL id per input row; null when unmatched or ambiguous. */
  ids: (number | null)[];
  matched: number;
  /** Sample of names that could not be matched unambiguously. */
  unmatchedNames: string[];
}

/**
 * Resolve Pundit rows to official FPL ids using team + position + normalized
 * names. A row is only matched when exactly one official player fits;
 * ambiguous rows are left unmatched rather than guessed.
 */
export function matchPunditPlayers(
  rows: PunditRow[],
  players: MatchablePlayer[],
  teams: MatchableTeam[],
): MatchOutcome {
  const teamIdByName = new Map<string, number>();
  for (const t of teams) {
    teamIdByName.set(norm(t.name), t.id);
    teamIdByName.set(norm(t.shortName), t.id);
  }
  const unknownTeams = new Set<string>();
  const teamIdOf = (raw: string): number | null => {
    const n = norm(raw);
    const id = teamIdByName.get(n) ?? teamIdByName.get(TEAM_ALIASES[n] ?? "");
    if (id == null) unknownTeams.add(raw);
    return id ?? null;
  };

  // Resolve every team first: an unknown team name means the feed (or FPL)
  // changed and per-player matching would silently fail for a whole club.
  for (const r of rows) teamIdOf(r.team);
  if (unknownTeams.size > 0) {
    throw new PunditUpstreamError(
      `Fantasy Football Pundit uses team names that do not match official FPL teams: ${[...unknownTeams].join(", ")}. The feed or season data may have changed.`,
    );
  }

  interface Indexed extends MatchablePlayer {
    full: string;
    web: string;
    lastToken: string;
    firstToken: string;
  }
  const indexed: Indexed[] = players.map((p) => {
    const full = norm(`${p.firstName} ${p.secondName}`);
    const web = norm(p.webName);
    const secondTokens = norm(p.secondName).split(" ");
    return {
      ...p,
      full,
      web,
      lastToken: secondTokens[secondTokens.length - 1] ?? "",
      firstToken: norm(p.firstName).split(" ")[0] ?? "",
    };
  });
  const byTeamPos = new Map<string, Indexed[]>();
  for (const p of indexed) {
    const key = `${p.teamId}|${p.position}`;
    const list = byTeamPos.get(key);
    if (list) list.push(p);
    else byTeamPos.set(key, [p]);
  }
  const byPosFull = new Map<string, Indexed[]>();
  for (const p of indexed) {
    const key = `${p.position}|${p.full}`;
    const list = byPosFull.get(key);
    if (list) list.push(p);
    else byPosFull.set(key, [p]);
  }

  const usedIds = new Set<number>();
  const ids: (number | null)[] = [];
  const unmatchedNames: string[] = [];
  let matched = 0;

  for (const r of rows) {
    const teamId = teamIdOf(r.team)!;
    const candidates = byTeamPos.get(`${teamId}|${r.position}`) ?? [];
    const n = norm(r.name);
    const tokens = n.split(" ");
    const last = tokens[tokens.length - 1] ?? "";
    const first = tokens[0] ?? "";

    const uniq = (list: Indexed[]): Indexed | null =>
      list.length === 1 ? list[0]! : null;

    let hit =
      uniq(candidates.filter((c) => c.full === n)) ??
      uniq(candidates.filter((c) => c.web === n));
    if (!hit) {
      // Surname match within the club; disambiguate by first name if needed.
      const byLast = candidates.filter(
        (c) => c.lastToken === last || c.web === last,
      );
      hit = uniq(byLast) ?? uniq(byLast.filter((c) => c.firstToken === first));
    }
    if (!hit) {
      // The feed sometimes lags transfers: accept a league-wide match only
      // when exactly one official player has this exact full name + position.
      hit = uniq(byPosFull.get(`${r.position}|${n}`) ?? []);
    }

    if (!hit || usedIds.has(hit.id)) {
      ids.push(null);
      if (unmatchedNames.length < 15) unmatchedNames.push(r.name);
      continue;
    }
    usedIds.add(hit.id);
    ids.push(hit.id);
    matched++;
  }
  return { ids, matched, unmatchedNames };
}

/**
 * Canonical rows for a standalone Pundit snapshot: assume-starting points per
 * gameweek. Pundit publishes no expected minutes, so minutes are 90 wherever
 * it forecasts points (consistent with "assume starting") and 0 otherwise.
 */
export function buildPunditCanonicalRows(
  rows: PunditRow[],
  ids: (number | null)[],
  gameweeks: number[],
): CanonicalPlayerRow[] {
  const out: CanonicalPlayerRow[] = [];
  rows.forEach((r, i) => {
    const fplId = ids[i];
    if (fplId == null) return;
    const byGameweek = new Map<number, { points: number; minutes: number }>();
    gameweeks.forEach((gw, gi) => {
      const points = r.startPoints[gi] ?? 0;
      byGameweek.set(gw, { points, minutes: points > 0 ? 90 : 0 });
    });
    out.push({
      fplId,
      name: r.name,
      position: r.position,
      team: r.team,
      price: r.price,
      ownership: r.ownership,
      byGameweek,
    });
  });
  return out;
}

/**
 * Combine Pundit assume-starting points with FFH expected minutes:
 * points = punditStartPoints × clamp(ffhMinutes / 90, 0, 1).
 * Players absent from FFH entirely are excluded (there is no minutes basis);
 * gameweeks FFH does not cover for a player count as 0 expected minutes.
 */
export function buildHybridRows(
  punditRows: CanonicalPlayerRow[],
  ffhMinutes: Map<number, Map<number, number>>,
  gameweeks: number[],
): { rows: CanonicalPlayerRow[]; missingFromFfh: number } {
  const rows: CanonicalPlayerRow[] = [];
  let missingFromFfh = 0;
  for (const p of punditRows) {
    const mins = ffhMinutes.get(p.fplId);
    if (!mins) {
      missingFromFfh++;
      continue;
    }
    const byGameweek = new Map<number, { points: number; minutes: number }>();
    for (const gw of gameweeks) {
      const punditPts = p.byGameweek.get(gw)?.points ?? 0;
      const m = mins.get(gw) ?? 0;
      const factor = Math.min(Math.max(m / 90, 0), 1);
      byGameweek.set(gw, { points: punditPts * factor, minutes: m });
    }
    rows.push({ ...p, byGameweek });
  }
  return { rows, missingFromFfh };
}

async function fetchPunditRows(): Promise<PunditRow[]> {
  let res: Response;
  try {
    res = await fetch(PUNDIT_CSV_URL, { headers: { "User-Agent": UA } });
  } catch {
    throw new PunditUpstreamError(
      "Could not reach the Fantasy Football Pundit feed.",
    );
  }
  if (!res.ok) {
    throw new PunditUpstreamError(
      `Fantasy Football Pundit feed returned status ${res.status}.`,
    );
  }
  const rows = parsePunditCsv(await res.text());
  validatePunditCumulative(rows);
  return rows;
}

function toMatchable(bootstrap: Bootstrap): {
  players: MatchablePlayer[];
  teams: MatchableTeam[];
} {
  return {
    players: bootstrap.elements.map((e) => ({
      id: e.id,
      webName: e.web_name,
      firstName: e.first_name ?? "",
      secondName: e.second_name ?? "",
      teamId: e.team,
      position: ELEMENT_TYPE_TO_POS[e.element_type] ?? "?",
    })),
    teams: bootstrap.teams.map((t) => ({
      id: t.id,
      name: t.name,
      shortName: t.short_name,
    })),
  };
}

const MIN_MATCH_COVERAGE = 0.75;

async function preparePundit(): Promise<{
  canonical: CanonicalPlayerRow[];
  gameweeks: number[];
  sourcePlayerCount: number;
}> {
  const [rows, { nextGameweek }, bootstrap] = await Promise.all([
    fetchPunditRows(),
    getGameweekInfo(),
    getBootstrap(),
  ]);
  const { players, teams } = toMatchable(bootstrap);
  const outcome = matchPunditPlayers(rows, players, teams);
  const coverage = outcome.matched / rows.length;
  if (coverage < MIN_MATCH_COVERAGE) {
    throw new PunditUpstreamError(
      `Only ${outcome.matched} of ${rows.length} Fantasy Football Pundit players could be matched to official FPL players (${Math.round(coverage * 100)}%). Import aborted — the feed or FPL data may have changed. Unmatched examples: ${outcome.unmatchedNames.join(", ")}.`,
    );
  }
  const gameweeks = punditGameweekWindow(nextGameweek);
  return {
    canonical: enrichCanonicalRowsWithBootstrap(
      buildPunditCanonicalRows(rows, outcome.ids, gameweeks),
      bootstrap,
    ),
    gameweeks,
    sourcePlayerCount: rows.length,
  };
}

async function seasonBestEffort(): Promise<string | null> {
  try {
    return await getSeasonName();
  } catch {
    return null;
  }
}

/** Import the current public Pundit projections as a standalone snapshot. */
export async function importPunditProjection(): Promise<ProjectionMeta> {
  const { canonical, gameweeks, sourcePlayerCount } = await preparePundit();
  const season = await seasonBestEffort();
  const fetchedAt = new Date().toISOString();
  const first = gameweeks[0]!;
  const last = gameweeks[gameweeks.length - 1]!;
  return saveProjectionSnapshot({
    filename: importedProjectionFilename("Pundit", fetchedAt, first, last),
    csv: buildCanonicalCsv(canonical, gameweeks),
    playerCount: canonical.length,
    gameweeks,
    source: "pundit",
    sourceLabel: "Fantasy Football Pundit",
    sourceUpdatedAt: fetchedAt,
    sourcePlayerCount,
    season,
  });
}

/**
 * Import a Pundit + FFH hybrid snapshot: both feeds are fetched in one
 * operation and combined as assume-starting points × clamp(xMins/90, 0, 1).
 * Requires a configured FFH session.
 */
export async function importPunditFfhHybrid(): Promise<ProjectionMeta> {
  const [{ canonical, gameweeks, sourcePlayerCount }, seasonP] =
    await Promise.all([preparePundit(), seasonBestEffort()]);
  const first = gameweeks[0]!;
  const last = gameweeks[gameweeks.length - 1]!;
  const ffhRows = await fetchFfhRows(first, last);
  const ffhMinutes = new Map<number, Map<number, number>>();
  for (const r of ffhRows) {
    const m = new Map<number, number>();
    for (const [gw, f] of r.byGameweek) m.set(gw, f.minutes);
    ffhMinutes.set(r.fplId, m);
  }
  const { rows } = buildHybridRows(canonical, ffhMinutes, gameweeks);
  if (rows.length === 0) {
    throw new PunditUpstreamError(
      "No Fantasy Football Pundit players could be paired with Fantasy Football Hub minutes; the hybrid snapshot was not saved.",
    );
  }
  const fetchedAt = new Date().toISOString();
  return saveProjectionSnapshot({
    filename: importedProjectionFilename("Pundit×FFH", fetchedAt, first, last),
    csv: buildCanonicalCsv(rows, gameweeks),
    playerCount: rows.length,
    gameweeks,
    source: "pundit-ffh",
    sourceLabel: "Pundit + FFH hybrid",
    // Both feeds were fetched at this moment; neither reports its own
    // update timestamp, so the fetch time is the provenance for both.
    sourceUpdatedAt: fetchedAt,
    sourcePlayerCount,
    season: seasonP,
  });
}
