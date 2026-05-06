/**
 * Prediction history recorder + bias-correction lookup.
 *
 * Every time recomputePredictionForShipment finishes, we append a snapshot
 * to the prediction_history Postgres table. When a shipment delivers, its
 * actual_arrival is on the shipment record; pairing the two lets us:
 *
 *   1. Score predictions made AT a useful moment (e.g. when you'd quote a
 *      customer, ~5 days before ETA), not the prediction made 5 minutes
 *      before arrival, which trivially has near-zero error.
 *   2. Compute per-lane bias (e.g. "Shanghai-LA Claimed ETA is +1.7d
 *      optimistic on average"). The predictor then corrects new
 *      predictions on the same lane using that bias.
 *
 * Storage is the prediction_history table on Neon Postgres (was a JSONL
 * file under data/ — wiped on every Replit redeploy). The in-memory bias
 * cache is rebuilt from the table at boot and refreshed whenever a new
 * entry is paired with an actual arrival.
 */

import { predictionHistory } from "@shared/schema";
import { getDb } from "../db";

export interface PredictionSnapshot {
  shipment_id: string;
  predicted_at: string;       // ISO when this prediction was made
  predicted_arrival: string;  // ISO consensus ETA at that moment
  prediction_confidence: number;
  origin: string | null;
  destination: string | null;
  mode: "ocean" | "air";
  carrier_scac: string | null;
  eta: string | null;         // carrier ETA at moment of prediction
  etd: string | null;
  sources: Array<{ source: string; etaIso: string; weight: number }>;
}

export async function recordPrediction(snap: PredictionSnapshot): Promise<void> {
  try {
    await getDb().insert(predictionHistory).values({
      shipment_id: snap.shipment_id,
      predicted_at: new Date(snap.predicted_at),
      predicted_arrival: new Date(snap.predicted_arrival),
      prediction_confidence: String(snap.prediction_confidence),
      origin: snap.origin,
      destination: snap.destination,
      mode: snap.mode,
      carrier_scac: snap.carrier_scac,
      eta: snap.eta,
      etd: snap.etd,
      sources: snap.sources,
    });
  } catch (err) {
    console.warn("[predictionHistory] insert failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Per-lane systematic bias, learned from prior delivered shipments. Positive
 * bias means past predictions arrived EARLIER than reality (system is
 * overoptimistic), so the predictor should add `bias` days to new predictions
 * on this lane.
 *
 * Lane key = `${origin_lower}|${destination_lower}|${mode}`. Lookup is
 * tolerant: missing/zero-sample lanes return null and the predictor falls
 * back to its uncorrected estimate.
 */
const biasCache = new Map<string, { bias: number; sample: number }>();

export function laneKey(origin: string | null | undefined, destination: string | null | undefined, mode: "ocean" | "air"): string | null {
  if (!origin || !destination) return null;
  return `${origin.trim().toLowerCase()}|${destination.trim().toLowerCase()}|${mode}`;
}

export function getLaneBiasDays(origin: string | null | undefined, destination: string | null | undefined, mode: "ocean" | "air"): { biasDays: number; sampleSize: number } | null {
  const k = laneKey(origin, destination, mode);
  if (!k) return null;
  const v = biasCache.get(k);
  if (!v || v.sample < 3) return null; // need at least 3 deliveries on this lane to trust bias
  return { biasDays: v.bias, sampleSize: v.sample };
}

/** Snapshot of a single scored prediction (used for accuracy + bias compute). */
export interface ScoredPrediction extends PredictionSnapshot {
  actual_arrival: string;
  errorDays: number; // signed: positive = predicted arrived later than actual (pessimistic), negative = predicted earlier than actual (optimistic)
}

/**
 * Read history + delivered shipments, pair them, and rebuild the per-lane bias
 * cache. Also returns paired records so callers can compute per-lane MAE.
 *
 * For each shipment we pick the prediction snapshot taken at "decision time":
 * the latest snapshot whose predicted_at is at least 5 days before
 * actual_arrival. Falls back to earliest available if no such snapshot exists.
 */
export async function rebuildBiasCache(deliveredShipments: Array<{ id: string; origin: string | null; destination: string | null; mode: string; actual_arrival: any }>): Promise<{ scored: ScoredPrediction[] }> {
  let rows: Array<typeof predictionHistory.$inferSelect> = [];
  try {
    rows = await getDb().select().from(predictionHistory);
  } catch (err) {
    console.warn("[predictionHistory] DB read failed:", err instanceof Error ? err.message : err);
    biasCache.clear();
    return { scored: [] };
  }

  // Index history by shipment_id
  const byShipment = new Map<string, PredictionSnapshot[]>();
  for (const r of rows) {
    const snap: PredictionSnapshot = {
      shipment_id: r.shipment_id,
      predicted_at: r.predicted_at.toISOString(),
      predicted_arrival: r.predicted_arrival.toISOString(),
      prediction_confidence: Number(r.prediction_confidence ?? 0),
      origin: r.origin,
      destination: r.destination,
      mode: r.mode as "ocean" | "air",
      carrier_scac: r.carrier_scac,
      eta: r.eta,
      etd: r.etd,
      sources: (r.sources as PredictionSnapshot["sources"]) ?? [],
    };
    let arr = byShipment.get(snap.shipment_id);
    if (!arr) { arr = []; byShipment.set(snap.shipment_id, arr); }
    arr.push(snap);
  }

  const DECISION_LEAD_DAYS = 5;
  const scored: ScoredPrediction[] = [];

  for (const ship of deliveredShipments) {
    if (!ship.actual_arrival) continue;
    const actualMs = new Date(ship.actual_arrival).getTime();
    if (isNaN(actualMs)) continue;

    const history = byShipment.get(ship.id);
    if (!history || history.length === 0) continue;

    // Pick the latest snapshot taken at least DECISION_LEAD_DAYS before actual arrival.
    const sorted = [...history].sort((a, b) => new Date(a.predicted_at).getTime() - new Date(b.predicted_at).getTime());
    const cutoff = actualMs - DECISION_LEAD_DAYS * 86400_000;
    let pick = [...sorted].reverse().find((s) => new Date(s.predicted_at).getTime() <= cutoff);
    if (!pick) pick = sorted[0]; // earliest available — better than nothing on short-lived shipments

    const predMs = new Date(pick.predicted_arrival).getTime();
    if (isNaN(predMs)) continue;

    // errorDays = actual - predicted; positive = arrived later than predicted (we were optimistic)
    const errorDays = (actualMs - predMs) / 86400_000;

    scored.push({
      ...pick,
      actual_arrival: new Date(actualMs).toISOString(),
      errorDays,
    });
  }

  // Rebuild bias cache: bias = mean signed error on each lane.
  const buckets = new Map<string, number[]>();
  for (const s of scored) {
    const k = laneKey(s.origin, s.destination, s.mode);
    if (!k) continue;
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(s.errorDays);
  }

  biasCache.clear();
  buckets.forEach((errors, k) => {
    const sum = errors.reduce((a, b) => a + b, 0);
    const mean = sum / errors.length;
    biasCache.set(k, { bias: Number(mean.toFixed(2)), sample: errors.length });
  });

  return { scored };
}

/** For diagnostics — expose the current bias cache. */
export function getAllBiases(): Array<{ key: string; biasDays: number; sampleSize: number }> {
  return Array.from(biasCache.entries()).map(([key, v]) => ({ key, biasDays: v.bias, sampleSize: v.sample }));
}
