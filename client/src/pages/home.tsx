import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronDown, ChevronUp, Info, Ship, TrendingUp, AlertTriangle, ShieldCheck, Minus } from "lucide-react";
import {
  calculate,
  type CalcInputs,
  type TriggerResult,
  type RiskTier,
  type CongestionLevel,
  type CarrierReliability,
  type SeasonRisk,
  type RouteRisk,
  type BufferTightness,
  fmtUSD,
  fmtPct,
  fmt,
} from "@/lib/calculations";

const DEFAULT_INPUTS: CalcInputs = {
  originPort: "",
  destinationPort: "",
  etd: "",
  eta: "",
  transshipments: 1,
  budget: 100,
  riskTier: "High",
  originCongestion: "Med",
  transshipCongestion: "Med",
  destCongestion: "Med",
  seasonRisk: "Med",
  routeRisk: "Med",
  carrierReliability: "Avg",
  bufferTightness: "Normal",
};

function RiskScoreBar({ score }: { score: number }) {
  const color =
    score < 33 ? "bg-emerald-500" : score < 66 ? "bg-amber-500" : "bg-red-500";
  const label =
    score < 33 ? "Low Risk" : score < 66 ? "Moderate Risk" : "High Risk";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
        <span className="text-xs font-bold tabular-nums text-foreground">{Math.round(score)} / 100</span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted">
        <div
          className={`h-2 rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

function RecommendationBadge({ rec }: { rec: "INSURE" | "OPTIONAL" | "SKIP" }) {
  if (rec === "INSURE") {
    return (
      <Badge className="bg-emerald-600 text-white text-xs font-bold tracking-wider px-3 py-1">
        INSURE
      </Badge>
    );
  }
  if (rec === "OPTIONAL") {
    return (
      <Badge className="bg-amber-500 text-white text-xs font-bold tracking-wider px-3 py-1">
        OPTIONAL
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-600 text-white text-xs font-bold tracking-wider px-3 py-1">
      SKIP
    </Badge>
  );
}

function TriggerCard({
  result,
  isBest,
}: {
  result: TriggerResult;
  isBest: boolean;
}) {
  const Icon =
    result.recommendation === "INSURE"
      ? ShieldCheck
      : result.recommendation === "OPTIONAL"
      ? AlertTriangle
      : Minus;

  return (
    <div
      data-testid={`trigger-card-${result.trigger}`}
      className={`rounded-lg border p-4 transition-all duration-200 space-y-3 ${
        isBest
          ? "border-primary bg-primary/5 ring-1 ring-primary/30"
          : "border-border bg-card"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon
            className={`w-4 h-4 shrink-0 ${
              result.recommendation === "INSURE"
                ? "text-emerald-500"
                : result.recommendation === "OPTIONAL"
                ? "text-amber-500"
                : "text-muted-foreground"
            }`}
          />
          <div>
            <p className="text-sm font-bold text-foreground leading-none">
              {result.trigger}-Day Trigger
            </p>
            {isBest && (
              <p className="text-xs text-primary mt-0.5 font-medium">Best EV</p>
            )}
          </div>
        </div>
        <RecommendationBadge rec={result.recommendation} />
      </div>

      <Separator className="bg-border/60" />

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div>
          <p className="text-muted-foreground">Insured Limit</p>
          <p className="font-semibold text-foreground tabular-nums" data-testid={`limit-${result.trigger}`}>
            {fmtUSD(result.insuredLimit)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Premium</p>
          <p className="font-semibold text-foreground tabular-nums" data-testid={`premium-${result.trigger}`}>
            {fmtUSD(result.premium)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Trigger Prob.</p>
          <p className="font-semibold text-foreground tabular-nums" data-testid={`prob-${result.trigger}`}>
            {fmtPct(result.triggerProbability)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Payout %</p>
          <p className="font-semibold text-foreground tabular-nums">
            {fmtPct(result.expectedPayoutPct)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Exp. Payout</p>
          <p className="font-semibold text-foreground tabular-nums" data-testid={`payout-${result.trigger}`}>
            {fmtUSD(result.expectedPayout)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">EV</p>
          <p
            className={`font-bold tabular-nums ${
              result.ev > 0 ? "text-emerald-500" : "text-red-400"
            }`}
            data-testid={`ev-${result.trigger}`}
          >
            {result.ev > 0 ? "+" : ""}
            {fmtUSD(result.ev)}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-muted-foreground">ROI</span>
        <span
          className={`text-sm font-bold tabular-nums ${
            result.roi >= 1
              ? "text-emerald-500"
              : result.roi > 0
              ? "text-amber-500"
              : "text-red-400"
          }`}
          data-testid={`roi-${result.trigger}`}
        >
          {result.roi > 0 ? "+" : ""}
          {fmt(result.roi, 2)}×
        </span>
      </div>
    </div>
  );
}

function SelectGroup<T extends string>({
  label,
  value,
  options,
  onValueChange,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onValueChange: (v: T) => void;
  testId?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={(v) => onValueChange(v as T)}>
        <SelectTrigger data-testid={testId} className="h-9 text-sm bg-background">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function Home() {
  const [inputs, setInputs] = useState<CalcInputs>(DEFAULT_INPUTS);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const result = useMemo(() => calculate(inputs), [inputs]);

  function set<K extends keyof CalcInputs>(key: K, value: CalcInputs[K]) {
    setInputs((prev) => ({ ...prev, [key]: value }));
  }

  const congestionOptions: { value: CongestionLevel; label: string }[] = [
    { value: "Low", label: "Low" },
    { value: "Med", label: "Medium" },
    { value: "High", label: "High" },
  ];

  const riskTierOptions: { value: RiskTier; label: string }[] = [
    { value: "Low", label: "Low" },
    { value: "Medium", label: "Medium" },
    { value: "High", label: "High" },
  ];

  const carrierOptions: { value: CarrierReliability; label: string }[] = [
    { value: "High", label: "High" },
    { value: "Avg", label: "Average" },
    { value: "Low", label: "Low" },
  ];

  const seasonOptions: { value: SeasonRisk; label: string }[] = [
    { value: "Low", label: "Low" },
    { value: "Med", label: "Medium" },
    { value: "High", label: "High" },
  ];

  const routeOptions: { value: RouteRisk; label: string }[] = [
    { value: "Low", label: "Low" },
    { value: "Med", label: "Medium" },
    { value: "High", label: "High" },
  ];

  const bufferOptions: { value: BufferTightness; label: string }[] = [
    { value: "Loose", label: "Loose" },
    { value: "Normal", label: "Normal" },
    { value: "Tight", label: "Tight" },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center shrink-0">
              <Ship className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-foreground tracking-tight text-lg">DelayPredict</span>
          </div>
          <Separator orientation="vertical" className="h-5" />
          <span className="text-xs text-muted-foreground hidden sm:block">
            Ocean Freight Delay Risk Calculator
          </span>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6 lg:py-8">
        <div className="flex flex-col lg:flex-row gap-6">

          {/* ── LEFT PANEL: Inputs ── */}
          <div className="w-full lg:w-[400px] shrink-0 space-y-4">

            {/* Routing */}
            <Card className="border-card-border">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold text-foreground">
                  Routing
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Origin Port</Label>
                  <Input
                    data-testid="input-origin-port"
                    placeholder="e.g. Shanghai (SHA)"
                    value={inputs.originPort}
                    onChange={(e) => set("originPort", e.target.value)}
                    className="h-9 text-sm bg-background"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Destination Port</Label>
                  <Input
                    data-testid="input-dest-port"
                    placeholder="e.g. Los Angeles (LAX)"
                    value={inputs.destinationPort}
                    onChange={(e) => set("destinationPort", e.target.value)}
                    className="h-9 text-sm bg-background"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">ETD</Label>
                    <Input
                      data-testid="input-etd"
                      type="date"
                      value={inputs.etd}
                      onChange={(e) => set("etd", e.target.value)}
                      className="h-9 text-sm bg-background"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">ETA</Label>
                    <Input
                      data-testid="input-eta"
                      type="date"
                      value={inputs.eta}
                      onChange={(e) => set("eta", e.target.value)}
                      className="h-9 text-sm bg-background"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Transshipments</Label>
                  <Input
                    data-testid="input-transshipments"
                    type="number"
                    min={0}
                    max={5}
                    value={inputs.transshipments}
                    onChange={(e) =>
                      set("transshipments", Math.max(0, parseInt(e.target.value) || 0))
                    }
                    className="h-9 text-sm bg-background"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Budget & Tier */}
            <Card className="border-card-border">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold text-foreground">
                  Insurance Parameters
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                      Budget (Premium)
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="w-3 h-3 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-48 text-xs">
                          This is the maximum premium you want to pay. The insured limit is derived from this.
                        </TooltipContent>
                      </Tooltip>
                    </Label>
                    <span
                      className="text-sm font-bold text-foreground tabular-nums"
                      data-testid="text-budget"
                    >
                      {fmtUSD(inputs.budget)}
                    </span>
                  </div>
                  <Slider
                    data-testid="slider-budget"
                    min={20}
                    max={300}
                    step={5}
                    value={[inputs.budget]}
                    onValueChange={([v]) => set("budget", v)}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>$20</span>
                    <span>$300</span>
                  </div>
                </div>

                <SelectGroup
                  label="Risk Tier"
                  value={inputs.riskTier}
                  options={riskTierOptions}
                  onValueChange={(v) => set("riskTier", v)}
                  testId="select-risk-tier"
                />
              </CardContent>
            </Card>

            {/* Advanced */}
            <Card className="border-card-border">
              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger asChild>
                  <button
                    data-testid="button-advanced-toggle"
                    className="w-full flex items-center justify-between px-4 py-3 text-left"
                  >
                    <span className="text-sm font-semibold text-foreground">Advanced</span>
                    <div className="flex items-center gap-1.5">
                      {!advancedOpen && (
                        <span className="text-xs text-muted-foreground">Med / Avg defaults</span>
                      )}
                      {advancedOpen ? (
                        <ChevronUp className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      )}
                    </div>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Port Congestion</p>
                    <div className="grid grid-cols-3 gap-2">
                      <SelectGroup
                        label="Origin"
                        value={inputs.originCongestion}
                        options={congestionOptions}
                        onValueChange={(v) => set("originCongestion", v)}
                        testId="select-origin-congestion"
                      />
                      <SelectGroup
                        label="Transship"
                        value={inputs.transshipCongestion}
                        options={congestionOptions}
                        onValueChange={(v) => set("transshipCongestion", v)}
                        testId="select-transship-congestion"
                      />
                      <SelectGroup
                        label="Destination"
                        value={inputs.destCongestion}
                        options={congestionOptions}
                        onValueChange={(v) => set("destCongestion", v)}
                        testId="select-dest-congestion"
                      />
                    </div>

                    <Separator className="bg-border/60" />

                    <SelectGroup
                      label="Season Risk"
                      value={inputs.seasonRisk}
                      options={seasonOptions}
                      onValueChange={(v) => set("seasonRisk", v)}
                      testId="select-season-risk"
                    />
                    <SelectGroup
                      label="Route / Geopolitical Risk"
                      value={inputs.routeRisk}
                      options={routeOptions}
                      onValueChange={(v) => set("routeRisk", v)}
                      testId="select-route-risk"
                    />
                    <SelectGroup
                      label="Carrier Reliability"
                      value={inputs.carrierReliability}
                      options={carrierOptions}
                      onValueChange={(v) => set("carrierReliability", v)}
                      testId="select-carrier-reliability"
                    />
                    <SelectGroup
                      label="Schedule Buffer Tightness"
                      value={inputs.bufferTightness}
                      options={bufferOptions}
                      onValueChange={(v) => set("bufferTightness", v)}
                      testId="select-buffer-tightness"
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          </div>

          {/* ── RIGHT PANEL: Results ── */}
          <div className="flex-1 min-w-0 space-y-4">

            {/* Best Recommendation */}
            <Card className="border-card-border">
              <CardContent className="p-4 sm:p-5">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                      Recommendation
                    </p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <RecommendationBadge rec={result.best.recommendation} />
                      <span className="text-xl font-bold text-foreground" data-testid="text-best-trigger">
                        {result.best.trigger}-Day Trigger
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground pt-0.5">
                      Highest expected value across all triggers
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <TrendingUp className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">EV</span>
                    <span
                      className={`text-lg font-bold tabular-nums ${
                        result.best.ev > 0 ? "text-emerald-500" : "text-red-400"
                      }`}
                      data-testid="text-best-ev"
                    >
                      {result.best.ev > 0 ? "+" : ""}{fmtUSD(result.best.ev)}
                    </span>
                  </div>
                </div>

                <Separator className="my-4 bg-border/60" />

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Insured Limit</p>
                    <p className="text-base font-bold text-foreground tabular-nums" data-testid="text-best-limit">
                      {fmtUSD(result.best.insuredLimit)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Premium</p>
                    <p className="text-base font-bold text-foreground tabular-nums" data-testid="text-best-premium">
                      {fmtUSD(result.best.premium)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Trigger Prob.</p>
                    <p className="text-base font-bold text-foreground tabular-nums" data-testid="text-best-prob">
                      {fmtPct(result.best.triggerProbability)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">ROI</p>
                    <p
                      className={`text-base font-bold tabular-nums ${
                        result.best.roi >= 1
                          ? "text-emerald-500"
                          : result.best.roi > 0
                          ? "text-amber-500"
                          : "text-red-400"
                      }`}
                      data-testid="text-best-roi"
                    >
                      {result.best.roi > 0 ? "+" : ""}{fmt(result.best.roi, 2)}×
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Risk Score */}
            <Card className="border-card-border">
              <CardContent className="px-4 py-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-foreground uppercase tracking-wider">
                    Risk Score
                  </p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap justify-end">
                    <span className="tabular-nums" data-testid="text-transit-days">
                      Transit: <span className="text-foreground font-semibold">{result.transitDays}d</span>
                    </span>
                    <span className="tabular-nums" data-testid="text-base-prob">
                      Base Prob: <span className="text-foreground font-semibold">{fmtPct(result.baseDelayProbability)}</span>
                    </span>
                    <span className="tabular-nums">
                      Exp. Delay: <span className="text-foreground font-semibold">{fmt(result.expectedDelayDays, 1)}d</span>
                    </span>
                  </div>
                </div>
                <RiskScoreBar score={result.riskScore} />
              </CardContent>
            </Card>

            {/* Trigger Comparison */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Trigger Comparison
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {result.triggers.map((t) => (
                  <TriggerCard
                    key={t.trigger}
                    result={t}
                    isBest={t.trigger === result.best.trigger}
                  />
                ))}
              </div>
            </div>

            {/* Rate Table */}
            <Card className="border-card-border">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Insurance Rate Reference
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="rounded-md border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/60 border-b border-border">
                        <th className="text-left px-3 py-2 text-muted-foreground font-medium">Trigger</th>
                        <th className="text-right px-3 py-2 text-muted-foreground font-medium">Low</th>
                        <th className="text-right px-3 py-2 text-muted-foreground font-medium">Medium</th>
                        <th className="text-right px-3 py-2 text-muted-foreground font-medium">High</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { trigger: "10-Day", low: "1.08%", med: "1.22%", high: "1.37%" },
                        { trigger: "8-Day", low: "1.40%", med: "1.57%", high: "1.77%" },
                        { trigger: "6-Day", low: "2.39%", med: "2.68%", high: "3.02%" },
                      ].map((row, i) => (
                        <tr
                          key={row.trigger}
                          className={i < 2 ? "border-b border-border" : ""}
                        >
                          <td className="px-3 py-2 font-medium text-foreground">{row.trigger}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{row.low}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{row.med}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{row.high}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* Disclaimer */}
            <div className="rounded-md bg-muted/40 border border-border px-4 py-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span className="font-semibold text-foreground">Disclaimer:</span>{" "}
                This is a heuristic model. Calibrate with historical ETA vs ATA data. DelayPredict does not sell insurance or place policies. All figures are estimates only and should not be relied upon for financial decisions without independent verification.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
