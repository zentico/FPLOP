import { describe, expect, it } from "vitest";
import { annotateOpposingClashes, OPPOSING_CLASH_PENALTY } from "../solver";
import type { FixtureInfo } from "../fpl";
import type { PickPlayer, SolvePlan } from "../store";

const player = (
  name: string,
  team: string,
  position: string,
): PickPlayer => ({
  name,
  team,
  position,
  price: 5,
  expectedPoints: 4,
  isCaptain: false,
  isViceCaptain: false,
});

const fixtures: FixtureInfo[] = [
  {
    gameweek: 3,
    home: "ARS",
    away: "LIV",
    homeName: "Arsenal",
    awayName: "Liverpool",
    homeDifficulty: 4,
    awayDifficulty: 4,
  },
  {
    gameweek: 4,
    home: "MCI",
    away: "CHE",
    homeName: "Man City",
    awayName: "Chelsea",
    homeDifficulty: 3,
    awayDifficulty: 4,
  },
];

const makePlan = (lineup: PickPlayer[], gameweek = 3): SolvePlan => ({
  totalExpectedPoints: 0,
  gameweeks: [
    {
      gameweek,
      expectedPoints: 60,
      lineup,
      bench: [],
      transfersIn: [],
      transfersOut: [],
    },
  ],
});

describe("annotateOpposingClashes", () => {
  it("flags defender-attacker pairings whose teams meet that gameweek", () => {
    const plan = makePlan([
      player("Gabriel", "ARS", "D"),
      player("Salah", "LIV", "M"),
      player("Haaland", "MCI", "F"),
    ]);

    annotateOpposingClashes(plan, fixtures);

    const gw = plan.gameweeks[0]!;
    expect(gw.opposingClashes).toEqual([
      {
        defender: "Gabriel",
        defenderTeam: "ARS",
        attacker: "Salah",
        attackerTeam: "LIV",
        penalty: OPPOSING_CLASH_PENALTY,
      },
    ]);
    expect(gw.opposingPenalty).toBe(OPPOSING_CLASH_PENALTY);
  });

  it("matches full team names from the solver CSV against fixtures", () => {
    const plan = makePlan([
      player("Alisson", "Liverpool", "G"),
      player("Saka", "Arsenal", "M"),
    ]);

    annotateOpposingClashes(plan, fixtures);

    const gw = plan.gameweeks[0]!;
    expect(gw.opposingPenalty).toBe(OPPOSING_CLASH_PENALTY);
    expect(gw.opposingClashes).toHaveLength(1);
    expect(gw.opposingClashes![0]).toMatchObject({
      defender: "Alisson",
      attacker: "Saka",
    });
  });

  it("sums the penalty across multiple clashes", () => {
    const plan = makePlan([
      player("Gabriel", "ARS", "D"),
      player("Timber", "ARS", "D"),
      player("Salah", "LIV", "M"),
    ]);

    annotateOpposingClashes(plan, fixtures);

    expect(plan.gameweeks[0]!.opposingPenalty).toBe(
      2 * OPPOSING_CLASH_PENALTY,
    );
  });

  it("leaves the fields absent when no clash exists (fixture in another gameweek)", () => {
    const plan = makePlan(
      [player("Gabriel", "ARS", "D"), player("Salah", "LIV", "M")],
      4,
    );

    annotateOpposingClashes(plan, fixtures);

    const gw = plan.gameweeks[0]!;
    expect(gw.opposingClashes).toBeUndefined();
    expect(gw.opposingPenalty).toBeUndefined();
  });

  it("ignores attacker-vs-attacker and defender-vs-defender matchups", () => {
    const plan = makePlan([
      player("Saka", "ARS", "M"),
      player("Salah", "LIV", "M"),
      player("Gabriel", "ARS", "D"),
      player("Van Dijk", "LIV", "D"),
    ]);

    annotateOpposingClashes(plan, fixtures);

    // Gabriel vs Salah and Van Dijk vs Saka are the only GK/DEF-vs-MID/FWD pairs.
    expect(plan.gameweeks[0]!.opposingClashes).toHaveLength(2);
  });
});
