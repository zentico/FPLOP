import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import {
  CreateSolveBody,
  CreateSolveResponse,
  DeleteSolveParams,
  GetSolveParams,
  GetSolveResponse,
  ListSolvesResponse,
} from "@workspace/api-zod";
import {
  computePoolStats,
  getRunProgress,
  selectPool,
  projectionHasOwnership,
  resolvePlayerRefs,
  startSolve,
  deleteRunArtifacts,
} from "../lib/solver";
import {
  type MegaRunMeta,
  type SolveRunMeta,
  listMegaMetas,
  listProjectionMetas,
  listRunMetas,
  newId,
  saveMegaMetas,
  saveRunMetas,
} from "../lib/store";
import { ALL_CHIPS, availableChipsFrom, createMegaRun } from "../lib/mega";
import { BlendError, createBlendSnapshot } from "../lib/blend";
import { getGameweekInfo, getTeamChipsPlayed } from "../lib/fpl";

const router: IRouter = Router();

/** History list omits full results to keep payloads small — the contract marks result nullable. */
/**
 * Chips for the history list: actual gameweeks from the solved plan when
 * available, with `optimized: true` for chips whose timing the solver chose
 * ("Any" assignments and chip-analysis scenarios).
 */
function playedChips(
  run: SolveRunMeta,
): { chip: string; gameweek: number; optimized: boolean }[] {
  const anyChips = new Set(
    (run.request.chips ?? [])
      .filter((c) => c.gameweek === 0)
      .map((c) => c.chip),
  );
  const allOptimized = run.request.chipMode != null;
  if (run.status === "completed" && run.result) {
    return run.result.gameweeks
      .filter((g) => g.chip)
      .map((g) => ({
        chip: g.chip as string,
        gameweek: g.gameweek,
        optimized: allOptimized || anyChips.has(g.chip as string),
      }));
  }
  return (run.request.chips ?? []).map((c) => ({
    chip: c.chip,
    gameweek: c.gameweek,
    optimized: c.gameweek === 0,
  }));
}

function summary(run: SolveRunMeta): Record<string, unknown> {
  // Actual plan count when completed; otherwise the requested count.
  const planCount =
    run.status === "completed" && run.result
      ? 1 + (run.result.alternatives?.length ?? 0)
      : (run.request.options?.numIterations ?? 1);
  const projection = listProjectionMetas().find(
    (item) => item.id === run.request.projectionId,
  );
  const startGameweek =
    run.result?.gameweeks[0]?.gameweek ?? projection?.gameweeks[0] ?? null;
  return {
    ...run,
    result: null,
    playedChips: playedChips(run),
    planCount,
    startGameweek,
  };
}

router.get("/solves", async (_req, res): Promise<void> => {
  const runs = [...listRunMetas()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  res.json(ListSolvesResponse.parse(runs.map(summary)));
});

type SolveRequestInput = ReturnType<typeof CreateSolveBody.parse>;

/**
 * When the request blends two or more sources, materialize the blend as an
 * immutable snapshot and rewrite the request to solve against it. The
 * normalized weights stay on the request for provenance, and the horizon is
 * capped at the blend's shared consecutive coverage. A single (or absent)
 * source leaves the request untouched — identical to today's behavior.
 */
function materializeBlendSources(
  request: SolveRequestInput,
): { error: string; status: number } | null {
  const sources = request.sources ?? [];
  if (sources.length === 0) return null;
  if (sources.length === 1) {
    request.projectionId = sources[0]!.projectionId;
    request.sources = undefined;
    return null;
  }
  try {
    const meta = createBlendSnapshot(sources);
    request.projectionId = meta.id;
    request.sources = (meta.components ?? []).map((c) => ({
      projectionId: c.projectionId,
      weight: c.weight,
    }));
    if (request.horizon != null && request.horizon > meta.gameweeks.length) {
      request.horizon = meta.gameweeks.length;
    }
    return null;
  } catch (err) {
    if (err instanceof BlendError) {
      return { error: err.message, status: err.status };
    }
    throw err;
  }
}

/**
 * Full semantic validation shared by the solve and mega-solve endpoints.
 * Returns the projection meta on success, or an error message to send as 400.
 */
function validateSolveRequest(
  request: SolveRequestInput,
): { projection: ReturnType<typeof listProjectionMetas>[number] } | { error: string } {
  const projection = listProjectionMetas().find(
    (m) => m.id === request.projectionId,
  );
  if (!projection) {
    return { error: "Projection not found" };
  }
  if (!request.firstGameweek && !request.teamId) {
    return {
      error: "A team ID is required unless optimizing for the first gameweek",
    };
  }
  const chips = request.chips ?? [];
  const chipNames = chips.map((c) => c.chip);
  if (new Set(chipNames).size !== chipNames.length) {
    return { error: "Each chip can only be assigned to one gameweek" };
  }

  const resolved: Record<"banned" | "locked", number[]> = {
    banned: [],
    locked: [],
  };
  for (const [label, refs] of [
    ["banned", request.options?.banned],
    ["locked", request.options?.locked],
  ] as const) {
    if (refs?.length) {
      const { ids, unknown } = resolvePlayerRefs(request.projectionId, refs);
      if (unknown.length > 0) {
        return {
          error: `Unknown ${label} player(s): ${unknown.join(", ")}. Use names exactly as they appear in the projection (e.g. "Haaland").`,
        };
      }
      resolved[label] = ids;
    }
  }
  const booked = request.options?.bookedTransfers ?? [];
  for (const bt of booked) {
    if (!bt.in && !bt.out) {
      return { error: "Each booked transfer needs a player in, a player out, or both." };
    }
    if (!Number.isInteger(bt.gameweek) || bt.gameweek < 1 || bt.gameweek > 38) {
      return { error: "Booked transfer gameweek must be between 1 and 38." };
    }
    const refs = [bt.in, bt.out].filter(Boolean) as string[];
    const { unknown, ambiguous } = resolvePlayerRefs(request.projectionId, refs);
    if (unknown.length > 0) {
      return {
        error: `Unknown booked-transfer player(s): ${unknown.join(", ")}. Use names exactly as they appear in the projection.`,
      };
    }
    if (ambiguous.length > 0) {
      return {
        error: `Ambiguous booked-transfer player name(s): ${ambiguous.join(", ")} — several players share that name in the projection. Use the player's numeric ID instead.`,
      };
    }
  }
  const bw = request.options?.benchWeights;
  if (bw != null && (bw.length !== 4 || bw.some((w) => !Number.isFinite(w) || w < 0 || w > 1))) {
    return { error: "Bench weights must be four numbers between 0 and 1 (GK, 1st, 2nd, 3rd)." };
  }

  const bannedIds = new Set(resolved.banned);
  const overlap = resolved.locked.filter((id) => bannedIds.has(id));
  if (overlap.length > 0) {
    return {
      error:
        "A player can't be both locked and banned. Remove the conflict and try again.",
    };
  }

  const k = request.differentialFactor ?? 0;
  if (k < 0 || k > 1) {
    return { error: "Differential factor must be between 0% and 100%" };
  }
  if (k > 0 && !projectionHasOwnership(request.projectionId)) {
    return {
      error:
        "This projection has no Ownership column, so a differential factor can't be applied. Re-import predictions from Fantasy Football Hub to get ownership data.",
    };
  }

  const filter = request.poolFilter;
  if (filter) {
    for (const [label, v] of [
      ["Goalkeepers (main)", filter.gkMain],
      ["Goalkeepers (bench)", filter.gkBench],
      ["Defenders (main)", filter.defMain],
      ["Defenders (bench)", filter.defBench],
      ["Midfielders (main)", filter.midMain],
      ["Midfielders (bench)", filter.midBench],
      ["Forwards (main)", filter.fwdMain],
      ["Forwards (bench)", filter.fwdBench],
    ] as const) {
      if (!Number.isInteger(v) || v < 0 || v > 500) {
        return { error: `${label} must be a whole number between 0 and 500` };
      }
    }
    // A legal squad needs 2 GK, 5 DEF, 5 MID, 3 FWD — reject filters that
    // cannot produce one instead of letting the solver fail cryptically.
    // Mirror the effective solver pool exactly: locked players are always
    // kept in the CSV, and banned players can never be picked.
    const lockedIds = new Set(resolved.locked);
    const stats = computePoolStats(request.projectionId);
    // Rank selection is keyed by player id — duplicate or invalid ids
    // would silently collapse selections, so reject them up front.
    const seenIds = new Set<number>();
    for (const p of stats) {
      if (!Number.isFinite(p.id) || p.id <= 0 || seenIds.has(p.id)) {
        return {
          error:
            "This projection has missing or duplicate player IDs, so the pool filter can't be applied. Re-import the projection or run without the filter.",
        };
      }
      seenIds.add(p.id);
    }
    const selected = selectPool(stats, filter);
    const byPos: Record<string, number> = { G: 0, D: 0, M: 0, F: 0 };
    for (const p of stats) {
      if (bannedIds.has(p.id)) continue;
      if (
        (selected.has(p.id) || lockedIds.has(p.id)) &&
        p.position in byPos
      ) {
        byPos[p.position]!++;
      }
    }
    const quotas: [string, string, number][] = [
      ["G", "goalkeepers", 2],
      ["D", "defenders", 5],
      ["M", "midfielders", 5],
      ["F", "forwards", 3],
    ];
    const short = quotas.filter(([pos, , need]) => byPos[pos]! < need);
    if (short.length > 0) {
      return {
        error: `The pool filter leaves too few players to build a legal squad (${short
          .map(([pos, label, need]) => `${byPos[pos]} of ${need} ${label}`)
          .join(", ")}). Increase the per-position counts.`,
      };
    }
  }

  return { projection };
}

router.post("/solves", async (req, res): Promise<void> => {
  const parsed = CreateSolveBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const request = parsed.data;
  const blendError = materializeBlendSources(request);
  if (blendError) {
    res.status(blendError.status).json({ error: blendError.error });
    return;
  }
  const validated = validateSolveRequest(request);
  if ("error" in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const { projection } = validated;

  // Chips assigned gameweek 0 ("Any") need the horizon window so the solver
  // can be forced to play the chip at a week of its own choosing.
  let anyChipGws: number[] | null = null;
  let startGw: number | null = null;
  const hasAnyChip = (request.chips ?? []).some((c) => c.gameweek === 0);
  const bookedGws = (request.options?.bookedTransfers ?? []).map(
    (bt) => bt.gameweek,
  );
  if (hasAnyChip || bookedGws.length > 0) {
    // The solver starts at FPL's next gameweek in both modes (preseason mode
    // also builds the squad at next_gw, not GW 1), so the chip window must too.
    let firstGw: number;
    try {
      firstGw = (await getGameweekInfo()).nextGameweek;
    } catch {
      res.status(400).json({
        error:
          "Could not determine the next gameweek from FPL, which is needed to time chips and booked transfers. Try again or pick a specific gameweek.",
      });
      return;
    }
    startGw = firstGw;
    const horizon = request.horizon ?? 5;
    const lastGw = firstGw + horizon - 1;
    const outside = bookedGws.filter((gw) => gw < firstGw || gw > lastGw);
    if (outside.length > 0) {
      res.status(400).json({
        error: `Booked transfer gameweek(s) ${outside.join(", ")} fall outside this solve's window (GW ${firstGw}-${lastGw}). Adjust the gameweek or extend the horizon.`,
      });
      return;
    }
    if (hasAnyChip) {
      anyChipGws = Array.from({ length: horizon }, (_, i) => firstGw + i);
    }
  }

  const run: SolveRunMeta = {
    id: newId(),
    status: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    request: { ...request, anyChipGws, startGw },
    projectionFilename: projection.filename,
    totalExpectedPoints: null,
    result: null,
  };
  const runs = listRunMetas();
  runs.unshift(run);
  saveRunMetas(runs);

  // Fire and forget; startSolve records failures on the run itself, and
  // this catch guards the pre-try synchronous window.
  startSolve(run.id, run.request).catch((err) => {
    logger.error({ err, runId: run.id }, "startSolve crashed");
  });

  res.status(201).json(CreateSolveResponse.parse(run));
});

/** Assemble a MegaRun response with fresh per-scenario data from child runs. */
function megaView(mega: MegaRunMeta): Record<string, unknown> {
  const runs = listRunMetas();
  const byId = new Map(runs.map((r) => [r.id, r]));
  const baseline = byId.get(
    mega.scenarios.find((s) => s.key === "none")?.runId ?? "",
  );
  const basePts =
    baseline?.status === "completed" ? (baseline.totalExpectedPoints ?? null) : null;
  return {
    ...mega,
    scenarios: mega.scenarios.map((s) => {
      const run = byId.get(s.runId);
      const pts =
        run?.status === "completed" ? (run.totalExpectedPoints ?? null) : null;
      const basePts2 =
        run?.status === "completed"
          ? (run.totalBaseExpectedPoints ?? null)
          : null;
      const chips =
        run?.result?.gameweeks
          ?.filter((g) => g.chip)
          .map((g) => ({ chip: g.chip as string, gameweek: g.gameweek })) ?? [];
      return {
        key: s.key,
        runId: s.runId,
        status: run?.status ?? "failed",
        totalExpectedPoints: pts,
        totalBaseExpectedPoints: basePts2,
        deltaVsBaseline: pts != null && basePts != null ? pts - basePts : null,
        chips,
        progress:
          run?.status === "running"
            ? getRunProgress(run.id, run.request.options?.numIterations ?? 1)
            : null,
        finalGapPercent:
          run?.status === "completed" ? (run.finalGapPercent ?? null) : null,
      };
    }),
  };
}

router.get("/solves/mega", async (_req, res): Promise<void> => {
  const megas = [...listMegaMetas()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  res.json(megas.map(megaView));
});

router.post("/solves/mega", async (req, res): Promise<void> => {
  const parsed = CreateSolveBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const request = parsed.data;
  const blendError = materializeBlendSources(request);
  if (blendError) {
    res.status(blendError.status).json({ error: blendError.error });
    return;
  }
  const validated = validateSolveRequest(request);
  if ("error" in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const { projection } = validated;
  let firstGw: number;
  try {
    firstGw = (await getGameweekInfo()).nextGameweek;
  } catch {
    // Fall back to the earliest gameweek the projection covers.
    firstGw = projection.gameweeks[0] ?? 1;
  }
  // After the first gameweek, only analyze chips the team can still play.
  let availableChips: string[] = [...ALL_CHIPS];
  if (!request.firstGameweek && request.teamId) {
    try {
      availableChips = availableChipsFrom(
        await getTeamChipsPlayed(request.teamId),
        firstGw,
      );
    } catch {
      // FPL history unavailable — assume all chips are still in hand.
    }
  }
  if (availableChips.length === 0) {
    res.status(400).json({
      error:
        "This team has already played all of its chips, so there is nothing to compare.",
    });
    return;
  }
  const mega = createMegaRun(request, projection.filename, firstGw, availableChips);
  res.status(201).json(megaView(mega));
});

router.get("/solves/mega/:id", async (req, res): Promise<void> => {
  const mega = listMegaMetas().find((m) => m.id === req.params.id);
  if (!mega) {
    res.status(404).json({ error: "Analysis not found" });
    return;
  }
  res.json(megaView(mega));
});

router.delete("/solves/mega/:id", async (req, res): Promise<void> => {
  const megas = listMegaMetas();
  const idx = megas.findIndex((m) => m.id === req.params.id);
  if (idx === -1) {
    res.status(404).json({ error: "Analysis not found" });
    return;
  }
  const childIds = new Set(megas[idx]!.scenarios.map((s) => s.runId));
  for (const run of listRunMetas()) {
    if (childIds.has(run.id)) deleteRunArtifacts(run);
  }
  megas.splice(idx, 1);
  saveMegaMetas(megas);
  saveRunMetas(listRunMetas().filter((r) => !childIds.has(r.id)));
  res.sendStatus(204);
});

router.get("/solves/:id", async (req, res): Promise<void> => {
  const params = GetSolveParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const run = listRunMetas().find((r) => r.id === params.data.id);
  if (!run) {
    res.status(404).json({ error: "Solve run not found" });
    return;
  }
  const progress =
    run.status === "running" || run.status === "queued"
      ? getRunProgress(run.id, run.request.options?.numIterations ?? 1)
      : null;
  res.json(GetSolveResponse.parse({ ...run, progress }));
});

router.delete("/solves", async (_req, res): Promise<void> => {
  // Delete all historical runs and chip analyses, keeping anything still active.
  const active = (s: string) => s === "running" || s === "queued";
  const megas = listMegaMetas();
  const keptMegas = megas.filter((m) => active(m.status));
  const keptChildIds = new Set(
    keptMegas.flatMap((m) => m.scenarios.map((s) => s.runId)),
  );
  for (const run of listRunMetas()) {
    if (!active(run.status) && !keptChildIds.has(run.id)) {
      deleteRunArtifacts(run);
    }
  }
  saveMegaMetas(keptMegas);
  saveRunMetas(
    listRunMetas().filter((r) => active(r.status) || keptChildIds.has(r.id)),
  );
  res.sendStatus(204);
});

router.delete("/solves/:id", async (req, res): Promise<void> => {
  const params = DeleteSolveParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const runs = listRunMetas();
  const idx = runs.findIndex((r) => r.id === params.data.id);
  if (idx === -1) {
    res.status(404).json({ error: "Solve run not found" });
    return;
  }
  deleteRunArtifacts(runs[idx]!);
  runs.splice(idx, 1);
  saveRunMetas(runs);
  res.sendStatus(204);
});

export default router;
