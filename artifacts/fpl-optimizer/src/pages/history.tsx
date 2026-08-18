import React from "react";
import { useListSolves, useDeleteSolve, getListSolvesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trash2, History, ChevronRight, Calculator, AlertCircle } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { formatChipStrategy, formatDifferentialFactor, formatPool } from "./solve";

export default function HistoryPage() {
  const { data: solves, isLoading } = useListSolves();
  const deleteMutation = useDeleteSolve();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.preventDefault(); // Prevent navigating
    deleteMutation.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSolvesQueryKey() });
        toast({ title: "Solve run deleted" });
      }
    });
  };

  if (isLoading) {
    return <div className="text-center py-20 text-muted-foreground font-mono animate-pulse">Loading history...</div>;
  }

  if (!solves || solves.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 animate-in fade-in">
        <div className="bg-muted p-6 rounded-full">
          <History className="h-12 w-12 text-muted-foreground opacity-50" />
        </div>
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">No optimization history</h2>
          <p className="text-muted-foreground max-w-sm">You haven't run any solves yet. Set up your first optimization to see results here.</p>
        </div>
        <Link href="/">
          <Button size="lg" className="mt-4 font-bold">Start Optimization</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-3">
          Run History
        </h1>
        <p className="text-muted-foreground mt-2">Past optimization runs and their outcomes.</p>
      </div>

      <div className="grid gap-4">
        {solves.map((solve) => (
          <Link key={solve.id} href={`/solves/${solve.id}`}>
            <Card className="cursor-pointer group hover:border-primary/50 transition-colors bg-card hover-elevate">
              <CardContent className="p-0">
                <div className="flex flex-col sm:flex-row items-center sm:items-stretch h-full">
                  
                  {/* Status Indicator Bar */}
                  <div className={`w-full sm:w-2 shrink-0 h-2 sm:h-auto rounded-t-lg sm:rounded-l-lg sm:rounded-tr-none ${
                    solve.status === 'completed' ? 'bg-green-500' :
                    solve.status === 'failed' ? 'bg-destructive' :
                    'bg-blue-500 animate-pulse'
                  }`} />

                  <div className="flex-1 p-5 grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
                    
                    {/* Meta info */}
                    <div className="md:col-span-4 space-y-1 text-center sm:text-left">
                      <div className="flex items-center justify-center sm:justify-start gap-2 mb-1">
                        <span className="font-mono text-sm text-muted-foreground">
                          {format(new Date(solve.createdAt), "MMM d, HH:mm")}
                        </span>
                        <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-wider">
                          {solve.status}
                        </Badge>
                      </div>
                      <h3 className="font-bold text-lg leading-tight truncate" title={solve.projectionFilename || "Unknown projection"}>
                        {solve.projectionFilename || "Unnamed Projection"}
                      </h3>
                      <p className="text-xs text-muted-foreground flex items-center justify-center sm:justify-start gap-1">
                        <Calculator className="h-3 w-3" />
                        {solve.request.horizon} GW horizon
                      </p>
                      {(formatChipStrategy(solve.request.chips) || formatDifferentialFactor(solve.request.differentialFactor) || formatPool(solve.poolKept, solve.poolTotal)) && (
                        <div className="flex flex-wrap items-center justify-center sm:justify-start gap-1 pt-1">
                          {formatChipStrategy(solve.request.chips)?.split(" · ").map((c) => (
                            <Badge key={c} variant="secondary" className="text-[10px] font-mono font-bold">{c}</Badge>
                          ))}
                          {formatDifferentialFactor(solve.request.differentialFactor) && (
                            <Badge variant="outline" className="text-[10px] font-mono font-bold border-primary/40 text-primary">
                              {formatDifferentialFactor(solve.request.differentialFactor)}
                            </Badge>
                          )}
                          {formatPool(solve.poolKept, solve.poolTotal) && (
                            <Badge variant="outline" className="text-[10px] font-mono font-bold">
                              {formatPool(solve.poolKept, solve.poolTotal)}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Team info */}
                    <div className="md:col-span-3 text-center sm:text-left hidden md:block">
                      <div className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1">Target</div>
                      <div className="font-mono bg-muted/40 px-2 py-1 rounded inline-block text-sm">
                        {solve.request.firstGameweek ? "First GW Mode" : `Team ${solve.request.teamId}`}
                      </div>
                    </div>

                    {/* Result */}
                    <div className="md:col-span-3 text-center sm:text-right">
                      {solve.status === 'completed' && solve.totalExpectedPoints && (
                        <div>
                          <div className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-1">
                            {solve.totalBaseExpectedPoints != null ? "Total xPts (base)" : "Total xPts"}
                          </div>
                          <div className="text-2xl font-black font-mono text-primary">
                            {(solve.totalBaseExpectedPoints ?? solve.totalExpectedPoints).toFixed(2)}
                          </div>
                          {solve.totalBaseExpectedPoints != null && (
                            <div className="text-xs font-mono text-muted-foreground">
                              adj {solve.totalExpectedPoints.toFixed(2)}
                            </div>
                          )}
                        </div>
                      )}
                      {solve.status === 'failed' && (
                        <div className="flex items-center justify-center sm:justify-end gap-2 text-destructive">
                          <AlertCircle className="h-5 w-5" />
                          <span className="text-sm font-semibold">Failed</span>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="md:col-span-2 flex justify-center sm:justify-end gap-2 items-center w-full">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity hidden sm:flex"
                        onClick={(e) => handleDelete(solve.id, e)}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <div className="p-2 bg-primary/5 rounded-full text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                        <ChevronRight className="h-5 w-5" />
                      </div>
                    </div>

                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}