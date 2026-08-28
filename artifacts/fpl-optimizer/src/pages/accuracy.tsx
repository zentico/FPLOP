import React from "react";
import {
  useGetAccuracy,
  useListResults,
  useRefreshResults,
  useGetAccuracyDetail,
  getGetAccuracyQueryKey,
  getListResultsQueryKey,
  getGetAccuracyDetailQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, RefreshCw, Target } from "lucide-react";

const fmt = (n: number | null | undefined, digits = 2) =>
  n == null ? "—" : n.toFixed(digits);

export default function AccuracyPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: entries, isLoading } = useGetAccuracy();
  const { data: results } = useListResults();
  const refreshMutation = useRefreshResults();

  const [sourceFilter, setSourceFilter] = React.useState<string>("all");
  const [gwFilter, setGwFilter] = React.useState<string>("all");
  const [detail, setDetail] = React.useState<{
    projectionId: string;
    gameweek: number;
    label: string;
  } | null>(null);

  const { data: misses, isLoading: missesLoading } = useGetAccuracyDetail(
    detail?.projectionId ?? "",
    detail?.gameweek ?? 0,
    {
      query: {
        enabled: !!detail,
        queryKey: getGetAccuracyDetailQueryKey(
          detail?.projectionId ?? "",
          detail?.gameweek ?? 0,
        ),
      },
    },
  );

  const sources = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries ?? []) m.set(e.source, e.sourceLabel);
    return [...m.entries()];
  }, [entries]);
  const gameweeks = React.useMemo(
    () => [...new Set((entries ?? []).map((e) => e.gameweek))].sort((a, b) => a - b),
    [entries],
  );

  const filtered = (entries ?? []).filter(
    (e) =>
      (sourceFilter === "all" || e.source === sourceFilter) &&
      (gwFilter === "all" || e.gameweek === Number(gwFilter)),
  );

  // Per-source summary over the filtered gameweeks. Average-based metrics are
  // weighted by sample size; CRPM is already a player-level sum, so gameweek
  // CRPM totals are added directly.
  const summary = React.useMemo(() => {
    const by = new Map<
      string,
      { label: string; n: number; mae: number; rmse2: number; bias: number; arpm: number; crpm: number; gws: Set<number> }
    >();
    for (const e of filtered) {
      const s = by.get(e.source) ?? {
        label: e.sourceLabel, n: 0, mae: 0, rmse2: 0, bias: 0, arpm: 0, crpm: 0, gws: new Set<number>(),
      };
      s.n += e.sampleSize;
      s.mae += e.mae * e.sampleSize;
      s.rmse2 += e.rmse * e.rmse * e.sampleSize;
      s.bias += e.bias * e.sampleSize;
      s.arpm += e.arpm * e.sampleSize;
      s.crpm += e.crpm;
      s.gws.add(e.gameweek);
      by.set(e.source, s);
    }
    return [...by.entries()]
      .map(([source, s]) => ({
        source,
        label: s.label,
        gameweeks: s.gws.size,
        sampleSize: s.n,
        mae: s.n ? s.mae / s.n : 0,
        rmse: s.n ? Math.sqrt(s.rmse2 / s.n) : 0,
        bias: s.n ? s.bias / s.n : 0,
        arpm: s.n ? s.arpm / s.n : 0,
        crpm: s.crpm,
      }))
      .sort((a, b) => a.arpm - b.arpm);
  }, [filtered]);

  const handleRefresh = () => {
    refreshMutation.mutate(undefined, {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListResultsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAccuracyQueryKey() });
        toast({
          title: data.archived.length
            ? `Archived official results for GW ${data.archived.join(", ")}`
            : "No new finished gameweeks to archive",
        });
      },
      onError: (err: any) => {
        toast({
          title: "Refresh failed",
          description: err?.data?.error || err?.error || "Could not fetch official results",
          variant: "destructive",
        });
      },
    });
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Prediction Accuracy</h1>
          <p className="text-muted-foreground mt-2">
            How each projection source's last pre-deadline snapshot compared with official FPL points.
          </p>
        </div>
        <Button onClick={handleRefresh} disabled={refreshMutation.isPending} variant="outline">
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
          {refreshMutation.isPending ? "Fetching…" : "Fetch official results"}
        </Button>
      </div>

      {!results?.length && !isLoading && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>No official results archived yet</AlertTitle>
          <AlertDescription>
            Click "Fetch official results" after a gameweek finishes. Accuracy is then computed
            against every snapshot that was imported before that gameweek's deadline.
          </AlertDescription>
        </Alert>
      )}

      {(entries?.length ?? 0) > 0 && (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <Select value={sourceFilter} onValueChange={setSourceFilter}>
              <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {sources.map(([key, label]) => (
                  <SelectItem key={key} value={key}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={gwFilter} onValueChange={setGwFilter}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All gameweeks</SelectItem>
                {gameweeks.map((gw) => (
                  <SelectItem key={gw} value={String(gw)}>GW {gw}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Target className="h-5 w-5 text-primary" />
                Source Summary
              </CardTitle>
              <CardDescription>
                 Sample-weighted averages over the selected gameweeks (CRPM is summed). Lower ARPM, CRPM, MAE, and RMSE
                are better; bias &gt; 0 means the source over-predicts. ARPM is 100 × the average
                absolute percentile-rank miss, with actual ranks taken across every official FPL
                 player so incomplete prediction sets are penalized. CRPM is the straight sum of
                 player misses after cubing inverse percentiles, giving misses among the
                 highest-ranked players more weight.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">GWs</TableHead>
                    <TableHead className="text-right">Players</TableHead>
                    <TableHead className="text-right">ARPM</TableHead>
                     <TableHead className="text-right">CRPM</TableHead>
                    <TableHead className="text-right">MAE</TableHead>
                    <TableHead className="text-right">RMSE</TableHead>
                    <TableHead className="text-right">Bias</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.map((s) => (
                    <TableRow key={s.source}>
                      <TableCell className="font-semibold">{s.label}</TableCell>
                      <TableCell className="text-right font-mono">{s.gameweeks}</TableCell>
                      <TableCell className="text-right font-mono">{s.sampleSize}</TableCell>
                      <TableCell className="text-right font-mono font-semibold">{fmt(s.arpm)}</TableCell>
                      <TableCell className="text-right font-mono font-semibold">{fmt(s.crpm)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(s.mae)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(s.rmse)}</TableCell>
                      <TableCell className="text-right font-mono">{s.bias > 0 ? "+" : ""}{fmt(s.bias)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>By Gameweek</CardTitle>
              <CardDescription>
                One row per source and gameweek, using the latest snapshot captured before that
                gameweek's deadline. Coverage is matched players over players who actually played —
                low coverage means the comparison is thin.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>GW</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Snapshot</TableHead>
                    <TableHead className="text-right">Players</TableHead>
                    <TableHead className="text-right">Coverage</TableHead>
                    <TableHead className="text-right">ARPM</TableHead>
                     <TableHead className="text-right">CRPM</TableHead>
                    <TableHead className="text-right">MAE</TableHead>
                    <TableHead className="text-right">RMSE</TableHead>
                    <TableHead className="text-right">Bias</TableHead>
                    <TableHead className="text-right">Corr</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((e) => (
                    <TableRow key={`${e.projectionId}-${e.gameweek}`}>
                      <TableCell className="font-mono">{e.gameweek}</TableCell>
                      <TableCell>
                        <div className="font-semibold">{e.sourceLabel}</div>
                        <div className="text-xs text-muted-foreground truncate max-w-[220px]">{e.projectionFilename}</div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">
                        {new Date(e.snapshotAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-mono">{e.sampleSize}</TableCell>
                      <TableCell className="text-right font-mono">
                        <span className={e.coverage < 0.7 ? "text-amber-600 dark:text-amber-500" : ""}>
                          {(e.coverage * 100).toFixed(0)}%
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono font-semibold">{fmt(e.arpm)}</TableCell>
                      <TableCell className="text-right font-mono font-semibold">{fmt(e.crpm)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(e.mae)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(e.rmse)}</TableCell>
                      <TableCell className="text-right font-mono">{e.bias > 0 ? "+" : ""}{fmt(e.bias)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(e.correlation)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() =>
                            setDetail({
                              projectionId: e.projectionId,
                              gameweek: e.gameweek,
                              label: `${e.sourceLabel} — GW ${e.gameweek}`,
                            })
                          }
                        >
                          Misses
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {detail && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>Largest Misses — {detail.label}</span>
                  <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>Close</Button>
                </CardTitle>
                <CardDescription>Biggest absolute prediction errors first.</CardDescription>
              </CardHeader>
              <CardContent>
                {missesLoading ? (
                  <p className="text-sm text-muted-foreground py-4">Loading…</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Player</TableHead>
                        <TableHead>Team</TableHead>
                        <TableHead>Pos</TableHead>
                        <TableHead className="text-right">Predicted</TableHead>
                        <TableHead className="text-right">Actual</TableHead>
                        <TableHead className="text-right">Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(misses ?? []).map((m) => (
                        <TableRow key={m.playerId}>
                          <TableCell className="font-semibold">{m.name}</TableCell>
                          <TableCell>{m.team}</TableCell>
                          <TableCell>{m.position}</TableCell>
                          <TableCell className="text-right font-mono">{fmt(m.predicted)}</TableCell>
                          <TableCell className="text-right font-mono">{m.actual}</TableCell>
                          <TableCell className="text-right font-mono">
                            <Badge variant={Math.abs(m.error) >= 4 ? "destructive" : "secondary"} className="font-mono">
                              {m.error > 0 ? "+" : ""}{fmt(m.error)}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {(results?.length ?? 0) > 0 && (entries?.length ?? 0) === 0 && !isLoading && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Results archived, but no comparable snapshots</AlertTitle>
          <AlertDescription>
            Accuracy only uses snapshots imported before a gameweek's deadline. Keep importing
            projections regularly; future finished gameweeks will show up here.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
