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
import { getGameweekInfo, getTeamChipsPlayed } from "../lib/fpl";

const router: IRouter = Router();

/** History list omits full results to keep payloads small — the contract marks result nullable. */
function summary(run: SolveRunMeta): SolveRunMeta {
  return { ...run, result: null };
}

router.get("/solves", async (_req, res): Promise<void> => {
  const runs = [...listRunMetas()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  res.json(ListSolvesResponse.parse(runs.map(summary)));
});

type SolveRequestInput = ReturnType<typeof CreateSolveBody.parse>;

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
  const validated = validateSolveRequest(request);
  if ("error" in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const { projection } = validated;

  // Chips assigned gameweek 0 ("Any") need the horizon window so the solver
  // can be forced to play the chip at a week of its own choosing.
  let anyChipGws: number[] | null = null;
  if ((request.chips ?? []).some((c) => c.gameweek === 0)) {
    let firstGw = 1;
    if (!request.firstGameweek) {
      try {
        firstGw = (await getGameweekInfo()).nextGameweek;
      } catch {
        res.status(400).json({
          error:
            'Could not determine the next gameweek from FPL, which is needed for "Any" chip timing. Try again or pick a specific gameweek.',
        });
        return;
      }
    }
    const horizon = request.horizon ?? 5;
    anyChipGws = Array.from({ length: horizon }, (_, i) => firstGw + i);
  }

  const run: SolveRunMeta = {
    id: newId(),
    status: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    request: { ...request, anyChipGws },
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
      const chips =
        run?.result?.gameweeks
          ?.filter((g) => g.chip)
          .map((g) => ({ chip: g.chip as string, gameweek: g.gameweek })) ?? [];
      return {
        key: s.key,
        runId: s.runId,
        status: run?.status ?? "failed",
        totalExpectedPoints: pts,
        deltaVsBaseline: pts != null && basePts != null ? pts - basePts : null,
        chips,
        progress: run?.status === "running" ? getRunProgress(run.id) : null,
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
      ? getRunProgress(run.id)
      : null;
  res.json(GetSolveResponse.parse({ ...run, progress }));
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
  runs.splice(idx, 1);
  saveRunMetas(runs);
  res.sendStatus(204);
});

export default router;
