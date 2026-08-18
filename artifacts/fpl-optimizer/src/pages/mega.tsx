import React, { useEffect } from "react";
import { useGetMegaSolve } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertCircle, FlaskConical, ChevronRight, Loader2 } from "lucide-react";

const SCENARIO_LABEL: Record<string, string> = {
  none: "No chips (baseline)",
  free: "All chips available",
  "only-wildcard": "Wildcard only",
  "only-bench_boost": "Bench Boost only",
  "only-free_hit": "Free Hit only",
  "only-triple_captain": "Triple Captain only",
};

const CHIP_LABEL: Record<string, string> = {
  wildcard: "WC",
  bench_boost: "BB",
  free_hit: "FH",
  triple_captain: "TC",
};

function ScenarioStatus({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <Badge className="bg-green-500 hover:bg-green-600">Completed</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "running":
      return <Badge className="bg-blue-500 animate-pulse">Running</Badge>;
    default:
      return <Badge variant="secondary">Queued</Badge>;
  }
}

export default function MegaDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: mega, refetch } = useGetMegaSolve(id!, {
    query: { enabled: !!id, queryKey: ["mega", id] },
  });

  const isActive = mega && (mega.status === "queued" || mega.status === "running");
  useEffect(() => {
    if (!isActive) return;
    const t = window.setInterval(() => refetch(), 3000);
    return () => clearInterval(t);
  }, [isActive, refetch]);

  if (!mega) {
    return (
      <div className="text-center py-20 text-muted-foreground font-mono animate-pulse">
        Loading analysis...
      </div>
    );
  }

  const done = mega.scenarios.filter(
    (s) => s.status === "completed" || s.status === "failed",
  ).length;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <FlaskConical className="h-7 w-7 text-primary" />
            Chip Strategy Analysis
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">
            {mega.scenarios.length} sequential solves compare chip availability
            scenarios over a {mega.horizon}-gameweek horizon, covering only the
            chips this team can still play. Chips may only be played in GW
            {mega.chipWindow[0]}–{mega.chipWindow[mega.chipWindow.length - 1]}.
          </p>
          <p className="text-sm font-mono text-muted-foreground mt-1 break-all">
            {mega.projectionFilename}
          </p>
        </div>
        <ScenarioStatus status={mega.status} />
      </div>

      {isActive && (
        <div className="flex items-start gap-3 text-sm text-muted-foreground bg-muted/40 border rounded-lg p-4">
          <Loader2 className="h-4 w-4 animate-spin mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div>
              Running scenario {Math.min(done + 1, mega.scenarios.length)} of{" "}
              {mega.scenarios.length} — each solve runs to completion before
              the next starts, so this can take a while.
            </div>
            {(() => {
              const running = mega.scenarios.find((s) => s.status === "running");
              const p = running?.progress;
              if (!p) return null;
              return (
                <div className="font-mono text-xs text-foreground/80">
                  {SCENARIO_LABEL[running!.key] ?? running!.key}: {p.message}
                  {p.gapPercent != null && ` (gap ${p.gapPercent.toFixed(1)}%)`}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {mega.status === "failed" && mega.error && (
        <div className="flex items-center gap-3 text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-lg p-4">
          <AlertCircle className="h-4 w-4" />
          {mega.error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Scenario comparison</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-4">Scenario</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Chips played</th>
                  <th className="py-2 pr-4 text-right">Total xPts</th>
                  <th className="py-2 pr-4 text-right">Δ vs no chips</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {mega.scenarios.map((s) => (
                  <tr key={s.key} className="border-b last:border-0">
                    <td className="py-3 pr-4 font-medium">
                      {SCENARIO_LABEL[s.key] ?? s.key}
                    </td>
                    <td className="py-3 pr-4">
                      <ScenarioStatus status={s.status} />
                    </td>
                    <td className="py-3 pr-4">
                      {s.chips.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {s.chips.map((c) => (
                            <Badge key={c.chip} variant="outline" className="font-mono">
                              {CHIP_LABEL[c.chip] ?? c.chip} @ GW{c.gameweek}
                            </Badge>
                          ))}
                        </div>
                      ) : s.status === "completed" ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="text-muted-foreground">…</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono">
                      {s.totalExpectedPoints != null
                        ? s.totalExpectedPoints.toFixed(2)
                        : "—"}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono">
                      {s.deltaVsBaseline != null ? (
                        <span
                          className={
                            s.deltaVsBaseline > 0
                              ? "text-green-600 dark:text-green-400 font-bold"
                              : "text-muted-foreground"
                          }
                        >
                          {s.deltaVsBaseline >= 0 ? "+" : ""}
                          {s.deltaVsBaseline.toFixed(2)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <Link href={`/solves/${s.runId}`}>
                        <Button variant="ghost" size="sm">
                          View plan <ChevronRight className="h-4 w-4 ml-1" />
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            The Δ column is the incremental {mega.horizon}-gameweek points
            expectation vs. the no-chip baseline. Each "X only" row is the
            standalone value of that chip; "All chips available" shows how much
            they're worth when combined and sequenced optimally.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
