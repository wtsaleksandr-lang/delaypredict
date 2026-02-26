export type RiskTier = "Low" | "Medium" | "High";
export type CongestionLevel = "Low" | "Med" | "High";
export type CarrierReliability = "High" | "Avg" | "Low";
export type SeasonRisk = "Low" | "Med" | "High";
export type RouteRisk = "Low" | "Med" | "High";
export type BufferTightness = "Loose" | "Normal" | "Tight";

export interface CalcInputs {
  originPort: string;
  destinationPort: string;
  etd: string;
  eta: string;
  transshipments: number;
  budget: number;
  riskTier: RiskTier;
  originCongestion: CongestionLevel;
  transshipCongestion: CongestionLevel;
  destCongestion: CongestionLevel;
  seasonRisk: SeasonRisk;
  routeRisk: RouteRisk;
  carrierReliability: CarrierReliability;
  bufferTightness: BufferTightness;
}

export interface TriggerResult {
  trigger: 6 | 8 | 10;
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
  transitDays: number;
  riskScore: number;
  baseDelayProbability: number;
  expectedDelayDays: number;
  triggers: TriggerResult[];
  best: TriggerResult;
}

const RATES: Record<6 | 8 | 10, Record<RiskTier, number>> = {
  10: { Low: 0.0108, Medium: 0.0122, High: 0.0137 },
  8: { Low: 0.0140, Medium: 0.0157, High: 0.0177 },
  6: { Low: 0.0239, Medium: 0.0268, High: 0.0302 },
};

const PROB_MULTIPLIER: Record<6 | 8 | 10, number> = {
  6: 1.0,
  8: 0.78,
  10: 0.62,
};

function congestionScore(c: CongestionLevel): number {
  return c === "Low" ? 0 : c === "Med" ? 3.33 : 6.67;
}

function computeRiskScore(inputs: CalcInputs, transitDays: number): number {
  let score = 0;

  // Transit length — max 20 pts
  if (transitDays <= 14) score += 5;
  else if (transitDays <= 21) score += 10;
  else if (transitDays <= 35) score += 15;
  else score += 20;

  // Transshipments — max 20 pts
  const tMax = Math.min(inputs.transshipments, 3);
  score += tMax * (20 / 3);

  // Congestion — max 20 pts total (origin + transship + dest, ~6.67 each)
  score += congestionScore(inputs.originCongestion);
  score += inputs.transshipments > 0 ? congestionScore(inputs.transshipCongestion) : 0;
  score += congestionScore(inputs.destCongestion);

  // Carrier reliability — max 15 pts
  if (inputs.carrierReliability === "Low") score += 15;
  else if (inputs.carrierReliability === "Avg") score += 7;
  else score += 0;

  // Season risk — max 10 pts
  if (inputs.seasonRisk === "High") score += 10;
  else if (inputs.seasonRisk === "Med") score += 5;
  else score += 0;

  // Route / geopolitical risk — max 10 pts
  if (inputs.routeRisk === "High") score += 10;
  else if (inputs.routeRisk === "Med") score += 5;
  else score += 0;

  // Buffer tightness — max 5 pts
  if (inputs.bufferTightness === "Tight") score += 5;
  else if (inputs.bufferTightness === "Normal") score += 2.5;
  else score += 0;

  return Math.min(100, Math.max(0, score));
}

function riskScoreToBaseProbability(score: number): number {
  // 0 score → 5%, 100 score → 60%, smooth interpolation
  return 0.05 + (score / 100) * 0.55;
}

function computeTriggerResult(
  triggerDays: 6 | 8 | 10,
  inputs: CalcInputs,
  baseProbability: number,
  expectedDelayDays: number
): TriggerResult {
  const rate = RATES[triggerDays][inputs.riskTier];

  const rawLimit = inputs.budget / rate;
  const insuredLimit = Math.min(250000, Math.max(1000, rawLimit));
  const premium = insuredLimit * rate;

  const rawProb = baseProbability * PROB_MULTIPLIER[triggerDays];
  const triggerProbability = Math.min(0.85, rawProb);

  const extraDays = Math.max(0, expectedDelayDays - triggerDays);
  const expectedPayoutPct = Math.min(1.0, 0.50 + 0.05 * extraDays);

  const expectedPayout = triggerProbability * insuredLimit * expectedPayoutPct;
  const ev = expectedPayout - premium;
  const roi = ev / premium;

  let recommendation: "INSURE" | "OPTIONAL" | "SKIP";
  if (ev <= 0) recommendation = "SKIP";
  else if (roi >= 1) recommendation = "INSURE";
  else recommendation = "OPTIONAL";

  return {
    trigger: triggerDays,
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

  let transitDays = 21; // default
  if (etd && eta && eta > etd) {
    transitDays = Math.round((eta.getTime() - etd.getTime()) / (1000 * 60 * 60 * 24));
  }

  const riskScore = computeRiskScore(inputs, transitDays);
  const baseDelayProbability = riskScoreToBaseProbability(riskScore);
  // Expected delay days: riskScore 0→0 days, 100→12 days
  const expectedDelayDays = (riskScore / 100) * 12;

  const triggerResults: TriggerResult[] = ([6, 8, 10] as const).map((t) =>
    computeTriggerResult(t, inputs, baseDelayProbability, expectedDelayDays)
  );

  // Best = highest EV
  const best = triggerResults.reduce((a, b) => (a.ev >= b.ev ? a : b));

  return {
    transitDays,
    riskScore,
    baseDelayProbability,
    expectedDelayDays,
    triggers: triggerResults,
    best,
  };
}

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
