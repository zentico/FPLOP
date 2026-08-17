import { Router, type IRouter } from "express";
import {
  CreateSolveBody,
  CreateSolveResponse,
  DeleteSolveParams,
  GetSolveParams,
  GetSolveResponse,
  ListSolvesResponse,
} from "@workspace/api-zod";
import { startSolve } from "../lib/solver";
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

  startSolve(run.id, request);

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
  res.json(GetSolveResponse.parse(run));
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
