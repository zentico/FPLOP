import fs from "node:fs";
import path from "node:path";
import { getSeasonName } from "./fpl";
import { STORE_DIR } from "./paths";
import {
  buildCanonicalCsv,
  saveProjectionSnapshot,
  type CanonicalPlayerRow,
} from "./projections";
import type { ProjectionMeta } from "./store";

const WWW_BASE = "https://www.fantasyfootballhub.co.uk";
const API_BASE = "https://public-api.fantasyfootballhub.co.uk";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class FfhSessionError extends Error {}
export class FfhUpstreamError extends Error {}

const POS_MAP: Record<string, string> = {
  GK: "G",
  DEF: "D",
  MID: "M",
  FWD: "F",
};

interface FfhFixture {
  gameweek: number;
  predictions: { points: number; minutes: number };
}

interface FfhPlayer {
  id: string;
  externalIds: { fplId?: number | null };
  displayName: string;
  price: number;
  position: string;
  ownership: number | null;
  team: { shortName: string };
  fixtures: FfhFixture[];
}

const COOKIE_FILE = path.join(STORE_DIR, "ffh_session.txt");

export function normalizeCookie(raw: string): string {
  // strip whitespace/newlines and any pasted "appSession...=" prefixes
  return raw
    .replace(/appSession(\.\d+)?=/g, "")
    .replace(/\s+/g, "");
}

export function getStoredCookie(): string | null {
  try {
    const fromFile = fs.readFileSync(COOKIE_FILE, "utf-8").trim();
    if (fromFile) return fromFile;
  } catch {
    // fall through to env
  }
  const fromEnv = process.env.FFH_SESSION_COOKIE?.trim();
  return fromEnv ? normalizeCookie(fromEnv) : null;
}

export function saveCookie(raw: string): void {
  fs.writeFileSync(COOKIE_FILE, normalizeCookie(raw), { mode: 0o600 });
}

export async function fetchAccessToken(cookie: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${WWW_BASE}/auth/access-token`, {
      headers: { Cookie: `appSession=${cookie}`, "User-Agent": UA },
    });
  } catch {
    throw new FfhUpstreamError("Could not reach Fantasy Football Hub.");
  }
  if (res.status === 401) {
    throw new FfhSessionError(
      "The Fantasy Football Hub session has expired. Log in at fantasyfootballhub.co.uk, copy the appSession cookie and paste it in the Import tab.",
    );
  }
  if (!res.ok) {
    throw new FfhUpstreamError(
      `Fantasy Football Hub auth returned status ${res.status}.`,
    );
  }
  const body = (await res.json()) as Record<string, unknown>;
  const token = body.token ?? body.accessToken ?? body.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new FfhUpstreamError(
      "Fantasy Football Hub auth response did not include a token.",
    );
  }
  return token;
}

async function fetchAllPlayers(
  token: string,
  minGameweek: number,
  maxGameweek: number,
): Promise<FfhPlayer[]> {
  const players: FfhPlayer[] = [];
  let after: string | undefined;
  let exhausted = false;
  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({
      limit: "100",
      minGameweek: String(minGameweek),
      maxGameweek: String(maxGameweek),
      minPrice: "3",
      maxPrice: "20",
      sortBy: "predictedPoints",
      sortDirection: "desc",
    });
    if (after) params.set("after", after);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/league/players?${params}`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
      });
    } catch {
      throw new FfhUpstreamError("Could not reach the Fantasy Football Hub API.");
    }
    if (res.status === 401 || res.status === 403) {
      throw new FfhSessionError(
        "The Fantasy Football Hub session was rejected. Log in again and paste a fresh appSession cookie in the Import tab.",
      );
    }
    if (!res.ok) {
      throw new FfhUpstreamError(
        `Fantasy Football Hub API returned status ${res.status}.`,
      );
    }
    const body = (await res.json()) as {
      data: FfhPlayer[];
      meta: { hasMore: boolean; nextCursor?: string | null };
    };
    players.push(...body.data);
    if (!body.meta.hasMore) {
      exhausted = true;
      break;
    }
    if (!body.meta.nextCursor || body.meta.nextCursor === after) {
      throw new FfhUpstreamError(
        "Fantasy Football Hub pagination broke mid-import; no data was saved.",
      );
    }
    after = body.meta.nextCursor;
  }
  if (!exhausted) {
    throw new FfhUpstreamError(
      "Fantasy Football Hub returned more pages than expected; no data was saved.",
    );
  }
  return players;
}

/**
 * Fetch FFH predictions for a gameweek window as canonical rows keyed by
 * official FPL id. Shared by the FFH import and the Pundit + FFH hybrid.
 */
export async function fetchFfhRows(
  minGameweek: number,
  maxGameweek: number,
): Promise<CanonicalPlayerRow[]> {
  const cookie = getStoredCookie();
  if (!cookie) {
    throw new FfhSessionError(
      "No Fantasy Football Hub session is configured. Paste your appSession cookie in the Import tab.",
    );
  }
  const token = await fetchAccessToken(cookie);
  const players = await fetchAllPlayers(token, minGameweek, maxGameweek);

  const rows: CanonicalPlayerRow[] = [];
  const seen = new Set<number>();
  for (const p of players) {
    const fplId = p.externalIds?.fplId;
    if (fplId == null || seen.has(fplId)) continue;
    seen.add(fplId);
    const pos = POS_MAP[p.position];
    if (!pos) continue;
    const byGw = new Map<number, { points: number; minutes: number }>();
    for (const f of p.fixtures ?? []) {
      const prev = byGw.get(f.gameweek);
      // double gameweeks: sum points and minutes across fixtures
      byGw.set(f.gameweek, {
        points: (prev?.points ?? 0) + (f.predictions?.points ?? 0),
        minutes: (prev?.minutes ?? 0) + (f.predictions?.minutes ?? 0),
      });
    }
    rows.push({
      fplId,
      name: p.displayName,
      position: pos,
      team: p.team?.shortName ?? "",
      price: p.price ?? 0,
      ownership: p.ownership ?? 0,
      byGameweek: byGw,
    });
  }

  if (rows.length === 0) {
    throw new FfhUpstreamError(
      "Fantasy Football Hub returned no players with FPL ids.",
    );
  }
  return rows;
}

export async function importFfhProjection(
  minGameweek: number,
  maxGameweek: number,
): Promise<ProjectionMeta> {
  const rows = await fetchFfhRows(minGameweek, maxGameweek);
  const gameweeks: number[] = [];
  for (let gw = minGameweek; gw <= maxGameweek; gw++) gameweeks.push(gw);

  let season: string | null = null;
  try {
    season = await getSeasonName();
  } catch {
    // Season labelling is best-effort.
  }

  const date = new Date().toISOString().slice(2, 10);
  return saveProjectionSnapshot({
    filename: `FFH ${date} (GW${minGameweek}-${maxGameweek})`,
    csv: buildCanonicalCsv(rows, gameweeks),
    playerCount: rows.length,
    gameweeks,
    source: "ffh",
    sourceLabel: "Fantasy Football Hub",
    season,
  });
}
