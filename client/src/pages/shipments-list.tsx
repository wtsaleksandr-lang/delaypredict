import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type { Shipment } from "@shared/schema";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus, Ship, Plane, ChevronRight, Package, TrendingUp, TrendingDown, Minus, AlertTriangle, Target, Globe } from "lucide-react";
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
                {s.predicted_arrival && (
                  <span className="inline-flex items-center gap-1 text-primary">
                    <Target className="w-3 h-3" />
                    Predicted {new Date(s.predicted_arrival as any).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>

            <div className="hidden sm:block text-right">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Risk</p>
              <p className={`text-base font-bold tabular-nums ${colors.text}`}>{Math.round(score)}</p>
            </div>

            {s.predicted_delay_days != null && (
              <div className="hidden md:block text-right">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Pred. Delay</p>
                <p className={`text-base font-bold tabular-nums ${n(s.predicted_delay_days) > 2 ? "text-red-400" : n(s.predicted_delay_days) > 0 ? "text-amber-500" : "text-emerald-500"}`}>
                  {n(s.predicted_delay_days) > 0 ? "+" : ""}{fmt(n(s.predicted_delay_days), 1)}d
                </p>
              </div>
            )}

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
  const { data: accuracy } = useQuery<{
    overall: { sampleSize: number; maeDays: number | null; bias: number | null };
    byMode: {
      ocean: { sampleSize: number; maeDays: number | null; bias: number | null };
      air: { sampleSize: number; maeDays: number | null; bias: number | null };
    };
    bySource: Array<{ source: string; sampleSize: number; maeDays: number | null; bias: number | null }>;
  }>({
    queryKey: ["/api/predictions/accuracy"],
  });
  const { data: observer } = useQuery<{
    enabled: boolean;
    vesselsTracked: number;
    lanesLearned: number;
    observationsTotal: number;
    topLanes: Array<{ origin: string; destination: string; count: number; meanDays: number }>;
  }>({
    queryKey: ["/api/voyage-observer"],
    refetchInterval: 30_000,
  });
  const { data: flightObs } = useQuery<{
    enabled: boolean;
    hubsPolled: number;
    routesLearned: number;
    observationsTotal: number;
    topRoutes: Array<{ origin: string; destination: string; count: number; meanHours: number }>;
  }>({
    queryKey: ["/api/flight-observer"],
    refetchInterval: 60_000,
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
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 mb-6">
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
        <Card>
          <CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Target className="w-3 h-3" /> Predict MAE
            </p>
            <p className={`text-xl font-bold tabular-nums ${
              accuracy?.overall.maeDays == null ? "text-muted-foreground" :
              accuracy.overall.maeDays < 1 ? "text-emerald-500" :
              accuracy.overall.maeDays < 3 ? "text-amber-500" : "text-red-400"
            }`}>
              {accuracy?.overall.maeDays != null ? `${accuracy.overall.maeDays.toFixed(1)}d` : "—"}
            </p>
            <p className="text-[10px] text-muted-foreground">{accuracy?.overall.sampleSize ?? 0} delivered</p>
          </CardContent>
        </Card>
      </div>

      {/* Accuracy breakdown — only render once we have any delivered shipments */}
      {accuracy && accuracy.overall.sampleSize > 0 && (
        <Card className="mb-6">
          <CardContent className="p-4">
            <p className="text-sm font-semibold flex items-center gap-2 mb-2">
              <Target className="w-4 h-4 text-primary" /> Prediction Accuracy
              <span className="text-[10px] text-muted-foreground font-normal">lower MAE = better. bias &gt; 0 = predictions arrive later than reality says</span>
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* By mode */}
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">By mode</p>
                <div className="space-y-1.5">
                  {(["ocean","air"] as const).map((mode) => {
                    const m = accuracy.byMode[mode];
                    const tone = m.maeDays == null ? "text-muted-foreground" : m.maeDays < 1 ? "text-emerald-500" : m.maeDays < 3 ? "text-amber-500" : "text-red-400";
                    return (
                      <div key={mode} className="flex items-center text-xs">
                        <span className="w-16 capitalize text-muted-foreground">{mode}</span>
                        <span className={`font-bold tabular-nums w-16 ${tone}`}>{m.maeDays != null ? `${m.maeDays.toFixed(1)}d` : "—"}</span>
                        <span className="text-muted-foreground tabular-nums w-20">bias {m.bias != null ? `${m.bias > 0 ? "+" : ""}${m.bias.toFixed(1)}d` : "—"}</span>
                        <span className="text-[10px] text-muted-foreground">n={m.sampleSize}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* By source */}
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">By source (best first)</p>
                <div className="space-y-1.5">
                  {accuracy.bySource.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No source breakdown available yet.</p>
                  ) : (
                    accuracy.bySource.slice(0, 7).map((src) => {
                      const tone = src.maeDays == null ? "text-muted-foreground" : src.maeDays < 1 ? "text-emerald-500" : src.maeDays < 3 ? "text-amber-500" : "text-red-400";
                      return (
                        <div key={src.source} className="flex items-center text-xs">
                          <span className="w-28 text-muted-foreground capitalize">{src.source.replace("_", " ")}</span>
                          <span className={`font-bold tabular-nums w-16 ${tone}`}>{src.maeDays != null ? `${src.maeDays.toFixed(1)}d` : "—"}</span>
                          <span className="text-muted-foreground tabular-nums w-20">bias {src.bias != null ? `${src.bias > 0 ? "+" : ""}${src.bias.toFixed(1)}d` : "—"}</span>
                          <span className="text-[10px] text-muted-foreground">n={src.sampleSize}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Flight Observer card — global air learning sensor */}
      {flightObs && (
        <Card className="mb-6 border-l-4 border-primary/40">
          <CardContent className="p-4">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-md bg-primary/15">
                  <Plane className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold flex items-center gap-2">
                    Global Flight Observer
                    {flightObs.enabled ? (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">on</span>
                    ) : (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-zinc-500/20 text-zinc-400 border border-zinc-500/40">off</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {flightObs.enabled
                      ? "Polling OpenSky for completed flights at major cargo hubs — feeds predictor's flight_global source."
                      : "Disabled. Set OPENSKY_CLIENT_ID + OPENSKY_CLIENT_SECRET to learn from global flight schedules."}
                  </p>
                </div>
              </div>
              <div className="flex gap-4 text-right">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Hubs polled</p>
                  <p className="text-lg font-bold tabular-nums">{flightObs.hubsPolled}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Routes learned</p>
                  <p className="text-lg font-bold tabular-nums">{flightObs.routesLearned.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Flights observed</p>
                  <p className="text-lg font-bold tabular-nums text-primary">{flightObs.observationsTotal.toLocaleString()}</p>
                </div>
              </div>
            </div>
            {flightObs.topRoutes.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Top air routes by sample size</p>
                <div className="flex flex-wrap gap-2">
                  {flightObs.topRoutes.slice(0, 6).map((r, i) => (
                    <span key={i} className="text-[11px] bg-muted/50 border border-border rounded px-2 py-0.5 font-mono">
                      {r.origin} → {r.destination}: <span className="text-foreground font-semibold">{r.meanHours}h</span> <span className="text-muted-foreground">({r.count})</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Voyage Observer card — global learning sensor */}
      {observer && (
        <Card className="mb-6 border-l-4 border-primary/40">
          <CardContent className="p-4">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-md bg-primary/15">
                  <Globe className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold flex items-center gap-2">
                    Global Voyage Observer
                    {observer.enabled ? (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">on</span>
                    ) : (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-zinc-500/20 text-zinc-400 border border-zinc-500/40">off</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {observer.enabled
                      ? "Passively learning from container vessels worldwide via AISStream — feeds the predictor's lane-history source."
                      : "Disabled. Set ENABLE_VOYAGE_OBSERVER=true and AISSTREAM_API_KEY to learn from global AIS traffic."}
                  </p>
                </div>
              </div>
              <div className="flex gap-4 text-right">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Vessels seen</p>
                  <p className="text-lg font-bold tabular-nums">{observer.vesselsTracked.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Lanes learned</p>
                  <p className="text-lg font-bold tabular-nums">{observer.lanesLearned.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Voyages observed</p>
                  <p className="text-lg font-bold tabular-nums text-primary">{observer.observationsTotal.toLocaleString()}</p>
                </div>
              </div>
            </div>
            {observer.topLanes.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Top lanes by sample size</p>
                <div className="flex flex-wrap gap-2">
                  {observer.topLanes.slice(0, 6).map((l, i) => (
                    <span key={i} className="text-[11px] bg-muted/50 border border-border rounded px-2 py-0.5 font-mono">
                      {l.origin} → {l.destination}: <span className="text-foreground font-semibold">{l.meanDays}d</span> <span className="text-muted-foreground">({l.count})</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
