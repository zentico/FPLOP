import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";
import { parseCsv } from "./csv";
import {
  RUNS_DIR,
  SOLVER_DATA_DIR,
  SOLVER_REPO,
  SOLVER_RESULTS_DIR,
} from "./paths";
import {
  type GameweekPlan,
  type PickPlayer,
  type SolveRequest,
  type SolveResult,
  listRunMetas,
  saveRunMetas,
  updateRun,
} from "./store";

const CHIP_OPTION: Record<string, string> = {
  wildcard: "use_wc",
  bench_boost: "use_bb",
  free_hit: "use_fh",
  triple_captain: "use_tc",
};

const CHIP_CODE: Record<string, string> = {
  WC: "wildcard",
  BB: "bench_boost",
  FH: "free_hit",
  TC: "triple_captain",
};

export function projectionCsvPath(projectionId: string): string {
  return path.join(SOLVER_DATA_DIR, `${projectionId}.csv`);
}

/** Map of player id -> price, read from the projection csv. */
function priceMap(projectionId: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const rows = parseCsv(fs.readFileSync(projectionCsvPath(projectionId), "utf-8"));
    if (rows.length === 0) return map;
    const first = rows[0]!;
    const priceCol = ["Value", "Price", "BV", "SV", "Cost", "now_cost"].find(
      (c) => c in first,
    );
    const idCol = ["ID", "Id", "id"].find((c) => c in first);
    if (!priceCol || !idCol) return map;
    for (const r of rows) {
      const v = Number(r[priceCol]);
      if (r[idCol] && Number.isFinite(v)) map.set(String(Number(r[idCol])), v);
    }
  } catch {
    // price enrichment is best-effort
  }
  return map;
}

/** Clamp the differential factor k to a sane fraction range. */
export function clampDifferentialFactor(k: number): number {
  return Math.min(Math.max(k, 0), 1);
}

/** True when the projection CSV includes an Ownership column. */
export function projectionHasOwnership(projectionId: string): boolean {
  try {
    const header = fs
      .readFileSync(projectionCsvPath(projectionId), "utf-8")
      .split(/\r?\n/, 1)[0]!;
    return header.split(",").map((h) => h.trim()).includes("Ownership");
  } catch {
    return false;
  }
}

export interface PoolFilter {
  impactPpm: number;
  valuePpmPerM: number;
  benchMaxPrice: number;
  benchMinPpm: number;
}

export interface PoolPlayerStat {
  id: number;
  name: string;
  position: string;
  price: number;
  ppm: number;
}

const POS_LETTER: Record<string, string> = {
  G: "G", GK: "G", GKP: "G",
  D: "D", DEF: "D",
  M: "M", MID: "M",
  F: "F", FWD: "F", FW: "F",
};

/** Points per match: total projected points / number of gameweeks in the projection. */
function rowPpm(row: Record<string, string>, headers: string[]): number {
  let pts = 0;
  let gws = 0;
  for (const h of headers) {
    if (/^\d+_Pts$/.test(h)) {
      pts += Number(row[h]) || 0;
      gws++;
    }
  }
  if (gws <= 0) return 0;
  return pts / gws;
}

/** True when a player passes the OR of the three pool-filter criteria. */
export function poolEligible(
  filter: PoolFilter,
  price: number,
  ppm: number,
): boolean {
  if (ppm > filter.impactPpm) return true;
  if (price > 0 && ppm / price > filter.valuePpmPerM) return true;
  if (price < filter.benchMaxPrice && ppm > filter.benchMinPpm) return true;
  return false;
}

/** Per-player stats used for pool filtering (price and points per match). */
export function computePoolStats(projectionId: string): PoolPlayerStat[] {
  const content = fs.readFileSync(projectionCsvPath(projectionId), "utf-8");
  const rows = parseCsv(content);
  if (rows.length === 0) return [];
  const headers = Object.keys(rows[0]!);
  const first = rows[0]!;
  const priceCol = ["Value", "Price", "BV", "SV", "Cost"].find((c) => c in first);
  const nameCol = ["Name", "name", "Player"].find((c) => c in first) ?? "Name";
  const posCol = ["Pos", "Position", "pos"].find((c) => c in first) ?? "Pos";
  const idCol = ["ID", "Id", "id"].find((c) => c in first);
  // ppm is intentionally unrounded so eligibility decisions here, in the
  // frontend live count, and in the per-run CSV filter agree at boundaries.
  return rows
    .map((r) => ({
      id: idCol ? Number(r[idCol]) || 0 : 0,
      name: r[nameCol] ?? "",
      position: POS_LETTER[(r[posCol] ?? "").toUpperCase()] ?? "?",
      price: priceCol ? Number(r[priceCol]) || 0 : 0,
      ppm: rowPpm(r, headers),
    }))
    .filter((p) => p.name);
}

const csvField = (v: string): string =>
  /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/**
 * Write the per-run copy of the projection CSV the solver reads:
 * - when `filter` is set, drop players failing all three pool criteria
 *   (locked players in `keepIds` are always kept);
 * - when k > 0, scale every per-GW points column by
 *   1 + k * (100 - ownership%) / 100.
 * Returns the per-player factor map (null when k = 0) and pool counts.
 */
function writeRunProjection(
  projectionId: string,
  datasource: string,
  k: number,
  filter: PoolFilter | null,
  keepIds: Set<number>,
): { factors: Map<string, number> | null; kept: number; total: number } {
  const content = fs.readFileSync(projectionCsvPath(projectionId), "utf-8");
  const rows = parseCsv(content);
  const headers = content
    .split(/\r?\n/, 1)[0]!
    .split(",")
    .map((h) => h.trim());
  const idCol = headers.find((h) => ["ID", "Id", "id"].includes(h));
  if (!idCol) throw new Error("Projection is missing an ID column");
  if (k > 0 && !headers.includes("Ownership")) {
    throw new Error("Projection is missing the Ownership column");
  }
  const ptsCols = new Set(headers.filter((h) => /^\d+_Pts$/.test(h)));
  const priceCol = ["Value", "Price", "BV", "SV", "Cost"].find((c) =>
    headers.includes(c),
  );

  const factors = k > 0 ? new Map<string, number>() : null;
  const lines = [headers.map(csvField).join(",")];
  let kept = 0;
  for (const r of rows) {
    if (filter) {
      const price = priceCol ? Number(r[priceCol]) || 0 : 0;
      const ppm = rowPpm(r, headers);
      if (
        !poolEligible(filter, price, ppm) &&
        !keepIds.has(Number(r[idCol]))
      ) {
        continue;
      }
    }
    kept++;
    let factor = 1;
    if (factors) {
      const ownership = Number(r["Ownership"]);
      factor = Number.isFinite(ownership)
        ? 1 + (k * (100 - Math.min(Math.max(ownership, 0), 100))) / 100
        : 1;
      factors.set(String(Number(r[idCol])), factor);
    }
    lines.push(
      headers
        .map((h) => {
          const v = r[h] ?? "";
          if (factors && ptsCols.has(h)) {
            const n = Number(v);
            if (Number.isFinite(n)) return String(Math.round(n * factor * 1000) / 1000);
          }
          return csvField(v);
        })
        .join(","),
    );
  }
  fs.writeFileSync(
    path.join(SOLVER_DATA_DIR, `${datasource}.csv`),
    lines.join("\n") + "\n",
  );
  return { factors, kept, total: rows.length };
}

interface PickRow {
  id: string;
  week: string;
  name: string;
  pos: string;
  team: string;
  xP: string;
  xp_cont: string;
  lineup: string;
  bench: string;
  captain: string;
  vicecaptain: string;
  transfer_in: string;
  transfer_out: string;
  chip: string;
  buy_price: string;
  iter: string;
}

function parseResultCsv(
  csvContent: string,
  prices: Map<string, number>,
  factors: Map<string, number> | null = null,
): SolveResult {
  const rows = parseCsv(csvContent) as unknown as PickRow[];
  const firstIter = rows.length > 0 ? rows[0]!.iter : "0";
  const iterRows = rows.filter((r) => r.iter === firstIter);

  const weeks = [...new Set(iterRows.map((r) => Number(r.week)))].sort(
    (a, b) => a - b,
  );

  const gameweeks: GameweekPlan[] = weeks.map((week) => {
    const wr = iterRows.filter((r) => Number(r.week) === week);

    const factorOf = (r: PickRow): number =>
      factors?.get(String(Number(r.id))) ?? 1;

    const toPlayer = (r: PickRow): PickPlayer => {
      const benchOrder = Number(r.bench);
      const buyPrice = Number(r.buy_price);
      return {
        name: r.name,
        team: r.team,
        position: (r.pos || "?").charAt(0),
        price:
          prices.get(String(Number(r.id))) ??
          (Number.isFinite(buyPrice) && buyPrice > 0 ? buyPrice : 0),
        expectedPoints: Number(r.xP) || 0,
        basePoints: factors
          ? Math.round(((Number(r.xP) || 0) / factorOf(r)) * 100) / 100
          : null,
        isCaptain: Number(r.captain) === 1,
        isViceCaptain: Number(r.vicecaptain) === 1,
        benchOrder: benchOrder >= 0 ? benchOrder : null,
      };
    };

    const lineup = wr
      .filter((r) => Number(r.lineup) === 1)
      .map(toPlayer)
      .sort((a, b) => "GDMF".indexOf(a.position) - "GDMF".indexOf(b.position));
    const bench = wr
      .filter((r) => Number(r.lineup) !== 1 && Number(r.bench) >= 0)
      .map(toPlayer)
      .sort((a, b) => (a.benchOrder ?? 0) - (b.benchOrder ?? 0));

    const chipCode = wr.find((r) => r.chip)?.chip ?? "";
    const squadRows = wr.filter(
      (r) => Number(r.lineup) === 1 || Number(r.bench) >= 0,
    );

    return {
      gameweek: week,
      chip: chipCode ? (CHIP_CODE[chipCode] ?? chipCode) : null,
      expectedPoints:
        Math.round(
          squadRows.reduce((s, r) => s + (Number(r.xp_cont) || 0), 0) * 100,
        ) / 100,
      baseExpectedPoints: factors
        ? Math.round(
            squadRows.reduce(
              (s, r) => s + (Number(r.xp_cont) || 0) / factorOf(r),
              0,
            ) * 100,
          ) / 100
        : null,
      bank: null,
      lineup,
      bench,
      transfersIn: wr
        .filter((r) => Number(r.transfer_in) === 1)
        .map((r) => r.name),
      transfersOut: wr
        .filter((r) => Number(r.transfer_out) === 1)
        .map((r) => r.name),
    };
  });

  return {
    totalExpectedPoints:
      Math.round(gameweeks.reduce((s, g) => s + g.expectedPoints, 0) * 100) /
      100,
    totalBaseExpectedPoints: factors
      ? Math.round(
          gameweeks.reduce((s, g) => s + (g.baseExpectedPoints ?? 0), 0) * 100,
        ) / 100
      : null,
    gameweeks,
  };
}

/** Resolve player names (or numeric ids) against a projection CSV to FPL ids. */
export function resolvePlayerRefs(
  projectionId: string,
  refs: string[],
): { ids: number[]; unknown: string[] } {
  const ids: number[] = [];
  const unknown: string[] = [];
  const byName = new Map<string, number>();
  const idSet = new Set<number>();
  try {
    const rows = parseCsv(
      fs.readFileSync(projectionCsvPath(projectionId), "utf-8"),
    );
    for (const r of rows) {
      const id = Number(r["ID"] ?? r["Id"] ?? r["id"]);
      const name = (r["Name"] ?? r["name"] ?? "").toLowerCase();
      if (Number.isFinite(id)) {
        idSet.add(id);
        if (name) byName.set(name, id);
      }
    }
  } catch {
    // no readable projection — everything becomes unknown
  }
  for (const ref of refs) {
    const trimmed = ref.trim();
    if (!trimmed) continue;
    if (/^\d+$/.test(trimmed)) {
      const id = Number(trimmed);
      if (idSet.has(id)) ids.push(id);
      else unknown.push(trimmed);
      continue;
    }
    const id = byName.get(trimmed.toLowerCase());
    if (id != null) ids.push(id);
    else unknown.push(trimmed);
  }
  return { ids, unknown };
}

function buildConfig(
  request: SolveRequest,
  datasource: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    datasource,
    horizon: request.horizon ?? 5,
    no_transfer_last_gws: 0,
    verbose: true,
    print_squads: false,
    print_result_table: false,
    print_decay_metrics: false,
    print_transfer_chip_summary: false,
    banned: [],
    locked: [],
    use_wc: [],
    use_bb: [],
    use_fh: [],
    use_tc: [],
  };

  if (request.firstGameweek) {
    config["preseason"] = true;
  } else {
    config["preseason"] = false;
    config["team_data"] = "id";
    config["team_id"] = request.teamId;
  }

  for (const assignment of request.chips ?? []) {
    const key = CHIP_OPTION[assignment.chip];
    if (key) {
      (config[key] as number[]).push(assignment.gameweek);
    }
  }

  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  const intClamp = (v: number, lo: number, hi: number) =>
    clamp(Math.round(v), lo, hi);

  const opts = request.options;
  if (opts) {
    if (opts.banned?.length) {
      config["banned"] = resolvePlayerRefs(request.projectionId, opts.banned).ids;
    }
    if (opts.locked?.length) {
      config["locked"] = resolvePlayerRefs(request.projectionId, opts.locked).ids;
    }
    if (opts.noTransferLastGws != null)
      config["no_transfer_last_gws"] = intClamp(opts.noTransferLastGws, 0, 37);
    if (opts.noFutureTransfer != null)
      config["no_future_transfer"] = opts.noFutureTransfer;
    if (opts.numTransfers != null)
      config["num_transfers"] = intClamp(opts.numTransfers, 0, 15);
    if (opts.hitLimit != null)
      config["hit_limit"] = intClamp(opts.hitLimit, 0, 20);
    if (opts.weeklyHitLimit != null)
      config["weekly_hit_limit"] = intClamp(opts.weeklyHitLimit, 0, 20);
    if (opts.decayBase != null)
      config["decay_base"] = clamp(opts.decayBase, 0.5, 1.2);
    if (opts.ftValue != null) config["ft_value"] = clamp(opts.ftValue, 0, 10);
    if (opts.itbValue != null) config["itb_value"] = clamp(opts.itbValue, 0, 5);
    if (opts.xminLb != null) config["xmin_lb"] = intClamp(opts.xminLb, 0, 5000);
    if (opts.secs != null) config["secs"] = intClamp(opts.secs, 10, MAX_SOLVE_SECS);
    if (opts.gap != null) config["gap"] = clamp(opts.gap, 0, 1);
    if (opts.randomized != null) config["randomized"] = opts.randomized;
  }

  return config;
}

const MAX_SOLVE_SECS = 30 * 60;

/** Child-process timeout: the solver's own (capped) time limit plus headroom. */
export function solveTimeoutMs(request: SolveRequest): number {
  const secs = request.options?.secs;
  const solverLimit =
    secs != null && secs > 0
      ? Math.min(secs, MAX_SOLVE_SECS) * 1000
      : 10 * 60 * 1000;
  return solverLimit + 5 * 60 * 1000;
}

/** Run the open-fpl-solver as a child process and persist the outcome on the run. */
export function startSolve(runId: string, request: SolveRequest): void {
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  // With a differential factor or pool filter, solve against a per-run copy
  // of the projection (adjusted scores and/or reduced player pool).
  const k = clampDifferentialFactor(request.differentialFactor ?? 0);
  const filter = request.poolFilter ?? null;
  const useAdjusted = k > 0 || filter != null;
  const datasource = useAdjusted ? `${request.projectionId}-r${runId}` : request.projectionId;
  const cleanupAdjusted = () => {
    if (!useAdjusted) return;
    try {
      fs.unlinkSync(path.join(SOLVER_DATA_DIR, `${datasource}.csv`));
    } catch {
      // best-effort cleanup
    }
  };

  // Everything from projection preparation to process spawn shares one
  // failure boundary so a partially written per-run CSV never leaks.
  let factors: Map<string, number> | null = null;
  let child: ReturnType<typeof spawn>;
  let logStream: fs.WriteStream;
  let logPath: string;
  let startedAt: number;
  try {
    if (useAdjusted) {
      const keepIds = new Set<number>(
        request.options?.locked?.length
          ? resolvePlayerRefs(request.projectionId, request.options.locked).ids
          : [],
      );
      const written = writeRunProjection(
        request.projectionId,
        datasource,
        k,
        filter,
        keepIds,
      );
      factors = written.factors;
      if (filter) {
        updateRun(runId, { poolKept: written.kept, poolTotal: written.total });
      }
    }

    const configPath = path.join(runDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(buildConfig(request, datasource), null, 2),
    );
    logPath = path.join(runDir, "solver.log");
    logStream = fs.createWriteStream(logPath);

    startedAt = Date.now();
    updateRun(runId, { status: "running" });

    child = spawn(
      "uv",
      ["run", "python", "run/solve.py", "--config", configPath],
      { cwd: SOLVER_REPO, env: { ...process.env } },
    );
  } catch (err) {
    cleanupAdjusted();
    updateRun(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: `Could not prepare the solve: ${(err as Error).message}`,
    });
    return;
  }

  // stdio defaults to "pipe", so stdout/stderr are always present.
  child.stdout!.pipe(logStream);
  child.stderr!.pipe(logStream);

  const timeout = setTimeout(() => {
    logger.warn({ runId }, "Solve timed out, killing solver process");
    child.kill("SIGKILL");
  }, solveTimeoutMs(request));

  child.on("error", (err) => {
    clearTimeout(timeout);
    cleanupAdjusted();
    logger.error({ err, runId }, "Failed to spawn solver");
    updateRun(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: `Failed to start solver: ${err.message}`,
    });
  });

  child.on("close", (code) => {
    clearTimeout(timeout);
    logStream.end();
    cleanupAdjusted();
    try {
      if (code !== 0) {
        const tail = readLogTail(logPath);
        updateRun(runId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error:
            code === null
              ? "Solver timed out"
              : `Solver exited with code ${code}. ${tail}`,
        });
        return;
      }

      const resultFile = findNewestResult(datasource, startedAt);
      if (!resultFile) {
        updateRun(runId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: `Solver finished but produced no result file. ${readLogTail(logPath)}`,
        });
        return;
      }

      const result = parseResultCsv(
        fs.readFileSync(resultFile, "utf-8"),
        priceMap(request.projectionId),
        factors,
      );
      // In first-gameweek mode the initial squad build is not a set of transfers.
      if (request.firstGameweek && result.gameweeks.length > 0) {
        result.gameweeks[0]!.transfersIn = [];
      }
      updateRun(runId, {
        status: "completed",
        completedAt: new Date().toISOString(),
        totalExpectedPoints: result.totalExpectedPoints,
        totalBaseExpectedPoints: result.totalBaseExpectedPoints ?? null,
        result,
      });
      logger.info({ runId, resultFile }, "Solve completed");
    } catch (err) {
      logger.error({ err, runId }, "Failed to parse solver result");
      updateRun(runId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: `Failed to parse solver result: ${(err as Error).message}`,
      });
    }
  });
}

export interface SolveProgress {
  stage: string;
  message: string;
  gapPercent: number | null;
}

/** Derive a human-readable progress snapshot from the solver's log file. */
export function getRunProgress(runId: string): SolveProgress {
  let content = "";
  try {
    content = fs.readFileSync(path.join(RUNS_DIR, runId, "solver.log"), "utf-8");
  } catch {
    // no log yet
  }

  if (content.includes("Solving report")) {
    return {
      stage: "finalizing",
      message: "Optimal plan found — writing out the solution",
      gapPercent: null,
    };
  }

  // HiGHS branch-and-bound progress rows look like:
  //   "  0  0  0   0.00%   126.759  126.715   0.03%   7  5  4  2387  1.4s"
  // The FIRST percentage is B&B tree exploration, the LAST one is the
  // optimality gap; when the gap is unknown HiGHS prints "Large"/"inf"
  // instead, leaving only one percentage on the row. Only trust rows that
  // end with an elapsed-time token, and take the most recent finite gap.
  let gap: number | null = null;
  for (const line of content.split("\n")) {
    if (!/\d+(?:\.\d+)?s\s*$/.test(line)) continue;
    const pcts = line.match(/\b\d+(?:\.\d+)?%/g);
    if (pcts && pcts.length >= 2) {
      const last = Number(pcts[pcts.length - 1]!.replace("%", ""));
      if (Number.isFinite(last)) gap = last;
    } else if (pcts && pcts.length === 1 && /\b(Large|inf)\b/.test(line)) {
      gap = null; // gap column is Large/inf — genuinely unknown right now
    }
  }

  if (content.includes("Solving MIP model") || content.includes("Presolving model")) {
    return {
      stage: "solving",
      message:
        gap != null
          ? `Exploring transfer plans — current solution within ${gap.toFixed(2)}% of the theoretical best`
          : "Exploring transfer plans with the MIP solver",
      gapPercent: gap,
    };
  }

  const pool = /Filtered player pool from (\d+) to (\d+) players/.exec(content);
  if (pool) {
    return {
      stage: "pool",
      message: `Building the optimization model from a pool of ${pool[2]} candidate players`,
      gapPercent: null,
    };
  }

  return {
    stage: "preparing",
    message: "Preparing the solver environment and loading projections",
    gapPercent: null,
  };
}

function readLogTail(logPath: string): string {
  try {
    const content = fs.readFileSync(logPath, "utf-8").trim();
    const lines = content.split("\n").filter((l) => l.trim());
    return lines.slice(-6).join(" | ").slice(-600);
  } catch {
    return "";
  }
}

function findNewestResult(
  datasource: string,
  startedAt: number,
): string | null {
  try {
    const files = fs
      .readdirSync(SOLVER_RESULTS_DIR)
      .filter((f) => f.startsWith(`${datasource}_`) && f.endsWith(".csv"))
      .map((f) => path.join(SOLVER_RESULTS_DIR, f))
      .filter((f) => fs.statSync(f).mtimeMs >= startedAt - 5000);
    if (files.length === 0) return null;
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0]!;
  } catch {
    return null;
  }
}

/** Re-mark any runs left in queued/running state (e.g. after a server restart). */
export function failStaleRuns(): void {
  const runs = listRunMetas();
  let changed = false;
  for (const run of runs) {
    if (run.status === "queued" || run.status === "running") {
      run.status = "failed";
      run.error = "Server restarted while the solve was in progress";
      run.completedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveRunMetas(runs);
}
