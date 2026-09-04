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

const PUNDIT_PAGE_URL =
  "https://www.fantasyfootballpundit.com/fpl-points-predictor/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class PunditUpstreamError extends Error {}

export interface PunditFrontendRecord {
  gameweek: number;
  playerCode: number;
  elementType: number;
  name: string;
  team: string;
  price: number;
  ownership: number;
  startPct: number;
  /** Points assuming the player starts. */
  startPoints: number;
}

/**
 * Parse the projection records embedded in the redesigned Next.js page.
 * The page serializes each record inside its React Server Component payload,
 * so JSON quotes appear escaped in the HTML source.
 */
export function parsePunditPage(content: string): PunditFrontendRecord[] {
  const serialized =
    content.match(/\{\\"gw\\":\d+,\\"player_code\\":\d+[^{}]*\}/g) ?? [];
  const records: PunditFrontendRecord[] = [];
  const seen = new Set<string>();

  for (const raw of serialized) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(raw.replaceAll('\\"', '"')) as Record<string, unknown>;
    } catch {
      throw new PunditUpstreamError(
        "Fantasy Football Pundit's embedded projection data could not be decoded; its page format may have changed.",
      );
    }
    const numberField = (key: string): number => {
      const parsed = Number(value[key]);
      if (!Number.isFinite(parsed)) {
        throw new PunditUpstreamError(
          `Fantasy Football Pundit's embedded projection data has an invalid ${key} value; its page format may have changed.`,
        );
      }
      return parsed;
    };
    const gameweek = numberField("gw");
    const playerCode = numberField("player_code");
    const key = `${playerCode}|${gameweek}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      gameweek,
      playerCode,
      elementType: numberField("element_type"),
      name: String(value["web_name"] ?? "").trim(),
      team: String(value["team_name"] ?? "").trim(),
      price: numberField("price"),
      ownership: numberField("selected_by_percent"),
      startPct: numberField("start_pct") / 100,
      // Despite the field names, the redesigned UI uses predicted_points for
      // its "assume starting" mode and predicted_points_start after applying
      // start probability.
      startPoints: numberField("predicted_points"),
    });
  }

  const players = new Set(records.map((record) => record.playerCode));
  if (players.size < 100) {
    throw new PunditUpstreamError(
      `Fantasy Football Pundit returned only ${players.size} players from its redesigned predictor; refusing a suspiciously small import.`,
    );
  }
  return records;
}

export function buildPunditFrontendRows(
  records: PunditFrontendRecord[],
  bootstrap: Bootstrap,
  gameweeks: number[],
): {
  canonical: CanonicalPlayerRow[];
  sourcePlayerCount: number;
} {
  const expectedGws = new Set(gameweeks);
  const actualGws = new Set(records.map((record) => record.gameweek));
  if (
    actualGws.size !== expectedGws.size ||
    [...actualGws].some((gameweek) => !expectedGws.has(gameweek))
  ) {
    throw new PunditUpstreamError(
      `Fantasy Football Pundit's predictor covers gameweeks ${[...actualGws].sort((a, b) => a - b).join(", ")} but FPL's expected window is ${gameweeks.join(", ")}. Import aborted.`,
    );
  }

  const elementByCode = new Map(
    bootstrap.elements.map((element) => [element.code, element]),
  );
  const byCode = new Map<number, Map<number, PunditFrontendRecord>>();
  for (const record of records) {
    const byGameweek =
      byCode.get(record.playerCode) ??
      new Map<number, PunditFrontendRecord>();
    byGameweek.set(record.gameweek, record);
    byCode.set(record.playerCode, byGameweek);
  }

  const canonical: CanonicalPlayerRow[] = [];
  const unknownCodes: number[] = [];
  for (const [code, sourceByGameweek] of byCode) {
    const element = elementByCode.get(code);
    if (!element) {
      if (unknownCodes.length < 15) unknownCodes.push(code);
      continue;
    }
    if (gameweeks.some((gameweek) => !sourceByGameweek.has(gameweek))) {
      throw new PunditUpstreamError(
        `Fantasy Football Pundit's predictor has an incomplete gameweek horizon for player code ${code}. Import aborted.`,
      );
    }
    const first = sourceByGameweek.get(gameweeks[0]!)!;
    const position = ELEMENT_TYPE_TO_POS[element.element_type];
    if (!position || first.elementType !== element.element_type) {
      throw new PunditUpstreamError(
        `Fantasy Football Pundit's position for player code ${code} does not match official FPL data. Import aborted.`,
      );
    }
    canonical.push({
      fplId: element.id,
      name: element.web_name,
      team: first.team,
      position,
      price: first.price,
      ownership: first.ownership,
      byGameweek: new Map(
        gameweeks.map((gameweek) => {
          const source = sourceByGameweek.get(gameweek)!;
          return [
            gameweek,
            {
              points: source.startPoints,
              minutes: source.startPoints !== 0 ? 90 : 0,
            },
          ];
        }),
      ),
    });
  }

  const coverage = canonical.length / byCode.size;
  if (coverage < 0.95) {
    throw new PunditUpstreamError(
      `Only ${canonical.length} of ${byCode.size} Fantasy Football Pundit player codes matched official FPL data (${Math.round(coverage * 100)}%). Import aborted. Unknown code examples: ${unknownCodes.join(", ")}.`,
    );
  }
  return { canonical, sourcePlayerCount: byCode.size };
}

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

async function fetchPunditRows(): Promise<PunditFrontendRecord[]> {
  let res: Response;
  try {
    res = await fetch(PUNDIT_PAGE_URL, { headers: { "User-Agent": UA } });
  } catch {
    throw new PunditUpstreamError(
      "Could not reach the Fantasy Football Pundit points predictor.",
    );
  }
  if (!res.ok) {
    throw new PunditUpstreamError(
      `Fantasy Football Pundit points predictor returned status ${res.status}.`,
    );
  }
  return parsePunditPage(await res.text());
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
  const gameweeks = punditGameweekWindow(nextGameweek);
  const built = buildPunditFrontendRows(rows, bootstrap, gameweeks);
  return {
    canonical: enrichCanonicalRowsWithBootstrap(
      built.canonical,
      bootstrap,
    ),
    gameweeks,
    sourcePlayerCount: built.sourcePlayerCount,
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
