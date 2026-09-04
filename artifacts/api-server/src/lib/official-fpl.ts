import { getBootstrap, getGameweekInfo, getSeasonName } from "./fpl";
import {
  buildCanonicalCsv,
  enrichCanonicalRowsWithBootstrap,
  importedProjectionFilename,
  saveProjectionSnapshot,
  type CanonicalPlayerRow,
} from "./projections";
import type { ProjectionMeta } from "./store";

const ELEMENT_TYPE_TO_POS: Record<number, string> = {
  1: "G",
  2: "D",
  3: "M",
  4: "F",
};

export class OfficialFplProjectionError extends Error {}

export function buildOfficialFplRows(
  bootstrap: Awaited<ReturnType<typeof getBootstrap>>,
  gameweek: number,
): CanonicalPlayerRow[] {
  const rows: CanonicalPlayerRow[] = [];
  for (const element of bootstrap.elements) {
    const points = Number(element.ep_next);
    const position = ELEMENT_TYPE_TO_POS[element.element_type];
    if (!Number.isFinite(points) || !position) continue;
    rows.push({
      fplId: element.id,
      name: element.web_name,
      position,
      team: "",
      price: element.now_cost / 10,
      ownership: Number(element.selected_by_percent) || 0,
      // FPL publishes next-GW expected points but no expected-minutes forecast.
      byGameweek: new Map([[gameweek, { points, minutes: 0 }]]),
    });
  }
  if (rows.length < 100) {
    throw new OfficialFplProjectionError(
      `Official FPL returned expected points for only ${rows.length} players; refusing a suspiciously small import.`,
    );
  }
  return enrichCanonicalRowsWithBootstrap(rows, bootstrap);
}

export async function importOfficialFplProjection(): Promise<ProjectionMeta> {
  const [bootstrap, { nextGameweek }, season] = await Promise.all([
    getBootstrap(),
    getGameweekInfo(),
    getSeasonName(),
  ]);
  const rows = buildOfficialFplRows(bootstrap, nextGameweek);
  const fetchedAt = new Date().toISOString();
  return saveProjectionSnapshot({
    filename: importedProjectionFilename(
      "Official FPL",
      fetchedAt,
      nextGameweek,
      nextGameweek,
    ),
    csv: buildCanonicalCsv(rows, [nextGameweek]),
    playerCount: rows.length,
    gameweeks: [nextGameweek],
    source: "official-fpl",
    sourceLabel: "Official FPL — next GW only",
    sourceUpdatedAt: fetchedAt,
    sourcePlayerCount: rows.length,
    season,
  });
}