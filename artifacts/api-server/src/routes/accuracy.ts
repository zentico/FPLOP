import { Router, type IRouter } from "express";
import {
  GetAccuracyResponse,
  GetAccuracyDetailParams,
  GetAccuracyDetailResponse,
  ListResultsResponse,
  RefreshResultsResponse,
} from "@workspace/api-zod";
import { computeAccuracy, computeAccuracyDetail } from "../lib/accuracy";
import { listResultArchives, refreshResults } from "../lib/results";
import { listProjectionMetas } from "../lib/store";

const router: IRouter = Router();

router.get("/results", async (_req, res): Promise<void> => {
  res.json(
    ListResultsResponse.parse(
      listResultArchives().map((a) => ({
        season: a.season,
        gameweek: a.gameweek,
        deadline: a.deadline,
        fetchedAt: a.fetchedAt,
        playerCount: a.players.length,
      })),
    ),
  );
});

router.post("/results/refresh", async (_req, res): Promise<void> => {
  try {
    const out = await refreshResults();
    res.json(RefreshResultsResponse.parse(out));
  } catch (err) {
    res.status(502).json({
      error: `Could not fetch official FPL results: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

router.get("/accuracy", async (_req, res): Promise<void> => {
  res.json(GetAccuracyResponse.parse(computeAccuracy()));
});

router.get(
  "/accuracy/:projectionId/detail/:gameweek",
  async (req, res): Promise<void> => {
    const params = GetAccuracyDetailParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const meta = listProjectionMetas().find(
      (m) => m.id === params.data.projectionId,
    );
    if (!meta) {
      res.status(404).json({ error: "Projection not found" });
      return;
    }
    const detail = computeAccuracyDetail(
      params.data.projectionId,
      Number(params.data.gameweek),
    );
    if (detail == null) {
      res.status(404).json({
        error: "No archived official results for that gameweek",
      });
      return;
    }
    res.json(GetAccuracyDetailResponse.parse(detail));
  },
);

export default router;
