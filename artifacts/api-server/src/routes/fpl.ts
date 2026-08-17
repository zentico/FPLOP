import { Router, type IRouter } from "express";
import {
  GetFplTeamParams,
  GetFplTeamResponse,
  GetGameweekInfoResponse,
  ListFixturesResponse,
} from "@workspace/api-zod";
import { getFixtures, getFplTeam, getGameweekInfo } from "../lib/fpl";

const router: IRouter = Router();

router.get("/fixtures", async (_req, res): Promise<void> => {
  try {
    res.json(ListFixturesResponse.parse(await getFixtures()));
  } catch (err) {
    res.status(502).json({
      error: `Could not load fixtures from the FPL API: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

router.get("/fpl/gameweek", async (_req, res): Promise<void> => {
  const info = await getGameweekInfo();
  res.json(GetGameweekInfoResponse.parse(info));
});

router.get("/fpl/team/:teamId", async (req, res): Promise<void> => {
  const params = GetFplTeamParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const team = await getFplTeam(params.data.teamId);
    res.json(GetFplTeamResponse.parse(team));
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      res.status(404).json({ error: "FPL team not found — check the team ID" });
      return;
    }
    throw err;
  }
});

export default router;
