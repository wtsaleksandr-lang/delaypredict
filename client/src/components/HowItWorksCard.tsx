import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Cpu,
  Layers,
  Workflow,
  Target,
  ChevronDown,
} from "lucide-react";
import { useState } from "react";

interface AccuracyResponse {
  overall: { sampleSize: number; maeDays: number | null; bias: number | null };
  byMode: { ocean: any; air: any };
  decisionTime?: {
    sampleSize: number;
    maeDays: number | null;
    bias: number | null;
    pctWithin2d: number | null;
  };
}

function Section({
  icon: Icon,
  title,
  summary,
  children,
}: {
  icon: typeof Cpu;
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors">
          <Icon className="w-4 h-4 mt-0.5 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-foreground">{title}</span>
              <ChevronDown
                className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{summary}</p>
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pb-4 pt-1 pl-11 text-xs text-muted-foreground leading-relaxed space-y-2">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function HowItWorksCard() {
  const { data: accuracy } = useQuery<AccuracyResponse>({
    queryKey: ["/api/predictions/accuracy"],
    refetchInterval: 5 * 60_000,
  });

  const dt = accuracy?.decisionTime;
  const pctWithin2d = dt?.pctWithin2d;
  const sample = dt?.sampleSize ?? 0;
  const overallSample = accuracy?.overall.sampleSize ?? 0;
  const mae = dt?.maeDays ?? accuracy?.overall.maeDays;

  const accuracyBadge = (() => {
    if (overallSample === 0) {
      return (
        <Badge variant="outline" className="text-xs">
          Calibrating — no delivered shipments yet
        </Badge>
      );
    }
    if (pctWithin2d != null) {
      const cls =
        pctWithin2d >= 70
          ? "bg-emerald-600 text-white"
          : pctWithin2d >= 50
          ? "bg-amber-500 text-white"
          : "bg-red-600 text-white";
      return (
        <Badge className={`${cls} text-xs font-bold`}>
          {pctWithin2d.toFixed(0)}% within ±2 days · n={sample}
        </Badge>
      );
    }
    if (mae != null) {
      return (
        <Badge variant="secondary" className="text-xs">
          MAE {mae.toFixed(1)}d · n={overallSample}
        </Badge>
      );
    }
    return null;
  })();

  return (
    <Card className="border-card-border mb-4">
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-border">
        <div>
          <h2 className="text-sm font-bold text-foreground">How DelayPredict works</h2>
          <p className="text-xs text-muted-foreground">
            Tap a section to expand. Live accuracy from your delivered shipments.
          </p>
        </div>
        {accuracyBadge}
      </div>
      <CardContent className="p-0 divide-y divide-border">
        <Section
          icon={Target}
          title="Prediction accuracy"
          summary={
            overallSample === 0
              ? "Self-scoring — needs delivered shipments to report a number"
              : pctWithin2d != null
              ? `${pctWithin2d.toFixed(0)}% of decision-time predictions land within ±2 days of actual arrival.`
              : `Average error ${mae?.toFixed(1) ?? "?"}d across ${overallSample} delivered shipments.`
          }
        >
          <p>
            Accuracy is computed against your own delivered shipments — not a vendor
            benchmark. For each delivery we replay the prediction snapshot taken at
            "decision time" (the latest prediction made at least 5 days before actual
            arrival), then compare to the real arrival.
          </p>
          <ul className="list-disc pl-4 space-y-1">
            <li><strong>Overall MAE:</strong> {mae != null ? `${mae.toFixed(2)} days` : "—"} (mean absolute error)</li>
            <li><strong>Within ±2 days:</strong> {pctWithin2d != null ? `${pctWithin2d.toFixed(0)}%` : "—"}</li>
            <li><strong>Sample size:</strong> {sample || overallSample} delivered shipments</li>
          </ul>
          <p className="text-[11px] italic">
            Lower MAE = more accurate. The number tightens as your delivered count
            grows; lanes you ship often outperform new lanes.
          </p>
        </Section>

        <Section
          icon={Layers}
          title="Signals we fuse"
          summary="Carrier ETA + live vessel/flight tracking + weather + port congestion + your history"
        >
          <p>The predictor blends up to 8 independent signals per shipment, weighted by reliability:</p>
          <ul className="list-disc pl-4 space-y-1">
            <li><strong>Carrier ETA</strong> (weight 0.35) — the carrier's published ETA</li>
            <li><strong>AIS vessel ETA</strong> (0.25, ocean) — live vessel-declared arrival from AISStream</li>
            <li><strong>Flight tracking</strong> (0.25, air) — actual departure delay from OpenSky Network</li>
            <li><strong>Heuristic risk model</strong> (0.15) — rule-based delay days from route/season/carrier risk</li>
            <li><strong>Marine weather</strong> (0.10) — Open-Meteo wave height/wind on the voyage path</li>
            <li><strong>Port congestion</strong> — origin (0.05) + destination (0.10) queue/berth pressure</li>
            <li><strong>Your lane history</strong> (0.10) — mean transit of your past delivered shipments on this lane</li>
            <li><strong>Global lane / route observer</strong> (0.15) — pooled p50 transit across all observed voyages</li>
          </ul>
        </Section>

        <Section
          icon={Workflow}
          title="Backend pipeline"
          summary="Cron-driven signal collection → weighted consensus → bias-correction → arrival auto-detect"
        >
          <ol className="list-decimal pl-4 space-y-1">
            <li>
              <strong>Signal collection (cron):</strong> jobs poll AIS vessel positions,
              flight tracks, marine weather, and port congestion every few minutes; each
              source persists to its own table.
            </li>
            <li>
              <strong>Consensus:</strong> <code>predictor.ts</code> takes the weighted
              average of available signals to produce one <code>predicted_arrival</code>
              per shipment. Confidence rises when sources agree.
            </li>
            <li>
              <strong>Per-lane bias correction:</strong> as your shipments deliver, the
              system learns systematic optimism/pessimism per lane (e.g.
              "Shanghai→LA carrier ETA runs +1.7d optimistic") and subtracts that bias
              from new predictions on the same lane.
            </li>
            <li>
              <strong>Arrival auto-detect:</strong> if a vessel is within the destination
              port radius AND AIS nav status = "moored", the shipment is auto-marked
              delivered with <code>actual_arrival</code> stamped from the AIS timestamp.
            </li>
            <li>
              <strong>Self-scoring:</strong> every prediction snapshot is appended to
              <code> prediction-history.jsonl</code>. When a shipment delivers, the
              snapshot taken 5d before arrival is paired with the actual to score
              decision-time accuracy.
            </li>
          </ol>
        </Section>

        <Section
          icon={Cpu}
          title="Tool stack"
          summary="React + Express + Postgres · AISStream · OpenSky · Open-Meteo · Anthropic Claude"
        >
          <ul className="list-disc pl-4 space-y-1">
            <li><strong>Frontend:</strong> React 18, TypeScript, Vite, TanStack Query, Radix UI, Tailwind</li>
            <li><strong>Backend:</strong> Node.js + Express, Drizzle ORM, PostgreSQL</li>
            <li><strong>Vessel tracking:</strong> AISStream WebSocket (live positions + ShipStaticData ETA)</li>
            <li><strong>Flight tracking:</strong> OpenSky Network REST (departure/arrival actuals)</li>
            <li><strong>Weather:</strong> Open-Meteo Marine API (wave height, wind on voyage path)</li>
            <li><strong>Carrier reliability:</strong> Sea-Intelligence GLP on-time % per carrier</li>
            <li><strong>Document parsing:</strong> Anthropic Claude (extracts shipment fields from carrier docs/BLs)</li>
            <li><strong>Persistence:</strong> Drizzle schema + JSONL append-only logs (voyage observations, prediction history)</li>
            <li><strong>Scheduler:</strong> in-process cron jobs — no external queue server</li>
          </ul>
        </Section>
      </CardContent>
    </Card>
  );
}
