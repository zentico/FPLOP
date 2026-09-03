import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOpposingPlay,
  calculateEndingFreeTransfers,
  ensureSquadPlayersInProjection,
} from "../solver";

describe("opposing-play settings", () => {
  it("compensates for the solver's two directed variables per real clash", () => {
    const config: Record<string, unknown> = {};

    applyOpposingPlay(config, "penalty");

    expect(config).toMatchObject({
      no_opposing_play: "penalty",
      opposing_play_group: "position",
      opposing_play_penalty: 0.25,
    });
  });

  it("leaves opposing-play settings absent when clashes are allowed", () => {
    const config: Record<string, unknown> = {};

    applyOpposingPlay(config, "off");

    expect(config).toEqual({});
  });
});

describe("free-transfer rollover", () => {
  it.each([
    { starting: 2, transfers: 0, chip: "", ending: 3 },
    { starting: 2, transfers: 1, chip: "", ending: 2 },
    { starting: 1, transfers: 2, chip: "", ending: 1 },
    { starting: 5, transfers: 0, chip: "", ending: 5 },
    { starting: 3, transfers: 0, chip: "WC", ending: 3 },
    { starting: 3, transfers: 0, chip: "FH", ending: 3 },
  ])(
    "$starting FT, $transfers transfers, chip '$chip' → $ending FT",
    ({ starting, transfers, chip, ending }) => {
      expect(calculateEndingFreeTransfers(starting, transfers, chip)).toBe(
        ending,
      );
    },
  );
});

describe("missing current-squad projections", () => {
  it("adds a zero-point run-local row without changing existing players", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fpl-projection-"));
    const csvPath = path.join(dir, "run.csv");
    fs.writeFileSync(
      csvPath,
      [
        "ID,Name,Pos,Team,Value,Ownership,3_Pts,3_xMins",
        "1,Raya,G,ARS,6,35.2,4.2,90",
        "",
      ].join("\n"),
    );

    const added = ensureSquadPlayersInProjection(csvPath, [
      {
        playerId: 1,
        name: "Raya",
        team: "ARS",
        position: "G",
        sellPrice: 6,
      },
      {
        playerId: 140,
        name: "Sánchez",
        team: "CHE",
        position: "G",
        sellPrice: 5,
      },
    ]);

    expect(added).toEqual([140]);
    expect(fs.readFileSync(csvPath, "utf-8")).toBe(
      [
        "ID,Name,Pos,Team,Value,Ownership,3_Pts,3_xMins",
        "1,Raya,G,ARS,6,35.2,4.2,90",
        "140,Sánchez,G,CHE,5,0,0,0",
        "",
      ].join("\n"),
    );
  });
});