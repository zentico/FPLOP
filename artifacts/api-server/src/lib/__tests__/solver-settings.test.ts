import { describe, expect, it } from "vitest";
import { applyOpposingPlay } from "../solver";

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