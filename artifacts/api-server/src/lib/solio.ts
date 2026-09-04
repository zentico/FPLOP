import { parseCsv } from "./csv";
import { getBootstrap, getSeasonName, type Bootstrap } from "./fpl";
import {
  buildCanonicalCsv,
  enrichCanonicalRowsWithBootstrap,
  importedProjectionFilename,
  saveProjectionSnapshot,
  type CanonicalPlayerRow,
} from "./projections";
import type { ProjectionMeta } from "./store";

const SHEET_ID = "1jiQP87cIiUkw6f_rB2XVIP2miuCebgPwIfAduYTkLs8";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

export class SolioUpstreamError extends Error {}

export function findLatestSolioTab(html: string): {
  name: string;
  gameweeks: number[];
} {
  const tabs = [...html.matchAll(/docs-sheet-tab-caption[^>]*>\s*(GW(\d+)-(\d+))\s*</gi)]
    .map((match) => ({
      name: match[1]!,
      first: Number(match[2]),
      last: Number(match[3]),
    }))
    .filter(
      (tab) =>
        Number.isInteger(tab.first) &&
        Number.isInteger(tab.last) &&
        tab.first >= 1 &&
        tab.last <= 38 &&
        tab.last >= tab.first,
    )
    .sort((a, b) => b.first - a.first || b.last - a.last);
  const latest = tabs[0];
  if (!latest) {
    throw new SolioUpstreamError(
      "Solio's sheet has no visible tab named like GW3-7.",
    );
  }
  return {
    name: latest.name,
    gameweeks: Array.from(
      { length: latest.last - latest.first + 1 },
      (_, index) => latest.first + index,
    ),
  };
}

interface SolioRow {
  name: string;
  team: string;
  price: number;
  points: Map<number, number>;
}

export function parseSolioCsv(content: string, gameweeks: number[]): SolioRow[] {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length < 2) {
    throw new SolioUpstreamError("Solio's latest tab returned no player rows.");
  }
  // The sheet leaves its price and average headers blank. Give those columns
  // stable names before using the shared CSV parser.
  lines[0] = ["Name", "Team", "Price", ...gameweeks.map(String), "Average"]
    .map((value) => `"${value}"`)
    .join(",");
  const parsed = parseCsv(lines.join("\n"));
  const rows: SolioRow[] = [];
  for (const raw of parsed) {
    const name = raw["Name"]?.trim();
    const team = raw["Team"]?.trim();
    const price = Number(raw["Price"]);
    if (!name && !team) continue;
    if (!name || !team || !Number.isFinite(price) || price <= 0) {
      throw new SolioUpstreamError(
        `Solio has an invalid player row near "${name || "(missing name)"}".`,
      );
    }
    const points = new Map<number, number>();
    for (const gw of gameweeks) {
      const value = Number(raw[String(gw)]);
      if (!Number.isFinite(value)) {
        throw new SolioUpstreamError(
          `Solio has an invalid GW${gw} prediction for ${name}.`,
        );
      }
      points.set(gw, value);
    }
    rows.push({ name, team, price, points });
  }
  if (rows.length < 100) {
    throw new SolioUpstreamError(
      `Solio returned only ${rows.length} players; refusing a suspiciously small import.`,
    );
  }
  return rows;
}

const norm = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function mapSolioRows(
  rows: SolioRow[],
  bootstrap: Bootstrap,
  gameweeks: number[],
): { canonical: CanonicalPlayerRow[]; unmatchedNames: string[] } {
  const teamIds = new Map(
    bootstrap.teams.flatMap((team) => [
      [norm(team.short_name), team.id] as const,
      [norm(team.name), team.id] as const,
    ]),
  );
  const players = bootstrap.elements.map((player) => ({
    player,
    full: norm(`${player.first_name ?? ""} ${player.second_name ?? ""}`),
    web: norm(player.web_name),
    last: norm(player.second_name ?? "").split(" ").at(-1) ?? "",
    firstInitial: norm(player.first_name ?? "").charAt(0),
  }));
  const canonical: CanonicalPlayerRow[] = [];
  const unmatchedNames: string[] = [];
  const used = new Set<number>();

  for (const row of rows) {
    const teamId = teamIds.get(norm(row.team));
    if (teamId == null) {
      throw new SolioUpstreamError(
        `Solio uses unknown team "${row.team}"; the sheet or FPL teams may have changed.`,
      );
    }
    const n = norm(row.name);
    const tokens = n.split(" ");
    const last = tokens.at(-1) ?? "";
    const initial = tokens[0]?.charAt(0) ?? "";
    const teamPlayers = players.filter(
      ({ player }) =>
        player.team === teamId &&
        Math.abs(player.now_cost / 10 - row.price) < 0.11 &&
        !used.has(player.id),
    );
    const unique = (items: typeof teamPlayers) =>
      items.length === 1 ? items[0] : undefined;
    const hit =
      unique(teamPlayers.filter((candidate) => candidate.full === n)) ??
      unique(teamPlayers.filter((candidate) => candidate.web === n)) ??
      unique(
        teamPlayers.filter(
          (candidate) =>
            (candidate.last === last || candidate.web === last) &&
            (!initial || candidate.firstInitial === initial),
        ),
      ) ??
      unique(
        teamPlayers.filter(
          (candidate) => candidate.last === last || candidate.web === last,
        ),
      );
    if (!hit) {
      if (unmatchedNames.length < 15) unmatchedNames.push(row.name);
      continue;
    }
    used.add(hit.player.id);
    canonical.push({
      fplId: hit.player.id,
      name: row.name,
      position: "",
      team: row.team,
      price: row.price,
      ownership: 0,
      byGameweek: new Map(
        gameweeks.map((gw) => {
          const points = row.points.get(gw) ?? 0;
          return [gw, { points, minutes: points > 0 ? 90 : 0 }];
        }),
      ),
    });
  }
  return {
    canonical: enrichCanonicalRowsWithBootstrap(canonical, bootstrap),
    unmatchedNames,
  };
}

export async function importSolioProjection(): Promise<ProjectionMeta> {
  let page: Response;
  try {
    page = await fetch(SHEET_URL, { headers: { "User-Agent": USER_AGENT } });
  } catch {
    throw new SolioUpstreamError("Could not reach Solio's Google Sheet.");
  }
  if (!page.ok) {
    throw new SolioUpstreamError(
      `Solio's Google Sheet returned status ${page.status}.`,
    );
  }
  const latest = findLatestSolioTab(await page.text());
  const csvUrl =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(latest.name)}`;
  const [csvResponse, bootstrap, season] = await Promise.all([
    fetch(csvUrl, { headers: { "User-Agent": USER_AGENT } }),
    getBootstrap(),
    getSeasonName(),
  ]);
  if (!csvResponse.ok) {
    throw new SolioUpstreamError(
      `Solio's ${latest.name} tab returned status ${csvResponse.status}.`,
    );
  }
  const sourceRows = parseSolioCsv(await csvResponse.text(), latest.gameweeks);
  const mapped = mapSolioRows(sourceRows, bootstrap, latest.gameweeks);
  const coverage = mapped.canonical.length / sourceRows.length;
  if (coverage < 0.9) {
    throw new SolioUpstreamError(
      `Only ${mapped.canonical.length} of ${sourceRows.length} Solio players matched official FPL data (${Math.round(coverage * 100)}%). Import aborted. Unmatched examples: ${mapped.unmatchedNames.join(", ")}.`,
    );
  }
  const fetchedAt = new Date().toISOString();
  return saveProjectionSnapshot({
    filename: importedProjectionFilename(
      "Solio",
      fetchedAt,
      latest.gameweeks[0]!,
      latest.gameweeks.at(-1)!,
    ),
    csv: buildCanonicalCsv(mapped.canonical, latest.gameweeks),
    playerCount: mapped.canonical.length,
    gameweeks: latest.gameweeks,
    source: "solio",
    sourceLabel: `Solio — ${latest.name}`,
    sourceUpdatedAt: fetchedAt,
    sourcePlayerCount: sourceRows.length,
    season,
  });
}