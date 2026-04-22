import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronDown, Ship, Plane, Save, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  calculate,
  fmtUSD,
  fmtPct,
  fmt,
  riskColor,
  deriveRiskTier,
  type CalcInputs,
  type FreightMode,
} from "@/lib/calculations";
import { apiRequest } from "@/lib/queryClient";

const DEFAULTS: CalcInputs = {
  mode: "ocean",
  originPort: "",
  destinationPort: "",
  etd: "",
  eta: "",
  transshipments: 0,
  budget: 100,
  riskTier: "Medium",
  originCongestion: "Med",
  transshipCongestion: "Med",
  destCongestion: "Med",
  seasonRisk: "Med",
  routeRisk: "Med",
  carrierReliability: "Avg",
  bufferTightness: "Normal",
  hasLayover: false,
  weatherRisk: "Med",
  slotPressure: "Med",
  airlineReliability: "Avg",
};

interface IdFields {
  personal_ref: string;
  booking_number: string;
  container_number: string;
  awb_number: string;
  flight_number: string;
  carrier_scac: string;
}
const ID_DEFAULTS: IdFields = {
  personal_ref: "",
  booking_number: "",
  container_number: "",
  awb_number: "",
  flight_number: "",
  carrier_scac: "",
};

interface PnLFields {
  cost: string;
  sale_price: string;
  insurance_chosen_trigger: number | null;
}
const PNL_DEFAULTS: PnLFields = { cost: "", sale_price: "", insurance_chosen_trigger: null };

function Sel<T extends string>({
  label, value, onChange, options,
}: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as T)}>
        <SelectTrigger className="h-9 text-sm bg-background"><SelectValue /></SelectTrigger>
        <SelectContent>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

export default function ShipmentNew() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [inputs, setInputs] = useState<CalcInputs>(DEFAULTS);
  const [ids, setIds] = useState<IdFields>(ID_DEFAULTS);
  const [pnl, setPnl] = useState<PnLFields>(PNL_DEFAULTS);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const result = useMemo(() => calculate(inputs), [inputs]);
  const colors = riskColor(result.riskScore);
  const derivedTier = deriveRiskTier(result.riskScore);
  // Auto-sync risk tier with computed score (the two used to be unrelated — confusing)
  if (inputs.riskTier !== derivedTier) {
    queueMicrotask(() => setInputs((p) => ({ ...p, riskTier: derivedTier })));
  }

  function set<K extends keyof CalcInputs>(k: K, v: CalcInputs[K]) {
    setInputs((p) => ({ ...p, [k]: v }));
  }

  const create = useMutation({
    mutationFn: async () => {
      const chosen = pnl.insurance_chosen_trigger
        ? result.triggers.find((t) => t.trigger === pnl.insurance_chosen_trigger)
        : null;
      const body = {
        personal_ref: ids.personal_ref || null,
        mode: inputs.mode,
        booking_number: ids.booking_number || null,
        container_number: ids.container_number || null,
        awb_number: ids.awb_number || null,
        flight_number: ids.flight_number || null,
        carrier_scac: ids.carrier_scac || null,
        origin: inputs.originPort || null,
        destination: inputs.destinationPort || null,
        etd: inputs.etd || null,
        eta: inputs.eta || null,
        inputs_json: inputs,
        result_json: result,
        risk_score: result.riskScore,
        base_delay_probability: result.baseDelayProbability,
        expected_delay_days: result.expectedDelayDays,
        best_trigger: result.best.trigger,
        best_ev: result.best.ev,
        recommendation: result.best.recommendation,
        cost: pnl.cost ? parseFloat(pnl.cost) : null,
        sale_price: pnl.sale_price ? parseFloat(pnl.sale_price) : null,
        insurance_premium: chosen?.premium ?? null,
        insurance_chosen_trigger: chosen?.trigger ?? null,
        status: "planned",
      };
      const res = await apiRequest("POST", "/api/shipments", body);
      return res.json();
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["/api/shipments"] });
      toast({ title: "Shipment saved", description: created.personal_ref || "New shipment created" });
      navigate(`/shipments/${created.id}`);
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: String(err?.message || err), variant: "destructive" });
    },
  });

  const isAir = inputs.mode === "air";
  const tierOpts: { value: any; label: string }[] = [
    { value: "Low", label: "Low" }, { value: "Medium", label: "Medium" }, { value: "High", label: "High" },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">New Shipment</h1>
          <p className="text-sm text-muted-foreground">Add identifiers, route &amp; risk inputs. P&amp;L and risk recommendation are computed live.</p>
        </div>
        <Button onClick={() => create.mutate()} disabled={create.isPending} data-testid="button-save-shipment">
          {create.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Shipment
        </Button>
      </div>

      <Tabs value={inputs.mode} onValueChange={(v) => set("mode", v as FreightMode)} className="mb-5">
        <TabsList>
          <TabsTrigger value="ocean" data-testid="tab-mode-ocean"><Ship className="w-4 h-4 mr-1.5" /> Ocean</TabsTrigger>
          <TabsTrigger value="air" data-testid="tab-mode-air"><Plane className="w-4 h-4 mr-1.5" /> Air</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
        {/* LEFT: form */}
        <div className="space-y-5">

          {/* Identifiers */}
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm font-semibold">Identifiers</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs text-muted-foreground">Your Reference (personal ref)</Label>
                <Input value={ids.personal_ref} onChange={(e) => setIds((p) => ({ ...p, personal_ref: e.target.value }))} placeholder="e.g. PO-2026-1442" data-testid="input-personal-ref" />
              </div>
              {!isAir ? (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Booking Number</Label>
                    <Input value={ids.booking_number} onChange={(e) => setIds((p) => ({ ...p, booking_number: e.target.value }))} placeholder="e.g. 12345678" data-testid="input-booking-number" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Container Number</Label>
                    <Input value={ids.container_number} onChange={(e) => setIds((p) => ({ ...p, container_number: e.target.value.toUpperCase() }))} placeholder="e.g. MSKU1234567" className="font-mono" data-testid="input-container-number" />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">AWB Number</Label>
                    <Input value={ids.awb_number} onChange={(e) => setIds((p) => ({ ...p, awb_number: e.target.value }))} placeholder="e.g. 020-12345678" className="font-mono" data-testid="input-awb-number" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Flight Number</Label>
                    <Input value={ids.flight_number} onChange={(e) => setIds((p) => ({ ...p, flight_number: e.target.value.toUpperCase() }))} placeholder="e.g. LH8400" className="font-mono" data-testid="input-flight-number" />
                  </div>
                </>
              )}
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs text-muted-foreground">Carrier SCAC (optional, helps route to direct API)</Label>
                <Input value={ids.carrier_scac} onChange={(e) => setIds((p) => ({ ...p, carrier_scac: e.target.value.toUpperCase() }))} placeholder="MAEU, HLCU, CMDU, MSCU, ONEY…" className="font-mono uppercase" data-testid="input-carrier-scac" />
              </div>
            </CardContent>
          </Card>

          {/* Route */}
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm font-semibold">Route</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Origin</Label>
                  <Input value={inputs.originPort} onChange={(e) => set("originPort", e.target.value)} placeholder={isAir ? "e.g. PVG" : "e.g. Shanghai (SHA)"} data-testid="input-origin" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Destination</Label>
                  <Input value={inputs.destinationPort} onChange={(e) => set("destinationPort", e.target.value)} placeholder={isAir ? "e.g. ORD" : "e.g. Los Angeles (LAX)"} data-testid="input-destination" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">ETD</Label>
                  <Input type="date" value={inputs.etd} onChange={(e) => set("etd", e.target.value)} data-testid="input-etd" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">ETA</Label>
                  <Input type="date" value={inputs.eta} onChange={(e) => set("eta", e.target.value)} data-testid="input-eta" />
                </div>
              </div>
              {(inputs.etd && inputs.eta) && new Date(inputs.eta) <= new Date(inputs.etd) && (
                <p className="text-xs text-amber-500">ETA must be after ETD — using default transit while you fix this.</p>
              )}
              {!isAir && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Transshipments</Label>
                  <Input type="number" min={0} max={5} value={inputs.transshipments}
                    onChange={(e) => set("transshipments", Math.min(5, Math.max(0, parseInt(e.target.value) || 0)))}
                    data-testid="input-transshipments" />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Risk inputs */}
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm font-semibold">Risk Factors</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              {!isAir ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <Sel label="Origin Congestion" value={inputs.originCongestion} onChange={(v) => set("originCongestion", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} />
                    {inputs.transshipments > 0 && (
                      <Sel label="Transship" value={inputs.transshipCongestion} onChange={(v) => set("transshipCongestion", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} />
                    )}
                    <Sel label="Dest Congestion" value={inputs.destCongestion} onChange={(v) => set("destCongestion", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Sel label="Season Risk" value={inputs.seasonRisk} onChange={(v) => set("seasonRisk", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} />
                    <Sel label="Route Risk" value={inputs.routeRisk} onChange={(v) => set("routeRisk", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} />
                    <Sel label="Carrier Reliability" value={inputs.carrierReliability} onChange={(v) => set("carrierReliability", v)} options={[{ value: "High", label: "High" }, { value: "Avg", label: "Avg" }, { value: "Low", label: "Low" }]} />
                    <Sel label="Schedule Buffer" value={inputs.bufferTightness} onChange={(v) => set("bufferTightness", v)} options={[{ value: "Loose", label: "Loose" }, { value: "Normal", label: "Normal" }, { value: "Tight", label: "Tight" }]} />
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-2 col-span-2">
                    <input type="checkbox" id="layover" checked={!!inputs.hasLayover} onChange={(e) => set("hasLayover", e.target.checked)} className="w-4 h-4" data-testid="checkbox-layover" />
                    <Label htmlFor="layover" className="text-sm">Has layover / transit stop</Label>
                  </div>
                  <Sel label="Weather Risk" value={inputs.weatherRisk!} onChange={(v) => set("weatherRisk", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} />
                  <Sel label="Slot/Capacity Pressure" value={inputs.slotPressure!} onChange={(v) => set("slotPressure", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} />
                  <Sel label="Airline Reliability" value={inputs.airlineReliability!} onChange={(v) => set("airlineReliability", v)} options={[{ value: "High", label: "High" }, { value: "Avg", label: "Avg" }, { value: "Low", label: "Low" }]} />
                  <Sel label="Route Risk" value={inputs.routeRisk} onChange={(v) => set("routeRisk", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} />
                </div>
              )}
            </CardContent>
          </Card>

          {/* P&L */}
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm font-semibold">Profit &amp; Loss</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Your Cost (USD)</Label>
                <Input type="number" step="0.01" value={pnl.cost} onChange={(e) => setPnl((p) => ({ ...p, cost: e.target.value }))} placeholder="e.g. 8000" data-testid="input-cost" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Sale Price (USD)</Label>
                <Input type="number" step="0.01" value={pnl.sale_price} onChange={(e) => setPnl((p) => ({ ...p, sale_price: e.target.value }))} placeholder="e.g. 11000" data-testid="input-sale-price" />
              </div>
              <div className="space-y-1.5 col-span-2">
                <Label className="text-xs text-muted-foreground">Buy insurance? (optional)</Label>
                <Select
                  value={pnl.insurance_chosen_trigger?.toString() ?? "none"}
                  onValueChange={(v) => setPnl((p) => ({ ...p, insurance_chosen_trigger: v === "none" ? null : parseInt(v) }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No insurance</SelectItem>
                    {result.triggers.map((t) => (
                      <SelectItem key={t.trigger} value={t.trigger.toString()}>
                        {t.trigger}-{result.triggerUnit} trigger — premium {fmtUSD(t.premium)} ({t.recommendation})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Insurance budget */}
          <Card>
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <button className="w-full flex items-center justify-between px-4 py-3 text-left">
                  <span className="text-sm font-semibold">Insurance Budget Slider</span>
                  <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="px-4 pb-4 space-y-2 border-t border-border pt-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">Premium Budget</Label>
                    <span className="text-sm font-bold tabular-nums">{fmtUSD(inputs.budget)}</span>
                  </div>
                  <Slider min={20} max={2500} step={20} value={[inputs.budget]} onValueChange={([v]) => set("budget", v)} />
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        </div>

        {/* RIGHT: live preview */}
        <div className="space-y-4 lg:sticky lg:top-20 self-start">
          <Card className={`border-l-4 ${colors.border}`}>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <Badge className={`${colors.bg}/20 ${colors.text} text-[10px] font-bold tracking-wider px-2 py-0.5 border-0`}>
                  {colors.label}
                </Badge>
                <span className={`text-2xl font-bold tabular-nums ${colors.text}`}>{Math.round(result.riskScore)}<span className="text-xs text-muted-foreground"> /100</span></span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted">
                <div className={`h-2 rounded-full ${colors.bg} transition-all`} style={{ width: `${result.riskScore}%` }} />
              </div>
              <Separator />
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <p className="text-muted-foreground">Transit</p>
                  <p className="font-semibold tabular-nums">{fmt(result.transitDays, 1)} {isAir ? "d" : "d"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Base Prob</p>
                  <p className="font-semibold tabular-nums">{fmtPct(result.baseDelayProbability)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Best Trigger</p>
                  <p className="font-semibold tabular-nums">{result.best.trigger}-{result.triggerUnit}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Best EV</p>
                  <p className={`font-bold tabular-nums ${result.best.ev > 0 ? "text-emerald-500" : "text-red-400"}`}>
                    {result.best.ev > 0 ? "+" : ""}{fmtUSD(result.best.ev)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Live P&L preview */}
          {(pnl.cost || pnl.sale_price) && (
            <Card>
              <CardContent className="p-4 space-y-2 text-xs">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Live P&amp;L</p>
                {(() => {
                  const cost = parseFloat(pnl.cost) || 0;
                  const sale = parseFloat(pnl.sale_price) || 0;
                  const chosen = pnl.insurance_chosen_trigger
                    ? result.triggers.find((t) => t.trigger === pnl.insurance_chosen_trigger)
                    : null;
                  const premium = chosen?.premium ?? 0;
                  const gross = sale - cost;
                  const expectedLoss = result.best.expectedPayout;
                  const net = premium > 0 ? gross - premium : gross - expectedLoss;
                  return (
                    <>
                      <div className="flex justify-between"><span className="text-muted-foreground">Gross Profit</span><span className={`font-bold tabular-nums ${gross >= 0 ? "text-emerald-500" : "text-red-400"}`}>{fmtUSD(gross)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Insurance Premium</span><span className="font-semibold tabular-nums">−{fmtUSD(premium)}</span></div>
                      {!chosen && <div className="flex justify-between"><span className="text-muted-foreground">Expected Delay Loss (uninsured)</span><span className="font-semibold tabular-nums text-amber-500">−{fmtUSD(expectedLoss)}</span></div>}
                      <Separator />
                      <div className="flex justify-between"><span className="font-semibold">Net Profit</span><span className={`font-bold tabular-nums ${net >= 0 ? "text-emerald-500" : "text-red-400"}`}>{fmtUSD(net)}</span></div>
                    </>
                  );
                })()}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
