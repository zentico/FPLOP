import fs from "node:fs";
import { Router, type IRouter } from "express";
import {
  DeleteProjectionParams,
  GetFfhSessionStatusResponse,
  GetProjectionPlayersParams,
  GetProjectionPlayersResponse,
  UpdateFfhSessionBody,
  UpdateFfhSessionResponse,
  ImportProjectionBody,
  ImportProjectionResponse,
  ListProjectionsResponse,
  UploadProjectionBody,
  UploadProjectionResponse,
} from "@workspace/api-zod";
import { parseCsv } from "../lib/csv";
import {
  FfhSessionError,
  FfhUpstreamError,
  fetchAccessToken,
  getStoredCookie,
  importFfhProjection,
  normalizeCookie,
  saveCookie,
} from "../lib/ffh";
import { getGameweekInfo } from "../lib/fpl";
import { projectionCsvPath } from "../lib/solver";
import {
  listProjectionMetas,
  newId,
  saveProjectionMetas,
} from "../lib/store";

const router: IRouter = Router();

const POS_MAP: Record<string, string> = {
  G: "G",
  GK: "G",
  GKP: "G",
  D: "D",
  DEF: "D",
  M: "M",
  MID: "M",
  F: "F",
  FWD: "F",
};

router.get("/projections", async (_req, res): Promise<void> => {
  res.json(ListProjectionsResponse.parse(listProjectionMetas()));
});

router.post("/projections", async (req, res): Promise<void> => {
  const parsed = UploadProjectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { filename, content } = parsed.data;

  const rows = parseCsv(content);
  if (rows.length === 0) {
    res.status(400).json({ error: "CSV file contains no data rows" });
    return;
  }
  const header = Object.keys(rows[0]!);
  const gameweeks = header
    .map((h) => /^(\d+)_Pts$/.exec(h)?.[1])
    .filter((g): g is string => g != null)
    .map(Number)
    .sort((a, b) => a - b);
  if (gameweeks.length === 0) {
    res.status(400).json({
      error:
        'No per-gameweek points columns found. The CSV needs columns like "1_Pts", "2_Pts" (and matching "N_xMins").',
    });
    return;
  }
  if (!header.some((h) => ["ID", "Id", "id"].includes(h))) {
    res.status(400).json({
      error:
        'The CSV needs an "ID" column with official FPL player ids so players can be matched.',
    });
    return;
  }

  const id = newId();
  fs.writeFileSync(projectionCsvPath(id), content);

  const meta = {
    id,
    filename,
    uploadedAt: new Date().toISOString(),
    playerCount: rows.length,
    gameweeks,
  };
  const metas = listProjectionMetas();
  metas.unshift(meta);
  saveProjectionMetas(metas);

  res.status(201).json(UploadProjectionResponse.parse(meta));
});

router.get("/settings/ffh-session", async (_req, res): Promise<void> => {
  res.json(
    GetFfhSessionStatusResponse.parse({ configured: getStoredCookie() != null }),
  );
});

router.post("/settings/ffh-session", async (req, res): Promise<void> => {
  const parsed = UpdateFfhSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const cookie = normalizeCookie(parsed.data.cookie);
  if (!cookie) {
    res.status(400).json({ error: "The cookie value is empty." });
    return;
  }
  try {
    await fetchAccessToken(cookie);
  } catch (err) {
    if (err instanceof FfhSessionError) {
      res.status(400).json({
        error:
          "Fantasy Football Hub rejected this cookie. Make sure you are logged in and copied the full appSession value (all parts).",
      });
    } else {
      res.status(502).json({ error: "Fantasy Football Hub could not be reached. Try again shortly." });
    }
    return;
  }
  saveCookie(cookie);
  res.json(UpdateFfhSessionResponse.parse({ configured: true }));
});

router.post("/projections/import", async (req, res): Promise<void> => {
  const parsed = ImportProjectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.source !== "ffh") {
    res.status(400).json({ error: `Unknown source "${parsed.data.source}"` });
    return;
  }
  const span = Math.min(Math.max(parsed.data.maxGameweeks ?? 10, 1), 38);
  try {
    const { nextGameweek } = await getGameweekInfo();
    const minGw = nextGameweek;
    const maxGw = Math.min(minGw + span - 1, 38);
    const meta = await importFfhProjection(minGw, maxGw);
    res.status(201).json(ImportProjectionResponse.parse(meta));
  } catch (err) {
    if (err instanceof FfhSessionError) {
      res.status(401).json({ error: err.message });
    } else if (err instanceof FfhUpstreamError) {
      res.status(502).json({ error: err.message });
    } else {
      res.status(502).json({
        error: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
});

router.delete("/projections/:id", async (req, res): Promise<void> => {
  const params = DeleteProjectionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const metas = listProjectionMetas();
  const idx = metas.findIndex((m) => m.id === params.data.id);
  if (idx === -1) {
    res.status(404).json({ error: "Projection not found" });
    return;
  }
  metas.splice(idx, 1);
  saveProjectionMetas(metas);
  fs.rmSync(projectionCsvPath(params.data.id), { force: true });
  res.sendStatus(204);
});

router.get("/projections/:id/players", async (req, res): Promise<void> => {
  const params = GetProjectionPlayersParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const meta = listProjectionMetas().find((m) => m.id === params.data.id);
  if (!meta) {
    res.status(404).json({ error: "Projection not found" });
    return;
  }

  const rows = parseCsv(
    fs.readFileSync(projectionCsvPath(params.data.id), "utf-8"),
  );
  const first = rows[0] ?? {};
  const priceCol = ["Value", "Price", "BV", "SV", "Cost"].find(
    (c) => c in first,
  );
  const nameCol = ["Name", "name", "Player"].find((c) => c in first) ?? "Name";
  const teamCol = ["Team", "team"].find((c) => c in first) ?? "Team";
  const posCol = ["Pos", "Position", "pos"].find((c) => c in first) ?? "Pos";

  const players = rows
    .map((r) => {
      const pointsPerGameweek = meta.gameweeks.map((gw) => ({
        gameweek: gw,
        points: Number(r[`${gw}_Pts`]) || 0,
      }));
      return {
        name: r[nameCol] ?? "",
        team: r[teamCol] ?? "",
        position: POS_MAP[(r[posCol] ?? "").toUpperCase()] ?? "?",
        price: priceCol ? Number(r[priceCol]) || 0 : 0,
        totalPoints:
          Math.round(
            pointsPerGameweek.reduce((s, p) => s + p.points, 0) * 100,
          ) / 100,
        pointsPerGameweek,
      };
    })
    .filter((p) => p.name)
    .sort((a, b) => b.totalPoints - a.totalPoints)
    .slice(0, 25);

  res.json(GetProjectionPlayersResponse.parse(players));
});

export default router;
