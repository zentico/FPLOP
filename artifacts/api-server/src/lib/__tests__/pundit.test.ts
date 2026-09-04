import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the persistent store at a temp dir before any lib module loads.
process.env.FPLOP_STORE_DIR ??= fs.mkdtempSync(
  path.join(os.tmpdir(), "fplop-test-store-"),
);

const {
  PunditUpstreamError,
  buildHybridRows,
  buildPunditFrontendRows,
  buildPunditCanonicalRows,
  matchPunditPlayers,
  parsePunditCsv,
  parsePunditPage,
  punditGameweekWindow,
  validatePunditCumulative,
} = await import("../pundit");
const { buildCanonicalCsv } = await import("../projections");
const { readPredictions } = await import("../accuracy");

const HEADER =
  "Name,Team,Position,Fixture,Ownership,Start,Price,StartingPredicted,Predicted," +
  "GW2,GW3,GW4,GW5,GW6,Next2GWsStart,Next3GWsStart,Next4GWsStart,Next5GWsStart,Next6GWsStart";

/** A consistent row: per-GW values 4.8,4.6,4.7,4.4,5.2,4.9 with matching cumulatives. */
const row = (name: string, team = "Arsenal", pos = "DEF") =>
  `${name},${team},${pos},Aston Villa (a),6.5%,80%,£5.5m,4.8,3.8,4.6,4.7,4.4,5.2,4.9,9.4,14.1,18.5,23.7,28.6`;

const csvWith = (n: number, extra: string[] = []) =>
  [HEADER, ...Array.from({ length: n }, (_, i) => row(`Player Num${i}`)), ...extra].join(
    "\n",
  );

describe("parsePunditCsv", () => {
  it("parses prices, percentages and the assume-starting horizon", () => {
    const rows = parsePunditCsv(csvWith(120));
    expect(rows).toHaveLength(120);
    expect(rows[0]).toMatchObject({
      team: "Arsenal",
      position: "D",
      price: 5.5,
      ownership: 6.5,
      startPct: 0.8,
    });
    expect(rows[0]!.startPoints).toEqual([4.8, 4.6, 4.7, 4.4, 5.2, 4.9]);
  });

  it("fails on missing columns (schema drift)", () => {
    const noGw6 = csvWith(120).replaceAll("GW6", "GWX");
    expect(() => parsePunditCsv(noGw6)).toThrow(PunditUpstreamError);
  });

  it("fails on unknown positions", () => {
    const bad = csvWith(120, [row("Weird Pos", "Arsenal", "WING")]);
    expect(() => parsePunditCsv(bad)).toThrow(PunditUpstreamError);
  });

  it("fails on non-numeric point cells instead of importing zeros", () => {
    const bad = csvWith(120, [
      "Bad Cell,Arsenal,DEF,X (a),6.5%,80%,£5.5m,oops,3.8,4.6,4.7,4.4,5.2,4.9,9.4,14.1,18.5,23.7,28.6",
    ]);
    expect(() => parsePunditCsv(bad)).toThrow(PunditUpstreamError);
  });

  it("refuses suspiciously small player lists", () => {
    expect(() => parsePunditCsv(csvWith(20))).toThrow(PunditUpstreamError);
  });
});

const frontendRecord = (
  code: number,
  gw: number,
  overrides: Record<string, unknown> = {},
) =>
  JSON.stringify({
    gw,
    player_code: code,
    web_name: `Player ${code}`,
    first_name: "Test",
    second_name: `Player ${code}`,
    position: "Defender",
    element_type: 2,
    team_name: "Arsenal",
    team_short: "ARS",
    team_abbr: "ARS",
    badge_url: "/badges/1.png",
    price: "5.5",
    selected_by_percent: "6.5",
    predicted_points: "4.800",
    predicted_points_start: "3.840",
    start_pct: "80.00",
    fixture_count: 1,
    source: "odds",
    opponent_abbr: "AVL",
    is_home: false,
    difficulty: 3,
    ...overrides,
  }).replaceAll('"', '\\"');

const frontendPage = (players = 120, gameweeks = [3, 4, 5, 6, 7, 8]) =>
  `<script>self.__next_f.push([1,"${Array.from(
    { length: players },
    (_, index) =>
      gameweeks
        .map((gameweek) => frontendRecord(1000 + index, gameweek))
        .join(","),
  ).join(",")}"])</script>`;

describe("redesigned Pundit predictor", () => {
  it("parses official player codes and assume-starting points from the embedded page data", () => {
    const rows = parsePunditPage(frontendPage());
    expect(rows).toHaveLength(720);
    expect(rows[0]).toMatchObject({
      gameweek: 3,
      playerCode: 1000,
      elementType: 2,
      price: 5.5,
      ownership: 6.5,
      startPct: 0.8,
      startPoints: 4.8,
    });
  });

  it("maps player codes directly to official FPL ids", () => {
    const records = parsePunditPage(frontendPage());
    const bootstrap = {
      elements: Array.from({ length: 120 }, (_, index) => ({
        id: index + 1,
        code: 1000 + index,
        web_name: `Official ${index}`,
        first_name: "Official",
        second_name: String(index),
        selected_by_percent: "1.0",
        team: 1,
        element_type: 2,
        now_cost: 55,
      })),
      teams: [{ id: 1, name: "Arsenal", short_name: "ARS" }],
      events: [],
    };
    const built = buildPunditFrontendRows(
      records,
      bootstrap,
      [3, 4, 5, 6, 7, 8],
    );

    expect(built.sourcePlayerCount).toBe(120);
    expect(built.canonical[0]).toMatchObject({
      fplId: 1,
      name: "Official 0",
      position: "D",
    });
    expect(built.canonical[0]!.byGameweek.get(3)).toEqual({
      points: 4.8,
      minutes: 90,
    });
  });

  it("rejects a predictor whose gameweek window does not match FPL", () => {
    const records = parsePunditPage(frontendPage(120, [4, 5, 6, 7, 8, 9]));
    expect(() =>
      buildPunditFrontendRows(
        records,
        {
          elements: [],
          teams: [],
          events: [],
        },
        [3, 4, 5, 6, 7, 8],
      ),
    ).toThrow(PunditUpstreamError);
  });
});

describe("validatePunditCumulative", () => {
  it("accepts rows whose cumulative columns match within rounding", () => {
    expect(() => validatePunditCumulative(parsePunditCsv(csvWith(120)))).not.toThrow();
  });

  it("rejects a feed whose cumulative columns disagree with the per-GW columns", () => {
    const rows = parsePunditCsv(csvWith(120));
    for (const r of rows) r.cumulativeStart = [20, 30, 40, 50, 60];
    expect(() => validatePunditCumulative(rows)).toThrow(PunditUpstreamError);
  });
});

describe("punditGameweekWindow", () => {
  it("covers the current gameweek plus the next five", () => {
    expect(punditGameweekWindow(2)).toEqual([2, 3, 4, 5, 6, 7]);
  });
  it("caps at gameweek 38", () => {
    expect(punditGameweekWindow(36)).toEqual([36, 37, 38]);
  });
});

const teams = [
  { id: 1, name: "Arsenal", shortName: "ARS" },
  { id: 18, name: "Nott'm Forest", shortName: "NFO" },
];
const player = (
  id: number,
  webName: string,
  firstName: string,
  secondName: string,
  teamId = 1,
  position = "D",
) => ({ id, webName, firstName, secondName, teamId, position });

const prow = (name: string, team = "Arsenal", pos = "DEF") => {
  const [r] = parsePunditCsv(csvWith(119, [row(name, team, pos)])).slice(-1);
  return r!;
};

describe("matchPunditPlayers", () => {
  it("matches by exact full name, web name, and unique surname", () => {
    const players = [
      player(10, "White", "Benjamin", "White"),
      player(11, "Saliba", "William", "Saliba"),
      player(12, "Gabriel", "Gabriel", "dos Santos Magalhães"),
    ];
    const rows = [
      prow("Benjamin White"),
      prow("William Saliba"),
      prow("Gabriel Magalhaes"),
    ];
    const m = matchPunditPlayers(rows, players, teams);
    expect(m.ids).toEqual([10, 11, 12]);
    expect(m.matched).toBe(3);
  });

  it("never guesses between ambiguous candidates", () => {
    const players = [
      player(10, "J.Smith", "John", "Smith"),
      player(11, "A.Smith", "Alan", "Smith"),
    ];
    const m = matchPunditPlayers([prow("Smith")], players, teams);
    expect(m.ids).toEqual([null]);
    expect(m.unmatchedNames).toContain("Smith");
  });

  it("disambiguates shared surnames by first name", () => {
    const players = [
      player(10, "J.Smith", "John", "Smith"),
      player(11, "A.Smith", "Alan", "Smith"),
    ];
    const m = matchPunditPlayers([prow("John Smith")], players, teams);
    expect(m.ids).toEqual([10]);
  });

  it("resolves Pundit team aliases like Notts Forest", () => {
    const players = [player(30, "Wood", "Chris", "Wood", 18, "F")];
    const m = matchPunditPlayers([prow("Chris Wood", "Notts Forest", "FWD")], players, teams);
    expect(m.ids).toEqual([30]);
  });

  it("fails loudly on unknown team names", () => {
    expect(() =>
      matchPunditPlayers([prow("Some Player", "Atletico Madrid")], [], teams),
    ).toThrow(PunditUpstreamError);
  });

  it("falls back to a unique league-wide full-name match when teams disagree", () => {
    // Feed lags a transfer: player is at Forest officially, Arsenal in the feed.
    const players = [player(40, "Doe", "Jonny", "Doe", 18, "D")];
    const m = matchPunditPlayers([prow("Jonny Doe", "Arsenal")], players, teams);
    expect(m.ids).toEqual([40]);
  });

  it("never assigns the same official player twice", () => {
    const players = [player(10, "White", "Benjamin", "White")];
    const m = matchPunditPlayers(
      [prow("Benjamin White"), prow("Benjamin White")],
      players,
      teams,
    );
    expect(m.ids).toEqual([10, null]);
  });
});

describe("buildPunditCanonicalRows", () => {
  it("writes assume-starting points per mapped gameweek and skips unmatched rows", () => {
    const rows = [prow("Benjamin White"), prow("Nobody Matched")];
    const gws = punditGameweekWindow(2);
    const canonical = buildPunditCanonicalRows(rows, [10, null], gws);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.fplId).toBe(10);
    expect(canonical[0]!.byGameweek.get(2)).toEqual({ points: 4.8, minutes: 90 });
    expect(canonical[0]!.byGameweek.get(3)!.points).toBeCloseTo(4.6);
    expect(canonical[0]!.byGameweek.get(7)!.points).toBeCloseTo(4.9);
    // Round-trips through the canonical CSV with real gameweek numbers.
    const csv = buildCanonicalCsv(canonical, gws);
    expect(readPredictions(csv, 4)[0]!.points).toBeCloseTo(4.7);
  });

  it("gives zero minutes to zero-point (blank) gameweeks", () => {
    const r = prow("Benjamin White");
    r.startPoints = [4.8, 0, 4.7, 4.4, 5.2, 4.9];
    const canonical = buildPunditCanonicalRows([r], [10], punditGameweekWindow(2));
    expect(canonical[0]!.byGameweek.get(3)).toEqual({ points: 0, minutes: 0 });
  });
});

describe("buildHybridRows", () => {
  const gws = [2, 3];
  const punditRows = buildPunditCanonicalRows(
    [prow("Benjamin White")],
    [10],
    gws,
  ); // points: GW2=4.8, GW3=4.6

  it("applies points × clamp(minutes/90, 0, 1)", () => {
    const ffh = new Map([[10, new Map([[2, 60], [3, 180]])]]);
    const { rows } = buildHybridRows(punditRows, ffh, gws);
    expect(rows[0]!.byGameweek.get(2)!.points).toBeCloseTo(4.8 * (60 / 90));
    // Double gameweek minutes clamp at 1 — never inflate beyond assume-starting.
    expect(rows[0]!.byGameweek.get(3)!.points).toBeCloseTo(4.6);
    expect(rows[0]!.byGameweek.get(2)!.minutes).toBe(60);
  });

  it("treats gameweeks missing from FFH as zero expected minutes", () => {
    const ffh = new Map([[10, new Map([[2, 90]])]]);
    const { rows } = buildHybridRows(punditRows, ffh, gws);
    expect(rows[0]!.byGameweek.get(3)).toEqual({ points: 0, minutes: 0 });
  });

  it("excludes players FFH does not cover at all, and counts them", () => {
    const { rows, missingFromFfh } = buildHybridRows(punditRows, new Map(), gws);
    expect(rows).toHaveLength(0);
    expect(missingFromFfh).toBe(1);
  });
});
