import React from "react";
import { useUploadProjection, useImportProjection, useGetFfhSessionStatus, useUpdateFfhSession, useListProjections, useDeleteProjection, useGetProjectionPlayers, useGetProjectionPoolStats, useGetGameweekInfo, useGetFplTeam, useCreateSolve, useCreateMegaSolve, getGetFplTeamQueryKey, getGetProjectionPlayersQueryKey, getGetProjectionPoolStatsQueryKey, getListProjectionsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { useLocation } from "wouter";
import { AlertCircle, UploadCloud, DownloadCloud, Download, Trash2, Database, ShieldAlert, Volleyball, Trophy, Banknote, Users, LineChart } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

function AdvField({ label, placeholder, hint, value, onChange }: {
  label: string;
  placeholder: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input inputMode="decimal" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

export default function Home() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // State
  const [projectionId, setProjectionId] = React.useState<string>("");
  const [firstGameweek, setFirstGameweek] = React.useState<boolean>(false);
  // Remembered across visits: defaults to the last team ID used.
  const [teamIdStr, setTeamIdStr] = React.useState<string>(
    () => localStorage.getItem("fplop.teamId") ?? "",
  );
  React.useEffect(() => {
    if (teamIdStr.trim()) localStorage.setItem("fplop.teamId", teamIdStr.trim());
  }, [teamIdStr]);
  const [horizon, setHorizon] = React.useState<number>(5);
  const [chips, setChips] = React.useState<Record<string, string>>({}); // chip type -> gameweek string
  const [chipThreshold, setChipThreshold] = React.useState("15"); // raw-points boost for a well-invested "Any" chip
  const [chipLowerThreshold, setChipLowerThreshold] = React.useState("10"); // below this the chip is poor value
  const [chipWindow, setChipWindow] = React.useState("6"); // total GWs over which chip value is measured
  const [diffFactorStr, setDiffFactorStr] = React.useState<string>("20");
  const [poolEnabled, setPoolEnabled] = React.useState(true);
  const [poolCounts, setPoolCounts] = React.useState({
    gkMain: "12", gkBench: "4",
    defMain: "32", defBench: "8",
    midMain: "32", midBench: "8",
    fwdMain: "20", fwdBench: "4",
  });
  const [showAdvanced, setShowAdvanced] = React.useState<boolean>(false);
  // Advanced solver settings — empty string means "solver default"
  const [adv, setAdv] = React.useState<Record<string, string>>({
    decayBase: "0.9",
    ftValue: "0.75",
    itbValue: "0.1",
    noTransferLastGws: "1",
    secs: "900",
    gap: "0.01",
  });
  const [advFlags, setAdvFlags] = React.useState<{ noFutureTransfer: boolean; randomized: boolean }>({ noFutureTransfer: false, randomized: false });
  // Booked transfers: moves the user has already decided on
  const [booked, setBooked] = React.useState<{ gw: string; inP: string; outP: string }[]>([]);
  const [opposingPlay, setOpposingPlay] = React.useState<"off" | "penalty" | "forbid">("penalty");

  // Queries
  const { data: projections, isLoading: isLoadingProjections } = useListProjections();
  const { data: gameweekInfo } = useGetGameweekInfo();
  
  const teamIdNum = teamIdStr ? parseInt(teamIdStr, 10) : undefined;
  const isTeamIdValid = teamIdNum && !isNaN(teamIdNum) && teamIdNum > 0;
  
  const { data: teamData, isLoading: isLoadingTeam, isError: isTeamError } = useGetFplTeam(
    isTeamIdValid ? teamIdNum : 0, 
    { query: { enabled: !!isTeamIdValid && !firstGameweek, retry: false, queryKey: getGetFplTeamQueryKey(isTeamIdValid ? teamIdNum : 0) } }
  );

  const { data: topPlayers } = useGetProjectionPlayers(projectionId, {
    query: { enabled: !!projectionId, queryKey: getGetProjectionPlayersQueryKey(projectionId) }
  });
  const { data: poolStats } = useGetProjectionPoolStats(projectionId, {
    query: { enabled: !!projectionId && poolEnabled, queryKey: getGetProjectionPoolStatsQueryKey(projectionId) }
  });

  // Parsed pool counts; NaN when a field is not a valid number.
  const poolNums = {
    gkMain: Number(poolCounts.gkMain), gkBench: Number(poolCounts.gkBench),
    defMain: Number(poolCounts.defMain), defBench: Number(poolCounts.defBench),
    midMain: Number(poolCounts.midMain), midBench: Number(poolCounts.midBench),
    fwdMain: Number(poolCounts.fwdMain), fwdBench: Number(poolCounts.fwdBench),
  };
  const poolValid = Object.values(poolNums).every(
    (n) => Number.isInteger(n) && n >= 0 && n <= 500,
  );

  // Live count of selected players. The rank-based selection always keeps
  // exactly min(main + bench, available) players per position, so only the
  // per-position availability matters for the count.
  const poolCount = React.useMemo(() => {
    if (!poolStats || !poolValid) return null;
    const counts: Record<string, number> = {
      G: poolNums.gkMain + poolNums.gkBench,
      D: poolNums.defMain + poolNums.defBench,
      M: poolNums.midMain + poolNums.midBench,
      F: poolNums.fwdMain + poolNums.fwdBench,
    };
    const avail: Record<string, number> = { G: 0, D: 0, M: 0, F: 0 };
    for (const p of poolStats) {
      if (p.position in avail) avail[p.position]!++;
    }
    const eligible = Object.keys(counts).reduce(
      (sum, pos) => sum + Math.min(counts[pos]!, avail[pos]!),
      0,
    );
    return { eligible, total: poolStats.length };
  }, [poolStats, poolValid, poolCounts]);

  // Full pool selection, mirroring the server's rank-based rule exactly
  // (same tie-breaks by player id). Locked players and, when optimizing an
  // existing team, the current squad are added on top.
  const poolSelection = React.useMemo(() => {
    if (!poolStats || !poolValid) return null;
    type P = NonNullable<typeof poolStats>[number];
    const counts: Record<string, [number, number]> = {
      G: [poolNums.gkMain, poolNums.gkBench],
      D: [poolNums.defMain, poolNums.defBench],
      M: [poolNums.midMain, poolNums.midBench],
      F: [poolNums.fwdMain, poolNums.fwdBench],
    };
    const lockedNames = new Set(
      (adv.locked ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    );
    const squadIds = new Set(
      !firstGameweek && teamData ? teamData.squad.map((p) => p.playerId) : [],
    );
    const byPos: Record<string, { player: P; extra: boolean }[]> = { G: [], D: [], M: [], F: [] };
    for (const pos of Object.keys(counts)) {
      const players = poolStats.filter((p) => p.position === pos);
      const value = (p: P) => (p.price > 0 ? p.ppm / p.price : 0);
      const rankOf = (sorted: P[]) => {
        const m = new Map<number, number>();
        sorted.forEach((p, i) => m.set(p.id, i + 1));
        return m;
      };
      const impactRank = rankOf([...players].sort((a, b) => b.ppm - a.ppm || a.id - b.id));
      const valueRank = rankOf([...players].sort((a, b) => value(b) - value(a) || a.id - b.id));
      const priceRank = rankOf([...players].sort((a, b) => a.price - b.price || a.id - b.id));
      const mainScore = (p: P) => (impactRank.get(p.id)! + valueRank.get(p.id)!) / 2;
      const benchScore = (p: P) => (priceRank.get(p.id)! + valueRank.get(p.id)!) / 2;
      const [mainN, benchN] = counts[pos]!;
      const byMain = [...players].sort(
        (a, b) => mainScore(a) - mainScore(b) || b.ppm - a.ppm || a.id - b.id,
      );
      const selected = new Set<number>();
      for (const p of byMain.slice(0, Math.max(0, mainN))) selected.add(p.id);
      const rest = byMain
        .slice(Math.max(0, mainN))
        .sort((a, b) => benchScore(a) - benchScore(b) || value(b) - value(a) || a.id - b.id);
      for (const p of rest.slice(0, Math.max(0, benchN))) selected.add(p.id);

      const list: { player: P; extra: boolean }[] = [];
      for (const p of players) {
        const isExtra = !selected.has(p.id) &&
          (squadIds.has(p.id) || lockedNames.has(p.name.toLowerCase()));
        if (selected.has(p.id) || isExtra) list.push({ player: p, extra: isExtra });
      }
      // Display order: horizon average points, best first.
      const horizonAvg = (p: P) => {
        const gws = p.gwPoints.slice(0, Math.max(1, horizon));
        return gws.length ? gws.reduce((a, b) => a + b, 0) / gws.length : 0;
      };
      list.sort((a, b) => horizonAvg(b.player) - horizonAvg(a.player) || a.player.id - b.player.id);
      byPos[pos] = list;
    }
    return byPos;
  }, [poolStats, poolValid, poolCounts, adv.locked, firstGameweek, teamData, horizon]);

  /** Average projected points over the planning horizon. */
  const horizonAvgPts = React.useCallback(
    (gwPoints: number[]) => {
      const gws = gwPoints.slice(0, Math.max(1, horizon));
      return gws.length ? gws.reduce((a, b) => a + b, 0) / gws.length : 0;
    },
    [horizon],
  );

  // Mutations
  const uploadMutation = useUploadProjection();
  const importMutation = useImportProjection();
  const updateSessionMutation = useUpdateFfhSession();
  const { data: ffhSession, refetch: refetchFfhSession } = useGetFfhSessionStatus();
  const [cookieInput, setCookieInput] = React.useState<string>("");
  const [showCookieField, setShowCookieField] = React.useState<boolean>(false);
  const deleteMutation = useDeleteProjection();
  const queryClient = useQueryClient();
  const createSolveMutation = useCreateSolve();
  const createMegaMutation = useCreateMegaSolve();

  // Handlers
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      uploadMutation.mutate({ data: { filename: file.name, content } }, {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: getListProjectionsQueryKey() });
          setProjectionId(data.id);
          toast({ title: "Projection uploaded successfully" });
        },
        onError: (err: any) => {
          toast({ 
            title: "Upload failed", 
            description: err?.error || "Invalid format", 
            variant: "destructive" 
          });
        }
      });
    };
    reader.readAsText(file);
  };

  const handleImport = (source: "ffh" | "drafthound" | "pundit" | "pundit-ffh" | "fantalens") => {
    importMutation.mutate({ data: { source } }, {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListProjectionsQueryKey() });
        setProjectionId(data.id);
        const coverage = data.sourcePlayerCount
          ? ` (matched ${data.playerCount} of ${data.sourcePlayerCount} feed players)`
          : "";
        toast({ title: "Predictions imported", description: `${data.playerCount} players, GW${data.gameweeks[0]}–${data.gameweeks[data.gameweeks.length - 1]}${coverage}` });
      },
      onError: (err: any) => {
        toast({
          title: "Import failed",
          description: err?.data?.error || err?.error || "Could not import predictions",
          variant: "destructive",
        });
      }
    });
  };

  const handleSaveCookie = () => {
    updateSessionMutation.mutate({ data: { cookie: cookieInput } }, {
      onSuccess: () => {
        setCookieInput("");
        setShowCookieField(false);
        refetchFfhSession();
        toast({ title: "Session updated", description: "The cookie was validated and saved." });
      },
      onError: (err: any) => {
        toast({
          title: "Cookie rejected",
          description: err?.data?.error || err?.error || "Could not validate the cookie",
          variant: "destructive",
        });
      }
    });
  };

  const handleDeleteProjection = (id: string) => {
    deleteMutation.mutate({ id }, {
      onSuccess: () => {
        if (projectionId === id) setProjectionId("");
        queryClient.invalidateQueries({ queryKey: getListProjectionsQueryKey() });
        toast({ title: "Projection deleted" });
      }
    });
  };

  const buildSolveRequest = () => {
    if (!projectionId) {
      toast({ title: "Missing projection", description: "Please select or upload a projection.", variant: "destructive" });
      return null;
    }
    if (!firstGameweek && !isTeamIdValid) {
      toast({ title: "Missing team ID", description: "Please enter a valid FPL team ID.", variant: "destructive" });
      return null;
    }
    
    const diffPct = Number(diffFactorStr);
    if (!Number.isFinite(diffPct) || diffPct < 0 || diffPct > 100) {
      toast({
        title: "Invalid differential factor",
        description: "Enter a percentage between 0 and 100 (0 = no adjustment).",
        variant: "destructive"
      });
      return null;
    }

    if (poolEnabled && !poolValid) {
      toast({
        title: "Invalid pool filter",
        description: "All pool counts must be whole numbers between 0 and 500.",
        variant: "destructive"
      });
      return null;
    }

    const chipsArray = Object.entries(chips).map(([chip, gw]) => ({
      chip,
      gameweek: parseInt(gw, 10)
    }));

    const num = (key: string) => {
      const v = adv[key]?.trim();
      if (!v) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const list = (key: string) => {
      const v = adv[key]?.trim();
      if (!v) return undefined;
      const items = v.split(",").map((s) => s.trim()).filter(Boolean);
      return items.length > 0 ? items : undefined;
    };
    const options = {
      banned: list("banned"),
      locked: list("locked"),
      noTransferLastGws: num("noTransferLastGws"),
      numTransfers: num("numTransfers"),
      hitLimit: num("hitLimit"),
      weeklyHitLimit: num("weeklyHitLimit"),
      decayBase: num("decayBase"),
      ftValue: num("ftValue"),
      itbValue: num("itbValue"),
      xminLb: num("xminLb"),
      secs: num("secs"),
      gap: num("gap"),
      noFutureTransfer: advFlags.noFutureTransfer || undefined,
      randomized: advFlags.randomized || undefined,
      opposingPlay: opposingPlay !== "off" ? opposingPlay : undefined,
      ...(Object.values(chips).includes("0")
        ? (() => {
            const num = (v: string, fallback: number) => {
              const n = Number(v.trim());
              return Number.isFinite(n) && n > 0 ? n : fallback;
            };
            return {
              chipEvalThreshold: num(chipThreshold, 15),
              chipEvalLowerThreshold: num(chipLowerThreshold, 10),
              chipEvalWindow: Math.round(num(chipWindow, 6)),
            };
          })()
        : {}),
      numIterations: num("numIterations"),
      benchWeights: (() => {
        const ws = ["bwGk", "bw1", "bw2", "bw3"].map((k) => adv[k]?.trim());
        if (ws.every((w) => !w)) return undefined;
        return ws.map((w, i) => {
          const n = Number(w);
          return w && Number.isFinite(n) ? n : [0.03, 0.21, 0.06, 0.002][i]!;
        });
      })(),
      bookedTransfers: (() => {
        const rows = booked
          .map((b) => ({
            // Blank GW falls back to the placeholder value (next gameweek)
            // instead of silently dropping the row.
            gameweek: b.gw.trim() ? parseInt(b.gw, 10) : currentGw,
            in: b.inP.trim() || undefined,
            out: b.outP.trim() || undefined,
          }))
          .filter((b) => Number.isFinite(b.gameweek) && (b.in || b.out));
        return rows.length > 0 ? rows : undefined;
      })(),
    };
    const hasOptions = Object.values(options).some((v) => v !== undefined);

    return {
      projectionId,
      firstGameweek,
      teamId: firstGameweek ? null : teamIdNum,
      horizon,
      differentialFactor: diffPct > 0 ? diffPct / 100 : undefined,
      poolFilter: poolEnabled ? poolNums : undefined,
      chips: chipsArray.length > 0 ? chipsArray : undefined,
      options: hasOptions ? options : undefined
    };
  };

  const handleStartSolve = () => {
    const data = buildSolveRequest();
    if (!data) return;
    createSolveMutation.mutate({ data }, {
      onSuccess: (run) => {
        setLocation(`/solves/${run.id}`);
      },
      onError: (err: any) => {
        toast({
          title: "Failed to start solver",
          description: err?.data?.error || err?.error || "Unknown error occurred.",
          variant: "destructive"
        });
      }
    });
  };

  const handleStartMega = () => {
    const data = buildSolveRequest();
    if (!data) return;
    createMegaMutation.mutate({ data }, {
      onSuccess: (mega) => {
        setLocation(`/mega/${mega.id}`);
      },
      onError: (err: any) => {
        toast({
          title: "Failed to start chip analysis",
          description: err?.data?.error || err?.error || "Unknown error occurred.",
          variant: "destructive"
        });
      }
    });
  };

  const currentGw = gameweekInfo?.nextGameweek || 1;
  const chipOptions = ["wildcard", "bench_boost", "free_hit", "triple_captain"];

  // Allow optimizing over every gameweek covered by the selected projection,
  // counting only the contiguous run starting at the next gameweek.
  const selectedProjection = projections?.find((p) => p.id === projectionId);
  const contiguousGws = React.useMemo(() => {
    const gws = selectedProjection?.gameweeks;
    if (!gws?.length) return 8;
    const start = gws.includes(currentGw) ? currentGw : gws[0];
    let n = 0;
    while (gws.includes(start + n)) n++;
    return n;
  }, [selectedProjection, currentGw]);
  const maxHorizon = Math.max(1, contiguousGws);
  const minHorizon = Math.min(2, maxHorizon);
  // Default the horizon to everything the selected dataset covers; manual
  // slider changes stick until the dataset (and thus its coverage) changes.
  React.useEffect(() => {
    setHorizon(maxHorizon);
  }, [projectionId, maxHorizon]);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">Run Optimization</h1>
        <p className="text-muted-foreground mt-2">Configure parameters and find the mathematically optimal sequence of transfers.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Left Column - Form */}
        <div className="lg:col-span-2 min-w-0 space-y-6">
          
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5 text-primary" />
                Data Source
              </CardTitle>
              <CardDescription>Upload or select a points projection CSV file.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              
              <Tabs defaultValue="select" className="w-full">
                <TabsList className="w-full grid grid-cols-3">
                  <TabsTrigger value="select">Select Existing</TabsTrigger>
                  <TabsTrigger value="upload">Upload New</TabsTrigger>
                  <TabsTrigger value="import">Import</TabsTrigger>
                </TabsList>
                
                <TabsContent value="select" className="mt-4">
                  {isLoadingProjections ? (
                    <div className="h-20 flex items-center justify-center text-muted-foreground text-sm">Loading projections...</div>
                  ) : !projections?.length ? (
                    <div className="text-center py-6 bg-muted/30 rounded-lg border border-dashed border-border text-muted-foreground">
                      <Database className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No projections available. Upload one.</p>
                    </div>
                  ) : (
                    <RadioGroup value={projectionId} onValueChange={setProjectionId} className="space-y-3">
                      {projections.map((p) => (
                        <div key={p.id} className={`flex items-center justify-between border rounded-lg p-4 transition-colors ${projectionId === p.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}>
                          <div className="flex items-center space-x-3">
                            <RadioGroupItem value={p.id} id={p.id} />
                            <Label htmlFor={p.id} className="flex flex-col cursor-pointer">
                              <span className="font-semibold flex items-center gap-2">
                                {p.filename}
                                {p.sourceLabel && (
                                  <Badge variant="secondary" className="text-[10px] font-normal">{p.sourceLabel}</Badge>
                                )}
                              </span>
                              <span className="text-xs text-muted-foreground font-mono mt-1">
                                {p.playerCount} players • GWs: {p.gameweeks.join(", ")}
                                {p.sourceUpdatedAt ? ` • source updated ${new Date(p.sourceUpdatedAt).toLocaleString()}` : ""}
                              </span>
                            </Label>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" asChild>
                              <a href={`${import.meta.env.BASE_URL}api/projections/${p.id}/csv`} download title="Download CSV">
                                <Download className="h-4 w-4" />
                              </a>
                            </Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => handleDeleteProjection(p.id)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </RadioGroup>
                  )}
                </TabsContent>
                
                <TabsContent value="upload" className="mt-4">
                  <div className="border-2 border-dashed border-border rounded-xl p-8 text-center hover:bg-muted/30 transition-colors">
                    <UploadCloud className="h-10 w-10 mx-auto text-primary mb-4" />
                    <Label htmlFor="file-upload" className="cursor-pointer text-sm font-medium">
                      <span className="text-primary hover:underline">Click to upload</span> or drag and drop
                    </Label>
                    <Input id="file-upload" type="file" accept=".csv" className="hidden" onChange={handleFileUpload} disabled={uploadMutation.isPending} />
                    <p className="text-xs text-muted-foreground mt-2 max-w-md mx-auto">
                      Requires columns: Pos, Name, Team, Price/Value, and per-gameweek "N_Pts" / "N_xMins" columns.
                    </p>
                    {uploadMutation.isPending && (
                      <p className="text-sm text-primary mt-4 font-medium animate-pulse">Uploading and processing...</p>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="import" className="mt-4 space-y-4">
                  <div className="border-2 border-dashed border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4 hover:bg-muted/30 transition-colors">
                    <DownloadCloud className="h-8 w-8 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1 text-left">
                      <p className="text-sm font-medium mb-1">Fantasy Football Hub</p>
                      <p className="text-xs text-muted-foreground">
                        Pull the latest points predictions, prices and ownership for the upcoming gameweeks directly from your Fantasy Football Hub membership.
                      </p>
                      {importMutation.isPending && (
                        <p className="text-xs text-primary mt-2 font-medium animate-pulse">Downloading predictions… this can take up to a minute.</p>
                      )}
                    </div>
                    <Button className="w-full sm:w-auto shrink-0" onClick={() => handleImport("ffh")} disabled={importMutation.isPending}>
                      {importMutation.isPending ? "Importing…" : "Import latest predictions"}
                    </Button>
                  </div>
                  <div className="border-2 border-dashed border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4 hover:bg-muted/30 transition-colors">
                    <DownloadCloud className="h-8 w-8 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1 text-left">
                      <p className="text-sm font-medium mb-1">DraftHound</p>
                      <p className="text-xs text-muted-foreground">
                        Import DraftHound's free expected points and minutes for the next five gameweeks. No account needed. Each import is saved as a dated snapshot so accuracy can be tracked over time.
                      </p>
                    </div>
                    <Button className="w-full sm:w-auto shrink-0" onClick={() => handleImport("drafthound")} disabled={importMutation.isPending} variant="secondary">
                      {importMutation.isPending ? "Importing…" : "Import DraftHound predictions"}
                    </Button>
                  </div>
                  <div className="border-2 border-dashed border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4 hover:bg-muted/30 transition-colors">
                    <DownloadCloud className="h-8 w-8 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1 text-left">
                      <p className="text-sm font-medium mb-1">Fantasy Football Pundit</p>
                      <p className="text-xs text-muted-foreground">
                        Import Pundit's free published points predictor for the current 6-gameweek horizon. Uses its assume-starting points (not its start-probability-adjusted points). No account needed; players are matched to official FPL ids by team, position and name.
                      </p>
                    </div>
                    <Button className="w-full sm:w-auto shrink-0" onClick={() => handleImport("pundit")} disabled={importMutation.isPending} variant="secondary">
                      {importMutation.isPending ? "Importing…" : "Import Pundit predictions"}
                    </Button>
                  </div>
                  <div className="border-2 border-dashed border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4 hover:bg-muted/30 transition-colors">
                    <DownloadCloud className="h-8 w-8 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1 text-left">
                      <p className="text-sm font-medium mb-1">FantaLens</p>
                      <p className="text-xs text-muted-foreground">
                        Import FantaLens' free public expected points and expected minutes for its full published horizon. Uses official FPL player ids directly; double-gameweek fixtures are summed. No account needed.
                      </p>
                    </div>
                    <Button className="w-full sm:w-auto shrink-0" onClick={() => handleImport("fantalens")} disabled={importMutation.isPending} variant="secondary">
                      {importMutation.isPending ? "Importing…" : "Import FantaLens predictions"}
                    </Button>
                  </div>
                  <div className="border-2 border-dashed border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4 hover:bg-muted/30 transition-colors">
                    <DownloadCloud className="h-8 w-8 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1 text-left">
                      <p className="text-sm font-medium mb-1">Pundit + FFH hybrid</p>
                      <p className="text-xs text-muted-foreground">
                        Fetches Pundit and Fantasy Football Hub together and combines them: <span className="font-mono">Pundit assume-starting points × clamp(FFH expected minutes ÷ 90, 0, 1)</span>. Saved as its own source so its accuracy is tracked separately.
                        {!ffhSession?.configured && " Requires a saved Hub session cookie (below)."}
                      </p>
                    </div>
                    <Button className="w-full sm:w-auto shrink-0" onClick={() => handleImport("pundit-ffh")} disabled={importMutation.isPending || !ffhSession?.configured} variant="secondary">
                      {importMutation.isPending ? "Importing…" : "Create hybrid snapshot"}
                    </Button>
                  </div>
                  <div className="mt-4 border rounded-lg p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">Hub session</p>
                        <p className="text-xs text-muted-foreground">
                          {ffhSession?.configured
                            ? "A session cookie is saved. Update it here when it expires."
                            : "No session cookie saved yet. Paste one to enable imports."}
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => setShowCookieField((v) => !v)}>
                        {showCookieField ? "Cancel" : "Update session cookie"}
                      </Button>
                    </div>
                    {showCookieField && (
                      <div className="mt-4 space-y-2">
                        <p className="text-xs text-muted-foreground">
                          Log in at fantasyfootballhub.co.uk, open developer tools → Application/Storage → Cookies, and copy the <span className="font-mono">appSession</span> value. If it's split into <span className="font-mono">appSession.0</span> and <span className="font-mono">appSession.1</span>, paste both values joined together (no spaces).
                        </p>
                        <div className="flex gap-2">
                          <Input
                            type="password"
                            placeholder="Paste appSession cookie value"
                            value={cookieInput}
                            onChange={(e) => setCookieInput(e.target.value)}
                            autoComplete="off"
                          />
                          <Button onClick={handleSaveCookie} disabled={!cookieInput.trim() || updateSessionMutation.isPending}>
                            {updateSessionMutation.isPending ? "Validating…" : "Save"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </TabsContent>
              </Tabs>

            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                Team Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div className="space-y-0.5">
                  <Label className="text-base font-semibold">First Gameweek Mode</Label>
                  <p className="text-sm text-muted-foreground">Build an optimal squad from scratch without an existing team.</p>
                </div>
                <Switch checked={firstGameweek} onCheckedChange={setFirstGameweek} />
              </div>

              {!firstGameweek && (
                <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                  <Label htmlFor="teamId">FPL Team ID</Label>
                  <div className="flex gap-3">
                    <Input 
                      id="teamId" 
                      placeholder="e.g. 123456" 
                      value={teamIdStr} 
                      onChange={(e) => setTeamIdStr(e.target.value)} 
                      className="font-mono max-w-[200px]"
                    />
                  </div>
                  
                  {isTeamError && (
                    <p className="text-sm text-destructive flex items-center gap-1 mt-2">
                      <ShieldAlert className="h-4 w-4" /> Team not found or invalid.
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Volleyball className="h-5 w-5 text-primary" />
                Solver Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-8">
              
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <Label>Planning Horizon</Label>
                  <span className="font-mono font-bold bg-primary/10 text-primary px-2 py-1 rounded-md">{horizon} GWs</span>
                </div>
                <Slider 
                  value={[horizon]} 
                  onValueChange={(v) => setHorizon(v[0])} 
                  max={maxHorizon} 
                  min={minHorizon} 
                  step={1} 
                  className="py-4"
                />
                <p className="text-xs text-muted-foreground">
                  Longer horizons are more accurate but take significantly more time to compute.
                  {selectedProjection ? ` The selected projection covers ${selectedProjection.gameweeks.length} gameweeks.` : ""}
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <Label htmlFor="diff-factor">Differential Factor (k)</Label>
                  <span className="font-mono font-bold bg-primary/10 text-primary px-2 py-1 rounded-md">{diffFactorStr || "0"}%</span>
                </div>
                <Input
                  id="diff-factor"
                  inputMode="decimal"
                  value={diffFactorStr}
                  onChange={(e) => setDiffFactorStr(e.target.value)}
                  placeholder="0"
                />
                <p className="text-xs text-muted-foreground">
                  Boosts low-ownership players: adjusted points = predicted × (1 + k × (100 − ownership%) / 100).
                  E.g. with k = 20%, a player at 71.8% ownership and 5.94 predicted points is optimized at 6.28.
                  Set 0 to optimize on raw predictions. Requires ownership data (Hub imports include it).
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <Switch id="pool-filter" checked={poolEnabled} onCheckedChange={setPoolEnabled} />
                    <Label htmlFor="pool-filter" className="cursor-pointer">Filter Player Pool</Label>
                  </div>
                  {poolEnabled && (
                    <div className="flex items-center gap-2">
                      {poolSelection && (
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button variant="outline" size="sm" className="h-7 text-xs">View pool</Button>
                          </DialogTrigger>
                          <DialogContent className="max-w-6xl max-h-[85vh] overflow-y-auto">
                            <DialogHeader>
                              <DialogTitle>Selected Player Pool</DialogTitle>
                            </DialogHeader>
                            <p className="text-xs text-muted-foreground -mt-2">
                              Sorted by average projected points over the {horizon}-GW planning horizon.
                              <span className="bg-primary/15 rounded px-1 mx-1">Shaded</span> players are locked or in
                              your current squad and are always kept, even outside the ranked selection.
                            </p>
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                              {([["G", "Goalkeepers"], ["D", "Defenders"], ["M", "Midfielders"], ["F", "Forwards"]] as const).map(([pos, label]) => (
                                <div key={pos}>
                                  <div className="font-bold text-sm mb-2 sticky top-0 bg-background py-1">
                                    {label} <span className="text-muted-foreground font-normal">({poolSelection[pos]!.length})</span>
                                  </div>
                                  <div className="space-y-1">
                                    <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-2 text-[11px] text-muted-foreground font-semibold uppercase tracking-wide">
                                      <span>#</span><span>Player</span><span className="text-right">£m</span><span className="text-right">Pts</span>
                                    </div>
                                    {poolSelection[pos]!.map(({ player, extra }, i) => (
                                      <div
                                        key={player.id}
                                        className={`grid grid-cols-[auto_1fr_auto_auto] gap-x-2 text-xs items-baseline ${extra ? "bg-primary/15 rounded px-1 -mx-1" : ""}`}
                                      >
                                        <span className="font-mono text-muted-foreground w-6">{i + 1}</span>
                                        <span className="truncate">
                                          {player.name}
                                          <span className="text-muted-foreground"> {player.team}</span>
                                        </span>
                                        <span className="font-mono text-right">{player.price.toFixed(1)}</span>
                                        <span className="font-mono text-right">{horizonAvgPts(player.gwPoints).toFixed(2)}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </DialogContent>
                        </Dialog>
                      )}
                      <span className="font-mono font-bold bg-primary/10 text-primary px-2 py-1 rounded-md text-sm">
                        {poolCount ? `${poolCount.eligible} of ${poolCount.total} players` : "…"}
                      </span>
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Keep the top-ranked players in each position. <span className="font-semibold">Main</span> picks rank
                  on 50% impact (points per match) + 50% value (pts/match per £m); <span className="font-semibold">Bench</span> picks
                  are then added from the rest, ranked on 50% price (cheaper is better) + 50% value. Locked players are always kept.
                </p>
                {poolEnabled && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {([
                        ["Goalkeepers", "gkMain", "gkBench"],
                        ["Defenders", "defMain", "defBench"],
                        ["Midfielders", "midMain", "midBench"],
                        ["Forwards", "fwdMain", "fwdBench"],
                      ] as const).map(([label, mainKey, benchKey]) => (
                        <div key={label} className="flex items-center justify-between gap-2 p-3 border rounded-lg bg-muted/20">
                          <span className="text-sm font-semibold">{label}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">Main</span>
                            <Input
                              inputMode="numeric"
                              className="w-14 h-8 font-mono text-right"
                              value={poolCounts[mainKey]}
                              onChange={(e) => setPoolCounts((t) => ({ ...t, [mainKey]: e.target.value }))}
                            />
                            <span className="text-xs text-muted-foreground">+ Bench</span>
                            <Input
                              inputMode="numeric"
                              className="w-14 h-8 font-mono text-right"
                              value={poolCounts[benchKey]}
                              onChange={(e) => setPoolCounts((t) => ({ ...t, [benchKey]: e.target.value }))}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Points per match = total projected points ÷ gameweeks covered by the projection.
                      Ranks are computed within each position.
                    </p>
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <Label>Chip Assignments</Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {chipOptions.map(chip => (
                    <div key={chip} className="flex items-center justify-between gap-3 p-3 border rounded-lg bg-muted/20">
                      <Label className="capitalize text-sm">{chip.replace('_', ' ')}</Label>
                      <Select 
                        value={chips[chip] || "none"} 
                        onValueChange={(val) => {
                          const newChips = { ...chips };
                          if (val === "none") delete newChips[chip];
                          else newChips[chip] = val;
                          setChips(newChips);
                        }}
                      >
                        <SelectTrigger className="w-[110px] h-8 text-xs font-mono">
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="0">Any (optimized)</SelectItem>
                          {Array.from({length: horizon}).map((_, i) => (
                            <SelectItem key={i} value={(currentGw + i).toString()}>
                              GW {currentGw + i}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
                {Object.values(chips).includes("0") && (
                  <div className="space-y-3 p-3 border rounded-lg bg-muted/20">
                    <div>
                      <Label className="text-sm">Chip value evaluation</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        "Any" chips are compared against a second no-chip solve (adds solve time).
                        The boost is raw points over the evaluation window starting at the chip
                        week. At or above the green threshold the chip is well-invested; below
                        the amber threshold it's poor value.
                      </p>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Green ≥</Label>
                        <Input
                          type="number"
                          className="h-8 text-xs font-mono"
                          value={chipThreshold}
                          onChange={(e) => setChipThreshold(e.target.value)}
                          min={1}
                          step={1}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Amber ≥</Label>
                        <Input
                          type="number"
                          className="h-8 text-xs font-mono"
                          value={chipLowerThreshold}
                          onChange={(e) => setChipLowerThreshold(e.target.value)}
                          min={0}
                          step={1}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Window (GWs)</Label>
                        <Input
                          type="number"
                          className="h-8 text-xs font-mono"
                          value={chipWindow}
                          onChange={(e) => setChipWindow(e.target.value)}
                          min={1}
                          step={1}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-4 pt-2 border-t">
                <button type="button" className="flex items-center justify-between w-full text-left" onClick={() => setShowAdvanced((v) => !v)}>
                  <Label className="cursor-pointer">Advanced Solver Settings</Label>
                  <span className="text-xs text-muted-foreground">{showAdvanced ? "Hide" : "Show"}</span>
                </button>
                {showAdvanced && (
                  <div className="space-y-5 animate-in fade-in">
                    <p className="text-xs text-muted-foreground">Leave any field empty to use the solver's default. These map directly to the open-fpl-solver configuration.</p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label className="text-xs">Banned players</Label>
                        <Input placeholder="e.g. Haaland, Salah" value={adv.banned || ""} onChange={(e) => setAdv({ ...adv, banned: e.target.value })} />
                        <p className="text-[11px] text-muted-foreground">Comma-separated names (as in the projection) the solver must never pick.</p>
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label className="text-xs">Locked players</Label>
                        <Input placeholder="e.g. M.Salah, Watkins" value={adv.locked || ""} onChange={(e) => setAdv({ ...adv, locked: e.target.value })} />
                        <p className="text-[11px] text-muted-foreground">Players that must stay in the squad for the whole horizon.</p>
                      </div>

                      <AdvField label="Roll transfers in last N GWs" placeholder="0" hint="Save transfers at the end of the horizon" value={adv.noTransferLastGws || ""} onChange={(v) => setAdv({ ...adv, noTransferLastGws: v })} />
                      <AdvField label="Exact transfers next GW" placeholder="auto" hint="Force this many transfers next gameweek" value={adv.numTransfers || ""} onChange={(v) => setAdv({ ...adv, numTransfers: v })} />
                      <AdvField label="Total hit limit" placeholder="unlimited" hint="Max points hits over the horizon" value={adv.hitLimit || ""} onChange={(v) => setAdv({ ...adv, hitLimit: v })} />
                      <AdvField label="Weekly hit limit" placeholder="0" hint="Max hits in any single gameweek" value={adv.weeklyHitLimit || ""} onChange={(v) => setAdv({ ...adv, weeklyHitLimit: v })} />
                      <AdvField label="Decay base" placeholder="0.9" hint="Weight of future GWs (0.85 = near-term focus)" value={adv.decayBase || ""} onChange={(v) => setAdv({ ...adv, decayBase: v })} />
                      <AdvField label="Free transfer value" placeholder="0.75" hint="Points value of carrying a free transfer" value={adv.ftValue || ""} onChange={(v) => setAdv({ ...adv, ftValue: v })} />
                      <AdvField label="In-the-bank value" placeholder="0.1" hint="Points value per £1.0 left in the bank" value={adv.itbValue || ""} onChange={(v) => setAdv({ ...adv, itbValue: v })} />
                      <AdvField label="Min expected minutes" placeholder="300" hint="Exclude players below this xMins total" value={adv.xminLb || ""} onChange={(v) => setAdv({ ...adv, xminLb: v })} />
                      <AdvField label="Time limit (seconds)" placeholder="900" hint="Stop the solver after this long" value={adv.secs || ""} onChange={(v) => setAdv({ ...adv, secs: v })} />
                      <AdvField label="Optimality gap" placeholder="0.01" hint="e.g. 0.01 accepts within 1% of optimal; larger is faster" value={adv.gap || ""} onChange={(v) => setAdv({ ...adv, gap: v })} />
                      <AdvField label="Alternative plans" placeholder="1" hint="Solve for up to 5 plans, each with different next-GW transfers (multiplies solve time)" value={adv.numIterations || ""} onChange={(v) => setAdv({ ...adv, numIterations: v })} />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Bench weights — odds each bench slot ends up scoring</Label>
                      <div className="grid grid-cols-4 gap-2">
                        <AdvField label="Bench GK" placeholder="0.03" hint="" value={adv.bwGk || ""} onChange={(v) => setAdv({ ...adv, bwGk: v })} />
                        <AdvField label="1st sub" placeholder="0.21" hint="" value={adv.bw1 || ""} onChange={(v) => setAdv({ ...adv, bw1: v })} />
                        <AdvField label="2nd sub" placeholder="0.06" hint="" value={adv.bw2 || ""} onChange={(v) => setAdv({ ...adv, bw2: v })} />
                        <AdvField label="3rd sub" placeholder="0.002" hint="" value={adv.bw3 || ""} onChange={(v) => setAdv({ ...adv, bw3: v })} />
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        How much of each bench player's points count in the objective (0–1). Raise these if your starters
                        have shaky minutes — e.g. 1st sub 0.3 makes the solver invest in a stronger bench.
                      </p>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-xs">Booked transfers</Label>
                          <p className="text-[11px] text-muted-foreground">Moves you've already decided on — the solver must make them and plans around them. In a first-gameweek solve, a GW1 row forces the player into (or out of) the GW1 squad for that week only.</p>
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => setBooked([...booked, { gw: "", inP: "", outP: "" }])}>
                          Add
                        </Button>
                      </div>
                      {booked.map((b, i) => (
                        <div key={i} className="flex items-end gap-2">
                          <div className="w-24 space-y-1">
                            <Label className="text-[11px] text-muted-foreground">GW</Label>
                            <Input inputMode="numeric" placeholder={`${currentGw}`} value={b.gw} onChange={(e) => setBooked(booked.map((x, j) => j === i ? { ...x, gw: e.target.value } : x))} />
                          </div>
                          <div className="flex-1 space-y-1">
                            <Label className="text-[11px] text-muted-foreground">Player in</Label>
                            <Input placeholder="e.g. Haaland" value={b.inP} onChange={(e) => setBooked(booked.map((x, j) => j === i ? { ...x, inP: e.target.value } : x))} />
                          </div>
                          <div className="flex-1 space-y-1">
                            <Label className="text-[11px] text-muted-foreground">Player out</Label>
                            <Input placeholder="e.g. Watkins" value={b.outP} onChange={(e) => setBooked(booked.map((x, j) => j === i ? { ...x, outP: e.target.value } : x))} />
                          </div>
                          <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => setBooked(booked.filter((_, j) => j !== i))}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/20">
                        <div>
                          <Label className="text-xs">No future transfers</Label>
                          <p className="text-[11px] text-muted-foreground">Only plan transfers for the next GW</p>
                        </div>
                        <Switch checked={advFlags.noFutureTransfer} onCheckedChange={(c) => setAdvFlags({ ...advFlags, noFutureTransfer: c })} />
                      </div>
                      <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/20">
                        <div>
                          <Label className="text-xs">Randomized</Label>
                          <p className="text-[11px] text-muted-foreground">Add noise for alternative solutions</p>
                        </div>
                        <Switch checked={advFlags.randomized} onCheckedChange={(c) => setAdvFlags({ ...advFlags, randomized: c })} />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Zero-sum matchups (GK/DEF vs your own MID/FWD)</Label>
                      <Select value={opposingPlay} onValueChange={(v) => setOpposingPlay(v as "off" | "penalty" | "forbid")}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="off">Allow (default)</SelectItem>
                          <SelectItem value="penalty">Discourage — small points penalty per clash</SelectItem>
                          <SelectItem value="forbid">Forbid — never start both sides of a clash</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">
                        Avoids starting a goalkeeper or defender against your own attackers in the same gameweek.
                      </p>
                    </div>
                  </div>
                )}
              </div>

            </CardContent>
            <CardFooter className="bg-muted/30 pt-6 flex-col gap-3">
              <Button 
                onClick={handleStartSolve} 
                disabled={createSolveMutation.isPending || createMegaMutation.isPending || !projectionId || (!firstGameweek && (!isTeamIdValid || !teamData))}
                size="lg" 
                className="w-full font-bold text-lg h-14"
              >
                {createSolveMutation.isPending ? "Initializing..." : "Start Solver"}
              </Button>
              <Button
                onClick={handleStartMega}
                variant="outline"
                disabled={createSolveMutation.isPending || createMegaMutation.isPending || !projectionId || (!firstGameweek && (!isTeamIdValid || !teamData))}
                size="lg"
                className="w-full font-bold h-12"
              >
                {createMegaMutation.isPending ? "Initializing..." : "Chip Strategy Analysis"}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Runs sequential solves — no chips, free chip choice, and each chip on its own — then compares the points impact. Only chips your team can still play are analyzed (loaded from FPL), and chips are only allowed in the first 6 weeks of the horizon. Manual chip assignments above are ignored.
              </p>
            </CardFooter>
          </Card>

        </div>

        {/* Right Column - Previews */}
        <div className="space-y-6">
          
          {!firstGameweek && teamData && (
            <Card className="border-primary/20 bg-primary/5 animate-in fade-in slide-in-from-right-4">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-primary" />
                  Team Preview
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <h3 className="font-bold text-lg leading-tight">{teamData.name}</h3>
                  <p className="text-sm text-muted-foreground">{teamData.managerName}</p>
                </div>
                
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="bg-background p-2 rounded border">
                    <span className="text-muted-foreground text-xs block">Overall Rank</span>
                    <span className="font-mono font-bold">{teamData.overallRank?.toLocaleString() || "N/A"}</span>
                  </div>
                  <div className="bg-background p-2 rounded border">
                    <span className="text-muted-foreground text-xs block">Bank</span>
                    <span className="font-mono font-bold text-primary">£{teamData.bank.toFixed(1)}</span>
                  </div>
                </div>

                <div className="pt-2 border-t">
                  <span className="text-xs text-muted-foreground mb-2 block font-semibold uppercase tracking-wider">Current Squad</span>
                  <div className="space-y-1">
                    {teamData.squad.slice(0, 5).map(p => (
                      <div key={p.playerId} className="flex justify-between items-center text-xs">
                        <span className="truncate pr-2">{p.name}</span>
                        <span className="text-muted-foreground font-mono w-6 text-right">{p.position}</span>
                      </div>
                    ))}
                    <div className="text-xs text-muted-foreground text-center mt-2 pt-2 italic">
                      +10 more players
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {topPlayers && topPlayers.length > 0 && (
            <Card className="animate-in fade-in slide-in-from-right-4 delay-100">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <LineChart className="h-4 w-4 text-primary" />
                  Top Projected Players
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[120px]">Name</TableHead>
                      <TableHead>Team</TableHead>
                      <TableHead className="text-right">Pts</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topPlayers.slice(0, 8).map((p, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium text-xs py-2">{p.name}</TableCell>
                        <TableCell className="text-xs py-2 text-muted-foreground">{p.team}</TableCell>
                        <TableCell className="text-right py-2 font-mono font-bold text-primary">{p.totalPoints.toFixed(1)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

        </div>

      </div>
    </div>
  );
}