import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the persistent store at a temp dir before any lib module loads.
process.env.FPLOP_STORE_DIR ??= fs.mkdtempSync(
  path.join(os.tmpdir(), "fplop-test-store-"),
);

const {
  FantaLensUpstreamError,
  extractEmbeddedPage,
  mapFantaLensPlayers,
  parseFantaLensPage,
} = await import("../fantalens");
const { buildCanonicalCsv } = await import("../projections");

const fixture = (xpts: number, mins: number) => ({
  opponent: "IPS",
  is_home: true,
  xpts,
  expected_minutes: mins,
});

const player = (id: number, over: Record<string, unknown> = {}) => ({
  id: id + 1000, // FantaLens internal id, deliberately different
  external_id: id,
  name: `Player ${id}`,
  position: "M",
  team: { name: "Man Utd", code: "MUN", external_id: 16 },
  price: 8.5,
  selected_by_percent: 12.3,
  xpts: {
    "2": { fixtures: [fixture(5.1, 88.2)], total: 5.1 },
    "3": { fixtures: [fixture(4.2, 85)], total: 4.2 },
  },
  ...over,
});

const page = (over: Record<string, unknown> = {}, propsOver: Record<string, unknown> = {}) => ({
  component: "SquadPlanner/Index",
  version: "abc123",
  props: {
    competitions: { active: "premier-league" },
    season: { name: "2026/27", slug: "2026-27" },
    gameweeks: [{ number: 2 }, { number: 3 }],
    selectedGameweeks: [2, 3],
    pagination: { page: 1, per_page: 100, last_page: 1, total: 2 },
    players: [player(411), player(412)],
    ...propsOver,
  },
  ...over,
});

describe("parseFantaLensPage", () => {
  it("accepts a valid payload", () => {
    const p = parseFantaLensPage(page());
    expect(p.version).toBe("abc123");
    expect(p.season).toBe("2026/27");
    expect(p.horizonGameweeks).toEqual([2, 3]);
    expect(p.selectedGameweeks).toEqual([2, 3]);
    expect(p.pagination).toEqual({ page: 1, lastPage: 1, total: 2 });
    expect(p.players).toHaveLength(2);
    const pl = p.players[0]!;
    expect(pl).toMatchObject({ fplId: 411, position: "M", teamCode: "MUN" });
    expect(pl.fixturesByGw.get(2)).toEqual([{ xPoints: 5.1, xMinutes: 88.2 }]);
  });

  it("rejects payloads without props", () => {
    expect(() => parseFantaLensPage({ foo: 1 })).toThrow(FantaLensUpstreamError);
    expect(() => parseFantaLensPage(null)).toThrow(FantaLensUpstreamError);
  });

  it("rejects unexpected competitions", () => {
    const p = page({}, { competitions: { active: "liga-portugal" } });
    expect(() => parseFantaLensPage(p)).toThrow(/liga-portugal/);
  });

  it("rejects unrecognized seasons", () => {
    const p = page({}, { season: { name: "??" } });
    expect(() => parseFantaLensPage(p)).toThrow(FantaLensUpstreamError);
  });

  it("rejects players missing official ids or fields (schema drift)", () => {
    const noId = page({}, { players: [player(411, { external_id: null })] });
    expect(() => parseFantaLensPage(noId)).toThrow(FantaLensUpstreamError);
    const badPos = page({}, { players: [player(411, { position: "WTF" })] });
    expect(() => parseFantaLensPage(badPos)).toThrow(/position/);
    const noTeam = page({}, { players: [player(411, { team: null })] });
    expect(() => parseFantaLensPage(noTeam)).toThrow(FantaLensUpstreamError);
  });

  it("rejects malformed fixture projections", () => {
    const bad = page({}, {
      players: [
        player(411, { xpts: { "2": { fixtures: [{ xpts: "high" }], total: 1 } } }),
      ],
    });
    expect(() => parseFantaLensPage(bad)).toThrow(/expected_minutes/);
  });

  it("treats null fixture values as zero (players not expected to feature)", () => {
    const p = page({}, {
      players: [
        player(411, {
          xpts: { "2": { fixtures: [{ xpts: 0, expected_minutes: null }], total: 0 } },
        }),
      ],
    });
    expect(parseFantaLensPage(p).players[0]!.fixturesByGw.get(2)).toEqual([
      { xPoints: 0, xMinutes: 0 },
    ]);
  });

  it("rejects malformed pagination", () => {
    const p = page({}, { pagination: { page: 1 } });
    expect(() => parseFantaLensPage(p)).toThrow(/pagination/);
  });

  it("tolerates players with no projections yet", () => {
    const p = parseFantaLensPage(page({}, { players: [player(411, { xpts: null })] }));
    expect(p.players[0]!.fixturesByGw.size).toBe(0);
  });
});

describe("mapFantaLensPlayers", () => {
  it("maps to canonical rows and CSV keyed by official FPL ids", () => {
    const { players } = parseFantaLensPage(page());
    const rows = mapFantaLensPlayers(players, [2, 3]);
    expect(rows[0]).toMatchObject({ fplId: 411, position: "M", team: "MUN", price: 8.5, ownership: 12.3 });
    expect(rows[0]!.byGameweek.get(2)).toEqual({ points: 5.1, minutes: 88.2 });
    const csv = buildCanonicalCsv(rows, [2, 3]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("ID,Name,Pos,Team,Value,Ownership,2_Pts,2_xMins,3_Pts,3_xMins");
    expect(lines[1]).toBe("411,Player 411,M,MUN,8.5,12.3,5.10,88,4.20,85");
  });

  it("sums double-gameweek fixture points and minutes", () => {
    const dgw = player(411, {
      xpts: { "2": { fixtures: [fixture(5.1, 88.2), fixture(3.4, 60.4)], total: 8.5 } },
    });
    const { players } = parseFantaLensPage(page({}, { players: [dgw] }));
    const rows = mapFantaLensPlayers(players, [2, 3]);
    const f = rows[0]!.byGameweek.get(2)!;
    expect(f.points).toBeCloseTo(8.5);
    expect(f.minutes).toBeCloseTo(148.6);
    // Blank gameweeks serialize as 0 points / 0 minutes.
    expect(buildCanonicalCsv(rows, [2, 3]).trim().split("\n")[1]).toBe(
      "411,Player 411,M,MUN,8.5,12.3,8.50,149,0.00,0",
    );
  });

  it("rejects duplicate official ids (pages shifted mid-import)", () => {
    const { players } = parseFantaLensPage(
      page({}, { players: [player(411), player(411)] }),
    );
    expect(() => mapFantaLensPlayers(players, [2, 3])).toThrow(/duplicate/);
  });

  it("rejects projections outside the requested horizon", () => {
    const { players } = parseFantaLensPage(page());
    expect(() => mapFantaLensPlayers(players, [2])).toThrow(/outside/);
  });

  it("rejects an empty projection horizon", () => {
    const { players } = parseFantaLensPage(page());
    expect(() => mapFantaLensPlayers(players, [])).toThrow(/empty/);
  });
});

describe("extractEmbeddedPage", () => {
  it("extracts the Inertia payload from rendered HTML", () => {
    const html = `<html><body><script data-page="app" type="application/json">{"version":"v1","props":{}}</script></body></html>`;
    expect(extractEmbeddedPage(html)).toEqual({ version: "v1", props: {} });
  });

  it("rejects pages without the embedded payload", () => {
    expect(() => extractEmbeddedPage("<html></html>")).toThrow(FantaLensUpstreamError);
    expect(() =>
      extractEmbeddedPage(
        '<script data-page="app" type="application/json">{oops</script>',
      ),
    ).toThrow(FantaLensUpstreamError);
  });
});
