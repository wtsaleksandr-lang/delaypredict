import { Switch, Route, Link, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect } from "react";
import { Ship, Plus, List, Calculator } from "lucide-react";
import NotFound from "@/pages/not-found";
import Calculator_ from "@/pages/home";
import ShipmentsList from "@/pages/shipments-list";
import ShipmentNew from "@/pages/shipment-new";
import ShipmentReport from "@/pages/shipment-report";

function NavLink({ href, icon: Icon, children }: { href: string; icon: any; children: React.ReactNode }) {
  const [location] = useLocation();
  const active = location === href || (href !== "/" && location.startsWith(href));
  return (
    <Link
      href={href}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors ${
        active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
      }`}
    >
      <Icon className="w-4 h-4" />
      {children}
    </Link>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card sticky top-0 z-50 print:hidden">
        <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/shipments" className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center shrink-0">
              <Ship className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-foreground tracking-tight text-lg">DelayPredict</span>
          </Link>
          <nav className="flex items-center gap-1 ml-4">
            <NavLink href="/shipments" icon={List}>Shipments</NavLink>
            <NavLink href="/shipments/new" icon={Plus}>New</NavLink>
            <NavLink href="/calculator" icon={Calculator}>Quick Calc</NavLink>
          </nav>
        </div>
      </header>
      {children}
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

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
