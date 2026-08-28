import fs from "node:fs";
import { projectionCsvPath } from "./solver";
import {
  listProjectionMetas,
  newId,
  saveProjectionMetas,
  type BlendComponentRef,
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

/** Consistent imported-dataset name: "Source YY-MM-DD (GWx-y)". */
export function importedProjectionFilename(
  source: string,
  date: Date | string,
  firstGameweek: number,
  lastGameweek: number,
): string {
  const iso = date instanceof Date ? date.toISOString() : date;
  const compactDate = iso.slice(0, 10).slice(2);
  return `${source} ${compactDate} (GW${firstGameweek}-${lastGameweek})`;
}

/** Normalize names from snapshots created before the compact convention. */
export function normalizeImportedProjectionFilename(filename: string): string {
  return filename
    .replace(
      /^(FFH|DraftHound|Pundit|FantaLens) predictions \d{2}(\d{2}-\d{2}-\d{2})(.*)$/,
      "$1 $2$3",
    )
    .replace(
      /^(DraftHound|Pundit|FantaLens) predictions (\d{4})-(\d{2})-(\d{2})(.*)$/,
      (_, source: string, year: string, month: string, day: string, rest: string) =>
        `${source} ${year.slice(2)}-${month}-${day}${rest}`,
    )
    .replace(
      /^Pundit×FFH hybrid (\d{4})-(\d{2})-(\d{2})(.*)$/,
      (_, year: string, month: string, day: string, rest: string) =>
        `Pundit×FFH ${year.slice(2)}-${month}-${day}${rest}`,
    );
}

/** Serialize canonical player rows to the solver's projection CSV format. */
export function buildCanonicalCsv(
  rows: CanonicalPlayerRow[],
  gameweeks: number[],
  options: { includeOwnership?: boolean } = {},
): string {
  const includeOwnership = options.includeOwnership ?? true;
  const header = [
    "ID",
    "Name",
    "Pos",
    "Team",
    "Value",
    ...(includeOwnership ? ["Ownership"] : []),
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
      ...(includeOwnership ? [String(r.ownership)] : []),
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
  components?: BlendComponentRef[] | null;
}): ProjectionMeta {
  const id = newId();
  fs.writeFileSync(projectionCsvPath(id), args.csv);
  // Absent optional fields are omitted (not stored as null): the API's
  // response schemas treat them as optional, and null would fail validation.
  const meta: ProjectionMeta = {
    id,
    filename: args.filename,
    uploadedAt: new Date().toISOString(),
    playerCount: args.playerCount,
    gameweeks: args.gameweeks,
    source: args.source,
    sourceLabel: args.sourceLabel,
    ...(args.sourceUpdatedAt != null
      ? { sourceUpdatedAt: args.sourceUpdatedAt }
      : {}),
    ...(args.season != null ? { season: args.season } : {}),
    ...(args.sourcePlayerCount != null
      ? { sourcePlayerCount: args.sourcePlayerCount }
      : {}),
    ...(args.components != null ? { components: args.components } : {}),
  };
  const metas = listProjectionMetas();
  metas.unshift(meta);
  saveProjectionMetas(metas);
  return meta;
}
