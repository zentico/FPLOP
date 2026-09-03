import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";
import { parseCsv } from "./csv";
import { getFplTeam, getFixtures, type FixtureInfo } from "./fpl";
import {
  RUNS_DIR,
  SOLVER_DATA_DIR,
  PROJECTIONS_DIR,
  SOLVER_REPO,
  SOLVER_RESULTS_DIR,
} from "./paths";
import {
  type ChipEval,
  type GameweekPlan,
  type PickPlayer,
  type SolveRequest,
  type SolvePlan,
  type SolveResult,
  listRunMetas,
  saveRunMetas,
  updateRun,
} from "./store";

const CHIP_OPTION: Record<string, string> = {
  wildcard: "use_wc",
  bench_boost: "use_bb",
  free_hit: "use_fh",
  triple_captain: "use_tc",
};

const CHIP_CODE: Record<string, string> = {
  WC: "wildcard",
  BB: "bench_boost",
  FH: "free_hit",
  TC: "triple_captain",
};

export function projectionCsvPath(projectionId: string): string {
  const current = path.join(PROJECTIONS_DIR, `${projectionId}.csv`);
  // Lazy migration: older versions stored projection CSVs in the solver's
  // own data dir, which is not persistent in Docker deployments.
  if (!fs.existsSync(current)) {
    const legacy = path.join(SOLVER_DATA_DIR, `${projectionId}.csv`);
    if (fs.existsSync(legacy)) fs.copyFileSync(legacy, current);
  }
  return current;
}

/** Map of player id -> price, read from the projection csv. */
function priceMap(projectionId: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const rows = parseCsv(fs.readFileSync(projectionCsvPath(projectionId), "utf-8"));
    if (rows.length === 0) return map;
    const first = rows[0]!;
    const priceCol = ["Value", "Price", "BV", "SV", "Cost", "now_cost"].find(
      (c) => c in first,
    );
    const idCol = ["ID", "Id", "id"].find((c) => c in first);
    if (!priceCol || !idCol) return map;
    for (const r of rows) {
      const v = Number(r[priceCol]);
      if (r[idCol] && Number.isFinite(v)) map.set(String(Number(r[idCol])), v);
    }
  } catch {
    // price enrichment is best-effort
  }
  return map;
}

/** Map of player id -> ownership %, read from the projection csv. */
function ownershipMap(projectionId: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const rows = parseCsv(fs.readFileSync(projectionCsvPath(projectionId), "utf-8"));
    if (rows.length === 0) return map;
    if (!("Ownership" in rows[0]!)) return map;
    const idCol = ["ID", "Id", "id"].find((c) => c in rows[0]!);
    if (!idCol) return map;
    for (const r of rows) {
      const v = Number(r["Ownership"]);
      if (r[idCol] && Number.isFinite(v)) map.set(String(Number(r[idCol])), v);
    }
  } catch {
    // ownership enrichment is best-effort
  }
  return map;
}

/** Clamp the differential factor k to a sane fraction range. */
export function clampDifferentialFactor(k: number): number {
  return Math.min(Math.max(k, 0), 1);
}

/** True when the projection CSV includes an Ownership column. */
export function projectionHasOwnership(projectionId: string): boolean {
  try {
    const header = fs
      .readFileSync(projectionCsvPath(projectionId), "utf-8")
      .split(/\r?\n/, 1)[0]!;
    return header.split(",").map((h) => h.trim()).includes("Ownership");
  } catch {
    return false;
  }
}

export interface PoolFilter {
  gkMain: number;
  gkBench: number;
  defMain: number;
  defBench: number;
  midMain: number;
  midBench: number;
  fwdMain: number;
  fwdBench: number;
}

export interface PoolPlayerStat {
  id: number;
  name: string;
  position: string;
  team: string;
  price: number;
  ppm: number;
  /** Per-gameweek projected points, in ascending gameweek order. */
  gwPoints: number[];
}

const POS_LETTER: Record<string, string> = {
  G: "G", GK: "G", GKP: "G",
  D: "D", DEF: "D",
  M: "M", MID: "M",
  F: "F", FWD: "F", FW: "F",
};

/** Points per match: total projected points / number of gameweeks in the projection. */
function rowPpm(row: Record<string, string>, headers: string[]): number {
  let pts = 0;
  let gws = 0;
  for (const h of headers) {
    if (/^\d+_Pts$/.test(h)) {
      pts += Number(row[h]) || 0;
      gws++;
    }
  }
  if (gws <= 0) return 0;
  return pts / gws;
}

/**
 * Rank-based pool selection. Within each position players get three ranks:
 * impact (points per match, higher better), value (ppm per £m, higher
 * better) and price (cheaper better). The "main squad" score averages
 * impact and value ranks; the "bench squad" score averages price and value
 * ranks. Per position the top `main` players by main score are selected,
 * then from the remainder the top `bench` players by bench score.
 */
export function selectPool(
  stats: PoolPlayerStat[],
  filter: PoolFilter,
): Set<number> {
  const counts: Record<string, [number, number]> = {
    G: [filter.gkMain, filter.gkBench],
    D: [filter.defMain, filter.defBench],
    M: [filter.midMain, filter.midBench],
    F: [filter.fwdMain, filter.fwdBench],
  };
  const selected = new Set<number>();
  for (const pos of Object.keys(counts)) {
    const players = stats.filter((p) => p.position === pos);
    const rankOf = (sorted: PoolPlayerStat[]) => {
      const m = new Map<number, number>();
      sorted.forEach((p, i) => m.set(p.id, i + 1));
      return m;
    };
    // Ties are broken by player id so selection is independent of CSV
    // row order. Zero-price players get zero value (can't divide) but
    // still rank cheapest on price.
    const value = (p: PoolPlayerStat) => (p.price > 0 ? p.ppm / p.price : 0);
    const impactRank = rankOf(
      [...players].sort((a, b) => b.ppm - a.ppm || a.id - b.id),
    );
    const valueRank = rankOf(
      [...players].sort((a, b) => value(b) - value(a) || a.id - b.id),
    );
    const priceRank = rankOf(
      [...players].sort((a, b) => a.price - b.price || a.id - b.id),
    );
    const mainScore = (p: PoolPlayerStat) =>
      (impactRank.get(p.id)! + valueRank.get(p.id)!) / 2;
    const benchScore = (p: PoolPlayerStat) =>
      (priceRank.get(p.id)! + valueRank.get(p.id)!) / 2;

    const [mainN, benchN] = counts[pos]!;
    const byMain = [...players].sort(
      (a, b) => mainScore(a) - mainScore(b) || b.ppm - a.ppm || a.id - b.id,
    );
    const main = byMain.slice(0, Math.max(0, mainN));
    for (const p of main) selected.add(p.id);
    const rest = byMain
      .slice(Math.max(0, mainN))
      .sort(
        (a, b) =>
          benchScore(a) - benchScore(b) || value(b) - value(a) || a.id - b.id,
      );
    for (const p of rest.slice(0, Math.max(0, benchN))) selected.add(p.id);
  }
  return selected;
}

/** Per-player stats used for pool filtering (price and points per match). */
export function computePoolStats(projectionId: string): PoolPlayerStat[] {
  const content = fs.readFileSync(projectionCsvPath(projectionId), "utf-8");
  const rows = parseCsv(content);
  if (rows.length === 0) return [];
  const headers = Object.keys(rows[0]!);
  const first = rows[0]!;
  const priceCol = ["Value", "Price", "BV", "SV", "Cost"].find((c) => c in first);
  const nameCol = ["Name", "name", "Player"].find((c) => c in first) ?? "Name";
  const posCol = ["Pos", "Position", "pos"].find((c) => c in first) ?? "Pos";
  const idCol = ["ID", "Id", "id"].find((c) => c in first);
  const teamCol = ["Team", "team", "Club"].find((c) => c in first);
  const gwCols = headers
    .filter((h) => /^\d+_Pts$/.test(h))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  // ppm is intentionally unrounded so eligibility decisions here, in the
  // frontend live count, and in the per-run CSV filter agree at boundaries.
  return rows
    .map((r) => ({
      id: idCol ? Number(r[idCol]) || 0 : 0,
      name: r[nameCol] ?? "",
      position: POS_LETTER[(r[posCol] ?? "").toUpperCase()] ?? "?",
      team: teamCol ? (r[teamCol] ?? "") : "",
      price: priceCol ? Number(r[priceCol]) || 0 : 0,
      ppm: rowPpm(r, headers),
      gwPoints: gwCols.map((c) => Number(r[c]) || 0),
    }))
    .filter((p) => p.name);
}

const csvField = (v: string): string =>
  /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/**
 * Write the per-run copy of the projection CSV the solver reads:
 * - when `keepIds` is set, drop players not in it (the caller builds it
 *   from the rank-based pool selection plus locked players);
 * - when k > 0, scale every per-GW points column by
 *   1 + k * (100 - ownership%) / 100.
 * Returns the per-player factor map (null when k = 0) and pool counts.
 */
function writeRunProjection(
  projectionId: string,
  datasource: string,
  k: number,
  keepIds: Set<number> | null,
): { factors: Map<string, number> | null; kept: number; total: number } {
  const content = fs.readFileSync(projectionCsvPath(projectionId), "utf-8");
  const rows = parseCsv(content);
  const headers = content
    .split(/\r?\n/, 1)[0]!
    .split(",")
    .map((h) => h.trim());
  const idCol = headers.find((h) => ["ID", "Id", "id"].includes(h));
  if (!idCol) throw new Error("Projection is missing an ID column");
  if (k > 0 && !headers.includes("Ownership")) {
    throw new Error("Projection is missing the Ownership column");
  }
  const ptsCols = new Set(headers.filter((h) => /^\d+_Pts$/.test(h)));

  const factors = k > 0 ? new Map<string, number>() : null;
  const lines = [headers.map(csvField).join(",")];
  let kept = 0;
  for (const r of rows) {
    if (keepIds && !keepIds.has(Number(r[idCol]))) continue;
    kept++;
    let factor = 1;
    if (factors) {
      const ownership = Number(r["Ownership"]);
      factor = Number.isFinite(ownership)
        ? 1 + (k * (100 - Math.min(Math.max(ownership, 0), 100))) / 100
        : 1;
      factors.set(String(Number(r[idCol])), factor);
    }
    lines.push(
      headers
        .map((h) => {
          const v = r[h] ?? "";
          if (factors && ptsCols.has(h)) {
            const n = Number(v);
            if (Number.isFinite(n)) return String(Math.round(n * factor * 1000) / 1000);
          }
          return csvField(v);
        })
        .join(","),
    );
  }
  fs.writeFileSync(
    path.join(SOLVER_DATA_DIR, `${datasource}.csv`),
    lines.join("\n") + "\n",
  );
  return { factors, kept, total: rows.length };
}

type SquadProjectionFallback = {
  playerId: number;
  name: string;
  team: string;
  position: string;
  sellPrice: number;
};

/**
 * The upstream solver requires every current-squad player to exist in the
 * projection datasource, even if that player has no forecast. Projection
 * providers sometimes omit unavailable or fringe players, so add zero-point
 * run-local rows for missing squad members. The source snapshot stays intact.
 */
export function ensureSquadPlayersInProjection(
  csvPath: string,
  squad: SquadProjectionFallback[],
): number[] {
  if (squad.length === 0) return [];
  const content = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCsv(content);
  const headers = content
    .split(/\r?\n/, 1)[0]!
    .split(",")
    .map((header) => header.trim());
  const idCol = headers.find((header) => ["ID", "Id", "id"].includes(header));
  if (!idCol) throw new Error("Projection is missing an ID column");

  const presentIds = new Set(rows.map((row) => Number(row[idCol])));
  const missing = squad.filter((player) => !presentIds.has(player.playerId));
  if (missing.length === 0) return [];

  const nameCol = headers.find((header) =>
    ["Name", "name", "Player"].includes(header),
  );
  const posCol = headers.find((header) =>
    ["Pos", "Position", "pos"].includes(header),
  );
  const teamCol = headers.find((header) =>
    ["Team", "team", "Club"].includes(header),
  );
  const priceCol = headers.find((header) =>
    ["Value", "Price", "BV", "SV", "Cost", "now_cost"].includes(header),
  );
  const ownershipCol = headers.find((header) => header === "Ownership");
  const appendedLines = missing.map((player) =>
    headers
      .map((header) => {
        let value = "";
        if (header === idCol) value = String(player.playerId);
        else if (header === nameCol) value = player.name;
        else if (header === posCol) value = player.position;
        else if (header === teamCol) value = player.team;
        else if (header === priceCol) value = String(player.sellPrice);
        else if (header === ownershipCol) value = "0";
        else if (/^\d+_(Pts|xMins)$/.test(header)) value = "0";
        return csvField(value);
      })
      .join(","),
  );
  fs.writeFileSync(
    csvPath,
    `${content.trimEnd()}\n${appendedLines.join("\n")}\n`,
  );
  return missing.map((player) => player.playerId);
}

interface PickRow {
  id: string;
  week: string;
  name: string;
  pos: string;
  team: string;
  xP: string;
  xp_cont: string;
  lineup: string;
  bench: string;
  captain: string;
  vicecaptain: string;
  transfer_in: string;
  transfer_out: string;
  chip: string;
  buy_price: string;
  sell_price: string;
  iter: string;
  ft: string;
}

export function calculateEndingFreeTransfers(
  starting: number,
  transfersMade: number,
  chipCode: string,
): number {
  const chipUsesTransferCarry = chipCode === "WC" || chipCode === "FH";
  return Math.max(
    1,
    Math.min(
      5,
      starting - transfersMade + 1 - (chipUsesTransferCarry ? 1 : 0),
    ),
  );
}

function parseResultCsv(
  csvContent: string,
  prices: Map<string, number>,
  factors: Map<string, number> | null = null,
  startBank: number | null = null,
  ownership: Map<string, number> | null = null,
): SolveResult {
  const rows = parseCsv(csvContent) as unknown as PickRow[];
  const iters = [...new Set(rows.map((r) => r.iter))].sort(
    (a, b) => Number(a) - Number(b),
  );
  const plans = iters.map((iter) =>
    parseIterPlan(
      rows.filter((r) => r.iter === iter),
      prices,
      factors,
      startBank,
      ownership,
    ),
  );
  const main = plans[0]!;
  return {
    ...main,
    alternatives: plans.length > 1 ? plans.slice(1) : null,
  };
}

function parseIterPlan(
  iterRows: PickRow[],
  prices: Map<string, number>,
  factors: Map<string, number> | null,
  startBank: number | null,
  ownership: Map<string, number> | null,
): SolvePlan {
  const weeks = [...new Set(iterRows.map((r) => Number(r.week)))].sort(
    (a, b) => a - b,
  );

  // Running bank ledger: each week's transfers move money in (sales) and out
  // (purchases). Free Hit changes revert the following week, so they don't
  // carry into the running balance.
  let runningBank = startBank;

  const gameweeks: GameweekPlan[] = weeks.map((week) => {
    const wr = iterRows.filter((r) => Number(r.week) === week);

    const factorOf = (r: PickRow): number =>
      factors?.get(String(Number(r.id))) ?? 1;

    const toPlayer = (r: PickRow): PickPlayer => {
      const benchOrder = Number(r.bench);
      const buyPrice = Number(r.buy_price);
      return {
        id: r.id != null && r.id !== "" ? String(Number(r.id)) : null,
        name: r.name,
        team: r.team,
        position: (r.pos || "?").charAt(0),
        price:
          prices.get(String(Number(r.id))) ??
          (Number.isFinite(buyPrice) && buyPrice > 0 ? buyPrice : 0),
        expectedPoints: Number(r.xP) || 0,
        basePoints: factors
          ? Math.round(((Number(r.xP) || 0) / factorOf(r)) * 100) / 100
          : null,
        isCaptain: Number(r.captain) === 1,
        isViceCaptain: Number(r.vicecaptain) === 1,
        benchOrder: benchOrder >= 0 ? benchOrder : null,
        ownership: ownership?.get(String(Number(r.id))) ?? null,
      };
    };

    const lineup = wr
      .filter((r) => Number(r.lineup) === 1)
      .map(toPlayer)
      .sort((a, b) => "GDMF".indexOf(a.position) - "GDMF".indexOf(b.position));
    const bench = wr
      .filter((r) => Number(r.lineup) !== 1 && Number(r.bench) >= 0)
      .map(toPlayer)
      .sort((a, b) => (a.benchOrder ?? 0) - (b.benchOrder ?? 0));

    const chipCode = wr.find((r) => r.chip)?.chip ?? "";
    const squadRows = wr.filter(
      (r) => Number(r.lineup) === 1 || Number(r.bench) >= 0,
    );

    const bankBefore = runningBank;
    let bank: number | null = null;
    if (runningBank != null) {
      const sold = wr
        .filter((r) => Number(r.transfer_out) === 1)
        .reduce((s, r) => s + (Number(r.sell_price) || 0), 0);
      const bought = wr
        .filter((r) => Number(r.transfer_in) === 1)
        .reduce((s, r) => s + (Number(r.buy_price) || 0), 0);
      bank = Math.round((runningBank + sold - bought) * 10) / 10;
      // Free Hit squads revert after the week, so its spending doesn't carry.
      if (chipCode !== "FH") runningBank = bank;
    }

    const freeTransfers = Number.isFinite(Number(wr[0]?.ft))
      ? Math.round(Number(wr[0]!.ft))
      : null;
    const transferCount = wr.filter((r) => Number(r.transfer_in) === 1).length;
    const freeTransfersAfter =
      freeTransfers == null
        ? null
        : calculateEndingFreeTransfers(
            freeTransfers,
            transferCount,
            chipCode,
          );

    return {
      gameweek: week,
      chip: chipCode ? (CHIP_CODE[chipCode] ?? chipCode) : null,
      expectedPoints:
        Math.round(
          squadRows.reduce((s, r) => s + (Number(r.xp_cont) || 0), 0) * 100,
        ) / 100,
      baseExpectedPoints: factors
        ? Math.round(
            squadRows.reduce(
              (s, r) => s + (Number(r.xp_cont) || 0) / factorOf(r),
              0,
            ) * 100,
          ) / 100
        : null,
      bankBefore,
      bank,
      freeTransfers,
      freeTransfersAfter,
      lineup,
      bench,
      transfersIn: wr
        .filter((r) => Number(r.transfer_in) === 1)
        .map((r) => r.name),
      transfersOut: wr
        .filter((r) => Number(r.transfer_out) === 1)
        .map((r) => r.name),
    };
  });

  return {
    totalExpectedPoints:
      Math.round(gameweeks.reduce((s, g) => s + g.expectedPoints, 0) * 100) /
      100,
    totalBaseExpectedPoints: factors
      ? Math.round(
          gameweeks.reduce((s, g) => s + (g.baseExpectedPoints ?? 0), 0) * 100,
        ) / 100
      : null,
    gameweeks,
  };
}

/** Resolve player names (or numeric ids) against a projection CSV to FPL ids. */
export function resolvePlayerRefs(
  projectionId: string,
  refs: string[],
): { ids: number[]; unknown: string[]; ambiguous: string[] } {
  const ids: number[] = [];
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  const byName = new Map<string, number>();
  const dupNames = new Set<string>();
  const idSet = new Set<number>();
  try {
    const rows = parseCsv(
      fs.readFileSync(projectionCsvPath(projectionId), "utf-8"),
    );
    for (const r of rows) {
      const id = Number(r["ID"] ?? r["Id"] ?? r["id"]);
      const name = (r["Name"] ?? r["name"] ?? "").toLowerCase();
      if (Number.isFinite(id)) {
        idSet.add(id);
        if (name) {
          const prev = byName.get(name);
          if (prev != null && prev !== id) dupNames.add(name);
          byName.set(name, id);
        }
      }
    }
  } catch {
    // no readable projection — everything becomes unknown
  }
  for (const ref of refs) {
    const trimmed = ref.trim();
    if (!trimmed) continue;
    if (/^\d+$/.test(trimmed)) {
      const id = Number(trimmed);
      if (idSet.has(id)) ids.push(id);
      else unknown.push(trimmed);
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (dupNames.has(lower)) {
      ambiguous.push(trimmed);
      continue;
    }
    const id = byName.get(lower);
    if (id != null) ids.push(id);
    else unknown.push(trimmed);
  }
  return { ids, unknown, ambiguous };
}

function buildConfig(
  request: SolveRequest,
  datasource: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    datasource,
    horizon: request.horizon ?? 5,
    no_transfer_last_gws: 0,
    verbose: true,
    print_squads: false,
    print_result_table: false,
    print_decay_metrics: false,
    print_transfer_chip_summary: false,
    banned: [],
    locked: [],
    use_wc: [],
    use_bb: [],
    use_fh: [],
    use_tc: [],
  };

  if (request.firstGameweek) {
    config["preseason"] = true;
  } else {
    config["preseason"] = false;
    config["team_data"] = "id";
    config["team_id"] = request.teamId;
  }

  const forcedChipGws: Record<string, number[]> = {};
  for (const assignment of request.chips ?? []) {
    if (assignment.gameweek === 0) {
      // "Any": the solver must play this chip exactly once, timing optimized.
      const code = CHIP_CODE_SHORT[assignment.chip];
      const window = request.anyChipGws ?? [];
      if (code && window.length > 0) forcedChipGws[code] = window;
      continue;
    }
    const key = CHIP_OPTION[assignment.chip];
    if (key) {
      (config[key] as number[]).push(assignment.gameweek);
    }
  }
  if (Object.keys(forcedChipGws).length > 0) {
    config["forced_chip_gws"] = forcedChipGws;
  }

  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  const intClamp = (v: number, lo: number, hi: number) =>
    clamp(Math.round(v), lo, hi);

  const opts = request.options;
  if (opts) {
    if (opts.banned?.length) {
      config["banned"] = resolvePlayerRefs(request.projectionId, opts.banned).ids;
    }
    if (opts.locked?.length) {
      config["locked"] = resolvePlayerRefs(request.projectionId, opts.locked).ids;
    }
    if (opts.noTransferLastGws != null)
      config["no_transfer_last_gws"] = intClamp(opts.noTransferLastGws, 0, 37);
    if (opts.noFutureTransfer != null)
      config["no_future_transfer"] = opts.noFutureTransfer;
    if (opts.numTransfers != null)
      config["num_transfers"] = intClamp(opts.numTransfers, 0, 15);
    if (opts.hitLimit != null)
      config["hit_limit"] = intClamp(opts.hitLimit, 0, 20);
    if (opts.weeklyHitLimit != null)
      config["weekly_hit_limit"] = intClamp(opts.weeklyHitLimit, 0, 20);
    if (opts.decayBase != null)
      config["decay_base"] = clamp(opts.decayBase, 0.5, 1.2);
    if (opts.ftValue != null) config["ft_value"] = clamp(opts.ftValue, 0, 10);
    if (opts.itbValue != null) config["itb_value"] = clamp(opts.itbValue, 0, 5);
    if (opts.xminLb != null) config["xmin_lb"] = intClamp(opts.xminLb, 0, 5000);
    if (opts.secs != null) config["secs"] = intClamp(opts.secs, 10, MAX_SOLVE_SECS);
    if (opts.gap != null) config["gap"] = clamp(opts.gap, 0, 1);
    if (opts.randomized != null) config["randomized"] = opts.randomized;
    if (opts.opposingPlay != null) applyOpposingPlay(config, opts.opposingPlay);
    if (opts.bookedTransfers?.length) {
      // In first-gameweek mode there are no transfers in the first modeled
      // week (the squad is built from scratch), so a "booked transfer" for
      // that week is translated to a single-week squad constraint instead:
      // `in` forces the player into that week's squad, `out` keeps them out
      // of it — for that week only. The first modeled week is FPL's next
      // gameweek (server-computed startGw), not necessarily GW 1.
      const firstModeledGw = request.startGw ?? 1;
      const booked: Record<string, unknown>[] = [];
      const lockedNextGw: [number, number][] = [];
      const bannedNextGw: [number, number][] = [];
      for (const bt of opts.bookedTransfers) {
        const inId = bt.in
          ? resolvePlayerRefs(request.projectionId, [bt.in]).ids[0]
          : undefined;
        const outId = bt.out
          ? resolvePlayerRefs(request.projectionId, [bt.out]).ids[0]
          : undefined;
        if (request.firstGameweek && bt.gameweek === firstModeledGw) {
          if (inId != null) lockedNextGw.push([inId, bt.gameweek]);
          if (outId != null) bannedNextGw.push([outId, bt.gameweek]);
          continue;
        }
        const entry: Record<string, unknown> = { gw: bt.gameweek };
        if (inId != null) entry["transfer_in"] = inId;
        if (outId != null) entry["transfer_out"] = outId;
        booked.push(entry);
      }
      if (booked.length) config["booked_transfers"] = booked;
      if (lockedNextGw.length) config["locked_next_gw"] = lockedNextGw;
      if (bannedNextGw.length) config["banned_next_gw"] = bannedNextGw;
    }
    if (opts.numIterations != null && opts.numIterations > 1) {
      config["num_iterations"] = intClamp(opts.numIterations, 1, 5);
      config["iteration_criteria"] = "this_gw_transfer_in";
    }
    if (opts.benchWeights?.length === 4) {
      config["bench_weights"] = Object.fromEntries(
        opts.benchWeights.map((w, i) => [i, clamp(w, 0, 1)]),
      );
    }
  }

  // Mega-run scenarios: solver chooses chip timing within the allowed window.
  const chipMode = request.chipMode;
  if (chipMode && chipMode.available.length > 0 && chipMode.allowedGws.length > 0) {
    const allowed: Record<string, number[]> = {};
    for (const chip of chipMode.available) {
      const code = CHIP_CODE_SHORT[chip];
      if (code) allowed[code] = chipMode.allowedGws;
    }
    config["allowed_chip_gws"] = allowed;
  }

  return config;
}

const CHIP_CODE_SHORT: Record<string, string> = {
  wildcard: "wc",
  bench_boost: "bb",
  free_hit: "fh",
  triple_captain: "tc",
};

export function applyOpposingPlay(
  config: Record<string, unknown>,
  opposingPlay: string,
): void {
  if (opposingPlay === "penalty" || opposingPlay === "forbid") {
    // Only defensive-vs-attacking matchups (GK/DEF facing MID/FWD) are
    // targeted — attacker-vs-attacker matchups are not zero-sum.
    config["no_opposing_play"] = opposingPlay === "forbid" ? true : "penalty";
    config["opposing_play_group"] = "position";
    if (opposingPlay === "penalty") {
      // open-fpl-solver creates both directed forms of each defender-attacker
      // pair. Halve its per-variable value so one real clash costs 0.5 points.
      config["opposing_play_penalty"] = 0.25;
    }
  }
}

/**
 * Objective cost of one kept defender-attacker clash under opposingPlay
 * "penalty": the solver charges opposing_play_penalty (0.25) for each of the
 * two directed forms of the pair, so one real clash costs 0.5 points.
 */
export const OPPOSING_CLASH_PENALTY = 0.5;

/**
 * Annotate each gameweek of a plan with the zero-sum matchups (own starting
 * GK/DEF facing own starting MID/FWD in the same gameweek) that the solver
 * penalised in its objective, and the total deduction. Team names from the
 * solver CSV may be short codes or full names, so fixtures are matched on
 * both.
 */
export function annotateOpposingClashes(
  plan: SolvePlan,
  fixtures: FixtureInfo[],
): void {
  const canonByGw = new Map<number, Map<string, string>>();
  const pairsByGw = new Map<number, Set<string>>();
  for (const f of fixtures) {
    if (f.gameweek == null) continue;
    let canon = canonByGw.get(f.gameweek);
    let pairs = pairsByGw.get(f.gameweek);
    if (!canon) canonByGw.set(f.gameweek, (canon = new Map()));
    if (!pairs) pairsByGw.set(f.gameweek, (pairs = new Set()));
    canon.set(f.home, f.home);
    canon.set(f.away, f.away);
    canon.set(f.homeName, f.home);
    canon.set(f.awayName, f.away);
    pairs.add(`${f.home}|${f.away}`);
    pairs.add(`${f.away}|${f.home}`);
  }
  for (const gw of plan.gameweeks) {
    const canon = canonByGw.get(gw.gameweek);
    const pairs = pairsByGw.get(gw.gameweek);
    if (!canon || !pairs) continue;
    const defenders = gw.lineup.filter(
      (p) => p.position === "G" || p.position === "D",
    );
    const attackers = gw.lineup.filter(
      (p) => p.position === "M" || p.position === "F",
    );
    const clashes = [];
    for (const d of defenders) {
      for (const a of attackers) {
        const dt = canon.get(d.team);
        const at = canon.get(a.team);
        if (dt && at && pairs.has(`${dt}|${at}`)) {
          clashes.push({
            defender: d.name,
            defenderTeam: d.team,
            attacker: a.name,
            attackerTeam: a.team,
            penalty: OPPOSING_CLASH_PENALTY,
          });
        }
      }
    }
    if (clashes.length > 0) {
      gw.opposingClashes = clashes;
      gw.opposingPenalty =
        Math.round(clashes.length * OPPOSING_CLASH_PENALTY * 100) / 100;
    }
  }
}

const MAX_SOLVE_SECS = 30 * 60;

/** Child-process timeout: the solver's own (capped) time limit plus headroom. */
export function solveTimeoutMs(request: SolveRequest): number {
  const secs = request.options?.secs;
  const solverLimit =
    secs != null && secs > 0
      ? Math.min(secs, MAX_SOLVE_SECS) * 1000
      : 10 * 60 * 1000;
  return solverLimit + 5 * 60 * 1000;
}

/** Run the open-fpl-solver as a child process and persist the outcome on the run. */
export async function startSolve(
  runId: string,
  request: SolveRequest,
): Promise<void> {
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  // With a differential factor or pool filter, solve against a per-run copy
  // of the projection (adjusted scores and/or reduced player pool).
  const k = clampDifferentialFactor(request.differentialFactor ?? 0);
  const filter = request.poolFilter ?? null;
  const useAdjusted = k > 0 || filter != null;
  // Always solve against a per-run datasource so concurrent runs can never
  // pick up each other's result files (they are matched by datasource prefix).
  const datasource = `${request.projectionId}-r${runId}`;
  const cleanupAdjusted = () => {
    try {
      fs.unlinkSync(path.join(SOLVER_DATA_DIR, `${datasource}.csv`));
    } catch {
      // best-effort cleanup
    }
  };

  // Everything from projection preparation to process spawn shares one
  // failure boundary so a partially written per-run CSV never leaks.
  let factors: Map<string, number> | null = null;
  let child: ReturnType<typeof spawn>;
  let logStream: fs.WriteStream;
  let logPath: string;
  let startedAt: number;
  try {
    const currentTeam =
      !request.firstGameweek && request.teamId
        ? await getFplTeam(request.teamId)
        : null;
    if (useAdjusted) {
      let keepIds: Set<number> | null = null;
      if (filter) {
        keepIds = selectPool(computePoolStats(request.projectionId), filter);
        // Locked and booked players are always kept regardless of rank —
        // the solver must be able to see any player it is forced to use.
        const forcedRefs = [
          ...(request.options?.locked ?? []),
          ...(request.options?.bookedTransfers ?? []).flatMap((bt) =>
            [bt.in, bt.out].filter((x): x is string => !!x),
          ),
        ];
        if (forcedRefs.length > 0) {
          for (const id of resolvePlayerRefs(request.projectionId, forcedRefs)
            .ids) {
            keepIds.add(id);
          }
        }
        // When optimizing an existing team, the current squad must stay in
        // the pool — the solver can't sell players it can't see.
        if (currentTeam) {
          for (const p of currentTeam.squad) keepIds.add(p.playerId);
        }
      }
      const written = writeRunProjection(
        request.projectionId,
        datasource,
        k,
        keepIds,
      );
      factors = written.factors;
      if (filter) {
        updateRun(runId, { poolKept: written.kept, poolTotal: written.total });
      }
    } else {
      fs.copyFileSync(
        projectionCsvPath(request.projectionId),
        path.join(SOLVER_DATA_DIR, `${datasource}.csv`),
      );
    }
    if (currentTeam) {
      const addedIds = ensureSquadPlayersInProjection(
        path.join(SOLVER_DATA_DIR, `${datasource}.csv`),
        currentTeam.squad,
      );
      if (addedIds.length > 0) {
        logger.warn(
          { runId, playerIds: addedIds },
          "Added missing current-squad players to run projection",
        );
      }
    }

    const configPath = path.join(runDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(buildConfig(request, datasource), null, 2),
    );
    logPath = path.join(runDir, "solver.log");
    logStream = fs.createWriteStream(logPath);

    startedAt = Date.now();
    updateRun(runId, { status: "running" });

    child = spawn(
      "uv",
      ["run", "python", "run/solve.py", "--config", configPath],
      { cwd: SOLVER_REPO, env: { ...process.env } },
    );
  } catch (err) {
    cleanupAdjusted();
    updateRun(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: `Could not prepare the solve: ${(err as Error).message}`,
    });
    return;
  }

  // stdio defaults to "pipe", so stdout/stderr are always present.
  child.stdout!.pipe(logStream);
  child.stderr!.pipe(logStream);

  const timeout = setTimeout(() => {
    logger.warn({ runId }, "Solve timed out, killing solver process");
    child.kill("SIGKILL");
  }, solveTimeoutMs(request));

  child.on("error", (err) => {
    clearTimeout(timeout);
    cleanupAdjusted();
    logger.error({ err, runId }, "Failed to spawn solver");
    updateRun(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: `Failed to start solver: ${err.message}`,
    });
  });

  child.on("close", (code): void => {
    void (async () => {
    clearTimeout(timeout);
    logStream.end();
    try {
      if (code !== 0) {
        const tail = readLogTail(logPath);
        // The vendored solver crashes with KeyError: 'week' when the time
        // limit expires before ANY feasible plan is found (empty picks table).
        const noIncumbent = tail.includes("KeyError: 'week'");
        updateRun(runId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error:
            code === null
              ? "Solver timed out"
              : noIncumbent
                ? "The solver ran out of time before finding any valid plan. This scenario's search space is too large for the current time limit — increase the solve time (secs), shorten the horizon, or tighten the player pool, then try again."
                : `Solver exited with code ${code}. ${tail}`,
        });
        return;
      }

      const resultFiles = findResultFiles(datasource, startedAt);
      if (resultFiles.length === 0) {
        updateRun(runId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: `Solver finished but produced no result file. ${readLogTail(logPath)}`,
        });
        return;
      }

      // Starting bank for the money ledger: full budget in first-GW mode,
      // otherwise the team's actual in-the-bank amount from FPL.
      let startBank: number | null = request.firstGameweek ? 100 : null;
      if (!request.firstGameweek && request.teamId) {
        try {
          startBank = (await getFplTeam(request.teamId)).bank;
        } catch {
          // FPL unreachable — leave the bank unknown rather than guessing.
        }
      }

      const result = parseResultCsv(
        concatCsvFiles(resultFiles),
        priceMap(request.projectionId),
        factors,
        startBank,
        ownershipMap(request.projectionId),
      );
      // In first-gameweek mode the initial squad build is not a set of transfers.
      if (request.firstGameweek) {
        for (const p of [result, ...(result.alternatives ?? [])]) {
          if (p.gameweeks.length > 0) p.gameweeks[0]!.transfersIn = [];
        }
      }

      // With opposingPlay "penalty", surface any zero-sum matchups the
      // solver kept (and paid for) so the UI can explain the deduction.
      if (request.options?.opposingPlay === "penalty") {
        try {
          const fixtures = await getFixtures();
          for (const p of [result, ...(result.alternatives ?? [])]) {
            annotateOpposingClashes(p, fixtures);
          }
        } catch (err) {
          // FPL unreachable — skip the annotation rather than fail the run.
          logger.warn({ err, runId }, "Could not annotate opposing clashes");
        }
      }

      // "Any"-gameweek chips: measure the chip's raw-points value against a
      // second, no-chip baseline solve over the same data.
      let chipEval: ChipEval[] | null = null;
      let chipEvalError: string | null = null;
      const hasAnyChip = (request.chips ?? []).some((c) => c.gameweek === 0);
      if (hasAnyChip && result.gameweeks.some((gw) => gw.chip)) {
        try {
          const baseline = await runBaselineSolve(
            runId,
            request,
            datasource,
            factors,
            startBank,
            resultFiles,
          );
          chipEval = compareChipValue(
            result,
            baseline,
            request.options?.chipEvalWindow ?? CHIP_EVAL_WINDOW_GWS,
          );
        } catch (err) {
          chipEvalError = `Chip value comparison failed: ${(err as Error).message}`;
          logger.error({ err, runId }, "Baseline chip-eval solve failed");
        }
      }

      updateRun(runId, {
        status: "completed",
        completedAt: new Date().toISOString(),
        totalExpectedPoints: result.totalExpectedPoints,
        totalBaseExpectedPoints: result.totalBaseExpectedPoints ?? null,
        finalGapPercent: extractFinalGap(logPath),
        objective: extractObjective(logPath),
        chipEval,
        chipEvalError,
        result,
      });
      logger.info({ runId, resultFiles }, "Solve completed");
    } catch (err) {
      logger.error({ err, runId }, "Failed to parse solver result");
      updateRun(runId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: `Failed to parse solver result: ${(err as Error).message}`,
      });
    } finally {
      cleanupAdjusted();
    }
    })();
  });
}

/** Default total window (chip week included) over which chip value is measured. */
const CHIP_EVAL_WINDOW_GWS = 6;

const round2 = (x: number) => Math.round(x * 100) / 100;

function rawPointsInWindow(plan: SolvePlan, start: number, end: number): number {
  return plan.gameweeks
    .filter((gw) => gw.gameweek >= start && gw.gameweek <= end)
    .reduce((s, gw) => s + (gw.baseExpectedPoints ?? gw.expectedPoints), 0);
}

/** Chip value: unadjusted, undecayed points over the chip GW + subsequent GWs, vs the baseline. */
function compareChipValue(
  result: SolveResult,
  baseline: SolveResult,
  windowGws: number,
): ChipEval[] {
  const lastGw = result.gameweeks[result.gameweeks.length - 1]?.gameweek ?? 0;
  const window = Math.max(1, Math.round(windowGws));
  const evals: ChipEval[] = [];
  for (const gw of result.gameweeks) {
    if (!gw.chip) continue;
    const windowEnd = Math.min(gw.gameweek + window - 1, lastGw);
    const chipPoints = rawPointsInWindow(result, gw.gameweek, windowEnd);
    const baselinePoints = rawPointsInWindow(baseline, gw.gameweek, windowEnd);
    evals.push({
      chip: gw.chip,
      gameweek: gw.gameweek,
      windowStart: gw.gameweek,
      windowEnd,
      chipPoints: round2(chipPoints),
      baselinePoints: round2(baselinePoints),
      boost: round2(chipPoints - baselinePoints),
    });
  }
  return evals;
}

/** Solve the same request with all chips disabled, against the same per-run datasource. */
function runBaselineSolve(
  runId: string,
  request: SolveRequest,
  datasource: string,
  factors: Map<string, number> | null,
  startBank: number | null,
  primaryResultFiles: string[],
): Promise<SolveResult> {
  const runDir = path.join(RUNS_DIR, runId);
  const baselineRequest: SolveRequest = {
    ...request,
    chips: [],
    anyChipGws: null,
  };
  const config = buildConfig(baselineRequest, datasource);
  // The baseline is a point of comparison, not a plan — one solution is enough.
  config["num_iterations"] = 1;
  const configPath = path.join(runDir, "config-baseline.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const logPath = path.join(runDir, "solver-baseline.log");
  const logStream = fs.createWriteStream(logPath);
  const startedAt = Date.now();

  return new Promise<SolveResult>((resolve, reject) => {
    const child = spawn(
      "uv",
      ["run", "python", "run/solve.py", "--config", configPath],
      { cwd: SOLVER_REPO, env: { ...process.env } },
    );
    child.stdout!.pipe(logStream);
    child.stderr!.pipe(logStream);
    const timeout = setTimeout(() => {
      logger.warn({ runId }, "Baseline solve timed out, killing solver process");
      child.kill("SIGKILL");
    }, solveTimeoutMs(request));
    child.on("error", (err) => {
      clearTimeout(timeout);
      logStream.end();
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      logStream.end();
      try {
        if (code !== 0) {
          throw new Error(
            code === null
              ? "the baseline solve timed out"
              : `the baseline solver exited with code ${code}`,
          );
        }
        // The mtime check has slack, and the baseline starts seconds after the
        // primary solve finishes — exclude the primary's files explicitly.
        const files = findResultFiles(datasource, startedAt).filter(
          (f) => !primaryResultFiles.includes(f),
        );
        if (files.length === 0) {
          throw new Error("the baseline solve produced no result file");
        }
        resolve(
          parseResultCsv(
            concatCsvFiles(files),
            priceMap(request.projectionId),
            factors,
            startBank,
            ownershipMap(request.projectionId),
          ),
        );
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}

export interface SolveProgress {
  stage: string;
  message: string;
  gapPercent: number | null;
}

/** Derive a human-readable progress snapshot from the solver's log file. */
/**
 * Final optimality gap from the HiGHS "Solving report" section, e.g.
 * `  Gap               48.69% (tolerance: 10%)`. Null if not found.
 */
function extractFinalGap(logPath: string | null): number | null {
  if (!logPath) return null;
  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const m = /^\s*Gap\s+(\d+(?:\.\d+)?)%/m.exec(content);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function extractObjective(logPath: string | null): number | null {
  if (!logPath) return null;
  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const matches = [...content.matchAll(/^\s*(-?\d+(?:\.\d+)?)\s+\(objective\)/gm)];
    if (matches.length === 0) return null;
    // Multi-iteration solves log one objective per iteration; the optimal plan has the best value.
    return Math.max(...matches.map(m => Number(m[1])));
  } catch {
    return null;
  }
}

export function getRunProgress(
  runId: string,
  totalIterations = 1,
): SolveProgress {
  let content = "";
  try {
    content = fs.readFileSync(path.join(RUNS_DIR, runId, "solver.log"), "utf-8");
  } catch {
    // no log yet
  }

  // Multi-iteration runs solve once per plan, so the log repeats the
  // presolve → search → "Solving report" cycle. Count finished cycles and
  // only inspect the log tail after the last one for live progress.
  const total = Math.max(1, totalIterations);
  const reports = content.split("Solving report");
  const completed = reports.length - 1;
  const planTag =
    total > 1 ? `plan ${Math.min(completed + 1, total)} of ${total}: ` : "";

  if (completed >= total) {
    return {
      stage: "finalizing",
      message:
        total > 1
          ? `All ${total} plans found — writing out the solutions`
          : "Optimal plan found — writing out the solution",
      gapPercent: null,
    };
  }
  if (completed > 0) {
    // Progress parsing below should only see the in-flight iteration.
    content = reports[reports.length - 1]!;
  }

  // HiGHS branch-and-bound progress rows look like:
  //   "  0  0  0   0.00%   126.759  126.715   0.03%   7  5  4  2387  1.4s"
  // The FIRST percentage is B&B tree exploration, the LAST one is the
  // optimality gap; when the gap is unknown HiGHS prints "Large"/"inf"
  // instead, leaving only one percentage on the row. Only trust rows that
  // end with an elapsed-time token, and take the most recent finite gap.
  let gap: number | null = null;
  let bestPlan: string | null = null;
  let bestBound: string | null = null;
  let elapsed: string | null = null;
  for (const line of content.split("\n")) {
    if (!/\d+(?:\.\d+)?s\s*$/.test(line)) continue;
    const pcts = line.match(/\b\d+(?:\.\d+)?%/g);
    if (pcts && pcts.length >= 2) {
      const last = Number(pcts[pcts.length - 1]!.replace("%", ""));
      if (Number.isFinite(last)) {
        gap = last;
        // Row layout ends with: ... BestBound BestSol Gap% ... Time. Grab the
        // two numeric tokens immediately before the gap percentage.
        const tokens = line.trim().split(/\s+/);
        const gapIdx = tokens.lastIndexOf(pcts[pcts.length - 1]!);
        if (gapIdx >= 2) {
          const boundTok = tokens[gapIdx - 2];
          const solTok = tokens[gapIdx - 1];
          if (boundTok && /^-?\d+(?:\.\d+)?$/.test(boundTok)) bestBound = boundTok;
          if (solTok && /^-?\d+(?:\.\d+)?$/.test(solTok)) bestPlan = solTok;
        }
        const timeTok = tokens[tokens.length - 1];
        if (timeTok && /^\d+(?:\.\d+)?s$/.test(timeTok)) elapsed = timeTok;
      }
    } else if (pcts && pcts.length === 1 && /\b(Large|inf)\b/.test(line)) {
      gap = null; // gap column is Large/inf — genuinely unknown right now
      bestPlan = null;
      bestBound = null;
    }
  }

  if (content.includes("Solving MIP model") || content.includes("Presolving model")) {
    let message: string;
    if (gap != null) {
      const parts = [`current solution within ${gap.toFixed(2)}% of the theoretical best`];
      if (bestPlan != null) parts.push(`best plan so far scores ${Number(bestPlan).toFixed(2)} pts`);
      if (bestBound != null) parts.push(`theoretical ceiling ${Number(bestBound).toFixed(2)} pts`);
      if (elapsed != null) parts.push(`${elapsed} of solver time`);
      message = `Exploring transfer plans — ${parts.join(" · ")}`;
    } else if (content.includes("Solving MIP model")) {
      message =
        "Exploring transfer plans with the MIP solver — no feasible plan found yet, gap still unknown";
    } else {
      message = "Presolving the optimization model — simplifying constraints before the search starts";
    }
    return {
      stage: "solving",
      message: planTag ? `${planTag}${message}` : message,
      gapPercent: gap,
    };
  }

  const pool = /Filtered player pool from (\d+) to (\d+) players/.exec(content);
  if (pool) {
    return {
      stage: "pool",
      message: `Building the optimization model — player pool filtered from ${pool[1]} down to ${pool[2]} candidates`,
      gapPercent: null,
    };
  }

  if (content.length > 0) {
    return {
      stage: "preparing",
      message: "Solver started — fetching FPL data and loading the projection dataset",
      gapPercent: null,
    };
  }

  return {
    stage: "preparing",
    message: "Preparing the solver environment and loading projections",
    gapPercent: null,
  };
}

function readLogTail(logPath: string): string {
  try {
    const content = fs.readFileSync(logPath, "utf-8").trim();
    const lines = content.split("\n").filter((l) => l.trim());
    return lines.slice(-6).join(" | ").slice(-600);
  } catch {
    return "";
  }
}

/** Concatenate CSV files that share a header (keep the first header only). */
function concatCsvFiles(files: string[]): string {
  return files
    .map((f, i) => {
      const content = fs.readFileSync(f, "utf-8");
      if (i === 0) return content;
      const nl = content.indexOf("\n");
      return nl === -1 ? "" : content.slice(nl + 1);
    })
    .join("");
}

/**
 * All result CSVs for this run's datasource. Multi-iteration solves write one
 * file per iteration (suffix _0, _1, ...); sorted so iteration 0 comes first.
 */
function findResultFiles(datasource: string, startedAt: number): string[] {
  try {
    return fs
      .readdirSync(SOLVER_RESULTS_DIR)
      .filter((f) => f.startsWith(`${datasource}_`) && f.endsWith(".csv"))
      .map((f) => path.join(SOLVER_RESULTS_DIR, f))
      .filter((f) => fs.statSync(f).mtimeMs >= startedAt - 5000)
      .sort();
  } catch {
    return [];
  }
}

/** Re-mark any runs left in queued/running state (e.g. after a server restart). */
export function failStaleRuns(): void {
  const runs = listRunMetas();
  let changed = false;
  for (const run of runs) {
    if (run.status === "queued" || run.status === "running") {
      run.status = "failed";
      run.error = "Server restarted while the solve was in progress";
      run.completedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveRunMetas(runs);
}
