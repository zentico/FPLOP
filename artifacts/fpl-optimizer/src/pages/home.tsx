import React from "react";
import { useUploadProjection, useImportProjection, useListProjections, useDeleteProjection, useGetProjectionPlayers, useGetGameweekInfo, useGetFplTeam, useCreateSolve, getGetFplTeamQueryKey, getGetProjectionPlayersQueryKey } from "@workspace/api-client-react";
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
import { AlertCircle, UploadCloud, DownloadCloud, Trash2, Database, ShieldAlert, Cpu, Trophy, Banknote, Users, LineChart } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export default function Home() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // State
  const [projectionId, setProjectionId] = React.useState<string>("");
  const [firstGameweek, setFirstGameweek] = React.useState<boolean>(false);
  const [teamIdStr, setTeamIdStr] = React.useState<string>("");
  const [horizon, setHorizon] = React.useState<number>(5);
  const [chips, setChips] = React.useState<Record<string, string>>({}); // chip type -> gameweek string

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

  // Mutations
  const uploadMutation = useUploadProjection();
  const importMutation = useImportProjection();
  const deleteMutation = useDeleteProjection();
  const createSolveMutation = useCreateSolve();

  // Handlers
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      uploadMutation.mutate({ data: { filename: file.name, content } }, {
        onSuccess: (data) => {
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

  const handleImportFfh = () => {
    importMutation.mutate({ data: { source: "ffh" } }, {
      onSuccess: (data) => {
        setProjectionId(data.id);
        toast({ title: "Predictions imported", description: `${data.playerCount} players, GW${data.gameweeks[0]}–${data.gameweeks[data.gameweeks.length - 1]}` });
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

  const handleDeleteProjection = (id: string) => {
    deleteMutation.mutate({ id }, {
      onSuccess: () => {
        if (projectionId === id) setProjectionId("");
        toast({ title: "Projection deleted" });
      }
    });
  };

  const handleStartSolve = () => {
    if (!projectionId) {
      toast({ title: "Missing projection", description: "Please select or upload a projection.", variant: "destructive" });
      return;
    }
    if (!firstGameweek && !isTeamIdValid) {
      toast({ title: "Missing team ID", description: "Please enter a valid FPL team ID.", variant: "destructive" });
      return;
    }
    
    const chipsArray = Object.entries(chips).map(([chip, gw]) => ({
      chip,
      gameweek: parseInt(gw, 10)
    }));

    createSolveMutation.mutate({
      data: {
        projectionId,
        firstGameweek,
        teamId: firstGameweek ? null : teamIdNum,
        horizon,
        chips: chipsArray.length > 0 ? chipsArray : undefined
      }
    }, {
      onSuccess: (run) => {
        setLocation(`/solves/${run.id}`);
      },
      onError: (err: any) => {
        toast({
          title: "Failed to start solver",
          description: err?.error || "Unknown error occurred.",
          variant: "destructive"
        });
      }
    });
  };

  const currentGw = gameweekInfo?.nextGameweek || 1;
  const chipOptions = ["wildcard", "bench_boost", "free_hit", "triple_captain"];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">Run Optimization</h1>
        <p className="text-muted-foreground mt-2">Configure parameters and find the mathematically optimal sequence of transfers.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Left Column - Form */}
        <div className="lg:col-span-2 space-y-6">
          
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
                              <span className="font-semibold">{p.filename}</span>
                              <span className="text-xs text-muted-foreground font-mono mt-1">
                                {p.playerCount} players • GWs: {p.gameweeks.join(", ")}
                              </span>
                            </Label>
                          </div>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => handleDeleteProjection(p.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
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

                <TabsContent value="import" className="mt-4">
                  <div className="border-2 border-dashed border-border rounded-xl p-8 text-center hover:bg-muted/30 transition-colors">
                    <DownloadCloud className="h-10 w-10 mx-auto text-primary mb-4" />
                    <p className="text-sm font-medium mb-1">Fantasy Football Hub</p>
                    <p className="text-xs text-muted-foreground mb-4 max-w-md mx-auto">
                      Pull the latest points predictions, prices and ownership for the upcoming gameweeks directly from your Fantasy Football Hub membership.
                    </p>
                    <Button onClick={handleImportFfh} disabled={importMutation.isPending}>
                      {importMutation.isPending ? "Importing…" : "Import latest predictions"}
                    </Button>
                    {importMutation.isPending && (
                      <p className="text-sm text-primary mt-4 font-medium animate-pulse">Downloading predictions… this can take up to a minute.</p>
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
                <Cpu className="h-5 w-5 text-primary" />
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
                  max={8} 
                  min={2} 
                  step={1} 
                  className="py-4"
                />
                <p className="text-xs text-muted-foreground">Longer horizons are more accurate but take significantly more time to compute.</p>
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
              </div>

            </CardContent>
            <CardFooter className="bg-muted/30 pt-6">
              <Button 
                onClick={handleStartSolve} 
                disabled={createSolveMutation.isPending || !projectionId || (!firstGameweek && (!isTeamIdValid || !teamData))}
                size="lg" 
                className="w-full font-bold text-lg h-14"
              >
                {createSolveMutation.isPending ? "Initializing..." : "Start Solver"}
              </Button>
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