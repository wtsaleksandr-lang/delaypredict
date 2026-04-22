/**
 * Carrier reliability static table.
 *
 * Sourced from Sea-Intelligence Global Liner Performance monthly reports (publicly
 * summarized). Refresh quarterly — the intel scraper can fetch latest summary and
 * update this file. Until then, these are 2025 Q4 averages rounded to whole %.
 *
 * Rating mapping for the risk model:
 *   on_time_pct >= 70  → "High" (reliable)
 *   55..70             → "Avg"
 *   < 55               → "Low"
 */

import type { SeasonRisk } from "./seasonRules";

type Reliability = "High" | "Avg" | "Low";

interface Entry {
  onTimePct: number;
  rating: Reliability;
  source: string;
  asOf: string; // YYYY-QN
}

// SCAC / common name → reliability. SCAC takes precedence; names are fallbacks.
const BY_SCAC: Record<string, Entry> = {
  MAEU: { onTimePct: 72, rating: "High", source: "Sea-Intelligence GLP", asOf: "2025-Q4" },
  MSCU: { onTimePct: 62, rating: "Avg", source: "Sea-Intelligence GLP", asOf: "2025-Q4" },
  HLCU: { onTimePct: 68, rating: "Avg", source: "Sea-Intelligence GLP", asOf: "2025-Q4" },
  CMDU: { onTimePct: 60, rating: "Avg", source: "Sea-Intelligence GLP", asOf: "2025-Q4" },
  ONEY: { onTimePct: 58, rating: "Avg", source: "Sea-Intelligence GLP", asOf: "2025-Q4" },
  ZIMU: { onTimePct: 56, rating: "Avg", source: "Sea-Intelligence GLP", asOf: "2025-Q4" },
  COSU: { onTimePct: 54, rating: "Low", source: "Sea-Intelligence GLP", asOf: "2025-Q4" },
  EGLV: { onTimePct: 51, rating: "Low", source: "Sea-Intelligence GLP", asOf: "2025-Q4" },
  YMLU: { onTimePct: 49, rating: "Low", source: "Sea-Intelligence GLP", asOf: "2025-Q4" },
  HMMU: { onTimePct: 55, rating: "Avg", source: "Sea-Intelligence GLP", asOf: "2025-Q4" },
};

const BY_NAME: Record<string, keyof typeof BY_SCAC> = {
  MAERSK: "MAEU",
  MSC: "MSCU",
  "HAPAG-LLOYD": "HLCU",
  HAPAG: "HLCU",
  "CMA CGM": "CMDU",
  CMACGM: "CMDU",
  ONE: "ONEY",
  "OCEAN NETWORK EXPRESS": "ONEY",
  ZIM: "ZIMU",
  COSCO: "COSU",
  EVERGREEN: "EGLV",
  "YANG MING": "YMLU",
  HMM: "HMMU",
  HYUNDAI: "HMMU",
};

export interface ReliabilityHit {
  value: Reliability;
  onTimePct?: number;
  rationale: string;
  source?: string;
  asOf?: string;
}

export function detectCarrierReliability(carrier?: string | null): ReliabilityHit {
  if (!carrier) {
    return { value: "Avg", rationale: "No carrier provided — defaulting to industry average." };
  }
  const key = carrier.trim().toUpperCase();
  const direct = BY_SCAC[key];
  if (direct) {
    return {
      value: direct.rating,
      onTimePct: direct.onTimePct,
      rationale: `${carrier} (${direct.onTimePct}% on-time, ${direct.asOf})`,
      source: direct.source,
      asOf: direct.asOf,
    };
  }
  const scac = BY_NAME[key];
  if (scac) {
    const e = BY_SCAC[scac];
    return {
      value: e.rating,
      onTimePct: e.onTimePct,
      rationale: `${carrier} (${e.onTimePct}% on-time, ${e.asOf})`,
      source: e.source,
      asOf: e.asOf,
    };
  }
  return { value: "Avg", rationale: `Unknown carrier "${carrier}" — defaulting to industry average.` };
}

export function allCarriers(): Array<{ scac: string } & Entry> {
  return Object.entries(BY_SCAC).map(([scac, e]) => ({ scac, ...e }));
}

// Re-export for centralized type imports
export type { SeasonRisk };
