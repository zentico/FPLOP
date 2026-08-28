import fs from "node:fs";
import path from "node:path";
import { RESULTS_DIR } from "./paths";
import { getEvents, getEventLive, getSeasonName } from "./fpl";

/** One archived gameweek of official player results. Immutable once written. */
export interface ResultArchive {
  season: string;
  gameweek: number;
  /** Gameweek deadline (ISO) — snapshots must predate this to count. */
  deadline: string;
  fetchedAt: string;
  players: { id: number; points: number; minutes: number }[];
}

export interface ResultArchiveInfo {
  season: string;
  gameweek: number;
  deadline: string;
  fetchedAt: string;
  playerCount: number;
}

function seasonDir(season: string): string {
  return path.join(RESULTS_DIR, season.replace("/", "-"));
}

function archivePath(season: string, gameweek: number): string {
  return path.join(seasonDir(season), `gw${gameweek}.json`);
}

export function listResultArchives(): ResultArchive[] {
  const out: ResultArchive[] = [];
  let seasons: string[] = [];
  try {
    seasons = fs.readdirSync(RESULTS_DIR);
  } catch {
    return out;
  }
  for (const s of seasons) {
    const dir = path.join(RESULTS_DIR, s);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^gw\d+\.json$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as ResultArchive);
      } catch {
        // Skip unreadable archives rather than failing the whole listing.
      }
    }
  }
  return out.sort(
    (a, b) => a.season.localeCompare(b.season) || a.gameweek - b.gameweek,
  );
}

/**
 * Archive official results for every finished gameweek that is not archived
 * yet. Existing archives are never overwritten. Returns the refreshed list.
 */
export async function refreshResults(): Promise<{
  archived: number[];
  results: ResultArchiveInfo[];
}> {
  const [season, events] = await Promise.all([getSeasonName(), getEvents()]);
  const finished = events.filter((e) => e.finished);
  const archived: number[] = [];
  fs.mkdirSync(seasonDir(season), { recursive: true });
  for (const ev of finished) {
    const file = archivePath(season, ev.id);
    if (fs.existsSync(file)) continue;
    const players = await getEventLive(ev.id);
    const archive: ResultArchive = {
      season,
      gameweek: ev.id,
      deadline: ev.deadline,
      fetchedAt: new Date().toISOString(),
      players,
    };
    // Unique temp + no-clobber link: a crash cannot leave a half-written
    // archive, and concurrent refreshes cannot overwrite an existing one.
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(archive));
    try {
      fs.linkSync(tmp, file); // fails with EEXIST if another request won
      archived.push(ev.id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      fs.unlinkSync(tmp);
    }
  }
  return {
    archived,
    results: listResultArchives().map((a) => ({
      season: a.season,
      gameweek: a.gameweek,
      deadline: a.deadline,
      fetchedAt: a.fetchedAt,
      playerCount: a.players.length,
    })),
  };
}
