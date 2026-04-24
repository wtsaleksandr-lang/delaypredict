import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronDown, Ship, Plane, Save, Loader2, HelpCircle, Sparkles, Lock, Unlock, Wand2, CheckCircle2, AlertCircle } from "lucide-react";
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
  vessel_mmsi: string;
  vessel_name: string;
}
const ID_DEFAULTS: IdFields = {
  personal_ref: "", booking_number: "", container_number: "", awb_number: "", flight_number: "", carrier_scac: "",
  vessel_mmsi: "", vessel_name: "",
};

interface PnLFields {
  cost: string;
  sale_price: string;
  insurance_chosen_trigger: number | null;
}
const PNL_DEFAULTS: PnLFields = { cost: "", sale_price: "", insurance_chosen_trigger: null };

// Which risk factors have been manually overridden — by default all are "auto" (oracle-driven if data is available).
type OverrideKey = "season" | "route" | "carrier" | "buffer" | "originCongestion" | "destCongestion";
type OverrideMap = Record<OverrideKey, boolean>;
const OVERRIDE_DEFAULTS: OverrideMap = {
  season: false, route: false, carrier: false, buffer: false, originCongestion: false, destCongestion: false,
};

interface Detection {
  season?: { value: "Low" | "Med" | "High"; rationale: string; source: string };
  carrier?: { value: "High" | "Avg" | "Low"; rationale: string; source?: string; asOf?: string };
  buffer?: { value: "Loose" | "Normal" | "Tight"; rationale: string; confidence: string; sampleSize: number; source: string };
  port_origin?: { value: "Low" | "Med" | "High"; rationale: string; source: string; asOf?: string };
  port_destination?: { value: "Low" | "Med" | "High"; rationale: string; source: string; asOf?: string };
  route?: { value: "Low" | "Med" | "High"; rationale: string; source: string; asOf?: string };
  intelAsOf?: string;
}

// Reverse-lookup carrier display name → SCAC (used by prefill response)
function carrierNameToScac(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("maersk")) return "MAEU";
  if (n.includes("msc")) return "MSCU";
  if (n.includes("hapag")) return "HLCU";
  if (n.includes("cma")) return "CMDU";
  if (n.includes("one") || n.includes("ocean network")) return "ONEY";
  if (n.includes("zim")) return "ZIMU";
  if (n.includes("evergreen")) return "EGLV";
  if (n.includes("cosco")) return "COSU";
  if (n.includes("yang ming")) return "YMLU";
  if (n.includes("hmm") || n.includes("hyundai")) return "HMMU";
  return "";
}

// Compact (?) helper
function Help({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <HelpCircle className="w-3 h-3 text-muted-foreground/70 hover:text-foreground cursor-help shrink-0" />
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs text-xs leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  );
}

// "(auto — rationale)" chip next to a risk-factor label
function AutoBadge({ rationale, source, asOf, onOverride }: { rationale: string; source?: string; asOf?: string; onOverride: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOverride}
          className="inline-flex items-center gap-1 text-[10px] font-medium text-primary bg-primary/10 hover:bg-primary/20 border border-primary/30 rounded px-1.5 py-0.5 cursor-pointer"
        >
          <Sparkles className="w-2.5 h-2.5" /> auto
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        <p><strong>Auto-detected:</strong> {rationale}</p>
        {source && <p className="text-[10px] text-muted-foreground mt-1">Source: {source}{asOf ? ` (${asOf})` : ""}</p>}
        <p className="text-[10px] text-primary mt-1">Click the chip to override manually.</p>
      </TooltipContent>
    </Tooltip>
  );
}

function ManualBadge({ onRevert }: { onRevert: () => void }) {
  return (
    <button
      type="button"
      onClick={onRevert}
      className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground bg-muted hover:bg-muted/80 border border-border rounded px-1.5 py-0.5 cursor-pointer"
      title="Click to revert to auto-detection"
    >
      <Lock className="w-2.5 h-2.5" /> manual
    </button>
  );
}

function Sel<T extends string>({
  label, value, onChange, options, help, chip,
}: {
  label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[];
  help?: string; chip?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
        {label}
        {help && <Help text={help} />}
        {chip}
      </Label>
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
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [overrides, setOverrides] = useState<OverrideMap>(OVERRIDE_DEFAULTS);
  const [detection, setDetection] = useState<Detection | null>(null);

  // Auto-fill state
  const [prefillStatus, setPrefillStatus] = useState<{ kind: "idle" | "loading" | "ok" | "err"; message?: string; matchedVia?: string }>({ kind: "idle" });
  const [vesselCandidates, setVesselCandidates] = useState<Array<{ mmsi: string; shipName: string; lastSeenAt: string }>>([]);
  const [vesselLookupStatus, setVesselLookupStatus] = useState<"idle" | "looking" | "matched" | "ambiguous" | "none">("idle");

  function set<K extends keyof CalcInputs>(k: K, v: CalcInputs[K]) {
    setInputs((p) => ({ ...p, [k]: v }));
  }
  function toggleOverride(key: OverrideKey) {
    setOverrides((p) => ({ ...p, [key]: !p[key] }));
  }

  // Ask the server for auto-detection whenever the relevant inputs change
  useEffect(() => {
    const body = {
      mode: inputs.mode,
      origin: inputs.originPort || null,
      destination: inputs.destinationPort || null,
      etd: inputs.etd || null,
      eta: inputs.eta || null,
      carrierScac: ids.carrier_scac || null,
    };
    if (!body.origin && !body.destination && !body.etd) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiRequest("POST", "/api/risk/detect", body);
        const data = await r.json();
        if (!cancelled) setDetection(data);
      } catch { /* silent — form still works manually */ }
    })();
    return () => { cancelled = true; };
  }, [inputs.mode, inputs.originPort, inputs.destinationPort, inputs.etd, inputs.eta, ids.carrier_scac]);

  // Apply auto-detected values to inputs (only for factors not manually overridden)
  useEffect(() => {
    if (!detection) return;
    setInputs((prev) => {
      const next = { ...prev };
      if (!overrides.season && detection.season) next.seasonRisk = detection.season.value;
      if (!overrides.route && detection.route) next.routeRisk = detection.route.value;
      if (!overrides.carrier && detection.carrier) next.carrierReliability = detection.carrier.value;
      if (!overrides.buffer && detection.buffer) next.bufferTightness = detection.buffer.value;
      if (!overrides.originCongestion && detection.port_origin) next.originCongestion = detection.port_origin.value;
      if (!overrides.destCongestion && detection.port_destination) next.destCongestion = detection.port_destination.value;
      return next;
    });
  }, [detection, overrides]);

  const result = useMemo(() => calculate(inputs), [inputs]);
  const colors = riskColor(result.riskScore);
  const derivedTier = deriveRiskTier(result.riskScore);
  if (inputs.riskTier !== derivedTier) {
    queueMicrotask(() => setInputs((p) => ({ ...p, riskTier: derivedTier })));
  }

  // Auto-prefill from carrier APIs (booking / container / awb)
  async function runPrefill() {
    setPrefillStatus({ kind: "loading" });
    try {
      const r = await apiRequest("POST", "/api/shipments/prefill", {
        mode: inputs.mode,
        booking_number: ids.booking_number || null,
        container_number: ids.container_number || null,
        awb_number: ids.awb_number || null,
        flight_number: ids.flight_number || null,
        carrier_scac: ids.carrier_scac || null,
      });
      const data = await r.json();
      const f = data.fields || {};
      // Apply only fields the user hasn't already filled
      setInputs((prev) => ({
        ...prev,
        originPort: prev.originPort || f.origin || "",
        destinationPort: prev.destinationPort || f.destination || "",
        etd: prev.etd || (f.etd ? String(f.etd).slice(0, 10) : ""),
        eta: prev.eta || (f.eta ? String(f.eta).slice(0, 10) : ""),
        transshipments: f.transshipments != null && prev.transshipments === 0 ? f.transshipments : prev.transshipments,
      }));
      setIds((prev) => ({
        ...prev,
        vessel_name: prev.vessel_name || f.vessel_name || "",
        vessel_mmsi: prev.vessel_mmsi || f.vessel_mmsi || "",
        carrier_scac: prev.carrier_scac || (f.carrier ? carrierNameToScac(f.carrier) : ""),
      }));
      const filled = [f.origin && "origin", f.destination && "destination", f.etd && "ETD", f.eta && "ETA", f.vessel_name && "vessel"].filter(Boolean).join(", ");
      setPrefillStatus({
        kind: "ok",
        matchedVia: data.matched_via,
        message: filled ? `Filled ${filled} from ${data.matched_via}` : `No useful fields returned from ${data.matched_via}`,
      });
      if (data.vessel_match_candidates?.length) setVesselCandidates(data.vessel_match_candidates);
      if (data.warnings?.length) toast({ title: "Prefill warnings", description: data.warnings.join(" • ") });
    } catch (err: any) {
      setPrefillStatus({ kind: "err", message: String(err?.message || err) });
    }
  }

  // Vessel-name → MMSI lookup (debounced on typing)
  useEffect(() => {
    if (inputs.mode !== "ocean") return;
    const name = ids.vessel_name?.trim();
    if (!name || name.length < 3) {
      setVesselLookupStatus("idle");
      setVesselCandidates([]);
      return;
    }
    setVesselLookupStatus("looking");
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/vessels/lookup?name=${encodeURIComponent(name)}`);
        const data = await r.json();
        const matches = data.matches ?? [];
        if (matches.length === 0) {
          setVesselLookupStatus("none");
          setVesselCandidates([]);
        } else if (matches.length === 1) {
          setVesselLookupStatus("matched");
          setVesselCandidates([]);
          setIds((prev) => ({ ...prev, vessel_mmsi: matches[0].mmsi, vessel_name: matches[0].shipName }));
        } else {
          setVesselLookupStatus("ambiguous");
          setVesselCandidates(matches);
        }
      } catch {
        setVesselLookupStatus("idle");
      }
    }, 600);
    return () => clearTimeout(t);
  }, [ids.vessel_name, inputs.mode]);

  const create = useMutation({
    mutationFn: async () => {
      const chosen = pnl.insurance_chosen_trigger ? result.triggers.find((t) => t.trigger === pnl.insurance_chosen_trigger) : null;
      const body = {
        personal_ref: ids.personal_ref || null, // server auto-generates if blank
        mode: inputs.mode,
        booking_number: ids.booking_number || null,
        container_number: ids.container_number || null,
        awb_number: ids.awb_number || null,
        flight_number: ids.flight_number || null,
        carrier_scac: ids.carrier_scac || null,
        vessel_mmsi: ids.vessel_mmsi || null,
        vessel_name: ids.vessel_name || null,
        origin: inputs.originPort || null,
        destination: inputs.destinationPort || null,
        etd: inputs.etd || null,
        eta: inputs.eta || null,
        inputs_json: { ...inputs, overrides, detection },
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
      toast({ title: "Shipment saved", description: created.personal_ref });
      navigate(`/shipments/${created.id}`);
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: String(err?.message || err), variant: "destructive" });
    },
  });

  const isAir = inputs.mode === "air";

  // Label chip builder: shows (auto) or (manual) based on override state
  const chipFor = (key: OverrideKey, det?: { rationale: string; source?: string; asOf?: string }) => {
    if (overrides[key]) return <ManualBadge onRevert={() => toggleOverride(key)} />;
    if (det) return <AutoBadge rationale={det.rationale} source={det.source} asOf={det.asOf} onOverride={() => toggleOverride(key)} />;
    return null;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">New Shipment</h1>
          <p className="text-sm text-muted-foreground">Risk factors auto-fill from the oracle when possible. Click any <strong className="text-primary">auto</strong> chip to override.</p>
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
        {/* LEFT */}
        <div className="space-y-5">

          {/* Identifiers */}
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                Identifiers
                <Help text="Just enter your booking or container number and click Auto-fill — the system will pull route, dates, vessel, and carrier from the carrier API. All fields are optional; leave reference blank to auto-generate." />
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                  Your Reference (personal ref)
                  <Help text="Your own PO / order / file number. If blank, one will be generated on save (format DP-YYYYMMDD-XXXX)." />
                </Label>
                <Input value={ids.personal_ref} onChange={(e) => setIds((p) => ({ ...p, personal_ref: e.target.value }))} placeholder="e.g. PO-2026-1442 (leave blank to auto-generate)" data-testid="input-personal-ref" />
              </div>
              {!isAir ? (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                      Booking Number <Help text="The carrier's booking reference for this shipment. Click Auto-fill below after entering this OR a container number to pull all the rest." />
                    </Label>
                    <Input value={ids.booking_number} onChange={(e) => setIds((p) => ({ ...p, booking_number: e.target.value }))} placeholder="e.g. 12345678" data-testid="input-booking-number" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                      Container Number <Help text="11-character ISO container ID (e.g. MSKU1234567). Click Auto-fill below to pull route + dates + vessel from the carrier." />
                    </Label>
                    <Input value={ids.container_number} onChange={(e) => setIds((p) => ({ ...p, container_number: e.target.value.toUpperCase() }))} placeholder="e.g. MSKU1234567" className="font-mono" data-testid="input-container-number" />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                      AWB Number <Help text="Air waybill number — 3 digits (airline prefix) + 8 digits. Click Auto-fill to pull route + dates from 17TRACK." />
                    </Label>
                    <Input value={ids.awb_number} onChange={(e) => setIds((p) => ({ ...p, awb_number: e.target.value }))} placeholder="e.g. 020-12345678" className="font-mono" data-testid="input-awb-number" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                      Flight Number <Help text="IATA or ICAO flight number (e.g. LH8400 / DLH8400). Used with OpenSky for free flight-status tracking." />
                    </Label>
                    <Input value={ids.flight_number} onChange={(e) => setIds((p) => ({ ...p, flight_number: e.target.value.toUpperCase() }))} placeholder="e.g. LH8400" className="font-mono" data-testid="input-flight-number" />
                  </div>
                </>
              )}

              {/* Auto-fill from carrier — the headline button */}
              <div className="sm:col-span-2 flex items-center gap-2 flex-wrap">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={runPrefill}
                  disabled={prefillStatus.kind === "loading" || (!ids.booking_number && !ids.container_number && !ids.awb_number && !ids.flight_number)}
                  data-testid="button-prefill"
                >
                  {prefillStatus.kind === "loading"
                    ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                    : <Wand2 className="w-4 h-4 mr-1.5" />}
                  Auto-fill from carrier
                </Button>
                {prefillStatus.kind === "ok" && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {prefillStatus.message}
                  </span>
                )}
                {prefillStatus.kind === "err" && (
                  <span className="inline-flex items-center gap-1 text-xs text-red-400">
                    <AlertCircle className="w-3.5 h-3.5" /> {prefillStatus.message}
                  </span>
                )}
                {prefillStatus.kind === "idle" && (
                  <span className="text-[11px] text-muted-foreground">Enter a booking, container, or AWB number above, then click to fetch route, dates, vessel.</span>
                )}
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                  Carrier SCAC <Help text="4-letter Standard Carrier Alpha Code (e.g. MAEU for Maersk, HLCU for Hapag-Lloyd). Filled automatically by Auto-fill; otherwise lets the app route tracking to the right carrier-direct API." />
                </Label>
                <Input value={ids.carrier_scac} onChange={(e) => setIds((p) => ({ ...p, carrier_scac: e.target.value.toUpperCase() }))} placeholder="MAEU, HLCU, CMDU, MSCU, ONEY…" className="font-mono uppercase" data-testid="input-carrier-scac" />
              </div>

              {!isAir && (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    Vessel Name
                    <Help text="The ship's name (e.g. MAERSK DENVER). Type at least 3 letters and we'll match it to a live AIS-tracked vessel automatically. You don't need to know the MMSI — we look it up for you." />
                    {vesselLookupStatus === "looking" && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                    {vesselLookupStatus === "matched" && <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-400"><CheckCircle2 className="w-3 h-3" /> matched · MMSI {ids.vessel_mmsi}</span>}
                    {vesselLookupStatus === "ambiguous" && <span className="text-[10px] font-bold text-amber-400">{vesselCandidates.length} matches — pick one ↓</span>}
                    {vesselLookupStatus === "none" && <span className="text-[10px] text-muted-foreground">not in AIS cache yet</span>}
                  </Label>
                  <Input value={ids.vessel_name} onChange={(e) => setIds((p) => ({ ...p, vessel_name: e.target.value, vessel_mmsi: "" }))} placeholder="e.g. MAERSK DENVER" data-testid="input-vessel-name" />
                  {vesselLookupStatus === "ambiguous" && vesselCandidates.length > 0 && (
                    <div className="space-y-1 rounded border border-amber-500/40 bg-amber-500/5 p-2">
                      <p className="text-[10px] uppercase tracking-wider text-amber-400 font-medium">Multiple vessels match — choose:</p>
                      {vesselCandidates.map((c) => (
                        <button
                          key={c.mmsi}
                          type="button"
                          onClick={() => {
                            setIds((p) => ({ ...p, vessel_name: c.shipName, vessel_mmsi: c.mmsi }));
                            setVesselLookupStatus("matched");
                            setVesselCandidates([]);
                          }}
                          className="w-full flex items-center justify-between text-xs px-2 py-1 rounded hover:bg-amber-500/15 text-left"
                        >
                          <span className="font-mono text-foreground">{c.shipName}</span>
                          <span className="text-[10px] text-muted-foreground">MMSI {c.mmsi} · last seen {new Date(c.lastSeenAt).toLocaleDateString()}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
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
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    Transshipments <Help text="Number of intermediate ports where cargo changes vessels. 0 = direct. Each extra transshipment adds ~6 points to risk score." />
                  </Label>
                  <Input type="number" min={0} max={5} value={inputs.transshipments}
                    onChange={(e) => set("transshipments", Math.min(5, Math.max(0, parseInt(e.target.value) || 0)))}
                    data-testid="input-transshipments" />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Risk factors — with auto/manual chips */}
          <Card>
            <CardHeader className="pb-3 pt-4 px-4 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                Risk Factors
                <Help text="These drive the 0-100 risk score. Factors with an 'auto' chip are auto-filled from the oracle (seasonal rules, carrier reliability table, your historical shipments, intel scraper). Click any chip to override." />
              </CardTitle>
              {detection?.intelAsOf && (
                <span className="text-[10px] text-muted-foreground">Intel: {detection.intelAsOf.slice(0, 10)}</span>
              )}
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              {!isAir ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <Sel label="Origin Congestion" value={inputs.originCongestion} onChange={(v) => set("originCongestion", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} chip={chipFor("originCongestion", detection?.port_origin)} help="How busy the origin port is this week — longer queue times mean higher delay risk. Auto-filled from weekly intel scraper when available." />
                    {inputs.transshipments > 0 && (
                      <Sel label="Transship" value={inputs.transshipCongestion} onChange={(v) => set("transshipCongestion", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} />
                    )}
                    <Sel label="Dest Congestion" value={inputs.destCongestion} onChange={(v) => set("destCongestion", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} chip={chipFor("destCongestion", detection?.port_destination)} help="Destination port congestion this week. Same source as origin." />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Sel label="Season Risk" value={inputs.seasonRisk} onChange={(v) => set("seasonRisk", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} chip={chipFor("season", detection?.season)} help="Seasonal disruptions — typhoon / hurricane season, CNY closures, winter storms. Auto-computed from ETD + route." />
                    <Sel label="Route Risk" value={inputs.routeRisk} onChange={(v) => set("routeRisk", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} chip={chipFor("route", detection?.route)} help="Geopolitical / lane-specific disruption (Red Sea, Panama Canal water, strikes, overflight bans). Auto-filled from intel scraper." />
                    <Sel label="Carrier Reliability" value={inputs.carrierReliability} onChange={(v) => set("carrierReliability", v)} options={[{ value: "High", label: "High" }, { value: "Avg", label: "Avg" }, { value: "Low", label: "Low" }]} chip={chipFor("carrier", detection?.carrier)} help="How often this carrier arrives on time, based on Sea-Intelligence monthly reliability reports. Enter carrier SCAC above to auto-fill." />
                    <Sel label="Schedule Buffer" value={inputs.bufferTightness} onChange={(v) => set("bufferTightness", v)} options={[{ value: "Loose", label: "Loose" }, { value: "Normal", label: "Normal" }, { value: "Tight", label: "Tight" }]} chip={chipFor("buffer", detection?.buffer)} help="How much slack between ETD and ETA vs your historical transit times for this lane. Needs ≥5 past shipments on the same route to auto-fill." />
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-2 col-span-2">
                    <input type="checkbox" id="layover" checked={!!inputs.hasLayover} onChange={(e) => set("hasLayover", e.target.checked)} className="w-4 h-4" data-testid="checkbox-layover" />
                    <Label htmlFor="layover" className="text-sm">Has layover / transit stop</Label>
                    <Help text="Cargo on a direct flight has meaningfully lower delay risk than one going through an intermediate hub." />
                  </div>
                  <Sel label="Weather Risk" value={inputs.weatherRisk!} onChange={(v) => set("weatherRisk", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} chip={chipFor("season", detection?.season)} help="Weather/season disruption for this route and date. Auto-filled from seasonal rules." />
                  <Sel label="Slot/Capacity Pressure" value={inputs.slotPressure!} onChange={(v) => set("slotPressure", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} help="How tight available cargo space is at the origin airport this week. Manual only today." />
                  <Sel label="Airline Reliability" value={inputs.airlineReliability!} onChange={(v) => set("airlineReliability", v)} options={[{ value: "High", label: "High" }, { value: "Avg", label: "Avg" }, { value: "Low", label: "Low" }]} help="Airline on-time performance. Manual for now; auto-fill can be added with OAG data." />
                  <Sel label="Route Risk" value={inputs.routeRisk} onChange={(v) => set("routeRisk", v)} options={[{ value: "Low", label: "Low" }, { value: "Med", label: "Med" }, { value: "High", label: "High" }]} chip={chipFor("route", detection?.route)} help="Overflight restrictions / geopolitical — e.g. Russia overflight bans, Middle East diversions." />
                </div>
              )}
            </CardContent>
          </Card>

          {/* P&L */}
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                Profit &amp; Loss
                <Help text="Your cost + sale price drive the net P&L tile on the report. Optional — leave blank if you only want the delay-risk analysis." />
              </CardTitle>
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
                <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                  Buy insurance? <Help text="Pick a trigger window to price insurance for this shipment. The premium + recommendation come straight from the model." />
                </Label>
                <Select value={pnl.insurance_chosen_trigger?.toString() ?? "none"} onValueChange={(v) => setPnl((p) => ({ ...p, insurance_chosen_trigger: v === "none" ? null : parseInt(v) }))}>
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

          {/* Budget slider */}
          <Card>
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <button className="w-full flex items-center justify-between px-4 py-3 text-left">
                  <span className="text-sm font-semibold flex items-center gap-1.5">
                    Insurance Budget <Help text="How much you'd pay for a premium. The insured limit is derived from this and the rate." />
                  </span>
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
                  <p className="font-semibold tabular-nums">{fmt(result.transitDays, 1)} d</p>
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

          {(pnl.cost || pnl.sale_price) && (
            <Card>
              <CardContent className="p-4 space-y-2 text-xs">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Live P&amp;L</p>
                {(() => {
                  const cost = parseFloat(pnl.cost) || 0;
                  const sale = parseFloat(pnl.sale_price) || 0;
                  const chosen = pnl.insurance_chosen_trigger ? result.triggers.find((t) => t.trigger === pnl.insurance_chosen_trigger) : null;
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
