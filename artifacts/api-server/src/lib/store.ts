import fs from "node:fs";
import path from "node:path";
import { STORE_DIR } from "./paths";

export interface ProjectionMeta {
  id: string;
  filename: string;
  uploadedAt: string;
  playerCount: number;
  gameweeks: number[];
}

export interface ChipAssignment {
  chip: string;
  gameweek: number;
}

export interface SolveOptions {
  banned?: string[];
  locked?: string[];
  noTransferLastGws?: number | null;
  noFutureTransfer?: boolean | null;
  numTransfers?: number | null;
  hitLimit?: number | null;
  weeklyHitLimit?: number | null;
  decayBase?: number | null;
  ftValue?: number | null;
  itbValue?: number | null;
  xminLb?: number | null;
  secs?: number | null;
  gap?: number | null;
  randomized?: boolean | null;
  opposingPlay?: "off" | "penalty" | "forbid" | null;
  /** Transfers the user has already decided on; the solver must make them. */
  bookedTransfers?: BookedTransfer[] | null;
  /** Generate this many alternative plans (each forced to differ in next-GW transfers). */
  numIterations?: number | null;
  /** Objective weights for bench slots [GK, 1st, 2nd, 3rd]. */
  benchWeights?: number[] | null;
}

export interface BookedTransfer {
  gameweek: number;
  in?: string | null;
  out?: string | null;
}

export interface PoolFilter {
  gkMain: number;
  gkBench: number;
  defMain: number;
  defBench: number;
  midMain: number;
  midBench: number;
  fwdMain: number;
  fwdBench: number;
}

export interface SolveRequest {
  projectionId: string;
  firstGameweek: boolean;
  teamId?: number | null;
  horizon?: number;
  differentialFactor?: number | null;
  poolFilter?: PoolFilter | null;
  chips?: ChipAssignment[];
  /**
   * Server-computed gameweek window for chips assigned gameweek 0 ("Any"):
   * the solver must play the chip exactly once within these gameweeks.
   */
  anyChipGws?: number[] | null;
  options?: SolveOptions | null;
  /**
   * Internal (mega-run scenarios only): let the solver choose chip timing.
   * Each listed chip may be played at most once, restricted to allowedGws.
   */
  chipMode?: { available: string[]; allowedGws: number[] } | null;
}

export interface PickPlayer {
  /** Stable player ID from the projection/solver data, when available. */
  id?: string | null;
  name: string;
  team: string;
  position: string;
  price: number;
  expectedPoints: number;
  basePoints?: number | null;
  isCaptain: boolean;
  isViceCaptain: boolean;
  benchOrder?: number | null;
  /** Ownership percentage from the projection file, when available. */
  ownership?: number | null;
}

export interface GameweekPlan {
  gameweek: number;
  chip?: string | null;
  expectedPoints: number;
  baseExpectedPoints?: number | null;
  bank?: number | null;
  /** Free transfers available going into this gameweek (from the solver's ft column). */
  freeTransfers?: number | null;
  lineup: PickPlayer[];
  bench: PickPlayer[];
  transfersIn: string[];
  transfersOut: string[];
}

export interface SolvePlan {
  totalExpectedPoints: number;
  totalBaseExpectedPoints?: number | null;
  gameweeks: GameweekPlan[];
}

export interface SolveResult extends SolvePlan {
  /** Alternative plans from multi-iteration solves (best plan first, excluded). */
  alternatives?: SolvePlan[] | null;
}

export interface SolveRunMeta {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string | null;
  error?: string | null;
  request: SolveRequest;
  projectionFilename?: string | null;
  totalExpectedPoints?: number | null;
  /** Final optimality gap (%) reported by the solver at completion. */
  finalGapPercent?: number | null;
  /** Solver objective value (decayed, adjusted, incl. bench weights and FT/ITB bonuses). */
  objective?: number | null;
  totalBaseExpectedPoints?: number | null;
  poolKept?: number | null;
  poolTotal?: number | null;
  result?: SolveResult | null;
}

export interface MegaScenarioMeta {
  key: string;
  runId: string;
}

export interface MegaRunMeta {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string | null;
  error?: string | null;
  projectionId: string;
  projectionFilename?: string | null;
  horizon: number;
  chipWindow: number[];
  scenarios: MegaScenarioMeta[];
}

const PROJECTIONS_FILE = path.join(STORE_DIR, "projections.json");
const RUNS_FILE = path.join(STORE_DIR, "runs.json");
const MEGA_FILE = path.join(STORE_DIR, "mega.json");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function listProjectionMetas(): ProjectionMeta[] {
  return readJson<ProjectionMeta[]>(PROJECTIONS_FILE, []);
}

export function saveProjectionMetas(metas: ProjectionMeta[]): void {
  writeJson(PROJECTIONS_FILE, metas);
}

/** All 8 count fields of the current PoolFilter shape. */
const POOL_FILTER_FIELDS = [
  "gkMain", "gkBench", "defMain", "defBench",
  "midMain", "midBench", "fwdMain", "fwdBench",
] as const;

export function listRunMetas(): SolveRunMeta[] {
  const runs = readJson<SolveRunMeta[]>(RUNS_FILE, []);
  // Legacy runs may carry a pool filter in an older shape; drop it rather
  // than letting response validation fail and blank the whole history.
  for (const r of runs) {
    const f = r.request?.poolFilter as Record<string, unknown> | null | undefined;
    if (f && !POOL_FILTER_FIELDS.every((k) => typeof f[k] === "number")) {
      r.request.poolFilter = null;
    }
  }
  return runs;
}

export function saveRunMetas(runs: SolveRunMeta[]): void {
  writeJson(RUNS_FILE, runs);
}

export function updateRun(
  id: string,
  update: Partial<SolveRunMeta>,
): SolveRunMeta | undefined {
  const runs = listRunMetas();
  const run = runs.find((r) => r.id === id);
  if (!run) return undefined;
  Object.assign(run, update);
  saveRunMetas(runs);
  return run;
}

export function listMegaMetas(): MegaRunMeta[] {
  return readJson<MegaRunMeta[]>(MEGA_FILE, []);
}

export function saveMegaMetas(megas: MegaRunMeta[]): void {
  writeJson(MEGA_FILE, megas);
}

export function updateMega(
  id: string,
  update: Partial<MegaRunMeta>,
): MegaRunMeta | undefined {
  const megas = listMegaMetas();
  const mega = megas.find((m) => m.id === id);
  if (!mega) return undefined;
  Object.assign(mega, update);
  saveMegaMetas(megas);
  return mega;
}

export function newId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  ).toLowerCase();
}
