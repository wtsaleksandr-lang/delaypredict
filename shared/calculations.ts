export type RiskTier = "Low" | "Medium" | "High";
export type CongestionLevel = "Low" | "Med" | "High";
export type CarrierReliability = "High" | "Avg" | "Low";
export type SeasonRisk = "Low" | "Med" | "High";
export type RouteRisk = "Low" | "Med" | "High";
export type BufferTightness = "Loose" | "Normal" | "Tight";
export type FreightMode = "ocean" | "air";

// Air-specific
export type WeatherRisk = "Low" | "Med" | "High";
export type SlotPressure = "Low" | "Med" | "High";

export interface CalcInputs {
  mode: FreightMode;
  originPort: string;
  destinationPort: string;
  etd: string;
  eta: string;
  /** Insured limit (USD) — must be one of LIMIT_TIERS. */
  insuredLimit: number;
  /**
   * Risk tier override. When omitted/null, the calculator auto-derives the
   * tier from the computed risk score (Low <33, Medium 33–66, High >66).
   */
  riskTier?: RiskTier | null;

  // Ocean factors
  transshipments: number;
  originCongestion: CongestionLevel;
  transshipCongestion: CongestionLevel;
  destCongestion: CongestionLevel;
  seasonRisk: SeasonRisk;
  routeRisk: RouteRisk;
  carrierReliability: CarrierReliability;
  bufferTightness: BufferTightness;

  // Air factors
  hasLayover?: boolean;
  weatherRisk?: WeatherRisk;
  slotPressure?: SlotPressure;
  airlineReliability?: CarrierReliability;
}

export interface TriggerResult {
  trigger: number;
  rate: number;
  insuredLimit: number;
  premium: number;
  triggerProbability: number;
  expectedPayoutPct: number;
  expectedPayout: number;
  ev: number;
  roi: number;
  recommendation: "INSURE" | "OPTIONAL" | "SKIP";
}

export interface CalcResult {
  mode: FreightMode;
  transitDays: number;
  riskScore: number;
  baseDelayProbability: number;
  expectedDelayDays: number;
  triggers: TriggerResult[];
  best: TriggerResult;
  triggerUnit: "day" | "hour"; // air uses hours
  /** Risk tier actually used for the rate lookup (auto-derived if not overridden). */
  effectiveRiskTier: RiskTier;
  /** Whether the tier was auto-derived from the score (true) or user-overridden (false). */
  riskTierAuto: boolean;
}

export interface PnL {
  cost: number;
  salePrice: number;
  grossProfit: number;
  insurancePremium: number;
  expectedDelayLoss: number; // expected_payout from chosen trigger (the loss insurance offsets)
  netProfit: number; // grossProfit - insurancePremium - (expected uninsured loss)
  marginPct: number;
}

// ── Rate tables ───────────────────────────────────────────────────────────────
const OCEAN_RATES: Record<6 | 8 | 10, Record<RiskTier, number>> = {
  10: { Low: 0.0108, Medium: 0.0122, High: 0.0137 },
  8: { Low: 0.0140, Medium: 0.0157, High: 0.0177 },
  6: { Low: 0.0239, Medium: 0.0268, High: 0.0302 },
};
const OCEAN_TRIGGERS: (6 | 8 | 10)[] = [6, 8, 10];
const OCEAN_PROB_MULT: Record<6 | 8 | 10, number> = { 6: 1.0, 8: 0.78, 10: 0.62 };

// Air uses tighter triggers (hours) per Otonomi/WCA: 3 / 6 / 12 / 24 hr
// Rates per $100 of insured limit, by lane risk tier.
const AIR_RATES: Record<3 | 6 | 12 | 24, Record<RiskTier, number>> = {
  24: { Low: 0.0075, Medium: 0.0083, High: 0.0093 },
  12: { Low: 0.0111, Medium: 0.0125, High: 0.0140 },
  6: { Low: 0.0146, Medium: 0.0164, High: 0.0184 },
  3: { Low: 0.0264, Medium: 0.0297, High: 0.0334 },
};
const AIR_TRIGGERS: (3 | 6 | 12 | 24)[] = [3, 6, 12, 24];
// P(claim | shipment) multiplier — tighter triggers fire more often.
const AIR_PROB_MULT: Record<3 | 6 | 12 | 24, number> = { 3: 1.0, 6: 0.82, 12: 0.62, 24: 0.42 };

// Pre-defined insured-limit tiers ($1k–$250k as per WCA).
export const LIMIT_TIERS = [
  1000, 5000, 10000, 15000, 20000, 25000, 50000, 75000, 100000, 150000, 200000, 250000,
] as const;

// ── Risk score ────────────────────────────────────────────────────────────────
function congestionScore(c: CongestionLevel): number {
  return c === "Low" ? 0 : c === "Med" ? 3.33 : 6.67;
}

function computeOceanRiskScore(inputs: CalcInputs, transitDays: number): number {
  let score = 0;
  // Transit length — continuous, max 20 pts (capped at >35d)
  score += Math.min(20, Math.max(0, 0.6 * Math.max(0, transitDays - 10)));
  // Transshipments — max 20 pts
  score += Math.min(inputs.transshipments, 3) * (20 / 3);
  // Congestion — max 20 pts
  score += congestionScore(inputs.originCongestion);
  score += inputs.transshipments > 0 ? congestionScore(inputs.transshipCongestion) : 0;
  score += congestionScore(inputs.destCongestion);
  // Carrier reliability
  if (inputs.carrierReliability === "Low") score += 15;
  else if (inputs.carrierReliability === "Avg") score += 7;
  // Season
  if (inputs.seasonRisk === "High") score += 10;
  else if (inputs.seasonRisk === "Med") score += 5;
  // Route
  if (inputs.routeRisk === "High") score += 10;
  else if (inputs.routeRisk === "Med") score += 5;
  // Buffer
  if (inputs.bufferTightness === "Tight") score += 5;
  else if (inputs.bufferTightness === "Normal") score += 2.5;

  return Math.min(100, Math.max(0, score));
}

function computeAirRiskScore(inputs: CalcInputs): number {
  let score = 0;
  // Layover — 25 pts
  if (inputs.hasLayover) score += 25;
  // Weather — max 25 pts
  const w = inputs.weatherRisk ?? "Med";
  score += w === "High" ? 25 : w === "Med" ? 12 : 0;
  // Slot/capacity pressure — max 20 pts
  const s = inputs.slotPressure ?? "Med";
  score += s === "High" ? 20 : s === "Med" ? 10 : 0;
  // Airline reliability — max 20 pts
  const a = inputs.airlineReliability ?? "Avg";
  score += a === "Low" ? 20 : a === "Avg" ? 10 : 0;
  // Route risk (overflight restrictions, geopolitical) — max 10 pts
  if (inputs.routeRisk === "High") score += 10;
  else if (inputs.routeRisk === "Med") score += 5;
  return Math.min(100, Math.max(0, score));
}

function riskScoreToBaseProbability(score: number): number {
  return 0.05 + (score / 100) * 0.55;
}

// ── Per-trigger result ────────────────────────────────────────────────────────
//
// Payout schedule (per WCA/Otonomi spec):
//   - 50% on the trigger date
//   - +5% per additional "period" of delay past the trigger date, capped at 100%
//   - Ocean: 1 period = 1 day (regardless of trigger choice)
//   - Air:   1 period = the chosen trigger value (3/6/12/24 hours)
//
function computeTriggerResult(
  triggerVal: number,
  rate: number,
  probMultiplier: number,
  inputs: CalcInputs,
  baseProbability: number,
  expectedDelay: number,
  isAir: boolean,
): TriggerResult {
  const insuredLimit = inputs.insuredLimit;
  const premium = insuredLimit * rate;

  const rawProb = baseProbability * probMultiplier;
  const triggerProbability = Math.min(0.85, rawProb);

  // Period length depends on mode: ocean = 1 day, air = trigger value (in hours).
  const periodLen = isAir ? triggerVal : 1;
  const extraPastTrigger = Math.max(0, expectedDelay - triggerVal);
  const extraPeriods = Math.floor(extraPastTrigger / periodLen);
  const expectedPayoutPct = Math.min(1.0, 0.5 + 0.05 * extraPeriods);

  const expectedPayout = triggerProbability * insuredLimit * expectedPayoutPct;
  const ev = expectedPayout - premium;
  const roi = premium > 0 ? ev / premium : 0;

  let recommendation: TriggerResult["recommendation"];
  if (ev <= 0) recommendation = "SKIP";
  else if (roi >= 1) recommendation = "INSURE";
  else recommendation = "OPTIONAL";

  return {
    trigger: triggerVal,
    rate,
    insuredLimit,
    premium,
    triggerProbability,
    expectedPayoutPct,
    expectedPayout,
    ev,
    roi,
    recommendation,
  };
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function calculate(inputs: CalcInputs): CalcResult {
  const etd = parseDate(inputs.etd);
  const eta = parseDate(inputs.eta);

  const isAir = inputs.mode === "air";
  // Default transit: ocean 21d, air 1d
  let transitDays = isAir ? 1 : 21;
  if (etd && eta && eta > etd) {
    transitDays = (eta.getTime() - etd.getTime()) / (1000 * 60 * 60 * 24);
  }

  const riskScore = isAir
    ? computeAirRiskScore(inputs)
    : computeOceanRiskScore(inputs, transitDays);
  const baseDelayProbability = riskScoreToBaseProbability(riskScore);

  // Auto-derive risk tier from the computed score unless the caller explicitly overrode it.
  const effectiveTier: RiskTier = inputs.riskTier ?? deriveRiskTier(riskScore);

  // Expected delay: ocean → 0..12 days, air → 0..18 hours (then converted)
  const expectedDelayDays = isAir
    ? (riskScore / 100) * 0.75 // 0..18 hours expressed in days for storage
    : (riskScore / 100) * 12;

  let triggerResults: TriggerResult[];
  if (isAir) {
    // Compare in HOURS for the trigger window math
    const expectedDelayHours = expectedDelayDays * 24;
    triggerResults = AIR_TRIGGERS.map((t) =>
      computeTriggerResult(
        t,
        AIR_RATES[t][effectiveTier],
        AIR_PROB_MULT[t],
        inputs,
        baseDelayProbability,
        expectedDelayHours,
        true,
      ),
    );
  } else {
    triggerResults = OCEAN_TRIGGERS.map((t) =>
      computeTriggerResult(
        t,
        OCEAN_RATES[t][effectiveTier],
        OCEAN_PROB_MULT[t],
        inputs,
        baseDelayProbability,
        expectedDelayDays,
        false,
      ),
    );
  }

  const best = triggerResults.reduce((a, b) => (a.ev >= b.ev ? a : b));

  return {
    mode: inputs.mode,
    transitDays: Math.round(transitDays * 100) / 100,
    riskScore,
    baseDelayProbability,
    expectedDelayDays,
    triggers: triggerResults,
    best,
    triggerUnit: isAir ? "hour" : "day",
    effectiveRiskTier: effectiveTier,
    riskTierAuto: inputs.riskTier == null,
  };
}

/**
 * Build the deterministic payout schedule for a given trigger.
 * Returns rows from "0 periods past trigger" up to the 100% cap.
 * Mirrors the WCA tables in the Otonomi product spec exactly.
 */
export function payoutSchedule(opts: {
  mode: FreightMode;
  trigger: number;
  insuredLimit: number;
}): Array<{ delayLabel: string; pct: number; amount: number }> {
  const isAir = opts.mode === "air";
  const periods = 10; // 0..10 → 50%..100%
  const out: Array<{ delayLabel: string; pct: number; amount: number }> = [];
  for (let n = 0; n <= periods; n++) {
    const pct = Math.min(1, 0.5 + 0.05 * n);
    const periodLen = isAir ? opts.trigger : 1;
    const delayUnits = n * periodLen;
    const label = isAir
      ? `+${delayUnits}h past trigger`
      : `+${delayUnits}d past trigger`;
    out.push({
      delayLabel: n === 0 ? "On trigger" : label,
      pct,
      amount: Math.round(opts.insuredLimit * pct),
    });
  }
  return out;
}

// ── P&L ──────────────────────────────────────────────────────────────────────
export function computePnL(opts: {
  cost: number;
  salePrice: number;
  insurancePremium: number;
  bestTriggerExpectedPayout: number;
}): PnL {
  const grossProfit = opts.salePrice - opts.cost;
  // The expected_payout is what insurance covers, so without insurance you bear that loss.
  const expectedDelayLoss = opts.bestTriggerExpectedPayout;
  const netProfit = grossProfit - opts.insurancePremium - Math.max(0, expectedDelayLoss - opts.bestTriggerExpectedPayout);
  // If insured: you pay premium, get back expected_payout in expectation → net = grossProfit - premium + expected_payout - expected_payout = grossProfit - premium
  // If not insured: you bear the expected loss → net = grossProfit - expected_payout
  const netProfitInsured = grossProfit - opts.insurancePremium;
  const netProfitUninsured = grossProfit - expectedDelayLoss;
  // Use whichever applies — we expose both via fields above; netProfit reflects the user's chosen insurance.
  const chosenNet = opts.insurancePremium > 0 ? netProfitInsured : netProfitUninsured;

  return {
    cost: opts.cost,
    salePrice: opts.salePrice,
    grossProfit,
    insurancePremium: opts.insurancePremium,
    expectedDelayLoss,
    netProfit: chosenNet,
    marginPct: opts.salePrice > 0 ? (chosenNet / opts.salePrice) * 100 : 0,
  };
}

// ── Sensitivity (per-factor contribution to risk score) ──────────────────────
export function riskFactorBreakdown(inputs: CalcInputs, transitDays: number): { label: string; points: number; max: number }[] {
  if (inputs.mode === "air") {
    const w = inputs.weatherRisk ?? "Med";
    const s = inputs.slotPressure ?? "Med";
    const a = inputs.airlineReliability ?? "Avg";
    return [
      { label: "Layover", points: inputs.hasLayover ? 25 : 0, max: 25 },
      { label: "Weather", points: w === "High" ? 25 : w === "Med" ? 12 : 0, max: 25 },
      { label: "Slot Pressure", points: s === "High" ? 20 : s === "Med" ? 10 : 0, max: 20 },
      { label: "Airline Reliability", points: a === "Low" ? 20 : a === "Avg" ? 10 : 0, max: 20 },
      { label: "Route", points: inputs.routeRisk === "High" ? 10 : inputs.routeRisk === "Med" ? 5 : 0, max: 10 },
    ];
  }
  const transitPts = Math.min(20, Math.max(0, 0.6 * Math.max(0, transitDays - 10)));
  return [
    { label: "Transit Length", points: Math.round(transitPts * 10) / 10, max: 20 },
    { label: "Transshipments", points: Math.round(Math.min(inputs.transshipments, 3) * (20 / 3) * 10) / 10, max: 20 },
    { label: "Port Congestion", points: Math.round((congestionScore(inputs.originCongestion) + (inputs.transshipments > 0 ? congestionScore(inputs.transshipCongestion) : 0) + congestionScore(inputs.destCongestion)) * 10) / 10, max: 20 },
    { label: "Carrier", points: inputs.carrierReliability === "Low" ? 15 : inputs.carrierReliability === "Avg" ? 7 : 0, max: 15 },
    { label: "Season", points: inputs.seasonRisk === "High" ? 10 : inputs.seasonRisk === "Med" ? 5 : 0, max: 10 },
    { label: "Route", points: inputs.routeRisk === "High" ? 10 : inputs.routeRisk === "Med" ? 5 : 0, max: 10 },
    { label: "Buffer", points: inputs.bufferTightness === "Tight" ? 5 : inputs.bufferTightness === "Normal" ? 2.5 : 0, max: 5 },
  ];
}

// ── Formatters ───────────────────────────────────────────────────────────────
export function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}
export function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}
export function fmtPct(n: number, decimals = 1): string {
  return (n * 100).toFixed(decimals) + "%";
}

export function riskBand(score: number): "low" | "moderate" | "high" {
  if (score < 33) return "low";
  if (score < 66) return "moderate";
  return "high";
}

export function riskColor(score: number) {
  const band = riskBand(score);
  return {
    bg: band === "low" ? "bg-emerald-500" : band === "moderate" ? "bg-amber-500" : "bg-red-500",
    text: band === "low" ? "text-emerald-500" : band === "moderate" ? "text-amber-500" : "text-red-500",
    border: band === "low" ? "border-emerald-500/60" : band === "moderate" ? "border-amber-500/60" : "border-red-500/60",
    ring: band === "low" ? "ring-emerald-500/30" : band === "moderate" ? "ring-amber-500/30" : "ring-red-500/30",
    label: band === "low" ? "Low Risk" : band === "moderate" ? "Moderate Risk" : "High Risk",
  };
}

// Risk Tier helper — derive from computed score so the UI doesn't have two unrelated "risk" controls
export function deriveRiskTier(score: number): RiskTier {
  if (score < 33) return "Low";
  if (score < 66) return "Medium";
  return "High";
}
