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
  type SolveRunMeta,
  listProjectionMetas,
  listRunMetas,
  newId,
  saveRunMetas,
} from "../lib/store";

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

router.post("/solves", async (req, res): Promise<void> => {
  const parsed = CreateSolveBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const request = parsed.data;

  const projection = listProjectionMetas().find(
    (m) => m.id === request.projectionId,
  );
  if (!projection) {
    res.status(400).json({ error: "Projection not found" });
    return;
  }
  if (!request.firstGameweek && !request.teamId) {
    res.status(400).json({
      error: "A team ID is required unless optimizing for the first gameweek",
    });
    return;
  }
  const chips = request.chips ?? [];
  const chipNames = chips.map((c) => c.chip);
  if (new Set(chipNames).size !== chipNames.length) {
    res.status(400).json({
      error: "Each chip can only be assigned to one gameweek",
    });
    return;
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
        res.status(400).json({
          error: `Unknown ${label} player(s): ${unknown.join(", ")}. Use names exactly as they appear in the projection (e.g. "Haaland").`,
        });
        return;
      }
      resolved[label] = ids;
    }
  }
  const bannedIds = new Set(resolved.banned);
  const overlap = resolved.locked.filter((id) => bannedIds.has(id));
  if (overlap.length > 0) {
    res.status(400).json({
      error:
        "A player can't be both locked and banned. Remove the conflict and try again.",
    });
    return;
  }

  const k = request.differentialFactor ?? 0;
  if (k < 0 || k > 1) {
    res.status(400).json({
      error: "Differential factor must be between 0% and 100%",
    });
    return;
  }
  if (k > 0 && !projectionHasOwnership(request.projectionId)) {
    res.status(400).json({
      error:
        "This projection has no Ownership column, so a differential factor can't be applied. Re-import predictions from Fantasy Football Hub to get ownership data.",
    });
    return;
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
        res.status(400).json({
          error: `${label} must be a whole number between 0 and 500`,
        });
        return;
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
        res.status(400).json({
          error:
            "This projection has missing or duplicate player IDs, so the pool filter can't be applied. Re-import the projection or run without the filter.",
        });
        return;
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
      res.status(400).json({
        error: `The pool filter leaves too few players to build a legal squad (${short
          .map(([pos, label, need]) => `${byPos[pos]} of ${need} ${label}`)
          .join(", ")}). Increase the per-position counts.`,
      });
      return;
    }
  }

  const run: SolveRunMeta = {
    id: newId(),
    status: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    request,
    projectionFilename: projection.filename,
    totalExpectedPoints: null,
    result: null,
  };
  const runs = listRunMetas();
  runs.unshift(run);
  saveRunMetas(runs);

  // Fire and forget; startSolve records failures on the run itself, and
  // this catch guards the pre-try synchronous window.
  startSolve(run.id, request).catch((err) => {
    logger.error({ err, runId: run.id }, "startSolve crashed");
  });

  res.status(201).json(CreateSolveResponse.parse(run));
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
