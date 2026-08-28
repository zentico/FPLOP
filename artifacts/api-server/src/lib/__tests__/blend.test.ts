import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the persistent store at a temp dir before any lib module loads.
process.env.FPLOP_STORE_DIR ??= fs.mkdtempSync(
  path.join(os.tmpdir(), "fplop-test-store-"),
);

const {
  BlendError,
  blendCsv,
  blendRows,
  buildBlend,
  createBlendSnapshot,
  normalizeBlendWeights,
  parseComponentCsv,
  sharedConsecutiveGameweeks,
} = await import("../blend");
const {
  buildCanonicalCsv,
  importedProjectionFilename,
  normalizeImportedProjectionFilename,
  saveProjectionSnapshot,
} = await import(
  "../projections"
);
const { listProjectionMetas } = await import("../store");
const { projectionCsvPath } = await import("../solver");
const { parseCsv } = await import("../csv");

describe("normalizeBlendWeights", () => {
  it("normalizes non-negative weights to sum to 1", () => {
    const out = normalizeBlendWeights([
      { projectionId: "a", weight: 3 },
      { projectionId: "b", weight: 1 },
    ]);
    expect(out).toEqual([
      { projectionId: "a", weight: 0.75 },
      { projectionId: "b", weight: 0.25 },
    ]);
  });

  it("allows zero weights as long as one is positive", () => {
    const out = normalizeBlendWeights([
      { projectionId: "a", weight: 0 },
      { projectionId: "b", weight: 2 },
    ]);
    expect(out.map((s) => s.weight)).toEqual([0, 1]);
  });

  it("rejects all-zero weights", () => {
    expect(() =>
      normalizeBlendWeights([
        { projectionId: "a", weight: 0 },
        { projectionId: "b", weight: 0 },
      ]),
    ).toThrow(/at least one/i);
  });

  it("rejects negative and non-finite weights", () => {
    expect(() =>
      normalizeBlendWeights([{ projectionId: "a", weight: -1 }]),
    ).toThrow(/non-negative/i);
    expect(() =>
      normalizeBlendWeights([{ projectionId: "a", weight: NaN }]),
    ).toThrow(/non-negative/i);
  });

  it("rejects duplicates and empty selections", () => {
    expect(() =>
      normalizeBlendWeights([
        { projectionId: "a", weight: 1 },
        { projectionId: "a", weight: 1 },
      ]),
    ).toThrow(/once/i);
    expect(() => normalizeBlendWeights([])).toThrow(/at least one/i);
  });
});

describe("importedProjectionFilename", () => {
  it("uses the compact naming convention for every source", () => {
    expect(
      importedProjectionFilename(
        "DraftHound",
        "2026-08-28T16:00:00.000Z",
        2,
        6,
      ),
    ).toBe("DraftHound 26-08-28 (GW2-6)");
    expect(
      importedProjectionFilename("Pundit", new Date("2026-08-28T16:00:00Z"), 2, 7),
    ).toBe("Pundit 26-08-28 (GW2-7)");
  });

  it("normalizes legacy source names used inside blend titles", () => {
    expect(
      normalizeImportedProjectionFilename(
        "DraftHound predictions 2026-08-28 (GW2-6)",
      ),
    ).toBe("DraftHound 26-08-28 (GW2-6)");
    expect(
      normalizeImportedProjectionFilename(
        "Pundit predictions 2026-08-28 (GW2-7)",
      ),
    ).toBe("Pundit 26-08-28 (GW2-7)");
  });
});

describe("sharedConsecutiveGameweeks", () => {
  it("intersects and keeps only the consecutive run from the earliest shared gw", () => {
    expect(
      sharedConsecutiveGameweeks([
        [3, 4, 5, 6, 8],
        [4, 5, 6, 7, 8],
      ]),
    ).toEqual([4, 5, 6]);
  });

  it("returns empty for no overlap", () => {
    expect(sharedConsecutiveGameweeks([[1, 2], [3, 4]])).toEqual([]);
  });

  it("single list passes through its consecutive run", () => {
    expect(sharedConsecutiveGameweeks([[2, 3, 4]])).toEqual([2, 3, 4]);
  });
});

const csvOf = (
  rows: {
    id: number;
    name: string;
    pts: Record<number, number>;
    mins?: Record<number, number>;
    ownership?: number;
    price?: number;
    team?: string;
    pos?: string;
  }[],
  gws: number[],
  withOwnership = true,
) => {
  const header = [
    "ID",
    "Name",
    "Pos",
    "Team",
    "Value",
    ...(withOwnership ? ["Ownership"] : []),
    ...gws.flatMap((g) => [`${g}_Pts`, `${g}_xMins`]),
  ];
  const lines = rows.map((r) =>
    [
      r.id,
      r.name,
      r.pos ?? "M",
      r.team ?? "ARS",
      r.price ?? 5,
      ...(withOwnership ? [r.ownership ?? 10] : []),
      ...gws.flatMap((g) => [r.pts[g] ?? 0, r.mins?.[g] ?? 90]),
    ].join(","),
  );
  return [header.join(","), ...lines].join("\n");
};

const comp = (
  id: string,
  weight: number,
  csv: string,
  gws: number[],
) => parseComponentCsv(id, `${id}.csv`, weight, gws, csv);

describe("blendRows", () => {
  const gws = [2, 3];
  const a = comp(
    "a",
    0.75,
    csvOf(
      [{ id: 1, name: "Alpha A", pts: { 2: 4, 3: 6 }, mins: { 2: 90, 3: 80 }, price: 5.5 }],
      gws,
    ),
    gws,
  );
  const b = comp(
    "b",
    0.25,
    csvOf(
      [
        { id: 1, name: "Alpha B", pts: { 2: 8, 3: 2 }, mins: { 2: 60, 3: 40 }, price: 5.0 },
        { id: 2, name: "Only B", pts: { 2: 4 }, mins: { 2: 88, 3: 88 } },
      ],
      gws,
    ),
    gws,
  );

  it("blends points and minutes with normalized weights", () => {
    const rows = blendRows([a, b], gws);
    const p1 = rows.find((r) => r.fplId === 1)!;
    expect(p1.byGameweek.get(2)).toEqual({ points: 5, minutes: 83 }); // .75*4+.25*8, .75*90+.25*60=82.5→83
    expect(p1.byGameweek.get(3)).toEqual({ points: 5, minutes: 70 });
  });

  it("treats missing players as zero contribution without reweighting", () => {
    const rows = blendRows([a, b], gws);
    const p2 = rows.find((r) => r.fplId === 2)!;
    expect(p2.byGameweek.get(2)!.points).toBe(1); // 0.25 * 4, NOT 4
    expect(p2.byGameweek.get(2)!.minutes).toBe(22); // 0.25 * 88
    expect(p2.byGameweek.get(3)!.points).toBe(0);
  });

  it("takes metadata from the highest-weight source containing the player", () => {
    const rows = blendRows([a, b], gws);
    expect(rows.find((r) => r.fplId === 1)!.name).toBe("Alpha A");
    expect(rows.find((r) => r.fplId === 1)!.price).toBe(5.5);
    expect(rows.find((r) => r.fplId === 2)!.name).toBe("Only B");
  });

  it("breaks weight ties toward the earlier-selected source", () => {
    const a5 = { ...a, weight: 0.5 };
    const b5 = { ...b, weight: 0.5 };
    expect(blendRows([a5, b5], gws).find((r) => r.fplId === 1)!.name).toBe(
      "Alpha A",
    );
    expect(blendRows([b5, a5], gws).find((r) => r.fplId === 1)!.name).toBe(
      "Alpha B",
    );
  });
});

describe("blendCsv ownership handling", () => {
  const gws = [2];
  it("drops the Ownership column when any component lacks it", () => {
    const a = comp("a", 0.5, csvOf([{ id: 1, name: "X", pts: { 2: 4 } }], gws), gws);
    const noOwn = comp(
      "b",
      0.5,
      csvOf([{ id: 1, name: "X", pts: { 2: 2 } }], gws, false),
      gws,
    );
    const rows = blendRows([a, noOwn], gws);
    const withCsv = blendCsv({ components: [a, noOwn], gameweeks: gws, rows, hasOwnership: false });
    expect(withCsv.split("\n")[0]).not.toContain("Ownership");
    const both = blendCsv({ components: [a, a], gameweeks: gws, rows, hasOwnership: true });
    expect(both.split("\n")[0]).toContain("Ownership");
  });

  it("preserves quoted commas and quotes when ownership is omitted", () => {
    const source = comp(
      "quoted",
      1,
      [
        "ID,Name,Pos,Team,Value,2_Pts,2_xMins",
        '1,"Doe, ""Junior""",M,"Team, United",5.5,4,90',
      ].join("\n"),
      gws,
    );
    const rows = blendRows([source], gws);
    const csv = blendCsv({
      components: [source],
      gameweeks: gws,
      rows,
      hasOwnership: false,
    });
    const parsed = parseCsv(csv);
    expect(parsed[0]?.Name).toBe('Doe, "Junior"');
    expect(parsed[0]?.Team).toBe("Team, United");
    expect(parsed[0]?.Value).toBe("5.5");
    expect(parsed[0]?.["2_Pts"]).toBe("4.00");
    expect(parsed[0]).not.toHaveProperty("Ownership");
  });
});

describe("buildBlend / createBlendSnapshot (store-backed)", () => {
  const gwsA = [2, 3, 4];
  const gwsB = [3, 4, 5];
  const metaA = saveProjectionSnapshot({
    filename: "srcA.csv",
    csv: csvOf(
      [{ id: 1, name: "One", pts: { 2: 2, 3: 3, 4: 4 } }],
      gwsA,
    ),
    playerCount: 1,
    gameweeks: gwsA,
    source: "test-a",
    sourceLabel: "Test A",
  });
  const metaB = saveProjectionSnapshot({
    filename: "srcB.csv",
    csv: csvOf(
      [
        { id: 1, name: "One B", pts: { 3: 6, 4: 6, 5: 6 } },
        { id: 2, name: "Two", pts: { 3: 2, 4: 2, 5: 2 } },
      ],
      gwsB,
    ),
    playerCount: 2,
    gameweeks: gwsB,
    source: "test-b",
    sourceLabel: "Test B",
  });

  it("limits the horizon to the shared consecutive gameweeks", () => {
    const blend = buildBlend([
      { projectionId: metaA.id, weight: 1 },
      { projectionId: metaB.id, weight: 1 },
    ]);
    expect(blend.gameweeks).toEqual([3, 4]);
    expect(blend.rows).toHaveLength(2);
  });

  it("errors clearly on deleted/unknown components", () => {
    try {
      buildBlend([
        { projectionId: metaA.id, weight: 1 },
        { projectionId: "nope", weight: 1 },
      ]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BlendError);
      expect((err as InstanceType<typeof BlendError>).status).toBe(404);
      expect((err as Error).message).toMatch(/deleted/i);
    }
  });

  it("errors clearly when there is no shared horizon", () => {
    const far = saveProjectionSnapshot({
      filename: "far.csv",
      csv: csvOf([{ id: 1, name: "One", pts: { 20: 5 } }], [20]),
      playerCount: 1,
      gameweeks: [20],
      source: "test-far",
      sourceLabel: "Test Far",
    });
    expect(() =>
      buildBlend([
        { projectionId: metaA.id, weight: 1 },
        { projectionId: far.id, weight: 1 },
      ]),
    ).toThrow(/shared consecutive gameweeks/i);
  });

  it("single-source blends reproduce the source values", () => {
    const blend = buildBlend([{ projectionId: metaA.id, weight: 7 }]);
    expect(blend.gameweeks).toEqual(gwsA);
    expect(blend.rows[0]!.byGameweek.get(3)).toEqual({ points: 3, minutes: 90 });
  });

  it("materializes an immutable snapshot with normalized provenance", () => {
    const snap = createBlendSnapshot([
      { projectionId: metaA.id, weight: 3 },
      { projectionId: metaB.id, weight: 1 },
    ]);
    expect(snap.source).toBe("blend");
    expect(snap.gameweeks).toEqual([3, 4]);
    expect(snap.components).toEqual([
      { projectionId: metaA.id, filename: "srcA.csv", weight: 0.75 },
      { projectionId: metaB.id, filename: "srcB.csv", weight: 0.25 },
    ]);
    // Snapshot is a real saved projection with its own CSV on disk.
    expect(listProjectionMetas().some((m) => m.id === snap.id)).toBe(true);
    const csv = fs.readFileSync(projectionCsvPath(snap.id), "utf-8");
    // Player 1 GW3: 0.75*3 + 0.25*6 = 4.5; player 2 GW3: 0.25*2 = 0.5
    expect(csv).toContain("4.50");
    expect(csv).toContain("0.50");
    // Reproducible: same inputs blend to identical CSV content.
    const again = createBlendSnapshot([
      { projectionId: metaA.id, weight: 3 },
      { projectionId: metaB.id, weight: 1 },
    ]);
    expect(fs.readFileSync(projectionCsvPath(again.id), "utf-8")).toBe(csv);
  });
});
