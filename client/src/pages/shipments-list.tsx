import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type { Shipment } from "@shared/schema";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus, Ship, Plane, ChevronRight, Package, TrendingUp, TrendingDown, Minus, AlertTriangle } from "lucide-react";
import { fmtUSD, fmt, riskColor, riskBand } from "@/lib/calculations";

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    planned: "bg-slate-600/30 text-slate-300 border-slate-500/40",
    in_transit: "bg-blue-600/20 text-blue-300 border-blue-500/40",
    delayed: "bg-red-600/20 text-red-300 border-red-500/40",
    delivered: "bg-emerald-600/20 text-emerald-300 border-emerald-500/40",
    cancelled: "bg-zinc-600/20 text-zinc-400 border-zinc-500/40",
  };
  return (
    <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${map[status] || map.planned}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function n(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const x = parseFloat(v);
  return isNaN(x) ? 0 : x;
}

function ShipmentRow({ s }: { s: Shipment }) {
  const score = n(s.risk_score);
  const colors = riskColor(score);
  const cost = n(s.cost);
  const sale = n(s.sale_price);
  const premium = n(s.insurance_premium);
  const grossProfit = sale - cost;
  const netProfit = premium > 0 ? grossProfit - premium : grossProfit - n(s.best_ev) * -1;
  const Icon = s.mode === "air" ? Plane : Ship;

  return (
    <Link href={`/shipments/${s.id}`}>
      <Card
        className={`group cursor-pointer hover-elevate transition-all border-l-4 ${colors.border}`}
        data-testid={`row-shipment-${s.id}`}
      >
        <CardContent className="p-4">
          <div className="flex items-center gap-4">
            <div className={`p-2 rounded-md ${colors.bg}/15`}>
              <Icon className={`w-5 h-5 ${colors.text}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-foreground text-sm truncate">
                  {s.personal_ref || s.container_number || s.awb_number || s.booking_number || "Unnamed shipment"}
                </span>
                <StatusPill status={s.status} />
                <Badge className={`text-[10px] font-bold uppercase tracking-wider ${colors.bg}/20 ${colors.text} border-0`}>
                  {colors.label}
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
                <span>{s.origin || "—"} → {s.destination || "—"}</span>
                {s.eta && <span>ETA {String(s.eta).slice(0, 10)}</span>}
                {s.container_number && <span className="font-mono">{s.container_number}</span>}
                {s.awb_number && <span className="font-mono">AWB {s.awb_number}</span>}
              </div>
            </div>

            <div className="hidden sm:block text-right">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Risk</p>
              <p className={`text-base font-bold tabular-nums ${colors.text}`}>{Math.round(score)}</p>
            </div>

            <div className="hidden md:block text-right">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Net P&amp;L</p>
              <p
                className={`text-base font-bold tabular-nums ${
                  netProfit > 0 ? "text-emerald-500" : netProfit < 0 ? "text-red-400" : "text-muted-foreground"
                }`}
              >
                {netProfit > 0 ? "+" : ""}{fmtUSD(netProfit)}
              </p>
            </div>

            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 group-hover:text-foreground transition-colors" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function ShipmentsList() {
  const { data: shipments, isLoading } = useQuery<Shipment[]>({
    queryKey: ["/api/shipments"],
  });

  // Aggregate KPIs
  const totals = (shipments ?? []).reduce(
    (acc, s) => {
      acc.count += 1;
      acc.cost += n(s.cost);
      acc.sale += n(s.sale_price);
      acc.premium += n(s.insurance_premium);
      const score = n(s.risk_score);
      const band = riskBand(score);
      acc.high += band === "high" ? 1 : 0;
      acc.delayed += s.status === "delayed" ? 1 : 0;
      return acc;
    },
    { count: 0, cost: 0, sale: 0, premium: 0, high: 0, delayed: 0 },
  );
  const grossMargin = totals.sale - totals.cost;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Shipments</h1>
          <p className="text-sm text-muted-foreground">All ocean &amp; air freight shipments with delay risk and P&amp;L</p>
        </div>
        <Link href="/shipments/new">
          <Button data-testid="button-new-shipment">
            <Plus className="w-4 h-4 mr-2" /> New Shipment
          </Button>
        </Link>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Shipments</p>
            <p className="text-xl font-bold tabular-nums">{totals.count}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Gross Margin</p>
            <p className={`text-xl font-bold tabular-nums ${grossMargin >= 0 ? "text-emerald-500" : "text-red-400"}`}>
              {fmtUSD(grossMargin)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Premium Spent</p>
            <p className="text-xl font-bold tabular-nums">{fmtUSD(totals.premium)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> High Risk
            </p>
            <p className="text-xl font-bold tabular-nums text-red-400">{totals.high}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Delayed Now</p>
            <p className="text-xl font-bold tabular-nums text-amber-500">{totals.delayed}</p>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (shipments ?? []).length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center">
            <Package className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-foreground font-semibold mb-1">No shipments yet</p>
            <p className="text-sm text-muted-foreground mb-4">Create your first shipment to start tracking risk and P&amp;L.</p>
            <Link href="/shipments/new">
              <Button><Plus className="w-4 h-4 mr-2" /> New Shipment</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {shipments!.map((s) => (
            <ShipmentRow key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}
