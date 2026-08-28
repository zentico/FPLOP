import { getSeasonName } from "./fpl";
import {
  buildCanonicalCsv,
  enrichCanonicalRowsWithOfficialFpl,
  importedProjectionFilename,
  saveProjectionSnapshot,
  type CanonicalPlayerRow,
} from "./projections";
import type { ProjectionMeta } from "./store";

/**
 * FantaLens (fantalens.com) is an Inertia.js app: every page embeds (and can
 * serve, via X-Inertia headers) a structured JSON payload with official FPL
 * player ids, per-gameweek expected points, and per-fixture expected minutes.
 * The squad-planner page exposes the full projection horizon per player, so
 * we consume that structured payload rather than scraping rendered tables.
 */
const FL_BASE = "https://fantalens.com";
const FL_PATH = "/squad-planner";
const PER_PAGE = 100;
const MAX_PAGES = 30;
const MIN_PLAYERS = 300;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class FantaLensUpstreamError extends Error {}

const VALID_POS = new Set(["G", "D", "M", "F"]);

interface FlFixture {
  xPoints: number;
  xMinutes: number;
}

export interface FlPlayer {
  /** Official FPL element id (FantaLens `external_id`). */
  fplId: number;
  name: string;
  position: string;
  teamCode: string;
  price: number;
  ownership: number;
  /** Per-gameweek fixtures (2+ entries in a double gameweek). */
  fixturesByGw: Map<number, FlFixture[]>;
}

export interface FlPage {
  players: FlPlayer[];
  /** Gameweeks the payload actually covers (its selected gameweeks). */
  selectedGameweeks: number[];
  /** The full published horizon advertised by the page. */
  horizonGameweeks: number[];
  pagination: { page: number; lastPage: number; total: number };
  season: string;
  competition: string;
  version: string;
}

function fail(msg: string): never {
  throw new FantaLensUpstreamError(
    `FantaLens ${msg}; the site's data format may have changed.`,
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate and extract one Inertia page payload (the object with
 * `component`, `props`, `version`). Strict: any schema drift aborts the
 * import with a clear message instead of importing garbage.
 */
export function parseFantaLensPage(body: unknown): FlPage {
  if (!isRecord(body) || !isRecord(body.props)) {
    fail("returned an unexpected payload (no Inertia props object)");
  }
  const props = body.props;
  const version = typeof body.version === "string" ? body.version : "";

  const competition = isRecord(props.competitions)
    ? String(props.competitions.active ?? "")
    : "";
  if (competition !== "premier-league") {
    throw new FantaLensUpstreamError(
      `FantaLens served data for competition "${competition || "unknown"}" instead of the Premier League; import aborted.`,
    );
  }
  const season =
    isRecord(props.season) && typeof props.season.name === "string"
      ? props.season.name
      : "";
  if (!/^\d{4}\/\d{2}$/.test(season)) {
    fail(`reported an unrecognized season "${season}"`);
  }

  if (!Array.isArray(props.gameweeks)) fail("payload has no gameweeks list");
  const horizonGameweeks = props.gameweeks.map((g) => {
    if (!isRecord(g) || typeof g.number !== "number" || !Number.isInteger(g.number)) {
      fail("gameweek horizon entries are malformed");
    }
    return g.number;
  });

  if (!Array.isArray(props.selectedGameweeks)) {
    fail("payload has no selected gameweeks");
  }
  const selectedGameweeks = props.selectedGameweeks.map((n) => {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 38) {
      fail("selected gameweeks are malformed");
    }
    return n;
  });

  const pag = props.pagination;
  if (
    !isRecord(pag) ||
    typeof pag.page !== "number" ||
    typeof pag.last_page !== "number" ||
    typeof pag.total !== "number" ||
    pag.page < 1 ||
    pag.last_page < 1 ||
    pag.total < 0
  ) {
    fail("pagination info is missing or malformed");
  }

  if (!Array.isArray(props.players)) fail("payload has no players array");
  const players: FlPlayer[] = [];
  for (const item of props.players) {
    if (!isRecord(item)) fail("player entries are malformed");
    const fplId = item.external_id;
    const name = item.name;
    const position = item.position;
    const team = item.team;
    if (
      typeof fplId !== "number" ||
      !Number.isInteger(fplId) ||
      fplId <= 0 ||
      typeof name !== "string" ||
      name.length === 0 ||
      typeof position !== "string" ||
      typeof item.price !== "number" ||
      !Number.isFinite(item.price) ||
      !isRecord(team) ||
      typeof team.code !== "string"
    ) {
      fail(
        "player data is missing expected fields (external_id/name/position/price/team.code)",
      );
    }
    if (!VALID_POS.has(position)) {
      fail(`reported unknown position "${position}" for "${name}"`);
    }
    const ownership =
      typeof item.selected_by_percent === "number" &&
      Number.isFinite(item.selected_by_percent)
        ? item.selected_by_percent
        : 0;

    const fixturesByGw = new Map<number, FlFixture[]>();
    const xpts = item.xpts;
    if (xpts != null) {
      if (!isRecord(xpts)) fail(`per-gameweek projections for "${name}" are malformed`);
      for (const [gwKey, entry] of Object.entries(xpts)) {
        const gw = Number(gwKey);
        if (!Number.isInteger(gw) || gw < 1 || gw > 38 || !isRecord(entry)) {
          fail(`per-gameweek projections for "${name}" are malformed`);
        }
        const fixtures = entry.fixtures;
        if (!Array.isArray(fixtures)) {
          fail(`gameweek ${gw} projections for "${name}" have no fixtures list`);
        }
        const list: FlFixture[] = [];
        for (const f of fixtures) {
          // FantaLens uses null for zero-projection fixtures (e.g. players
          // not expected to feature); treat null as 0 but reject anything else.
          const numOrNull = (v: unknown): number | null =>
            v == null ? 0 : typeof v === "number" && Number.isFinite(v) ? v : null;
          const xPoints = isRecord(f) ? numOrNull(f.xpts) : null;
          const xMinutes = isRecord(f) ? numOrNull(f.expected_minutes) : null;
          if (xPoints == null || xMinutes == null) {
            fail(
              `fixture projections for "${name}" are missing xpts/expected_minutes`,
            );
          }
          list.push({ xPoints, xMinutes });
        }
        fixturesByGw.set(gw, list);
      }
    }
    players.push({
      fplId,
      name,
      position,
      teamCode: team.code,
      price: item.price,
      ownership,
      fixturesByGw,
    });
  }

  return {
    players,
    selectedGameweeks,
    horizonGameweeks,
    pagination: { page: pag.page, lastPage: pag.last_page, total: pag.total },
    season,
    competition,
    version,
  };
}

/**
 * Convert validated FantaLens players to canonical rows. Fixture-level
 * expected points and minutes are summed per gameweek, so double gameweeks
 * aggregate correctly. Duplicate official ids abort the import.
 */
export function mapFantaLensPlayers(
  players: FlPlayer[],
  gameweeks: number[],
): CanonicalPlayerRow[] {
  if (gameweeks.length === 0) {
    throw new FantaLensUpstreamError(
      "FantaLens published an empty projection horizon; there is nothing to import.",
    );
  }
  const gwSet = new Set(gameweeks);
  const seen = new Set<number>();
  const rows: CanonicalPlayerRow[] = [];
  for (const p of players) {
    if (seen.has(p.fplId)) {
      throw new FantaLensUpstreamError(
        `FantaLens returned duplicate player id ${p.fplId} ("${p.name}"); the pages shifted mid-import. Try again.`,
      );
    }
    seen.add(p.fplId);
    const byGameweek = new Map<number, { points: number; minutes: number }>();
    for (const [gw, fixtures] of p.fixturesByGw) {
      if (!gwSet.has(gw)) {
        throw new FantaLensUpstreamError(
          `FantaLens returned projections for gameweek ${gw}, outside the requested horizon (GW${gameweeks[0]}-${gameweeks[gameweeks.length - 1]}).`,
        );
      }
      let points = 0;
      let minutes = 0;
      for (const f of fixtures) {
        points += f.xPoints;
        minutes += f.xMinutes;
      }
      byGameweek.set(gw, { points, minutes });
    }
    rows.push({
      fplId: p.fplId,
      name: p.name,
      position: p.position,
      team: p.teamCode,
      price: p.price,
      ownership: p.ownership,
      byGameweek,
    });
  }
  return rows;
}

async function flFetch(
  url: string,
  inertiaVersion?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": UA };
  if (inertiaVersion != null) {
    headers["X-Inertia"] = "true";
    headers["X-Inertia-Version"] = inertiaVersion;
    headers["Accept"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(url, { headers, redirect: "follow" });
  } catch {
    throw new FantaLensUpstreamError("Could not reach FantaLens.");
  }
  if (!res.ok) {
    throw new FantaLensUpstreamError(
      `FantaLens returned status ${res.status}.`,
    );
  }
  return res;
}

/** Extract the embedded Inertia page JSON from a rendered FantaLens page. */
export function extractEmbeddedPage(html: string): unknown {
  const m = /<script data-page="app" type="application\/json">(.*?)<\/script>/s.exec(
    html,
  );
  if (!m) {
    fail("did not embed its structured page data where expected");
  }
  try {
    return JSON.parse(m[1]!);
  } catch {
    fail("embedded structured page data that is not valid JSON");
  }
}

/**
 * Fetch every page of the squad-planner payload across the full published
 * horizon. The first request loads the rendered page to learn the horizon
 * and the current Inertia asset version; subsequent requests use the
 * lightweight JSON protocol.
 */
async function fetchAllPages(): Promise<{
  players: FlPlayer[];
  gameweeks: number[];
  season: string;
}> {
  const firstRes = await flFetch(`${FL_BASE}${FL_PATH}`);
  const first = parseFantaLensPage(extractEmbeddedPage(await firstRes.text()));

  const horizon = first.horizonGameweeks;
  if (horizon.length === 0) {
    throw new FantaLensUpstreamError(
      "FantaLens published an empty projection horizon; there is nothing to import.",
    );
  }
  const gwParam = horizon.join("-");

  const players: FlPlayer[] = [];
  let expectedTotal: number | null = null;
  let page = 1;
  for (;;) {
    if (page > MAX_PAGES) {
      throw new FantaLensUpstreamError(
        `FantaLens pagination did not terminate after ${MAX_PAGES} pages; import aborted.`,
      );
    }
    const url = `${FL_BASE}${FL_PATH}?gw=${gwParam}&per_page=${PER_PAGE}&page=${page}`;
    const res = await flFetch(url, first.version);
    let parsed: FlPage;
    try {
      parsed = parseFantaLensPage(await res.json());
    } catch (err) {
      if (err instanceof FantaLensUpstreamError) throw err;
      throw new FantaLensUpstreamError(
        "FantaLens returned invalid JSON while paginating.",
      );
    }
    if (
      parsed.selectedGameweeks.length !== horizon.length ||
      parsed.selectedGameweeks.some((gw, i) => gw !== horizon[i])
    ) {
      throw new FantaLensUpstreamError(
        `FantaLens ignored the requested gameweek horizon (asked GW${horizon[0]}-${horizon[horizon.length - 1]}, got ${parsed.selectedGameweeks.join(",") || "none"}); import aborted.`,
      );
    }
    if (parsed.pagination.page !== page) {
      throw new FantaLensUpstreamError(
        `FantaLens pagination is inconsistent (requested page ${page}, got ${parsed.pagination.page}); import aborted.`,
      );
    }
    if (parsed.players.length === 0) {
      throw new FantaLensUpstreamError(
        `FantaLens returned an empty page ${page} while paginating; import aborted.`,
      );
    }
    expectedTotal = parsed.pagination.total;
    players.push(...parsed.players);
    if (page >= parsed.pagination.lastPage) break;
    page++;
  }
  if (expectedTotal != null && players.length !== expectedTotal) {
    throw new FantaLensUpstreamError(
      `FantaLens reported ${expectedTotal} players but returned ${players.length} across its pages; the data shifted mid-import. Try again.`,
    );
  }
  return { players, gameweeks: horizon, season: first.season };
}

/** Import the current public FantaLens projections as a standalone snapshot. */
export async function importFantaLensProjection(): Promise<ProjectionMeta> {
  const { players, gameweeks, season } = await fetchAllPages();
  if (players.length < MIN_PLAYERS) {
    throw new FantaLensUpstreamError(
      `FantaLens returned only ${players.length} players; refusing a suspiciously small import.`,
    );
  }
  const rows = await enrichCanonicalRowsWithOfficialFpl(
    mapFantaLensPlayers(players, gameweeks),
  );

  // Cross-check the season against the official FPL API when reachable:
  // importing last season's data silently would poison accuracy tracking.
  try {
    const fplSeason = await getSeasonName();
    if (fplSeason !== season) {
      throw new FantaLensUpstreamError(
        `FantaLens is publishing data for season ${season}, but the official FPL season is ${fplSeason}; import aborted.`,
      );
    }
  } catch (err) {
    if (err instanceof FantaLensUpstreamError) throw err;
    // Season cross-check is best-effort when the FPL API is unreachable.
  }

  const fetchedAt = new Date().toISOString();
  const first = gameweeks[0]!;
  const last = gameweeks[gameweeks.length - 1]!;
  return saveProjectionSnapshot({
    filename: importedProjectionFilename("FantaLens", fetchedAt, first, last),
    csv: buildCanonicalCsv(rows, gameweeks),
    playerCount: rows.length,
    gameweeks,
    source: "fantalens",
    sourceLabel: "FantaLens",
    // FantaLens does not report a data timestamp; the fetch time is the provenance.
    sourceUpdatedAt: fetchedAt,
    season,
  });
}
