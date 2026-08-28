import fs from "node:fs";
import { projectionCsvPath } from "./solver";
import { getBootstrap, type Bootstrap } from "./fpl";
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

const OFFICIAL_POSITIONS: Record<number, string> = {
  1: "G",
  2: "D",
  3: "M",
  4: "F",
};

/**
 * Replace provider metadata with the official FPL values captured at import
 * time. Prediction sources remain authoritative only for points and minutes.
 */
export function enrichCanonicalRowsWithBootstrap(
  rows: CanonicalPlayerRow[],
  bootstrap: Bootstrap,
): CanonicalPlayerRow[] {
  const teams = new Map(bootstrap.teams.map((team) => [team.id, team.short_name]));
  const players = new Map(bootstrap.elements.map((player) => [player.id, player]));
  const missingIds: number[] = [];
  const enriched = rows.map((row) => {
    const player = players.get(row.fplId);
    if (!player) {
      missingIds.push(row.fplId);
      return row;
    }
    const ownership = Number(player.selected_by_percent);
    return {
      ...row,
      name: player.web_name,
      position: OFFICIAL_POSITIONS[player.element_type] ?? row.position,
      team: teams.get(player.team) ?? row.team,
      price: player.now_cost / 10,
      ownership:
        Number.isFinite(ownership) && ownership >= 0 && ownership <= 100
          ? ownership
          : 0,
    };
  });
  if (missingIds.length > 0) {
    throw new Error(
      `Official FPL data has no player record for ID(s): ${missingIds.slice(0, 10).join(", ")}${missingIds.length > 10 ? "…" : ""}.`,
    );
  }
  return enriched;
}

export async function enrichCanonicalRowsWithOfficialFpl(
  rows: CanonicalPlayerRow[],
): Promise<CanonicalPlayerRow[]> {
  return enrichCanonicalRowsWithBootstrap(rows, await getBootstrap());
}

/** Convert an uploaded projection CSV into canonical prediction rows. */
export function canonicalRowsFromCsv(
  csvRows: Record<string, string>[],
  gameweeks: number[],
): CanonicalPlayerRow[] {
  const first = csvRows[0] ?? {};
  const find = (names: string[]) => names.find((name) => name in first);
  const idCol = find(["ID", "Id", "id"]);
  if (!idCol) throw new Error('The CSV needs an "ID" column.');
  const nameCol = find(["Name", "name", "Player"]);
  const posCol = find(["Pos", "Position", "pos"]);
  const teamCol = find(["Team", "team", "Club"]);
  const priceCol = find(["Value", "Price", "BV", "SV", "Cost"]);

  return csvRows.map((row) => {
    const fplId = Number(row[idCol]);
    if (!Number.isInteger(fplId) || fplId <= 0) {
      throw new Error(`Invalid official FPL player ID "${row[idCol]}".`);
    }
    return {
      fplId,
      name: nameCol ? row[nameCol] ?? "" : "",
      position: posCol ? row[posCol] ?? "" : "",
      team: teamCol ? row[teamCol] ?? "" : "",
      price: priceCol ? Number(row[priceCol]) || 0 : 0,
      ownership: 0,
      byGameweek: new Map(
        gameweeks.map((gw) => [
          gw,
          {
            points: Number(row[`${gw}_Pts`]) || 0,
            minutes: Number(row[`${gw}_xMins`]) || 0,
          },
        ]),
      ),
    };
  });
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
