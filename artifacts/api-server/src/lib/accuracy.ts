import fs from "node:fs";
import { parseCsv } from "./csv";
import { listResultArchives, type ResultArchive } from "./results";
import { projectionCsvPath } from "./solver";
import { listProjectionMetas, type ProjectionMeta } from "./store";

/** Accuracy of one source's snapshot against one gameweek's official results. */
export interface AccuracyEntry {
  source: string;
  sourceLabel: string;
  season: string;
  gameweek: number;
  projectionId: string;
  projectionFilename: string;
  /** When the winning snapshot was captured (always before the deadline). */
  snapshotAt: string;
  /** Players present in both the snapshot and the official results. */
  sampleSize: number;
  /** Matched players / players who actually played (minutes > 0). */
  coverage: number;
  mae: number;
  rmse: number;
  /** Mean of (predicted − actual); positive means the source over-predicts. */
  bias: number;
  /** Pearson correlation between predicted and actual points (null if degenerate). */
  correlation: number | null;
}

export interface AccuracyMiss {
  playerId: number;
  name: string;
  team: string;
  position: string;
  predicted: number;
  actual: number;
  error: number;
}

export function sourceKeyOf(meta: ProjectionMeta): string {
  if (meta.source) return meta.source;
  // Legacy metas predate source tracking; recognize our own import filenames.
  if (/^FFH predictions /.test(meta.filename)) return "ffh";
  return "upload";
}

export function sourceLabelOf(meta: ProjectionMeta): string {
  if (meta.sourceLabel) return meta.sourceLabel;
  const key = sourceKeyOf(meta);
  if (key === "ffh") return "Fantasy Football Hub";
  return key === "upload" ? "Manual upload" : key;
}

/**
 * Pick, per source, the latest snapshot captured strictly before the deadline
 * that covers the gameweek. Later snapshots are hindsight-contaminated and
 * must never be used.
 */
export function selectSnapshots(
  metas: ProjectionMeta[],
  gameweek: number,
  deadline: string,
  season?: string,
): Map<string, ProjectionMeta> {
  const deadlineMs = Date.parse(deadline);
  const best = new Map<string, ProjectionMeta>();
  for (const m of metas) {
    if (!m.gameweeks.includes(gameweek)) continue;
    // Never compare across seasons: require a season match whenever both
    // sides are known. (Legacy metas without a season stay eligible.)
    if (season && m.season && m.season !== season) continue;
    const at = Date.parse(m.uploadedAt);
    if (!Number.isFinite(at) || at >= deadlineMs) continue;
    const key = sourceKeyOf(m);
    const cur = best.get(key);
    if (!cur || at > Date.parse(cur.uploadedAt)) best.set(key, m);
  }
  return best;
}

export interface PredictionRow {
  playerId: number;
  name: string;
  team: string;
  position: string;
  points: number;
}

/** Read one gameweek's predictions from a canonical projection CSV. */
export function readPredictions(
  csvContent: string,
  gameweek: number,
): PredictionRow[] {
  const rows = parseCsv(csvContent);
  const out: PredictionRow[] = [];
  for (const r of rows) {
    const id = Number(r["ID"] ?? r["Id"] ?? r["id"]);
    const rawPts = (r[`${gameweek}_Pts`] ?? "").trim();
    const pts = Number(rawPts);
    // Blank cells must not silently become 0-point forecasts.
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      rawPts === "" ||
      !Number.isFinite(pts)
    )
      continue;
    out.push({
      playerId: id,
      name: r["Name"] ?? r["name"] ?? r["Player"] ?? "",
      team: r["Team"] ?? r["team"] ?? "",
      position: r["Pos"] ?? r["Position"] ?? r["pos"] ?? "",
      points: pts,
    });
  }
  return out;
}

export interface MetricResult {
  sampleSize: number;
  /** Matched players who actually played (official minutes > 0). */
  matchedPlayed: number;
  mae: number;
  rmse: number;
  bias: number;
  correlation: number | null;
  misses: AccuracyMiss[];
}

/** Compare predictions to actuals for players present in both datasets. */
export function computeMetrics(
  predictions: PredictionRow[],
  actuals: { id: number; points: number; minutes?: number }[],
): MetricResult | null {
  const actualById = new Map(actuals.map((a) => [a.id, a]));
  const pairs: { row: PredictionRow; actual: number }[] = [];
  let matchedPlayed = 0;
  for (const p of predictions) {
    const a = actualById.get(p.playerId);
    if (a === undefined) continue;
    if ((a.minutes ?? 0) > 0) matchedPlayed++;
    pairs.push({ row: p, actual: a.points });
  }
  const n = pairs.length;
  if (n === 0) return null;
  let sumAbs = 0;
  let sumSq = 0;
  let sumErr = 0;
  for (const { row, actual } of pairs) {
    const err = row.points - actual;
    sumAbs += Math.abs(err);
    sumSq += err * err;
    sumErr += err;
  }
  const meanP = pairs.reduce((s, x) => s + x.row.points, 0) / n;
  const meanA = pairs.reduce((s, x) => s + x.actual, 0) / n;
  let cov = 0;
  let varP = 0;
  let varA = 0;
  for (const { row, actual } of pairs) {
    cov += (row.points - meanP) * (actual - meanA);
    varP += (row.points - meanP) ** 2;
    varA += (actual - meanA) ** 2;
  }
  const correlation =
    varP > 0 && varA > 0 ? cov / Math.sqrt(varP * varA) : null;
  const misses = pairs
    .map(({ row, actual }) => ({
      playerId: row.playerId,
      name: row.name,
      team: row.team,
      position: row.position,
      predicted: row.points,
      actual,
      error: row.points - actual,
    }))
    .sort((a, b) => Math.abs(b.error) - Math.abs(a.error));
  return {
    sampleSize: n,
    matchedPlayed,
    mae: sumAbs / n,
    rmse: Math.sqrt(sumSq / n),
    bias: sumErr / n,
    correlation,
    misses,
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function entryFor(
  meta: ProjectionMeta,
  archive: ResultArchive,
  metrics: MetricResult,
): AccuracyEntry {
  const played = archive.players.filter((p) => p.minutes > 0).length;
  return {
    source: sourceKeyOf(meta),
    sourceLabel: sourceLabelOf(meta),
    season: archive.season,
    gameweek: archive.gameweek,
    projectionId: meta.id,
    projectionFilename: meta.filename,
    snapshotAt: meta.uploadedAt,
    sampleSize: metrics.sampleSize,
    coverage:
      played > 0 ? round(Math.min(1, metrics.matchedPlayed / played)) : 0,
    mae: round(metrics.mae),
    rmse: round(metrics.rmse),
    bias: round(metrics.bias),
    correlation:
      metrics.correlation == null ? null : round(metrics.correlation),
  };
}

function loadCsv(id: string): string | null {
  try {
    return fs.readFileSync(projectionCsvPath(id), "utf-8");
  } catch {
    return null;
  }
}

/** Accuracy of every source against every archived gameweek result. */
export function computeAccuracy(): AccuracyEntry[] {
  const metas = listProjectionMetas();
  const entries: AccuracyEntry[] = [];
  for (const archive of listResultArchives()) {
    const snapshots = selectSnapshots(
      metas,
      archive.gameweek,
      archive.deadline,
      archive.season,
    );
    for (const meta of snapshots.values()) {
      const csv = loadCsv(meta.id);
      if (csv == null) continue;
      const metrics = computeMetrics(
        readPredictions(csv, archive.gameweek),
        archive.players,
      );
      if (!metrics) continue;
      entries.push(entryFor(meta, archive, metrics));
    }
  }
  return entries.sort(
    (a, b) =>
      a.season.localeCompare(b.season) ||
      a.gameweek - b.gameweek ||
      a.source.localeCompare(b.source),
  );
}

/** Player-level errors for one snapshot vs one gameweek, biggest misses first. */
export function computeAccuracyDetail(
  projectionId: string,
  gameweek: number,
  limit = 25,
): AccuracyMiss[] | null {
  const meta = listProjectionMetas().find((m) => m.id === projectionId);
  const candidates = listResultArchives().filter(
    (a) => a.gameweek === gameweek,
  );
  // Prefer the archive matching the snapshot's season; else the latest season
  // (archives are sorted season-ascending).
  const archive = meta?.season
    ? candidates.find((a) => a.season === meta.season)
    : candidates[candidates.length - 1];
  if (!archive) return null;
  const csv = loadCsv(projectionId);
  if (csv == null) return null;
  const metrics = computeMetrics(
    readPredictions(csv, gameweek),
    archive.players,
  );
  if (!metrics) return [];
  return metrics.misses.slice(0, limit).map((m) => ({
    ...m,
    predicted: round(m.predicted),
    error: round(m.error),
  }));
}
