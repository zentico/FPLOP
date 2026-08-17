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

const SOLVE_TIMEOUT_MS = 15 * 60 * 1000;

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
): SolveResult {
  const rows = parseCsv(csvContent) as unknown as PickRow[];
  const firstIter = rows.length > 0 ? rows[0]!.iter : "0";
  const iterRows = rows.filter((r) => r.iter === firstIter);

  const weeks = [...new Set(iterRows.map((r) => Number(r.week)))].sort(
    (a, b) => a - b,
  );

  const gameweeks: GameweekPlan[] = weeks.map((week) => {
    const wr = iterRows.filter((r) => Number(r.week) === week);

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

    return {
      gameweek: week,
      chip: chipCode ? (CHIP_CODE[chipCode] ?? chipCode) : null,
      expectedPoints:
        Math.round(
          wr
            .filter((r) => Number(r.lineup) === 1 || Number(r.bench) >= 0)
            .reduce((s, r) => s + (Number(r.xp_cont) || 0), 0) * 100,
        ) / 100,
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
    gameweeks,
  };
}

function buildConfig(request: SolveRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {
    datasource: request.projectionId,
    horizon: request.horizon ?? 5,
    no_transfer_last_gws: 0,
    verbose: false,
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

  return config;
}

/** Run the open-fpl-solver as a child process and persist the outcome on the run. */
export function startSolve(runId: string, request: SolveRequest): void {
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const configPath = path.join(runDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(buildConfig(request), null, 2));
  const logPath = path.join(runDir, "solver.log");
  const logStream = fs.createWriteStream(logPath);

  const startedAt = Date.now();
  updateRun(runId, { status: "running" });

  const child = spawn(
    "uv",
    ["run", "python", "run/solve.py", "--config", configPath],
    { cwd: SOLVER_REPO, env: { ...process.env } },
  );

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  const timeout = setTimeout(() => {
    logger.warn({ runId }, "Solve timed out, killing solver process");
    child.kill("SIGKILL");
  }, SOLVE_TIMEOUT_MS);

  child.on("error", (err) => {
    clearTimeout(timeout);
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

      const resultFile = findNewestResult(request.projectionId, startedAt);
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
      );
      // In first-gameweek mode the initial squad build is not a set of transfers.
      if (request.firstGameweek && result.gameweeks.length > 0) {
        result.gameweeks[0]!.transfersIn = [];
      }
      updateRun(runId, {
        status: "completed",
        completedAt: new Date().toISOString(),
        totalExpectedPoints: result.totalExpectedPoints,
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
  projectionId: string,
  startedAt: number,
): string | null {
  try {
    const files = fs
      .readdirSync(SOLVER_RESULTS_DIR)
      .filter((f) => f.startsWith(`${projectionId}_`) && f.endsWith(".csv"))
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
