import { Switch, Route, Link, useLocation, Router as WouterRouter } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Ship, Plus, List, Calculator } from "lucide-react";
import NotFound from "@/pages/not-found";
import Calculator_ from "@/pages/home";
import ShipmentsList from "@/pages/shipments-list";
import ShipmentNew from "@/pages/shipment-new";
import ShipmentReport from "@/pages/shipment-report";
import { SecretsButton } from "@/components/SecretsModal";
import { ThemeToggle, useTheme } from "@/components/ThemeToggle";

function NavLink({ href, icon: Icon, children }: { href: string; icon: any; children: React.ReactNode }) {
  const [location] = useLocation();
  const active = location === href || (href !== "/" && location.startsWith(href));
  return (
    <Link
      href={href}
      className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-150 ${
        active
          ? "bg-primary/15 text-primary shadow-sm ring-1 ring-primary/20"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
      }`}
    >
      <Icon className="w-4 h-4" />
      {children}
    </Link>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border/60 bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60 sticky top-0 z-50 print:hidden">
        <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/shipments" className="flex items-center gap-2 group">
            <div className="w-7 h-7 rounded-md bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shrink-0 shadow-sm shadow-primary/30 group-hover:shadow-primary/50 transition-shadow">
              <Ship className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-foreground tracking-tight text-lg">DelayPredict</span>
          </Link>
          <nav className="flex items-center gap-1 ml-4">
            <NavLink href="/shipments" icon={List}>Shipments</NavLink>
            <NavLink href="/calculator" icon={Calculator}>Quick Calc</NavLink>
          </nav>
        </div>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="border-t border-border bg-card mt-auto print:hidden">
        <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>DelayPredict</span>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <SecretsButton />
          </div>
        </div>
      </footer>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/"><Shell><ShipmentsList /></Shell></Route>
      <Route path="/shipments"><Shell><ShipmentsList /></Shell></Route>
      <Route path="/shipments/new"><Shell><ShipmentNew /></Shell></Route>
      <Route path="/shipments/:id">{(params) => <Shell><ShipmentReport id={params.id} /></Shell>}</Route>
      <Route path="/calculator"><Shell><Calculator_ /></Shell></Route>
      <Route><NotFound /></Route>
    </Switch>
  );
}

// import.meta.env.BASE_URL is "/" by default, "/delaypredict/" when built with BASE_PATH set.
// wouter's Router base must NOT have a trailing slash.
const ROUTER_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

function App() {
  // Theme is managed by useTheme() (reads localStorage; defaults to dark).
  // Calling it at the App root ensures the html.dark class is applied before children render.
  useTheme();

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <WouterRouter base={ROUTER_BASE}>
          <Router />
        </WouterRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
