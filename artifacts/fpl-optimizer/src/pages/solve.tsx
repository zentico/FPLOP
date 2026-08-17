import React, { useEffect, useRef } from "react";
import { useLocation, useParams } from "wouter";
import { useGetSolve, useDeleteSolve, useListFixtures } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ArrowRightLeft, Target, Trophy, Clock, AlertTriangle, ShieldCheck, Cctv, Info } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { format } from "date-fns";
import { getGetSolveQueryKey } from "@workspace/api-client-react";
import type { GameweekPlan, PickPlayer } from "@workspace/api-client-react";

export default function SolveDetail() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  
  // We want to poll every 2 seconds if status is queued or running
  const { data: solve, refetch } = useGetSolve(id!, {
    query: { enabled: !!id, queryKey: getGetSolveQueryKey(id!) }
  });

  useEffect(() => {
    let interval: number;
    if (solve && (solve.status === 'queued' || solve.status === 'running')) {
      interval = window.setInterval(() => {
        refetch();
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [solve?.status, refetch]);

  if (!solve) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
        <p className="text-muted-foreground font-mono">Loading solve context...</p>
      </div>
    );
  }

  const isPending = solve.status === 'queued' || solve.status === 'running';
  const isFailed = solve.status === 'failed';
  const isCompleted = solve.status === 'completed';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="icon" onClick={() => setLocation('/history')} className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
              Solve Result
              <StatusBadge status={solve.status} />
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Started {format(new Date(solve.createdAt), "MMM d, HH:mm:ss")}
            </p>
          </div>
        </div>
        
        {isCompleted && solve.totalExpectedPoints && (
          <div className="text-right bg-primary text-primary-foreground px-4 py-2 rounded-lg shadow-sm">
            <div className="text-xs uppercase tracking-wider font-semibold opacity-80">
              {solve.result?.totalBaseExpectedPoints != null ? "Total xPts (base)" : "Total xPts"}
            </div>
            <div className="text-3xl font-black font-mono tracking-tighter">
              {(solve.result?.totalBaseExpectedPoints ?? solve.totalExpectedPoints).toFixed(2)}
            </div>
            {solve.result?.totalBaseExpectedPoints != null && (
              <div className="text-xs font-mono opacity-80">adjusted {solve.totalExpectedPoints.toFixed(2)}</div>
            )}
          </div>
        )}
      </div>

      {isPending && (
        <Card className="border-primary/20 bg-primary/5 min-h-[40vh] flex flex-col items-center justify-center text-center animate-in fade-in duration-500">
          <div className="relative">
            <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full animate-pulse" />
            <Cctv className="h-16 w-16 text-primary mb-6 animate-bounce relative z-10" />
          </div>
          <h3 className="text-xl font-bold mb-2">Optimizer is running...</h3>
          <p className="text-muted-foreground max-w-md mx-auto">
            {solve.progress?.message ||
              `Exploring thousands of transfer combinations over a ${solve.request.horizon}-gameweek horizon to find the mathematically optimal path.`}
          </p>
          <SolveProgressBar progress={solve.progress ?? null} createdAt={solve.createdAt} />
          <div className="mt-8 flex gap-2">
            <div className="h-2 w-2 bg-primary rounded-full animate-ping" style={{ animationDelay: '0ms' }} />
            <div className="h-2 w-2 bg-primary rounded-full animate-ping" style={{ animationDelay: '150ms' }} />
            <div className="h-2 w-2 bg-primary rounded-full animate-ping" style={{ animationDelay: '300ms' }} />
          </div>
        </Card>
      )}

      {isFailed && (
        <Card className="border-destructive bg-destructive/5 animate-in fade-in">
          <CardContent className="pt-6 flex flex-col items-center text-center">
            <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
            <h3 className="text-lg font-bold text-destructive mb-2">Optimization Failed</h3>
            <p className="text-muted-foreground max-w-lg mb-6">{solve.error || "An unknown error occurred during processing."}</p>
            <Button variant="outline" onClick={() => setLocation('/')}>Start New Solve</Button>
          </CardContent>
        </Card>
      )}

      {isCompleted && solve.result && (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
          
          {/* Metadata Card */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="bg-card border rounded-lg p-4 shadow-sm">
              <div className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Projection</div>
              <div className="font-mono mt-1 text-sm truncate">{solve.projectionFilename}</div>
            </div>
            <div className="bg-card border rounded-lg p-4 shadow-sm">
              <div className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Team ID</div>
              <div className="font-mono mt-1 text-sm">{solve.request.firstGameweek ? "First GW Mode" : solve.request.teamId}</div>
            </div>
            <div className="bg-card border rounded-lg p-4 shadow-sm">
              <div className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Horizon</div>
              <div className="font-mono mt-1 text-sm">{solve.request.horizon} Gameweeks</div>
            </div>
            <div className="bg-card border rounded-lg p-4 shadow-sm">
              <div className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Strategy</div>
              <div className="font-mono mt-1 text-sm">
                {[
                  formatChipStrategy(solve.request.chips),
                  formatDifferentialFactor(solve.request.differentialFactor),
                  formatPool(solve.poolKept, solve.poolTotal),
                ]
                  .filter(Boolean)
                  .join(" · ") || "No chips · k 0%"}
              </div>
            </div>
            <div className="bg-card border rounded-lg p-4 shadow-sm">
              <div className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Compute Time</div>
              <div className="font-mono mt-1 text-sm">
                {solve.completedAt ? 
                  `${Math.round((new Date(solve.completedAt).getTime() - new Date(solve.createdAt).getTime()) / 1000)}s` 
                  : "-"}
              </div>
            </div>
          </div>

          {/* Gameweek Plans */}
          <Tabs defaultValue={`gw-${solve.result.gameweeks[0]?.gameweek}`} className="w-full">
            <div className="overflow-x-auto pb-2">
              <TabsList className="w-full justify-start inline-flex h-12">
                {solve.result.gameweeks.map(gw => (
                  <TabsTrigger 
                    key={gw.gameweek} 
                    value={`gw-${gw.gameweek}`}
                    className="px-6 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground font-mono"
                  >
                    GW {gw.gameweek}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {solve.result.gameweeks.map(gw => (
              <TabsContent key={gw.gameweek} value={`gw-${gw.gameweek}`} className="mt-6 focus-visible:outline-none">
                <GameweekView plan={gw} />
              </TabsContent>
            ))}
          </Tabs>

        </div>
      )}
    </div>
  );
}

const STAGES = ["preparing", "pool", "solving", "finalizing"] as const;
const STAGE_LABEL: Record<string, string> = {
  preparing: "Preparing",
  pool: "Building model",
  solving: "Optimizing",
  finalizing: "Finalizing",
};

function SolveProgressBar({
  progress,
  createdAt,
}: {
  progress: { stage: string; message: string; gapPercent?: number | null } | null;
  createdAt: string;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 1000));
  const stageIdx = Math.max(0, STAGES.indexOf((progress?.stage ?? "preparing") as (typeof STAGES)[number]));

  // During the solving stage, the optimality gap shrinking toward 0 is the
  // best available signal — map it onto the solving segment of the bar.
  let pct = (stageIdx / STAGES.length) * 100;
  if (progress?.stage === "solving") {
    const gap = progress.gapPercent;
    const within = gap != null && gap <= 100 ? 1 - gap / 100 : 0.1;
    pct = 50 + within * 25;
  } else if (progress?.stage === "finalizing") {
    pct = 90;
  } else if (progress?.stage === "pool") {
    pct = 30;
  } else {
    pct = 10;
  }

  return (
    <div className="w-full max-w-md mx-auto mt-8 space-y-2">
      <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-1000 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground font-mono">
        <span>
          {STAGE_LABEL[progress?.stage ?? "preparing"] ?? "Working"}
          {progress?.stage === "solving" && progress.gapPercent != null
            ? ` — gap ${progress.gapPercent.toFixed(2)}%`
            : ""}
        </span>
        <span>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'completed': return <Badge className="bg-green-500 hover:bg-green-600">Completed</Badge>;
    case 'failed': return <Badge variant="destructive">Failed</Badge>;
    case 'queued': return <Badge variant="outline" className="text-orange-500 border-orange-500">Queued</Badge>;
    case 'running': return <Badge className="bg-blue-500 animate-pulse">Running</Badge>;
    default: return <Badge variant="secondary">{status}</Badge>;
  }
}

interface FixtureChip {
  label: string;
  difficulty: number;
}

/** Returns FDR-based Tailwind classes for background and text. */
function fdrClasses(difficulty: number): string {
  if (difficulty <= 1) return "bg-teal-500 text-white";
  if (difficulty === 2) return "bg-green-400 text-white";
  if (difficulty === 3) return "bg-gray-200 text-gray-800 dark:bg-gray-600 dark:text-gray-100";
  if (difficulty === 4) return "bg-orange-400 text-white";
  return "bg-red-600 text-white";
}

/**
 * Map team identifier -> array of {label, difficulty} fixtures for the gameweek.
 * Keyed on both the FPL short code (e.g. "ARS") and the full name (e.g.
 * "Arsenal") so results from the solver CSV — which may use either format —
 * are matched correctly.
 */
function useOpponents(gameweek: number): { opponents: Map<string, FixtureChip[]>; fixturesLoading: boolean; fixturesError: boolean } {
  const { data: fixtures, isLoading: fixturesLoading, isError: fixturesError } = useListFixtures();
  const opponents = React.useMemo(() => {
    const raw = new Map<string, FixtureChip[]>();
    for (const f of fixtures ?? []) {
      if (f.gameweek !== gameweek) continue;
      raw.set(f.home, [
        ...(raw.get(f.home) ?? []),
        { label: `${f.away} (H)`, difficulty: f.homeDifficulty ?? 3 },
      ]);
      raw.set(f.away, [
        ...(raw.get(f.away) ?? []),
        { label: `${f.home} (A)`, difficulty: f.awayDifficulty ?? 3 },
      ]);
    }
    const map = new Map<string, FixtureChip[]>();
    for (const [key, chips] of raw) {
      map.set(key, chips);
    }
    // Also key on full names so solver results that use full names match too
    for (const f of fixtures ?? []) {
      if (f.gameweek !== gameweek) continue;
      if (f.homeName && !map.has(f.homeName)) {
        const chips = raw.get(f.home);
        if (chips) map.set(f.homeName, chips);
      }
      if (f.awayName && !map.has(f.awayName)) {
        const chips = raw.get(f.away);
        if (chips) map.set(f.awayName, chips);
      }
    }
    return map;
  }, [fixtures, gameweek]);
  return { opponents, fixturesLoading, fixturesError };
}

function FixtureCell({ chips, fixturesLoading, fixturesError }: {
  chips: FixtureChip[] | undefined;
  fixturesLoading: boolean;
  fixturesError: boolean;
}) {
  if (fixturesLoading) {
    return <div className="h-4 w-20 bg-muted animate-pulse rounded" />;
  }
  if (fixturesError || !chips || chips.length === 0) {
    return <span className="text-xs font-mono text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <span
          key={i}
          className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-bold font-mono leading-tight ${fdrClasses(c.difficulty)}`}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

function FixtureColumnHead({ fixturesError }: { fixturesError: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      Fixture
      {fixturesError && (
        <span title="Fixture data unavailable — FPL API may be slow or down">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        </span>
      )}
    </div>
  );
}

const CHIP_ABBR: Record<string, string> = {
  wildcard: "WC",
  bench_boost: "BB",
  free_hit: "FH",
  triple_captain: "TC",
};

/** e.g. "BB GW1 · WC GW7" from a run's chip assignments. */
export function formatChipStrategy(
  chips: { chip: string; gameweek: number }[] | null | undefined,
): string | null {
  if (!chips?.length) return null;
  return [...chips]
    .sort((a, b) => a.gameweek - b.gameweek)
    .map((c) => `${CHIP_ABBR[c.chip] ?? c.chip.toUpperCase()} GW${c.gameweek}`)
    .join(" · ");
}

/** e.g. "Pool 111/568" when a player-pool filter was applied. */
export function formatPool(
  kept: number | null | undefined,
  total: number | null | undefined,
): string | null {
  if (kept == null || total == null) return null;
  return `Pool ${kept}/${total}`;
}

/** e.g. "k 20%" when a differential factor was applied. */
export function formatDifferentialFactor(
  k: number | null | undefined,
): string | null {
  if (!k || k <= 0) return null;
  return `k ${Math.round(k * 1000) / 10}%`;
}

function GameweekView({ plan }: { plan: GameweekPlan }) {
  const { opponents, fixturesLoading, fixturesError } = useOpponents(plan.gameweek);
  const transfersInSet = React.useMemo(
    () => new Set(plan.transfersIn),
    [plan.transfersIn],
  );
  const hasBase = plan.baseExpectedPoints != null;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      
      {/* Sidebar: Overview & Transfers */}
      <div className="space-y-6">
        <Card className="bg-gradient-to-br from-card to-muted/30 border-primary/20">
          <CardContent className="pt-6">
            <div className="flex justify-between items-end mb-6">
              <div>
                <div className="text-sm text-muted-foreground font-medium mb-1">
                  {plan.baseExpectedPoints != null ? "Expected Points (base)" : "Expected Points"}
                </div>
                <div className="text-4xl font-black font-mono tracking-tighter text-primary">
                  {(plan.baseExpectedPoints ?? plan.expectedPoints).toFixed(2)}
                </div>
                {plan.baseExpectedPoints != null && (
                  <div className="text-sm font-mono text-muted-foreground mt-1">
                    adjusted {plan.expectedPoints.toFixed(2)}
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="text-sm text-muted-foreground font-medium mb-1">Bank</div>
                <div className="text-xl font-bold font-mono">£{(plan.bank || 0).toFixed(1)}</div>
              </div>
            </div>

            {plan.chip && (
              <div className="mt-4 pt-4 border-t flex items-center gap-2 text-primary font-bold">
                <Target className="h-5 w-5" />
                <span className="capitalize">{plan.chip.replace('_', ' ')} Played</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5 text-muted-foreground" />
              Transfers
            </CardTitle>
          </CardHeader>
          <CardContent>
            {plan.transfersIn.length === 0 && plan.transfersOut.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground text-sm bg-muted/20 rounded-md border border-dashed">
                Roll transfer
              </div>
            ) : (
              <div className="space-y-4">
                {plan.transfersOut.length > 0 && (
                  <div>
                    <div className="text-xs font-bold text-destructive uppercase tracking-wider mb-2">Transfers Out</div>
                    <ul className="space-y-2">
                      {plan.transfersOut.map((name, i) => (
                        <li key={i} className="flex justify-between text-sm bg-destructive/5 px-3 py-2 rounded border border-destructive/10">
                          <span className="font-medium text-destructive">{name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {plan.transfersIn.length > 0 && (
                  <div>
                    <div className="text-xs font-bold text-primary uppercase tracking-wider mb-2">Transfers In</div>
                    <ul className="space-y-2">
                      {plan.transfersIn.map((name, i) => (
                        <li key={i} className="flex justify-between text-sm bg-primary/5 px-3 py-2 rounded border border-primary/20">
                          <span className="font-medium text-primary">{name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Main: Lineup */}
      <div className="lg:col-span-2 space-y-6">
        <Card>
          <CardHeader className="border-b bg-muted/10 pb-4">
            <CardTitle className="text-xl">Starting XI</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-b">
                  <TableHead className="w-12 text-center">Pos</TableHead>
                  <TableHead>Player</TableHead>
                  <TableHead className="hidden md:table-cell">Team</TableHead>
                  <TableHead><FixtureColumnHead fixturesError={fixturesError} /></TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  {hasBase && <TableHead className="text-right">Base xPts</TableHead>}
                  <TableHead className="text-right pr-6">{hasBase ? "Adj xPts" : "xPts"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Group by position order: G, D, M, F */}
                {['G', 'D', 'M', 'F'].map(pos => {
                  const players = plan.lineup.filter(p => p.position === pos);
                  return players.map((player, idx) => {
                    const isTransferIn = transfersInSet.has(player.name);
                    return (
                      <TableRow key={`${pos}-${idx}`} className={`group hover:bg-muted/30 ${isTransferIn ? "bg-primary/8 dark:bg-primary/12" : ""}`}>
                        <TableCell className="text-center font-mono font-bold text-muted-foreground border-r bg-muted/10">{pos}</TableCell>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {player.name}
                            {isTransferIn && <Badge className="px-1.5 py-0 h-5 text-[10px] bg-primary/20 text-primary border border-primary/30" variant="outline">IN</Badge>}
                            {player.isCaptain && <Badge className="px-1.5 py-0 h-5 text-[10px] bg-primary">C</Badge>}
                            {player.isViceCaptain && <Badge variant="outline" className="px-1.5 py-0 h-5 text-[10px]">V</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{player.team}</TableCell>
                        <TableCell>
                          <FixtureCell chips={opponents.get(player.team)} fixturesLoading={fixturesLoading} fixturesError={fixturesError} />
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">£{player.price.toFixed(1)}</TableCell>
                        {hasBase && (
                          <TableCell className="text-right font-mono text-sm text-muted-foreground">
                            {((player.basePoints ?? 0) * (player.isCaptain ? (plan.chip === 'triple_captain' ? 3 : 2) : 1)).toFixed(2)}
                          </TableCell>
                        )}
                        <TableCell className="text-right pr-6 font-mono font-bold text-primary">
                          {(player.expectedPoints * (player.isCaptain ? (plan.chip === 'triple_captain' ? 3 : 2) : 1)).toFixed(2)}
                        </TableCell>
                      </TableRow>
                    );
                  });
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b bg-muted/10 py-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              Bench
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-b">
                  <TableHead className="w-12 text-center">#</TableHead>
                  <TableHead className="w-12 text-center">Pos</TableHead>
                  <TableHead>Player</TableHead>
                  <TableHead className="hidden md:table-cell">Team</TableHead>
                  <TableHead><FixtureColumnHead fixturesError={fixturesError} /></TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  {hasBase && <TableHead className="text-right">Base xPts</TableHead>}
                  <TableHead className="text-right pr-6">{hasBase ? "Adj xPts" : "xPts"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Sort bench by benchOrder 0-3 (0 is GK usually) */}
                {[...plan.bench].sort((a, b) => (a.benchOrder ?? 99) - (b.benchOrder ?? 99)).map((player) => {
                  const isTransferIn = transfersInSet.has(player.name);
                  return (
                    <TableRow key={player.name} className={`transition-opacity hover:opacity-100 ${isTransferIn ? "opacity-90 bg-primary/8 dark:bg-primary/12" : "opacity-70"}`}>
                      <TableCell className="w-12 text-center font-mono text-xs border-r bg-muted/10">
                        {player.benchOrder === 0 ? 'GK' : player.benchOrder}
                      </TableCell>
                      <TableCell className="w-12 text-center font-mono font-bold text-muted-foreground">{player.position}</TableCell>
                      <TableCell className="font-medium text-sm">
                        <div className="flex items-center gap-2">
                          {player.name}
                          {isTransferIn && <Badge className="px-1.5 py-0 h-5 text-[10px] bg-primary/20 text-primary border border-primary/30" variant="outline">IN</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{player.team}</TableCell>
                      <TableCell>
                        <FixtureCell chips={opponents.get(player.team)} fixturesLoading={fixturesLoading} fixturesError={fixturesError} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">£{player.price.toFixed(1)}</TableCell>
                      {hasBase && (
                        <TableCell className="text-right font-mono text-sm text-muted-foreground">
                          {(player.basePoints ?? 0).toFixed(2)}
                        </TableCell>
                      )}
                      <TableCell className="text-right pr-6 font-mono font-bold">{player.expectedPoints.toFixed(2)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

    </div>
  );
}
