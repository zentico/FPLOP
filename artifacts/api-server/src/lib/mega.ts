import { logger } from "./logger";
import { startSolve } from "./solver";
import {
  type MegaRunMeta,
  type SolveRequest,
  type SolveRunMeta,
  listMegaMetas,
  listRunMetas,
  newId,
  saveMegaMetas,
  saveRunMetas,
  updateMega,
} from "./store";

export const ALL_CHIPS = [
  "wildcard",
  "bench_boost",
  "free_hit",
  "triple_captain",
] as const;

/** Scenario order: baseline first so the comparison table fills in early. */
export const MEGA_SCENARIOS: { key: string; available: string[] }[] = [
  { key: "none", available: [] },
  { key: "free", available: [...ALL_CHIPS] },
  { key: "only-wildcard", available: ["wildcard"] },
  { key: "only-bench_boost", available: ["bench_boost"] },
  { key: "only-free_hit", available: ["free_hit"] },
  { key: "only-triple_captain", available: ["triple_captain"] },
];

const CHIP_WINDOW_GWS = 6;

export function chipWindow(firstGw: number, horizon: number): number[] {
  const n = Math.min(CHIP_WINDOW_GWS, horizon);
  return Array.from({ length: n }, (_, i) => firstGw + i);
}

export function createMegaRun(
  request: SolveRequest,
  projectionFilename: string,
  firstGw: number,
): MegaRunMeta {
  const horizon = request.horizon ?? 5;
  const window = chipWindow(firstGw, horizon);

  const runs = listRunMetas();
  const scenarios = MEGA_SCENARIOS.map((s) => {
    const childRequest: SolveRequest = {
      ...request,
      // Scenario chip availability replaces any manually forced chips.
      chips: [],
      chipMode:
        s.available.length > 0
          ? { available: s.available, allowedGws: window }
          : null,
    };
    const child: SolveRunMeta = {
      id: newId(),
      status: "queued",
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      request: childRequest,
      projectionFilename,
      totalExpectedPoints: null,
      result: null,
    };
    runs.unshift(child);
    return { key: s.key, runId: child.id };
  });
  saveRunMetas(runs);

  const mega: MegaRunMeta = {
    id: newId(),
    status: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    projectionId: request.projectionId,
    projectionFilename,
    horizon,
    chipWindow: window,
    scenarios,
  };
  const megas = listMegaMetas();
  megas.unshift(mega);
  saveMegaMetas(megas);

  // Fire and forget — progress is recorded on the mega and child runs.
  runMegaSequence(mega.id).catch((err) => {
    logger.error({ err, megaId: mega.id }, "Mega run crashed");
    updateMega(mega.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: `Mega run crashed: ${(err as Error).message}`,
    });
  });

  return mega;
}

function waitForRun(runId: string): Promise<SolveRunMeta | undefined> {
  return new Promise((resolve) => {
    const check = () => {
      const run = listRunMetas().find((r) => r.id === runId);
      if (!run || run.status === "completed" || run.status === "failed") {
        resolve(run);
        return;
      }
      setTimeout(check, 2000);
    };
    check();
  });
}

async function runMegaSequence(megaId: string): Promise<void> {
  updateMega(megaId, { status: "running" });
  const mega = listMegaMetas().find((m) => m.id === megaId);
  if (!mega) return;

  let failed = 0;
  for (const scenario of mega.scenarios) {
    const child = listRunMetas().find((r) => r.id === scenario.runId);
    if (!child) {
      failed++;
      continue;
    }
    await startSolve(child.id, child.request).catch((err) => {
      logger.error({ err, runId: child.id }, "Mega child solve crashed");
    });
    const finished = await waitForRun(child.id);
    if (finished?.status !== "completed") failed++;
  }

  // The comparison is only trustworthy when every scenario solved.
  updateMega(megaId, {
    status: failed === 0 ? "completed" : "failed",
    completedAt: new Date().toISOString(),
    error:
      failed === 0
        ? null
        : `${failed} of ${mega.scenarios.length} chip scenarios failed — the comparison is incomplete`,
  });
}

/** Re-mark megas left in queued/running state (e.g. after a server restart). */
export function failStaleMegas(): void {
  const megas = listMegaMetas();
  let changed = false;
  for (const mega of megas) {
    if (mega.status === "queued" || mega.status === "running") {
      mega.status = "failed";
      mega.error = "Server restarted while the analysis was in progress";
      mega.completedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveMegaMetas(megas);
}
