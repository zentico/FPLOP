import fs from "node:fs";
import { Router, type IRouter } from "express";
import {
  PreviewProjectionBlendBody,
  PreviewProjectionBlendResponse,
  DeleteProjectionParams,
  GetFfhSessionStatusResponse,
  GetProjectionPlayersParams,
  GetProjectionPlayersResponse,
  GetProjectionPoolStatsParams,
  GetProjectionPoolStatsResponse,
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
import {
  DraftHoundUpstreamError,
  importDraftHoundProjection,
} from "../lib/drafthound";
import {
  PunditUpstreamError,
  importPunditFfhHybrid,
  importPunditProjection,
} from "../lib/pundit";
import {
  FantaLensUpstreamError,
  importFantaLensProjection,
} from "../lib/fantalens";
import { getGameweekInfo, getSeasonName } from "../lib/fpl";
import { BlendError, buildBlend } from "../lib/blend";
import { saveProjectionSnapshot } from "../lib/projections";
import { computePoolStats, projectionCsvPath } from "../lib/solver";
import { listProjectionMetas, saveProjectionMetas } from "../lib/store";

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

  let season: string | null = null;
  try {
    season = await getSeasonName();
  } catch {
    // Season labelling is best-effort.
  }
  const meta = saveProjectionSnapshot({
    filename,
    csv: content,
    playerCount: rows.length,
    gameweeks,
    source: "upload",
    sourceLabel: "Manual upload",
    season,
  });

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
  const KNOWN_SOURCES = ["ffh", "drafthound", "pundit", "pundit-ffh", "fantalens"];
  if (!KNOWN_SOURCES.includes(parsed.data.source)) {
    res.status(400).json({ error: `Unknown source "${parsed.data.source}"` });
    return;
  }
  const span = Math.min(Math.max(parsed.data.maxGameweeks ?? 10, 1), 38);
  try {
    let meta;
    if (parsed.data.source === "drafthound") {
      meta = await importDraftHoundProjection();
    } else if (parsed.data.source === "pundit") {
      meta = await importPunditProjection();
    } else if (parsed.data.source === "pundit-ffh") {
      meta = await importPunditFfhHybrid();
    } else if (parsed.data.source === "fantalens") {
      meta = await importFantaLensProjection();
    } else {
      const { nextGameweek } = await getGameweekInfo();
      const minGw = nextGameweek;
      const maxGw = Math.min(minGw + span - 1, 38);
      meta = await importFfhProjection(minGw, maxGw);
    }
    res.status(201).json(ImportProjectionResponse.parse(meta));
  } catch (err) {
    if (err instanceof FfhSessionError) {
      res.status(401).json({ error: err.message });
    } else if (
      err instanceof FfhUpstreamError ||
      err instanceof DraftHoundUpstreamError ||
      err instanceof PunditUpstreamError ||
      err instanceof FantaLensUpstreamError
    ) {
      res.status(502).json({ error: err.message });
    } else {
      res.status(502).json({
        error: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
});

router.post("/projections/blend/preview", async (req, res): Promise<void> => {
  const parsed = PreviewProjectionBlendBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const blend = buildBlend(parsed.data.sources);
    const round2 = (x: number) => Math.round(x * 100) / 100;
    const players = blend.rows
      .map((r) => {
        const pointsPerGameweek = blend.gameweeks.map((gw) => ({
          gameweek: gw,
          points: r.byGameweek.get(gw)?.points ?? 0,
        }));
        return {
          name: r.name,
          team: r.team,
          position: r.position,
          price: r.price,
          totalPoints: round2(
            pointsPerGameweek.reduce((s, p) => s + p.points, 0),
          ),
          pointsPerGameweek,
        };
      })
      .filter((p) => p.name)
      .sort((a, b) => b.totalPoints - a.totalPoints)
      .slice(0, 25);
    const poolStats = blend.rows
      .map((r) => {
        const gwPoints = blend.gameweeks.map(
          (gw) => r.byGameweek.get(gw)?.points ?? 0,
        );
        return {
          id: r.fplId,
          name: r.name,
          position: r.position,
          team: r.team,
          price: r.price,
          ppm:
            gwPoints.length > 0
              ? gwPoints.reduce((s, p) => s + p, 0) / gwPoints.length
              : 0,
          gwPoints,
        };
      })
      .filter((p) => p.name);
    res.json(
      PreviewProjectionBlendResponse.parse({
        gameweeks: blend.gameweeks,
        playerCount: blend.rows.length,
        hasOwnership: blend.hasOwnership,
        components: blend.components.map((c) => ({
          projectionId: c.projectionId,
          filename: c.filename,
          weight: c.weight,
        })),
        players,
        poolStats,
      }),
    );
  } catch (err) {
    if (err instanceof BlendError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
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

router.get("/projections/:id/csv", async (req, res): Promise<void> => {
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
  const filePath = projectionCsvPath(params.data.id);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Projection file is missing" });
    return;
  }
  const downloadName = meta.filename.toLowerCase().endsWith(".csv")
    ? meta.filename
    : `${meta.filename}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${downloadName.replace(/[^\w.\- ]/g, "_")}"`,
  );
  fs.createReadStream(filePath).pipe(res);
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

router.get("/projections/:id/pool-stats", async (req, res): Promise<void> => {
  const params = GetProjectionPoolStatsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const meta = listProjectionMetas().find((m) => m.id === params.data.id);
  if (!meta) {
    res.status(404).json({ error: "Projection not found" });
    return;
  }
  res.json(GetProjectionPoolStatsResponse.parse(computePoolStats(params.data.id)));
});

export default router;
