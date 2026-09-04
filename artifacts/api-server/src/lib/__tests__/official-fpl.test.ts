import { describe, expect, it } from "vitest";
import { buildOfficialFplRows, OfficialFplProjectionError } from "../official-fpl";

const bootstrap = (count: number, epNext: string | null = "4.5") => ({
  elements: Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    code: 1000 + index,
    web_name: `Player ${index}`,
    first_name: "Player",
    second_name: String(index),
    selected_by_percent: "2.5",
    team: 1,
    element_type: (index % 4) + 1,
    now_cost: 50,
    ep_next: epNext,
  })),
  teams: [{ id: 1, short_name: "ARS", name: "Arsenal" }],
  events: [],
});

describe("official FPL next-gameweek projections", () => {
  it("imports ep_next for exactly one gameweek without inventing expected minutes", () => {
    const rows = buildOfficialFplRows(bootstrap(120), 3);

    expect(rows).toHaveLength(120);
    expect(rows[0]).toMatchObject({
      fplId: 1,
      name: "Player 0",
      team: "ARS",
      position: "G",
      price: 5,
      ownership: 2.5,
    });
    expect(rows[0]!.byGameweek.get(3)).toEqual({
      points: 4.5,
      minutes: 0,
    });
    expect(rows[0]!.byGameweek.has(4)).toBe(false);
  });

  it("rejects a suspiciously small set of usable estimates", () => {
    expect(() => buildOfficialFplRows(bootstrap(20), 3)).toThrow(
      OfficialFplProjectionError,
    );
  });
});