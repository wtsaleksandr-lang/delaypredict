import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import type { Shipment } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Ship, Plane, ArrowLeft, RefreshCw, Printer, Trash2,
  TrendingUp, TrendingDown, ShieldCheck, AlertTriangle, Clock,
  Package, Loader2, ExternalLink, MapPin, Navigation, Target, Sparkles, CalendarClock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  fmtUSD, fmtPct, fmt, riskColor, riskBand,
  type CalcInputs, type CalcResult, type TriggerResult,
  riskFactorBreakdown,
} from "@/lib/calculations";
import { apiRequest } from "@/lib/queryClient";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, LabelList,
} from "recharts";

function n(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const x = parseFloat(v);
  return isNaN(x) ? 0 : x;
}

interface Props { id: string; }

interface VesselPosition {
  mmsi: string;
  shipName: string | null;
  lat: number;
  lon: number;
  sogKnots: number | null;
  cogDeg: number | null;
  navStatus: number | null;
  navStatusLabel: string | null;
  updatedAt: string;
}

export default function ShipmentReport({ id }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: shipment, isLoading, refetch } = useQuery<Shipment>({
    queryKey: [`/api/shipments/${id}`],
  });
  const mmsi = shipment?.vessel_mmsi || null;
  const { data: vessel } = useQuery<VesselPosition>({
    queryKey: [`/api/vessels/${mmsi}`],
    enabled: !!mmsi,
    refetchInterval: 60_000, // live-ish refresh every minute
    retry: false,
  });

  const refresh = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/shipments/${id}/refresh-tracking`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Tracking refreshed" });
      qc.invalidateQueries({ queryKey: [`/api/shipments/${id}`] });
      refetch();
    },
    onError: (err: any) => {
      toast({ title: "Refresh failed", description: String(err?.message || err), variant: "destructive" });
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/shipments/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Shipment deleted" });
      qc.invalidateQueries({ queryKey: ["/api/shipments"] });
      window.location.href = "/shipments";
    },
  });

  if (isLoading) return <div className="max-w-7xl mx-auto px-4 py-10 text-sm text-muted-foreground">Loading…</div>;
  if (!shipment) return <div className="max-w-7xl mx-auto px-4 py-10 text-sm text-muted-foreground">Not found.</div>;

  const inputs = shipment.inputs_json as CalcInputs;
  const result = shipment.result_json as CalcResult;
  const score = n(shipment.risk_score);
  const colors = riskColor(score);
  const Icon = shipment.mode === "air" ? Plane : Ship;

  // P&L
  const cost = n(shipment.cost);
  const sale = n(shipment.sale_price);
  const premium = n(shipment.insurance_premium);
  const gross = sale - cost;
  const expectedLoss = result?.best?.expectedPayout ?? 0;
  const netInsured = gross - premium;
  const netUninsured = gross - expectedLoss;
  const chosenNet = premium > 0 ? netInsured : netUninsured;

  const breakdown = riskFactorBreakdown(inputs, result?.transitDays ?? 0);
  const breakdownData = breakdown.map((b) => ({ name: b.label, value: Number(b.points), max: b.max }));
  const triggerData = result?.triggers?.map((t) => ({
    name: `${t.trigger}-${result.triggerUnit}`,
    EV: Math.round(t.ev),
    premium: Math.round(t.premium),
    expectedPayout: Math.round(t.expectedPayout),
    rec: t.recommendation,
  })) ?? [];

  const triggerBarColor = (rec: string) =>
    rec === "INSURE" ? "#10b981" : rec === "OPTIONAL" ? "#f59e0b" : "#6b7280";

  const milestones = (shipment.tracking_payload as any)?.milestones ?? [];

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 print:py-2">
      {/* Toolbar (hidden in print) */}
      <div className="flex items-center justify-between mb-4 print:hidden">
        <Link href="/shipments">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 mr-1.5" /> Back</Button>
        </Link>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1.5" />}
            Refresh Tracking
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="w-4 h-4 mr-1.5" /> Print / PDF
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { if (confirm("Delete this shipment?")) remove.mutate(); }} className="text-red-400 hover:text-red-300">
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Hero band */}
      <Card className={`mb-5 border-l-[6px] ${colors.border} overflow-hidden`}>
        <div className={`h-1.5 ${colors.bg}`} />
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3 min-w-0">
              <div className={`p-2.5 rounded-lg ${colors.bg}/20 shrink-0`}>
                <Icon className={`w-6 h-6 ${colors.text}`} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-2xl font-bold tracking-tight" data-testid="text-shipment-title">
                    {shipment.personal_ref || shipment.container_number || shipment.awb_number || "Shipment"}
                  </h1>
                  <Badge className={`${colors.bg}/20 ${colors.text} text-[10px] font-bold tracking-wider px-2 py-0.5 border-0`}>
                    {colors.label}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] uppercase tracking-wider">{shipment.mode}</Badge>
                  <Badge variant="outline" className="text-[10px] uppercase tracking-wider">{shipment.status.replace("_", " ")}</Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {shipment.origin || "—"} → {shipment.destination || "—"}
                  {shipment.etd && <> · ETD {String(shipment.etd).slice(0, 10)}</>}
                  {shipment.eta && <> · ETA {String(shipment.eta).slice(0, 10)}</>}
                </p>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {shipment.booking_number && <span>Booking: <span className="font-mono text-foreground">{shipment.booking_number}</span></span>}
                  {shipment.container_number && <span>Container: <span className="font-mono text-foreground">{shipment.container_number}</span></span>}
                  {shipment.awb_number && <span>AWB: <span className="font-mono text-foreground">{shipment.awb_number}</span></span>}
                  {shipment.flight_number && <span>Flight: <span className="font-mono text-foreground">{shipment.flight_number}</span></span>}
                  {shipment.carrier_scac && <span>Carrier: <span className="font-mono text-foreground">{shipment.carrier_scac}</span></span>}
                </div>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Risk Score</p>
              <p className={`text-4xl font-black tabular-nums leading-none ${colors.text}`}>{Math.round(score)}<span className="text-base text-muted-foreground font-bold"> /100</span></p>
              <p className="text-xs text-muted-foreground mt-1">Recommendation: <span className={`font-bold ${colors.text}`}>{shipment.recommendation}</span></p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* P&L tiles */}
      {(cost > 0 || sale > 0) && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
          <PnLTile label="Cost" value={fmtUSD(cost)} icon={Package} tone="neutral" />
          <PnLTile label="Sale Price" value={fmtUSD(sale)} icon={TrendingUp} tone="neutral" />
          <PnLTile label="Gross Profit" value={fmtUSD(gross)} icon={gross >= 0 ? TrendingUp : TrendingDown} tone={gross >= 0 ? "good" : "bad"} />
          <PnLTile label={premium > 0 ? "Premium Paid" : "Expected Loss"} value={fmtUSD(premium > 0 ? premium : expectedLoss)} icon={premium > 0 ? ShieldCheck : AlertTriangle} tone={premium > 0 ? "neutral" : "warn"} />
          <PnLTile label="Net Profit" value={fmtUSD(chosenNet)} icon={chosenNet >= 0 ? TrendingUp : TrendingDown} tone={chosenNet >= 0 ? "good" : "bad"} />
        </div>
      )}

      <PredictedArrivalCard shipment={shipment} />
      {shipment.actual_arrival && <ActualArrivalCard shipment={shipment} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Risk breakdown chart */}
        <Card>
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold">Risk Score Breakdown</CardTitle>
            <p className="text-xs text-muted-foreground">Per-factor contribution to the 0–100 score</p>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <ResponsiveContainer width="100%" height={Math.max(180, breakdownData.length * 36)}>
              <BarChart data={breakdownData} layout="vertical" margin={{ left: 10, right: 30 }}>
                <XAxis type="number" domain={[0, "dataMax"]} hide />
                <YAxis type="category" dataKey="name" width={120} tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.03)" }}
                  contentStyle={{ background: "#0b1220", border: "1px solid #1e293b", borderRadius: 6, fontSize: 12 }}
                  formatter={(v: any, _n: any, p: any) => [`${v} / ${p.payload.max} pts`, ""]}
                />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {breakdownData.map((d, i) => {
                    const ratio = d.max > 0 ? d.value / d.max : 0;
                    const color = ratio > 0.66 ? "#ef4444" : ratio > 0.33 ? "#f59e0b" : "#10b981";
                    return <Cell key={i} fill={color} />;
                  })}
                  <LabelList dataKey="value" position="right" style={{ fill: "#cbd5e1", fontSize: 11 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Trigger comparison chart */}
        <Card>
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold">Insurance Triggers — Expected Value</CardTitle>
            <p className="text-xs text-muted-foreground">Bar = EV, height/color reflects recommendation</p>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={triggerData} margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
                <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: "#0b1220", border: "1px solid #1e293b", borderRadius: 6, fontSize: 12 }}
                  formatter={(v: any) => [fmtUSD(v), "EV"]}
                />
                <Bar dataKey="EV" radius={[6, 6, 0, 0]}>
                  {triggerData.map((d, i) => <Cell key={i} fill={triggerBarColor(d.rec)} />)}
                  <LabelList dataKey="EV" position="top" formatter={(v: any) => fmtUSD(v)} style={{ fill: "#cbd5e1", fontSize: 11 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              {result?.triggers?.map((t) => (
                <TriggerMini key={t.trigger} t={t} unit={result.triggerUnit} isBest={t.trigger === result.best.trigger} />
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Live vessel position (AIS) */}
        {mmsi && (
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Navigation className="w-4 h-4" />
                Live Vessel Position
                {shipment.vessel_name && <Badge variant="outline" className="text-[10px]">{shipment.vessel_name}</Badge>}
                <Badge variant="outline" className="text-[10px] font-mono">MMSI {mmsi}</Badge>
                <Badge variant="outline" className="text-[10px]">via AISStream.io</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {!vessel ? (
                <p className="text-sm text-muted-foreground">
                  Waiting for first AIS position report. This usually takes 1–5 minutes after the vessel next transmits.
                  Requires <span className="font-mono">AISSTREAM_API_KEY</span> in your <span className="font-mono">.env</span>.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                  <div>
                    <p className="text-muted-foreground flex items-center gap-1"><MapPin className="w-3 h-3" /> Position</p>
                    <p className="font-bold tabular-nums text-foreground">{vessel.lat.toFixed(3)}°, {vessel.lon.toFixed(3)}°</p>
                    <a
                      href={`https://www.openstreetmap.org/?mlat=${vessel.lat}&mlon=${vessel.lon}&zoom=6`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-primary hover:underline inline-flex items-center gap-1 mt-0.5"
                    >
                      View on map <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Speed</p>
                    <p className="font-bold tabular-nums text-foreground">
                      {vessel.sogKnots != null ? `${vessel.sogKnots.toFixed(1)} kn` : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Course / Status</p>
                    <p className="font-bold tabular-nums text-foreground">
                      {vessel.cogDeg != null ? `${Math.round(vessel.cogDeg)}°` : "—"}
                    </p>
                    {vessel.navStatusLabel && <p className="text-[10px] text-muted-foreground">{vessel.navStatusLabel}</p>}
                  </div>
                  <div>
                    <p className="text-muted-foreground">Last Update</p>
                    <p className="font-semibold tabular-nums text-foreground">{new Date(vessel.updatedAt).toLocaleString()}</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Tracking */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Live Tracking
              {shipment.tracking_provider && <Badge variant="outline" className="text-[10px]">via {shipment.tracking_provider}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {!shipment.tracking_last_polled ? (
              <p className="text-sm text-muted-foreground">
                No tracking data yet.{" "}
                <button onClick={() => refresh.mutate()} className="underline text-primary hover:text-primary/80">
                  Click "Refresh Tracking"
                </button>{" "}
                — requires at least one carrier API key in your <span className="font-mono">.env</span>.
              </p>
            ) : milestones.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events returned by provider yet (last polled {String(shipment.tracking_last_polled).slice(0, 16)}).</p>
            ) : (
              <ol className="relative border-l border-border ml-2 space-y-3">
                {milestones.map((m: any, i: number) => (
                  <li key={i} className="ml-4">
                    <div className="absolute -left-[5px] w-2.5 h-2.5 rounded-full bg-primary" />
                    <p className="text-sm font-medium text-foreground">{m.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {m.location && <span>{m.location} · </span>}
                      {m.occurred_at ? new Date(m.occurred_at).toLocaleString() : ""}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        {shipment.notes && (
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2 pt-4 px-4"><CardTitle className="text-sm font-semibold">Notes</CardTitle></CardHeader>
            <CardContent className="px-4 pb-4 text-sm text-muted-foreground whitespace-pre-wrap">{shipment.notes}</CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function PredictedArrivalCard({ shipment }: { shipment: Shipment }) {
  const predicted = shipment.predicted_arrival ? new Date(shipment.predicted_arrival as any) : null;
  const carrierEta = shipment.eta ? new Date(shipment.eta as any) : null;
  const aisEta = shipment.ais_eta ? new Date(shipment.ais_eta as any) : null;
  const sources = (shipment.prediction_sources as any[]) || [];
  const confidence = n(shipment.prediction_confidence);
  const delayDays = n(shipment.predicted_delay_days);

  if (!predicted && !carrierEta) return null;

  const delayTone = delayDays > 2 ? "text-red-400" : delayDays > 0 ? "text-amber-500" : "text-emerald-500";
  const confPct = Math.round(confidence * 100);
  const confTone = confPct >= 70 ? "text-emerald-500" : confPct >= 40 ? "text-amber-500" : "text-red-400";

  // Divergence between AIS and carrier (shown only if both exist)
  let divergenceDays: number | null = null;
  if (aisEta && carrierEta) divergenceDays = (aisEta.getTime() - carrierEta.getTime()) / 86400_000;

  return (
    <Card className="mb-5 border-l-4 border-primary/60">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Target className="w-4 h-4 text-primary" />
          Predicted Arrival
          <Badge className="bg-primary/20 text-primary text-[10px] font-bold border-0">
            <Sparkles className="w-2.5 h-2.5 mr-1 inline" /> consensus
          </Badge>
          {confPct > 0 && <span className={`text-[10px] font-semibold ${confTone}`}>confidence {confPct}%</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {predicted ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Predicted arrival</p>
              <p className="text-2xl font-bold tabular-nums text-foreground">
                {predicted.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </p>
              <p className="text-[11px] text-muted-foreground">{predicted.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Delay vs carrier ETA</p>
              <p className={`text-2xl font-bold tabular-nums ${delayTone}`}>
                {delayDays > 0 ? "+" : ""}{fmt(delayDays, 1)}d
              </p>
              {carrierEta && <p className="text-[11px] text-muted-foreground">Carrier said {carrierEta.toLocaleDateString()}</p>}
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Sources combined</p>
              <p className="text-2xl font-bold tabular-nums text-foreground">{sources.length}</p>
              <p className="text-[11px] text-muted-foreground">More sources = higher confidence</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Prediction pending — waiting for first AIS ping or tracking refresh.</p>
        )}

        {divergenceDays != null && Math.abs(divergenceDays) >= 1 && (
          <div className="mt-3 flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200">
              <strong>ETA divergence:</strong> the vessel is announcing arrival {Math.abs(divergenceDays).toFixed(1)}d
              {divergenceDays > 0 ? " LATER" : " EARLIER"} than the carrier's ETA. Vessels usually know earlier than carrier APIs update.
            </p>
          </div>
        )}

        {sources.length > 0 && (
          <div className="mt-3 space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Signal breakdown</p>
            {sources.map((s, i) => (
              <div key={i} className="flex items-center gap-3 text-xs">
                <span className="inline-block w-24 text-muted-foreground capitalize">{String(s.source).replace("_", " ")}</span>
                <span className="font-semibold text-foreground tabular-nums w-32">{new Date(s.etaIso).toLocaleDateString()}</span>
                <span className="text-muted-foreground flex-1">{s.note ?? ""}</span>
                <span className="text-[10px] text-muted-foreground">w={s.weight}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActualArrivalCard({ shipment }: { shipment: Shipment }) {
  const actual = shipment.actual_arrival ? new Date(shipment.actual_arrival as any) : null;
  if (!actual) return null;
  const actualDelay = n(shipment.actual_delay_days);
  const predicted = shipment.predicted_arrival ? new Date(shipment.predicted_arrival as any) : null;
  const predictionError = predicted ? (actual.getTime() - predicted.getTime()) / 86400_000 : null;
  const source = shipment.actual_arrival_source || "manual";

  return (
    <Card className="mb-5 border-l-4 border-emerald-500/60">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-emerald-500" />
          Arrived
          <Badge variant="outline" className="text-[10px] uppercase">{source.replace("_", " ")}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Actual arrival</p>
          <p className="text-xl font-bold text-foreground">{actual.toLocaleDateString()}</p>
          <p className="text-[11px] text-muted-foreground">{actual.toLocaleTimeString()}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Actual delay vs carrier ETA</p>
          <p className={`text-xl font-bold tabular-nums ${actualDelay > 0 ? "text-red-400" : "text-emerald-500"}`}>
            {actualDelay > 0 ? "+" : ""}{fmt(actualDelay, 1)}d
          </p>
        </div>
        {predictionError != null && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Prediction error</p>
            <p className={`text-xl font-bold tabular-nums ${Math.abs(predictionError) < 1 ? "text-emerald-500" : Math.abs(predictionError) < 3 ? "text-amber-500" : "text-red-400"}`}>
              {predictionError > 0 ? "+" : ""}{fmt(predictionError, 1)}d
            </p>
            <p className="text-[11px] text-muted-foreground">Lower = better model</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PnLTile({ label, value, icon: Icon, tone }: { label: string; value: string; icon: any; tone: "good" | "bad" | "warn" | "neutral" }) {
  const toneClass =
    tone === "good" ? "text-emerald-500 bg-emerald-500/10 border-emerald-500/30" :
    tone === "bad" ? "text-red-400 bg-red-500/10 border-red-500/30" :
    tone === "warn" ? "text-amber-500 bg-amber-500/10 border-amber-500/30" :
    "text-foreground bg-muted/40 border-border";
  return (
    <Card className={`border-l-4 ${toneClass.split(" ").find((c) => c.startsWith("border-"))}`}>
      <CardContent className="p-3">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1">
          <Icon className="w-3 h-3" /> {label}
        </p>
        <p className={`text-xl font-bold tabular-nums ${toneClass.split(" ")[0]}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function TriggerMini({ t, unit, isBest }: { t: TriggerResult; unit: "day" | "hour"; isBest: boolean }) {
  const recColor = t.recommendation === "INSURE" ? "text-emerald-500" : t.recommendation === "OPTIONAL" ? "text-amber-500" : "text-muted-foreground";
  return (
    <div className={`rounded border p-2 ${isBest ? "border-primary bg-primary/5" : "border-border"}`}>
      <div className="flex items-center justify-between">
        <span className="font-bold text-foreground">{t.trigger}-{unit}</span>
        <span className={`text-[10px] font-bold ${recColor}`}>{t.recommendation}</span>
      </div>
      <div className="text-[11px] text-muted-foreground mt-0.5">
        Limit {fmtUSD(t.insuredLimit)} · Premium {fmtUSD(t.premium)} · ROI {fmt(t.roi, 2)}×
      </div>
    </div>
  );
}
