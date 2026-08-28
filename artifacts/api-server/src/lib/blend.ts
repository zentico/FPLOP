import fs from "node:fs";
import { parseCsv } from "./csv";
import {
  buildCanonicalCsv,
  normalizeImportedProjectionFilename,
  saveProjectionSnapshot,
  type CanonicalPlayerRow,
} from "./projections";
import { projectionCsvPath } from "./solver";
import { listProjectionMetas, type ProjectionMeta } from "./store";

/**
 * Weighted projection blends: combine two or more saved prediction snapshots
 * into one canonical projection using globally normalized non-negative
 * weights. A player missing from a source contributes zero points and zero
 * minutes for that source — weights are never redistributed per player.
 */

/** Validation/lookup failure while building a blend. `status` maps to HTTP. */
export class BlendError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "BlendError";
  }
}

export interface BlendSourceInput {
  projectionId: string;
  weight: number;
}

/**
 * Validate raw source weights and normalize them to sum to 1.
 * Order is preserved (it is the tie-break for metadata precedence).
 */
export function normalizeBlendWeights(
  sources: BlendSourceInput[],
): { projectionId: string; weight: number }[] {
  if (sources.length === 0) {
    throw new BlendError("Select at least one projection to blend.");
  }
  const seen = new Set<string>();
  for (const s of sources) {
    if (seen.has(s.projectionId)) {
      throw new BlendError(
        "The same projection can only appear once in a blend.",
      );
    }
    seen.add(s.projectionId);
    if (!Number.isFinite(s.weight) || s.weight < 0) {
      throw new BlendError("Blend weights must be non-negative numbers.");
    }
  }
  const total = sources.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) {
    throw new BlendError("At least one blend weight must be positive.");
  }
  return sources.map((s) => ({
    projectionId: s.projectionId,
    weight: s.weight / total,
  }));
}

/**
 * The consecutive gameweek run covered by every list, starting at the
 * earliest shared gameweek. Empty when there is no overlap.
 */
export function sharedConsecutiveGameweeks(gwLists: number[][]): number[] {
  if (gwLists.length === 0) return [];
  let shared = new Set(gwLists[0]);
  for (const gws of gwLists.slice(1)) {
    const other = new Set(gws);
    shared = new Set([...shared].filter((g) => other.has(g)));
  }
  if (shared.size === 0) return [];
  const start = Math.min(...shared);
  const out: number[] = [];
  for (let gw = start; shared.has(gw); gw++) out.push(gw);
  return out;
}

const POS_LETTER: Record<string, string> = {
  G: "G", GK: "G", GKP: "G",
  D: "D", DEF: "D",
  M: "M", MID: "M",
  F: "F", FWD: "F", FW: "F",
};

/** One source's parsed player table, ready for blending. */
export interface BlendComponentData {
  projectionId: string;
  filename: string;
  /** Normalized weight (all components sum to 1). */
  weight: number;
  gameweeks: number[];
  hasOwnership: boolean;
  players: Map<
    number,
    {
      name: string;
      position: string;
      team: string;
      price: number;
      ownership: number;
      byGameweek: Map<number, { points: number; minutes: number }>;
    }
  >;
}

/** Parse one snapshot CSV into blend-ready per-player data. */
export function parseComponentCsv(
  projectionId: string,
  filename: string,
  weight: number,
  gameweeks: number[],
  csv: string,
): BlendComponentData {
  const rows = parseCsv(csv);
  const first = rows[0] ?? {};
  const idCol = ["ID", "Id", "id"].find((c) => c in first);
  if (!idCol) {
    throw new BlendError(
      `Projection "${filename}" has no ID column, so it can't be blended.`,
    );
  }
  const nameCol = ["Name", "name", "Player"].find((c) => c in first) ?? "Name";
  const posCol = ["Pos", "Position", "pos"].find((c) => c in first) ?? "Pos";
  const teamCol = ["Team", "team", "Club"].find((c) => c in first) ?? "Team";
  const priceCol = ["Value", "Price", "BV", "SV", "Cost"].find(
    (c) => c in first,
  );
  const hasOwnership = "Ownership" in first;
  const players: BlendComponentData["players"] = new Map();
  for (const r of rows) {
    const id = Number(r[idCol]);
    if (!Number.isFinite(id) || id <= 0) continue;
    const byGameweek = new Map<number, { points: number; minutes: number }>();
    for (const gw of gameweeks) {
      byGameweek.set(gw, {
        points: Number(r[`${gw}_Pts`]) || 0,
        minutes: Number(r[`${gw}_xMins`]) || 0,
      });
    }
    players.set(id, {
      name: r[nameCol] ?? "",
      position: POS_LETTER[(r[posCol] ?? "").toUpperCase()] ?? "?",
      team: r[teamCol] ?? "",
      price: priceCol ? Number(r[priceCol]) || 0 : 0,
      ownership: hasOwnership ? Number(r["Ownership"]) || 0 : 0,
      byGameweek,
    });
  }
  return { projectionId, filename, weight, gameweeks, hasOwnership, players };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Blend components into canonical player rows over the union of player ids.
 *
 * - Points and expected minutes are the weight-multiplied sums across all
 *   components; a player missing from a component contributes zero from it
 *   (weights are never redistributed per player).
 * - Metadata (name, position, team, price, ownership) comes from the
 *   highest-weight component containing the player; ties break toward the
 *   component listed first in the user's selection.
 * - Values are rounded exactly as the canonical CSV stores them, so previews
 *   computed from these rows match the solver's input byte for byte.
 */
export function blendRows(
  components: BlendComponentData[],
  gameweeks: number[],
): CanonicalPlayerRow[] {
  // Metadata precedence: weight descending; stable sort keeps selection order for ties.
  const precedence = [...components].sort((a, b) => b.weight - a.weight);
  const ids = new Set<number>();
  for (const c of components) for (const id of c.players.keys()) ids.add(id);
  const rows: CanonicalPlayerRow[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const donor = precedence.find((c) => c.players.has(id))!.players.get(id)!;
    const byGameweek = new Map<number, { points: number; minutes: number }>();
    for (const gw of gameweeks) {
      let points = 0;
      let minutes = 0;
      for (const c of components) {
        const f = c.players.get(id)?.byGameweek.get(gw);
        points += c.weight * (f?.points ?? 0);
        minutes += c.weight * (f?.minutes ?? 0);
      }
      byGameweek.set(gw, { points: round2(points), minutes: Math.round(minutes) });
    }
    rows.push({
      fplId: id,
      name: donor.name,
      position: donor.position,
      team: donor.team,
      price: donor.price,
      ownership: donor.ownership,
      byGameweek,
    });
  }
  return rows;
}

export interface BuiltBlend {
  components: BlendComponentData[];
  /** Shared consecutive gameweek horizon. */
  gameweeks: number[];
  rows: CanonicalPlayerRow[];
  /** True when every component carries ownership data. */
  hasOwnership: boolean;
}

/**
 * Resolve saved snapshots, normalize weights and blend. Throws BlendError
 * for unknown/deleted snapshots, invalid weights or no shared horizon.
 */
export function buildBlend(sources: BlendSourceInput[]): BuiltBlend {
  const normalized = normalizeBlendWeights(sources);
  const metas = listProjectionMetas();
  const resolved: { meta: ProjectionMeta; weight: number }[] = normalized.map(
    (s) => {
      const meta = metas.find((m) => m.id === s.projectionId);
      if (!meta) {
        throw new BlendError(
          `Projection ${s.projectionId} was not found — it may have been deleted. Remove it from the blend and try again.`,
          404,
        );
      }
      return { meta, weight: s.weight };
    },
  );
  const gameweeks = sharedConsecutiveGameweeks(
    resolved.map((r) => r.meta.gameweeks),
  );
  if (gameweeks.length === 0) {
    throw new BlendError(
      "The selected projections have no shared consecutive gameweeks, so they can't be blended.",
    );
  }
  const components = resolved.map(({ meta, weight }) => {
    const filePath = projectionCsvPath(meta.id);
    if (!fs.existsSync(filePath)) {
      throw new BlendError(
        `The data file for projection "${meta.filename}" is missing. Remove it from the blend and try again.`,
        404,
      );
    }
    return parseComponentCsv(
      meta.id,
      meta.filename,
      weight,
      gameweeks,
      fs.readFileSync(filePath, "utf-8"),
    );
  });
  return {
    components,
    gameweeks,
    rows: blendRows(components, gameweeks),
    hasOwnership: components.every((c) => c.hasOwnership),
  };
}

/** Serialize blended rows; Ownership is only kept when every source has it. */
export function blendCsv(blend: BuiltBlend): string {
  return buildCanonicalCsv(blend.rows, blend.gameweeks, {
    // Omit the column at canonical serialization time so quoted commas and
    // escaped quotes in player/team metadata remain intact.
    includeOwnership: blend.hasOwnership,
  });
}

function pct(w: number): string {
  return `${Math.round(w * 1000) / 10}%`;
}

/**
 * Materialize a blend as an immutable saved snapshot recording its component
 * provenance (ids, filenames and normalized weights). Solves run against
 * this exact snapshot, so the blend is reproducible even if components are
 * later deleted or reimported.
 */
export function createBlendSnapshot(sources: BlendSourceInput[]): ProjectionMeta {
  const blend = buildBlend(sources);
  const label = blend.components
    .map(
      (c) =>
        `${pct(c.weight)} ${normalizeImportedProjectionFilename(c.filename).replace(/\.csv$/i, "")}`,
    )
    .join(" + ");
  return saveProjectionSnapshot({
    filename: `Blend ${label}`.slice(0, 180),
    csv: blendCsv(blend),
    playerCount: blend.rows.length,
    gameweeks: blend.gameweeks,
    source: "blend",
    sourceLabel: "Weighted blend",
    components: blend.components.map((c) => ({
      projectionId: c.projectionId,
      filename: c.filename,
      weight: c.weight,
    })),
  });
}
