import fs from "node:fs";
import { projectionCsvPath } from "./solver";
import {
  listProjectionMetas,
  newId,
  saveProjectionMetas,
  type ProjectionMeta,
} from "./store";

export function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One player row in the canonical projection format. */
export interface CanonicalPlayerRow {
  /** Official FPL player id. */
  fplId: number;
  name: string;
  /** One of G, D, M, F. */
  position: string;
  team: string;
  price: number;
  ownership: number;
  /** Per-gameweek predictions; missing gameweeks are written as 0. */
  byGameweek: Map<number, { points: number; minutes: number }>;
}

/** Serialize canonical player rows to the solver's projection CSV format. */
export function buildCanonicalCsv(
  rows: CanonicalPlayerRow[],
  gameweeks: number[],
): string {
  const header = [
    "ID",
    "Name",
    "Pos",
    "Team",
    "Value",
    "Ownership",
    ...gameweeks.flatMap((gw) => [`${gw}_Pts`, `${gw}_xMins`]),
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    const cells = [
      String(r.fplId),
      csvEscape(r.name),
      r.position,
      csvEscape(r.team),
      String(r.price),
      String(r.ownership),
      ...gameweeks.flatMap((gw) => {
        const f = r.byGameweek.get(gw);
        return [
          (f?.points ?? 0).toFixed(2),
          String(Math.round(f?.minutes ?? 0)),
        ];
      }),
    ];
    lines.push(cells.join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * Persist a projection CSV as an immutable snapshot and register its
 * metadata. All import paths (uploads and provider adapters) go through
 * here so every snapshot carries the same source metadata.
 */
export function saveProjectionSnapshot(args: {
  filename: string;
  csv: string;
  playerCount: number;
  gameweeks: number[];
  source: string;
  sourceLabel: string;
  sourceUpdatedAt?: string | null;
  season?: string | null;
  sourcePlayerCount?: number | null;
}): ProjectionMeta {
  const id = newId();
  fs.writeFileSync(projectionCsvPath(id), args.csv);
  const meta: ProjectionMeta = {
    id,
    filename: args.filename,
    uploadedAt: new Date().toISOString(),
    playerCount: args.playerCount,
    gameweeks: args.gameweeks,
    source: args.source,
    sourceLabel: args.sourceLabel,
    sourceUpdatedAt: args.sourceUpdatedAt ?? null,
    season: args.season ?? null,
    sourcePlayerCount: args.sourcePlayerCount ?? null,
  };
  const metas = listProjectionMetas();
  metas.unshift(meta);
  saveProjectionMetas(metas);
  return meta;
}
