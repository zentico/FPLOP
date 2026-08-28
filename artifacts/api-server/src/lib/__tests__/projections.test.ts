import { describe, expect, it } from "vitest";
import {
  canonicalRowsFromCsv,
  enrichCanonicalRowsWithBootstrap,
} from "../projections";

const bootstrap = {
  elements: [
    {
      id: 165,
      web_name: "João Pedro",
      first_name: "João",
      second_name: "Pedro",
      selected_by_percent: "68.5",
      team: 7,
      element_type: 4,
      now_cost: 75,
    },
  ],
  teams: [{ id: 7, short_name: "CHE", name: "Chelsea" }],
  events: [],
};

describe("official FPL projection metadata", () => {
  it("overwrites source price, ownership, name, team, and position", () => {
    const rows = canonicalRowsFromCsv(
      [
        {
          ID: "165",
          Name: "Wrong name",
          Pos: "M",
          Team: "XXX",
          Value: "99",
          Ownership: "127.722",
          "2_Pts": "6.25",
          "2_xMins": "88",
        },
      ],
      [2],
    );

    const [player] = enrichCanonicalRowsWithBootstrap(rows, bootstrap);

    expect(player).toMatchObject({
      fplId: 165,
      name: "João Pedro",
      position: "F",
      team: "CHE",
      price: 7.5,
      ownership: 68.5,
    });
    expect(player?.byGameweek.get(2)).toEqual({ points: 6.25, minutes: 88 });
  });

  it("rejects IDs absent from official FPL data", () => {
    expect(() =>
      enrichCanonicalRowsWithBootstrap(
        [
          {
            fplId: 9999,
            name: "",
            position: "",
            team: "",
            price: 0,
            ownership: 0,
            byGameweek: new Map(),
          },
        ],
        bootstrap,
      ),
    ).toThrow("9999");
  });
});