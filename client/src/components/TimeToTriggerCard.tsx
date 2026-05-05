import { useEffect, useState } from "react";
import type { Shipment } from "@shared/schema";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, AlertTriangle, CheckCircle2, ShieldCheck, Lock } from "lucide-react";
import { fmtUSD } from "@/lib/calculations";

function n(v: any): number {
  if (v == null) return 0;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Per-shipment Time-to-Trigger widget.
 *
 * Renders only when the shipment has a chosen insurance trigger AND a locked
 * policy ETA. Shows:
 *   - Locked policy ETA (the parametric reference)
 *   - Trigger date (locked ETA + chosen trigger)
 *   - Live countdown / overshoot indicator
 *   - Best estimate of payout if it lands at the predicted_arrival
 */
export function TimeToTriggerCard({ shipment }: { shipment: Shipment }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const trigger = shipment.insurance_chosen_trigger;
  const lockedEtaRaw = (shipment as any).policy_eta_locked ?? shipment.eta;
  const limit = n(shipment.insurance_premium) > 0
    ? // back-compute insured limit from premium / rate isn't reliable; prefer the
      // result_json snapshot if it carries the limit
      n((shipment.result_json as any)?.best?.insuredLimit) || n((shipment.inputs_json as any)?.insuredLimit)
    : n((shipment.inputs_json as any)?.insuredLimit);

  if (!trigger || !lockedEtaRaw || !limit) {
    return null;
  }

  const isAir = shipment.mode === "air";
  const lockedEtaMs = new Date(lockedEtaRaw).getTime();
  if (!Number.isFinite(lockedEtaMs)) return null;

  // Convert trigger to ms: ocean = days, air = hours
  const triggerMs = isAir ? trigger * 3600_000 : trigger * 86400_000;
  const triggerDateMs = lockedEtaMs + triggerMs;

  const predictedMs = shipment.predicted_arrival ? new Date(shipment.predicted_arrival as any).getTime() : null;
  const actualMs = shipment.actual_arrival ? new Date(shipment.actual_arrival as any).getTime() : null;

  // Decide the "current" arrival timestamp to evaluate against — actual wins if known
  const evalMs = actualMs ?? predictedMs ?? null;

  const beforeTrigger = now < triggerDateMs && (actualMs == null || actualMs < triggerDateMs);
  const triggered = (actualMs ?? now) >= triggerDateMs;
  const arrived = actualMs != null;

  // Periods past trigger (50% + 5% per period, capped at 100%)
  let payoutPct = 0;
  let periods = 0;
  if (evalMs != null && evalMs >= triggerDateMs) {
    const periodMs = isAir ? trigger * 3600_000 : 86400_000;
    periods = Math.floor((evalMs - triggerDateMs) / periodMs);
    payoutPct = Math.min(1, 0.5 + 0.05 * periods);
  }
  const payoutAmount = Math.round(limit * payoutPct);

  // Time-to-trigger label
  let countdownLabel: string;
  let tone: "ok" | "warn" | "bad" | "neutral" = "neutral";
  let Icon = Clock;
  if (arrived && evalMs! >= triggerDateMs) {
    Icon = ShieldCheck;
    tone = "ok";
    countdownLabel = `Triggered · payout ${(payoutPct * 100).toFixed(0)}%`;
  } else if (arrived && evalMs! < triggerDateMs) {
    Icon = CheckCircle2;
    tone = "neutral";
    countdownLabel = "Arrived on time — no claim";
  } else if (now >= triggerDateMs) {
    Icon = AlertTriangle;
    tone = "bad";
    countdownLabel = `Past trigger by ${formatDelta(now - triggerDateMs, isAir, trigger)}`;
  } else {
    const ms = triggerDateMs - now;
    Icon = Clock;
    tone = ms < 86400_000 ? "warn" : "neutral";
    countdownLabel = `${formatDelta(ms, isAir, trigger)} until trigger`;
  }

  const toneClass: Record<typeof tone, string> = {
    ok: "border-emerald-500/40 bg-emerald-500/5",
    warn: "border-amber-500/40 bg-amber-500/5",
    bad: "border-red-500/40 bg-red-500/5",
    neutral: "border-border",
  };
  const iconClass: Record<typeof tone, string> = {
    ok: "text-emerald-500",
    warn: "text-amber-500",
    bad: "text-red-500",
    neutral: "text-muted-foreground",
  };

  return (
    <Card className={`border-l-4 ${toneClass[tone]}`}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <Icon className={`w-5 h-5 mt-0.5 ${iconClass[tone]}`} />
            <div>
              <p className="text-sm font-semibold flex items-center gap-2">
                Time to Trigger
                <Lock className="w-3 h-3 text-muted-foreground" aria-label="Locked policy ETA" />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Policy ETA locked at departure. Trigger fires when ATA &ge; ETA + {trigger}{isAir ? "h" : "d"}.
              </p>
            </div>
          </div>
          <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
            {trigger}{isAir ? "h" : "d"} trigger
          </Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div>
            <p className="text-muted-foreground">Locked ETA</p>
            <p className="font-semibold tabular-nums">{formatDate(lockedEtaMs)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Trigger date</p>
            <p className="font-semibold tabular-nums">{formatDate(triggerDateMs)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">{actualMs ? "Actual ATA" : "Predicted ATA"}</p>
            <p className={`font-semibold tabular-nums ${
              evalMs != null && evalMs >= triggerDateMs ? "text-amber-400" : ""
            }`}>
              {evalMs != null ? formatDate(evalMs) : "—"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">If lands now</p>
            <p className={`font-semibold tabular-nums ${
              payoutPct > 0 ? "text-emerald-400" : "text-muted-foreground"
            }`}>
              {payoutPct > 0 ? `${fmtUSD(payoutAmount)} (${(payoutPct * 100).toFixed(0)}%)` : "—"}
            </p>
          </div>
        </div>

        <div className={`text-xs font-semibold ${
          tone === "bad" ? "text-red-400" : tone === "ok" ? "text-emerald-400" :
          tone === "warn" ? "text-amber-400" : "text-muted-foreground"
        }`}>
          {countdownLabel}
        </div>

        {beforeTrigger && (
          <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
            Each additional {isAir ? `${trigger}h` : "day"} of delay past trigger adds another 5% to the payout, up to 100% at +10 periods ({fmtUSD(limit)}).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function formatDelta(ms: number, isAir: boolean, _trigger: number): string {
  const abs = Math.abs(ms);
  if (isAir) {
    if (abs < 3600_000) return `${Math.floor(abs / 60_000)} min`;
    const h = Math.floor(abs / 3600_000);
    const m = Math.floor((abs % 3600_000) / 60_000);
    return `${h}h ${m}m`;
  }
  if (abs < 86400_000) return `${Math.floor(abs / 3600_000)}h`;
  const d = Math.floor(abs / 86400_000);
  const h = Math.floor((abs % 86400_000) / 3600_000);
  return `${d}d ${h}h`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
