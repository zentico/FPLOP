import { describe, expect, it } from "vitest";
import {
  applyOpposingPlay,
  calculateEndingFreeTransfers,
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