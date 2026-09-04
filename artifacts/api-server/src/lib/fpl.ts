const BASE_URL = "https://fantasy.premierleague.com/api";

interface BootstrapElement {
  id: number;
  code: number;
  web_name: string;
  first_name?: string;
  second_name?: string;
  selected_by_percent: string;
  team: number;
  element_type: number;
  now_cost: number;
  ep_next?: string | null;
}

interface BootstrapTeam {
  id: number;
  short_name: string;
  name: string;
}

interface BootstrapEvent {
  id: number;
  is_next: boolean;
  finished: boolean;
  deadline_time: string;
}

export interface Bootstrap {
  elements: BootstrapElement[];
  teams: BootstrapTeam[];
  events: BootstrapEvent[];
}

let bootstrapCache: { data: Bootstrap; at: number } | null = null;

type FetchLike = typeof fetch;

const RETRYABLE_FPL_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Fetch FPL JSON with short bounded retries for transient upstream failures.
 * Optional dependencies make retry behavior deterministic in unit tests.
 */
export async function fplFetch<T>(
  path: string,
  options: {
    fetchImpl?: FetchLike;
    sleep?: (milliseconds: number) => Promise<void>;
    attempts?: number;
  } = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = Math.max(1, options.attempts ?? 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(`${BASE_URL}${path}`, {
        headers: { "User-Agent": "Mozilla/5.0 (fpl-optimizer)" },
      });
      if (res.ok) return (await res.json()) as T;
      const error = Object.assign(
        new Error(`FPL API ${res.status} for ${path}`),
        { status: res.status },
      );
      if (!RETRYABLE_FPL_STATUSES.has(res.status) || attempt === attempts) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      if (
        (typeof status === "number" && !RETRYABLE_FPL_STATUSES.has(status)) ||
        attempt === attempts
      ) {
        throw error;
      }
      lastError = error;
    }
    // 250ms before the second attempt, then 750ms before the third.
    await sleep(250 * (attempt * 2 - 1));
  }
  throw lastError;
}

export async function getBootstrap(): Promise<Bootstrap> {
  if (bootstrapCache && Date.now() - bootstrapCache.at < 10 * 60 * 1000) {
    return bootstrapCache.data;
  }
  const data = await fplFetch<Bootstrap>("/bootstrap-static/");
  bootstrapCache = { data, at: Date.now() };
  return data;
}

const POSITIONS: Record<number, string> = { 1: "G", 2: "D", 3: "M", 4: "F" };

interface RawFixture {
  event: number | null;
  team_h: number;
  team_a: number;
  team_h_difficulty: number;
  team_a_difficulty: number;
}

export interface FixtureInfo {
  gameweek: number | null;
  home: string;
  away: string;
  homeName: string;
  awayName: string;
  /** FDR 1-5 for the home team in this fixture */
  homeDifficulty: number;
  /** FDR 1-5 for the away team in this fixture */
  awayDifficulty: number;
}

let fixturesCache: { data: FixtureInfo[]; at: number } | null = null;

export async function getFixtures(): Promise<FixtureInfo[]> {
  if (fixturesCache && Date.now() - fixturesCache.at < 10 * 60 * 1000) {
    return fixturesCache.data;
  }
  const [bootstrap, raw] = await Promise.all([
    getBootstrap(),
    fplFetch<RawFixture[]>("/fixtures/"),
  ]);
  const teamShort = new Map(bootstrap.teams.map((t) => [t.id, t.short_name]));
  const teamFull = new Map(bootstrap.teams.map((t) => [t.id, t.name]));
  const data = raw.map((f) => ({
    gameweek: f.event,
    home: teamShort.get(f.team_h) ?? "?",
    away: teamShort.get(f.team_a) ?? "?",
    homeName: teamFull.get(f.team_h) ?? "?",
    awayName: teamFull.get(f.team_a) ?? "?",
    homeDifficulty: f.team_h_difficulty ?? 3,
    awayDifficulty: f.team_a_difficulty ?? 3,
  }));
  fixturesCache = { data, at: Date.now() };
  return data;
}

/** Season name derived from event deadlines, e.g. "2026/27". */
export async function getSeasonName(): Promise<string> {
  const bootstrap = await getBootstrap();
  const first = bootstrap.events[0];
  if (!first?.deadline_time) {
    throw new Error("FPL bootstrap has no event deadlines to derive the season from");
  }
  const y = new Date(first.deadline_time).getUTCFullYear();
  return `${y}/${String((y + 1) % 100).padStart(2, "0")}`;
}

/** All gameweek events with deadlines and finished flags. */
export async function getEvents(): Promise<
  { id: number; finished: boolean; deadline: string }[]
> {
  const bootstrap = await getBootstrap();
  return bootstrap.events.map((e) => ({
    id: e.id,
    finished: e.finished,
    deadline: e.deadline_time,
  }));
}

interface EventLiveElement {
  id: number;
  stats: { total_points: number; minutes: number };
}

/** Official per-player results for a gameweek from the event-live endpoint. */
export async function getEventLive(
  gameweek: number,
): Promise<{ id: number; points: number; minutes: number }[]> {
  const body = await fplFetch<{ elements: EventLiveElement[] }>(
    `/event/${gameweek}/live/`,
  );
  if (!Array.isArray(body.elements)) {
    throw new Error(`FPL event-live for GW${gameweek} had no elements array`);
  }
  return body.elements.map((e) => ({
    id: e.id,
    points: e.stats?.total_points ?? 0,
    minutes: e.stats?.minutes ?? 0,
  }));
}

export async function getGameweekInfo(): Promise<{
  nextGameweek: number;
  isFirstGameweek: boolean;
  deadline: string | null;
}> {
  const bootstrap = await getBootstrap();
  const next = bootstrap.events.find((e) => e.is_next);
  const nextGameweek = next ? next.id : 38;
  return {
    nextGameweek,
    isFirstGameweek: nextGameweek === 1,
    deadline: next ? next.deadline_time : null,
  };
}

interface Entry {
  id: number;
  name: string;
  player_first_name: string;
  player_last_name: string;
  summary_overall_rank: number | null;
  summary_overall_points: number | null;
  last_deadline_bank: number | null;
  current_event: number | null;
}

const FPL_CHIP_NAME: Record<string, string> = {
  wildcard: "wildcard",
  freehit: "free_hit",
  bboost: "bench_boost",
  "3xc": "triple_captain",
};

/** Chips the team has already played this season, from FPL entry history. */
export async function getTeamChipsPlayed(
  teamId: number,
): Promise<{ chip: string; gameweek: number }[]> {
  const history = await fplFetch<{
    chips?: { name: string; event: number }[];
  }>(`/entry/${teamId}/history/`);
  return (history.chips ?? [])
    .map((c) => ({ chip: FPL_CHIP_NAME[c.name] ?? c.name, gameweek: c.event }))
    .filter((c) => c.gameweek > 0);
}

interface EventPicks {
  picks: { element: number }[];
  entry_history?: { bank: number; total_points?: number };
}

export async function getFplTeam(teamId: number): Promise<{
  teamId: number;
  name: string;
  managerName: string;
  overallRank: number | null;
  totalPoints: number | null;
  bank: number;
  squad: {
    playerId: number;
    name: string;
    team: string;
    position: string;
    sellPrice: number;
  }[];
}> {
  let entry: Entry | null = null;
  let entryError: unknown;
  try {
    entry = await fplFetch<Entry>(`/entry/${teamId}/`);
  } catch (error) {
    entryError = error;
    const status = (error as { status?: unknown })?.status;
    if (typeof status === "number" && !RETRYABLE_FPL_STATUSES.has(status)) {
      throw error;
    }
  }
  const bootstrap = await getBootstrap();
  const elementById = new Map(bootstrap.elements.map((e) => [e.id, e]));
  const teamById = new Map(bootstrap.teams.map((t) => [t.id, t]));

  let squad: {
    playerId: number;
    name: string;
    team: string;
    position: string;
    sellPrice: number;
  }[] = [];
  let bank = (entry?.last_deadline_bank ?? 0) / 10;
  let picks: EventPicks | null = null;

  if (entry?.current_event) {
    picks = await fplFetch<EventPicks>(
      `/entry/${teamId}/event/${entry.current_event}/picks/`,
    );
  } else if (!entry) {
    // During FPL's post-deadline maintenance window, entry and history return
    // 503 while the latest completed picks remain available. Those picks are
    // the squad entering the next gameweek and are sufficient for a solve.
    const completedEvent = bootstrap.events
      .filter((event) => event.finished)
      .sort((a, b) => b.id - a.id)[0]?.id;
    const nextEvent = bootstrap.events.find((event) => event.is_next)?.id;
    const fallbackEvent = completedEvent ?? (nextEvent ? nextEvent - 1 : 0);
    if (fallbackEvent < 1) throw entryError;
    picks = await fplFetch<EventPicks>(
      `/entry/${teamId}/event/${fallbackEvent}/picks/`,
    );
  }

  if (picks) {
    if (picks.entry_history) {
      bank = picks.entry_history.bank / 10;
    }
    squad = picks.picks.map((p) => {
      const el = elementById.get(p.element);
      return {
        playerId: p.element,
        name: el?.web_name ?? `Player ${p.element}`,
        team: el ? (teamById.get(el.team)?.short_name ?? "?") : "?",
        position: el ? (POSITIONS[el.element_type] ?? "?") : "?",
        sellPrice: el ? el.now_cost / 10 : 0,
      };
    });
  }

  return {
    teamId: entry?.id ?? teamId,
    name: entry?.name ?? `FPL Team ${teamId}`,
    managerName: entry
      ? `${entry.player_first_name} ${entry.player_last_name}`.trim()
      : "",
    overallRank: entry?.summary_overall_rank ?? null,
    totalPoints:
      entry?.summary_overall_points ?? picks?.entry_history?.total_points ?? null,
    bank,
    squad,
  };
}
