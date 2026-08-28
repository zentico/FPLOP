import { useLocation } from "wouter";
import { Link } from "wouter";
import { Activity, History, LineChart, Target, Volleyball } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background selection:bg-accent selection:text-accent-foreground">
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between px-4 md:px-8 max-w-7xl mx-auto">
          <div className="flex items-center gap-2">
            <div className="bg-primary text-primary-foreground p-1.5 rounded-md flex items-center justify-center">
              <Volleyball className="h-5 w-5" />
            </div>
            <Link href="/" className="font-bold text-xl tracking-tight cursor-pointer hover:text-primary/80 transition-colors">
              FPL Optimizer <span className="text-primary/60">(FPLOP)</span>
            </Link>
          </div>
          
          <nav className="flex items-center space-x-6 text-sm font-medium">
            <Link 
              href="/" 
              className={`transition-colors hover:text-primary ${location === "/" ? "text-foreground font-semibold" : "text-foreground/60"}`}
            >
              <div className="flex items-center gap-2">
                <LineChart className="h-4 w-4" />
                <span>New Solve</span>
              </div>
            </Link>
            <Link 
              href="/history" 
              className={`transition-colors hover:text-primary ${location === "/history" ? "text-foreground font-semibold" : "text-foreground/60"}`}
            >
              <div className="flex items-center gap-2">
                <History className="h-4 w-4" />
                <span>History</span>
              </div>
            </Link>
            <Link 
              href="/accuracy" 
              className={`transition-colors hover:text-primary ${location === "/accuracy" ? "text-foreground font-semibold" : "text-foreground/60"}`}
            >
              <div className="flex items-center gap-2">
                <Target className="h-4 w-4" />
                <span>Accuracy</span>
              </div>
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 md:px-8 py-8">
        {children}
      </main>
      <footer className="py-6 border-t border-border mt-auto">
        <div className="container max-w-7xl mx-auto px-4 md:px-8 flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5" />
            <span>FPL Optimizer (FPLOP)</span>
          </div>
          <p>Strictly analytical. No guarantees on matchday.</p>
        </div>
      </footer>
    </div>
  );
}
