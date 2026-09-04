import { describe, expect, it } from "vitest";
import { findLatestSolioTab, parseSolioCsv, SolioUpstreamError } from "../solio";

describe("Solio projection import", () => {
  it("selects the newest valid gameweek-range tab", () => {
    const html = `
      <div class="docs-sheet-tab-caption">GW2-6</div>
      <div class="docs-sheet-tab-caption">Notes</div>
      <div class="docs-sheet-tab-caption">GW3-7</div>`;
    expect(findLatestSolioTab(html)).toEqual({
      name: "GW3-7",
      gameweeks: [3, 4, 5, 6, 7],
    });
  });

  it("parses point columns while replacing the sheet's blank headers", () => {
    const players = Array.from({ length: 100 }, (_, index) =>
      `"Player ${index}","ARS","5.5","${index + 0.1}","${index + 0.2}","ignored"`,
    );
    const rows = parseSolioCsv(
      ['"Name","Team","","3","4",""', ...players].join("\n"),
      [3, 4],
    );
    expect(rows).toHaveLength(100);
    expect(rows[0]).toMatchObject({
      name: "Player 0",
      team: "ARS",
      price: 5.5,
    });
    expect(rows[0]!.points.get(3)).toBe(0.1);
    expect(rows[0]!.points.get(4)).toBe(0.2);
  });

  it("rejects a sheet without a gameweek-range tab", () => {
    expect(() =>
      findLatestSolioTab('<div class="docs-sheet-tab-caption">Notes</div>'),
    ).toThrow(SolioUpstreamError);
  });
});