import { getSeasonName } from "./fpl";
import {
  buildCanonicalCsv,
  importedProjectionFilename,
  saveProjectionSnapshot,
  type CanonicalPlayerRow,
} from "./projections";
import type { ProjectionMeta } from "./store";

const DH_URL = "https://www.drafthound.com/api/fpl/players";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class DraftHoundUpstreamError extends Error {}

const POS_MAP: Record<string, string> = {
  GKP: "G",
  GK: "G",
  DEF: "D",
  MID: "M",
  FWD: "F",
};

interface DhGameweek {
  id: number;
  xPoints: number;
  xMinutes: number;
}

interface DhPlayer {
  id: number;
  name: string;
  teamAbbr: string;
  positionAbbr: string;
  price: number;
  selectedBy: number;
  gameweeks: DhGameweek[];
}

/**
 * Validate DraftHound's undocumented payload strictly: if the schema drifts,
 * fail with a clear message instead of importing garbage.
 */
export function parseDraftHoundPayload(body: unknown): {
  players: DhPlayer[];
  updatedAt: string | null;
} {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) {
    throw new DraftHoundUpstreamError(
      "DraftHound returned an unexpected payload (no data array); the site's API may have changed.",
    );
  }
  const raw = (body as { data: unknown[]; updatedAt?: unknown }).data;
  const updatedAtRaw = (body as { updatedAt?: unknown }).updatedAt;
  const updatedAt =
    typeof updatedAtRaw === "string" && !Number.isNaN(Date.parse(updatedAtRaw))
      ? updatedAtRaw
      : null;

  const players: DhPlayer[] = [];
  for (const item of raw) {
    const p = item as Record<string, unknown>;
    if (
      typeof p.id !== "number" ||
      !Number.isInteger(p.id) ||
      p.id <= 0 ||
      typeof p.name !== "string" ||
      p.name.length === 0 ||
      typeof p.positionAbbr !== "string" ||
      typeof p.teamAbbr !== "string" ||
      typeof p.price !== "number" ||
      !Array.isArray(p.gameweeks)
    ) {
      throw new DraftHoundUpstreamError(
        "DraftHound player data is missing expected fields (id/name/positionAbbr/teamAbbr/price/gameweeks); the site's API may have changed.",
      );
    }
    const gameweeks: DhGameweek[] = [];
    for (const g of p.gameweeks as unknown[]) {
      const gw = g as Record<string, unknown>;
      if (
        typeof gw.id !== "number" ||
        !Number.isInteger(gw.id) ||
        gw.id < 1 ||
        gw.id > 38 ||
        typeof gw.xPoints !== "number" ||
        !Number.isFinite(gw.xPoints) ||
        typeof gw.xMinutes !== "number" ||
        !Number.isFinite(gw.xMinutes)
      ) {
        throw new DraftHoundUpstreamError(
          "DraftHound per-gameweek predictions are missing id/xPoints/xMinutes; the site's API may have changed.",
        );
      }
      gameweeks.push({ id: gw.id, xPoints: gw.xPoints, xMinutes: gw.xMinutes });
    }
    players.push({
      id: p.id,
      name: p.name,
      teamAbbr: p.teamAbbr,
      positionAbbr: p.positionAbbr,
      price: p.price,
      selectedBy: typeof p.selectedBy === "number" ? p.selectedBy : 0,
      gameweeks,
    });
  }
  if (players.length < 100) {
    throw new DraftHoundUpstreamError(
      `DraftHound returned only ${players.length} players; refusing a suspiciously small import.`,
    );
  }
  return { players, updatedAt };
}

/** Convert validated DraftHound players to canonical rows plus covered gameweeks. */
export function mapDraftHoundPlayers(players: DhPlayer[]): {
  rows: CanonicalPlayerRow[];
  gameweeks: number[];
} {
  const gwSet = new Set<number>();
  const rows: CanonicalPlayerRow[] = [];
  const seen = new Set<number>();
  for (const p of players) {
    if (seen.has(p.id)) continue;
    const pos = POS_MAP[p.positionAbbr];
    if (!pos) {
      throw new DraftHoundUpstreamError(
        `DraftHound reported unknown position "${p.positionAbbr}"; the site's API may have changed.`,
      );
    }
    seen.add(p.id);
    const byGameweek = new Map<number, { points: number; minutes: number }>();
    for (const g of p.gameweeks) {
      gwSet.add(g.id);
      // A gameweek appears once per player; fixtures are already aggregated.
      byGameweek.set(g.id, { points: g.xPoints, minutes: g.xMinutes });
    }
    rows.push({
      fplId: p.id,
      name: p.name,
      position: pos,
      team: p.teamAbbr,
      price: p.price,
      ownership: p.selectedBy,
      byGameweek,
    });
  }
  const gameweeks = [...gwSet].sort((a, b) => a - b);
  if (gameweeks.length === 0) {
    throw new DraftHoundUpstreamError(
      "DraftHound returned no per-gameweek predictions.",
    );
  }
  return { rows, gameweeks };
}

export async function importDraftHoundProjection(): Promise<ProjectionMeta> {
  let res: Response;
  try {
    res = await fetch(DH_URL, { headers: { "User-Agent": UA } });
  } catch {
    throw new DraftHoundUpstreamError("Could not reach DraftHound.");
  }
  if (!res.ok) {
    throw new DraftHoundUpstreamError(
      `DraftHound returned status ${res.status}.`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new DraftHoundUpstreamError("DraftHound returned invalid JSON.");
  }
  const { players, updatedAt } = parseDraftHoundPayload(body);
  const { rows, gameweeks } = mapDraftHoundPlayers(players);

  let season: string | null = null;
  try {
    season = await getSeasonName();
  } catch {
    // Season labelling is best-effort; the snapshot is still valid without it.
  }

  const first = gameweeks[0]!;
  const last = gameweeks[gameweeks.length - 1]!;
  return saveProjectionSnapshot({
    filename: importedProjectionFilename("DraftHound", new Date(), first, last),
    csv: buildCanonicalCsv(rows, gameweeks),
    playerCount: rows.length,
    gameweeks,
    source: "drafthound",
    sourceLabel: "DraftHound",
    sourceUpdatedAt: updatedAt,
    season,
  });
}
