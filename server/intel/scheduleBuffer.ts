/**
 * Schedule buffer tightness — compares this shipment's ETD→ETA vs. historical averages
 * for the same origin/destination pair across your own past shipments.
 *
 * Needs ≥5 past shipments on the same lane to give a confident answer.
 */

import { storage } from "../storage";

export type BufferTightness = "Loose" | "Normal" | "Tight";

export interface BufferHit {
  value: BufferTightness;
  rationale: string;
  confidence: "high" | "medium" | "low";
  sampleSize: number;
}

export async function detectScheduleBuffer(opts: {
  origin?: string | null;
  destination?: string | null;
  etd?: string | null;
  eta?: string | null;
}): Promise<BufferHit> {
  const { origin, destination, etd, eta } = opts;
  if (!etd || !eta || !origin || !destination) {
    return { value: "Normal", rationale: "Insufficient input to assess schedule buffer.", confidence: "low", sampleSize: 0 };
  }

  const etdD = new Date(etd);
  const etaD = new Date(eta);
  if (isNaN(etdD.getTime()) || isNaN(etaD.getTime()) || etaD <= etdD) {
    return { value: "Normal", rationale: "ETD/ETA missing or inverted.", confidence: "low", sampleSize: 0 };
  }
  const thisTransit = (etaD.getTime() - etdD.getTime()) / 86400000;

  const all = await storage.listShipments();
  const sameLane = all.filter(
    (s) =>
      (s.origin || "").trim().toLowerCase() === origin.trim().toLowerCase() &&
      (s.destination || "").trim().toLowerCase() === destination.trim().toLowerCase() &&
      s.etd && s.eta,
  );
  const samples = sameLane
    .map((s) => {
      const a = new Date(s.etd as any).getTime();
      const b = new Date(s.eta as any).getTime();
      if (isNaN(a) || isNaN(b) || b <= a) return null;
      return (b - a) / 86400000;
    })
    .filter((x): x is number => x !== null);

  if (samples.length < 5) {
    return {
      value: "Normal",
      rationale: `Only ${samples.length} past shipment(s) on ${origin} → ${destination} — need ≥5 for a confident buffer assessment. Defaulting to Normal.`,
      confidence: "low",
      sampleSize: samples.length,
    };
  }

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const ratio = thisTransit / mean;
  const value: BufferTightness = ratio < 0.9 ? "Tight" : ratio > 1.15 ? "Loose" : "Normal";
  return {
    value,
    rationale: `This shipment's ${thisTransit.toFixed(1)}d transit vs. ${mean.toFixed(1)}d historical mean on ${origin} → ${destination} (${samples.length} samples, ratio ${ratio.toFixed(2)})`,
    confidence: samples.length >= 15 ? "high" : "medium",
    sampleSize: samples.length,
  };
}
