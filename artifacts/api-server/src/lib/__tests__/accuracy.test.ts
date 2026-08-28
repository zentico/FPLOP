import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the persistent store at a temp dir before any lib module loads.
process.env.FPLOP_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "fplop-test-store-"),
);

const {
  computeMetrics,
  readPredictions,
  selectSnapshots,
  sourceKeyOf,
  sourceLabelOf,
} = await import("../accuracy");
const { parseDraftHoundPayload, mapDraftHoundPlayers, DraftHoundUpstreamError } =
  await import("../drafthound");
const { buildCanonicalCsv } = await import("../projections");
const { listResultArchives } = await import("../results");
const { RESULTS_DIR } = await import("../paths");

const meta = (over: Record<string, unknown>) => ({
  id: "x",
  filename: "f",
  uploadedAt: "2026-08-20T10:00:00Z",
  playerCount: 1,
  gameweeks: [2, 3],
  ...over,
});

describe("selectSnapshots", () => {
  const deadline = "2026-08-22T17:30:00Z";

  it("picks the latest pre-deadline snapshot per source", () => {
    const metas = [
      meta({ id: "old", source: "ffh", uploadedAt: "2026-08-20T10:00:00Z" }),
      meta({ id: "new", source: "ffh", uploadedAt: "2026-08-22T10:00:00Z" }),
      meta({ id: "dh", source: "drafthound", uploadedAt: "2026-08-21T10:00:00Z" }),
    ];
    const best = selectSnapshots(metas as never, 2, deadline);
    expect(best.get("ffh")?.id).toBe("new");
    expect(best.get("drafthound")?.id).toBe("dh");
  });

  it("excludes snapshots at or after the deadline (no hindsight)", () => {
    const metas = [
      meta({ id: "late", source: "ffh", uploadedAt: "2026-08-22T17:30:00Z" }),
      meta({ id: "later", source: "ffh", uploadedAt: "2026-08-23T09:00:00Z" }),
    ];
    expect(selectSnapshots(metas as never, 2, deadline).size).toBe(0);
  });

  it("excludes snapshots that do not cover the gameweek", () => {
    const metas = [meta({ id: "a", source: "ffh", gameweeks: [5, 6] })];
    expect(selectSnapshots(metas as never, 2, deadline).size).toBe(0);
  });

  it("excludes snapshots from a different season", () => {
    const metas = [
      meta({ id: "old-season", source: "ffh", season: "2025/26" }),
      meta({ id: "this-season", source: "drafthound", season: "2026/27" }),
      meta({ id: "legacy-no-season", source: "upload" }),
    ];
    const best = selectSnapshots(metas as never, 2, deadline, "2026/27");
    expect(best.get("ffh")).toBeUndefined();
    expect(best.get("drafthound")?.id).toBe("this-season");
    expect(best.get("upload")?.id).toBe("legacy-no-season");
  });

  it("treats legacy metas without a source as uploads", () => {
    const m = meta({ id: "legacy" });
    expect(sourceKeyOf(m as never)).toBe("upload");
    expect(sourceLabelOf(m as never)).toBe("Manual upload");
    const best = selectSnapshots([m] as never, 2, deadline);
    expect(best.get("upload")?.id).toBe("legacy");
  });
});

describe("readPredictions", () => {
  const csv =
    "ID,Name,Pos,Team,Value,Ownership,2_Pts,2_xMins,3_Pts,3_xMins\n" +
    '411,Haaland,F,MCI,15.5,67.9,6.71,90,7.04,90\n' +
    'bad,NoId,F,MCI,5,0,1.00,90,1.00,90\n' +
    "328,Salah,M,LIV,14.5,55,5.50,90,6.00,90\n";

  it("reads one gameweek's points keyed by FPL id", () => {
    const rows = readPredictions(csv, 3);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ playerId: 411, name: "Haaland", points: 7.04 });
  });

  it("returns nothing for uncovered gameweeks", () => {
    expect(readPredictions(csv, 9)).toHaveLength(0);
  });

  it("skips blank point cells instead of treating them as 0", () => {
    const partial =
      "ID,Name,Pos,Team,Value,Ownership,2_Pts\n411,Haaland,F,MCI,15.5,67.9,\n328,Salah,M,LIV,14.5,55,5.5\n";
    const rows = readPredictions(partial, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.playerId).toBe(328);
  });
});

describe("computeMetrics", () => {
  it("computes MAE, RMSE, bias and correlation over matched players only", () => {
    const preds = [
      { playerId: 1, name: "A", team: "T", position: "M", points: 5 },
      { playerId: 2, name: "B", team: "T", position: "F", points: 3 },
      { playerId: 3, name: "C", team: "T", position: "D", points: 8 }, // unmatched
    ];
    const actuals = [
      { id: 1, points: 7, minutes: 90 },
      { id: 2, points: 2, minutes: 0 }, // matched but did not play
      { id: 99, points: 12, minutes: 90 }, // not predicted
    ];
    const m = computeMetrics(preds, actuals)!;
    expect(m.sampleSize).toBe(2);
    expect(m.matchedPlayed).toBe(1); // only players with minutes > 0 count for coverage
    expect(m.mae).toBeCloseTo(1.5); // |−2| and |+1|
    expect(m.rmse).toBeCloseTo(Math.sqrt((4 + 1) / 2));
    expect(m.bias).toBeCloseTo(-0.5);
    expect(m.correlation).toBeCloseTo(1); // (5,7),(3,2) — perfectly ordered
    expect(m.misses[0]!.playerId).toBe(1); // biggest absolute error first
  });

  it("returns null when no players match", () => {
    expect(
      computeMetrics(
        [{ playerId: 1, name: "A", team: "T", position: "M", points: 5 }],
        [{ id: 2, points: 3 }],
      ),
    ).toBeNull();
  });

  it("returns null correlation when predictions are constant", () => {
    const m = computeMetrics(
      [
        { playerId: 1, name: "A", team: "T", position: "M", points: 4 },
        { playerId: 2, name: "B", team: "T", position: "M", points: 4 },
      ],
      [
        { id: 1, points: 2 },
        { id: 2, points: 9 },
      ],
    )!;
    expect(m.correlation).toBeNull();
  });
});

describe("DraftHound adapter", () => {
  const validPlayer = (id: number) => ({
    id,
    name: `P${id}`,
    teamAbbr: "MCI",
    positionAbbr: "FWD",
    price: 10,
    selectedBy: 20,
    gameweeks: [
      { id: 2, xPoints: 5.1, xMinutes: 90 },
      { id: 3, xPoints: 4.2, xMinutes: 80 },
    ],
  });
  const validPayload = {
    updatedAt: "2026-08-28T11:30:52.234Z",
    data: Array.from({ length: 150 }, (_, i) => validPlayer(i + 1)),
  };

  it("accepts a valid payload and maps to canonical rows", () => {
    const { players, updatedAt } = parseDraftHoundPayload(validPayload);
    expect(updatedAt).toBe(validPayload.updatedAt);
    const { rows, gameweeks } = mapDraftHoundPlayers(players);
    expect(gameweeks).toEqual([2, 3]);
    expect(rows[0]).toMatchObject({ fplId: 1, position: "F", team: "MCI" });
    const csv = buildCanonicalCsv(rows, gameweeks);
    expect(csv.split("\n")[0]).toBe(
      "ID,Name,Pos,Team,Value,Ownership,2_Pts,2_xMins,3_Pts,3_xMins",
    );
    const parsed = readPredictions(csv, 2);
    expect(parsed[0]!.points).toBeCloseTo(5.1);
  });

  it("rejects payloads without a data array", () => {
    expect(() => parseDraftHoundPayload({ foo: 1 })).toThrow(DraftHoundUpstreamError);
  });

  it("rejects players with missing fields (schema drift)", () => {
    const bad = {
      ...validPayload,
      data: [...validPayload.data, { id: "nope", name: "X" }],
    };
    expect(() => parseDraftHoundPayload(bad)).toThrow(DraftHoundUpstreamError);
  });

  it("rejects unknown positions", () => {
    const { players } = parseDraftHoundPayload(validPayload);
    players[0]!.positionAbbr = "WTF";
    expect(() => mapDraftHoundPlayers(players)).toThrow(DraftHoundUpstreamError);
  });

  it("rejects suspiciously small player lists", () => {
    expect(() =>
      parseDraftHoundPayload({ data: [validPlayer(1)], updatedAt: null }),
    ).toThrow(DraftHoundUpstreamError);
  });
});

describe("result archive listing", () => {
  beforeAll(() => {
    const dir = path.join(RESULTS_DIR, "2026-27");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "gw1.json"),
      JSON.stringify({
        season: "2026/27",
        gameweek: 1,
        deadline: "2026-08-15T17:30:00Z",
        fetchedAt: "2026-08-18T00:00:00Z",
        players: [{ id: 411, points: 13, minutes: 90 }],
      }),
    );
    fs.writeFileSync(path.join(dir, "gw2.json"), "{corrupt");
  });

  it("lists valid archives and skips corrupt files", () => {
    const archives = listResultArchives();
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatchObject({ gameweek: 1, season: "2026/27" });
  });
});
