/**
 * Delay-prediction engine.
 *
 * Produces a single "predicted_arrival" timestamp per shipment by combining
 * up to four independent signals:
 *
 *   1. Carrier ETA           — the carrier's own ETA (shipment.eta)
 *   2. Vessel-declared ETA   — AIS ShipStaticData.Eta (ais_eta)
 *   3. Heuristic model       — carrier ETA + risk-score-derived delay days
 *   4. Historical lane mean  — avg actual transit of delivered shipments on
 *                               the same origin→destination lane
 *
 * Each source carries a weight; the consensus is the weighted average of the
 * available sources. Confidence is higher when sources agree and lower when
 * they diverge.
 *
 * Also runs arrival detection: if a vessel is within its destination port's
 * radius AND AIS nav status is "moored", the shipment is auto-marked delivered
 * with actual_arrival = the AIS timestamp and actual_arrival_source = 'ais_geofence'.
 */

import { storage } from "../storage";
import type { Shipment } from "@shared/schema";
import { aisStream, NAV_STATUS_LABELS } from "../tracking/vessels/aisstream";
import type { VesselPosition, VesselStatic } from "../tracking/vessels/aisstream";
import { resolvePort, haversineKm } from "./ports";
import { voyageObserver } from "./voyageObserver";
import { OpenSkyProvider } from "../tracking/providers/opensky";
import { flightObserver } from "./flightObserver";

interface EtaSource {
  source: "carrier" | "ais_vessel" | "air_flight" | "heuristic" | "lane_history" | "lane_global" | "flight_global";
  etaIso: string;
  weight: number; // 0..1
  note?: string;
}

interface PredictionResult {
  predicted_arrival: string | null; // ISO
  predicted_delay_days: number | null;
  prediction_confidence: number; // 0..1
  prediction_sources: EtaSource[];
}

// Tunables
const ARRIVAL_ANCHOR_THRESHOLD_HOURS = 6; // nav=at_anchor near dest for >6h → considered arrived
const SOURCE_WEIGHTS: Record<EtaSource["source"], number> = {
  carrier: 0.35,
  ais_vessel: 0.25,    // ocean — vessel-declared via AIS ShipStaticData
  air_flight: 0.25,    // air — actual departure delay via OpenSky
  heuristic: 0.15,
  lane_history: 0.10,  // your own delivered shipments
  lane_global: 0.15,   // global ocean voyage observer
  flight_global: 0.15, // global air route observer
};
const opensky = new OpenSkyProvider();
const MIN_LANE_HISTORY_SAMPLES = 5;

// Cache to avoid recomputing too often (per shipment id)
const lastPredictedAt = new Map<string, number>();
const MIN_RECOMPUTE_MS = 30_000;

export async function recomputePredictionForShipment(shipmentId: string, force = false): Promise<PredictionResult | null> {
  const s = await storage.getShipment(shipmentId);
  if (!s) return null;
  if (s.status === "delivered" || s.status === "cancelled") return null;

  const now = Date.now();
  const last = lastPredictedAt.get(shipmentId) ?? 0;
  if (!force && now - last < MIN_RECOMPUTE_MS) return null;
  lastPredictedAt.set(shipmentId, now);

  const sources: EtaSource[] = [];

  // 1. Carrier ETA
  if (s.eta) {
    const d = new Date(s.eta as any);
    if (!isNaN(d.getTime())) {
      sources.push({ source: "carrier", etaIso: d.toISOString(), weight: SOURCE_WEIGHTS.carrier, note: "From carrier booking" });
    }
  }

  // 2. AIS vessel-declared ETA (ocean only)
  if (s.mode === "ocean" && s.vessel_mmsi) {
    const st = aisStream.getStatic(s.vessel_mmsi);
    if (st?.etaIso) {
      sources.push({
        source: "ais_vessel",
        etaIso: st.etaIso,
        weight: SOURCE_WEIGHTS.ais_vessel,
        note: `Vessel self-declared via AIS (dest ${st.destination ?? "unknown"})`,
      });
    }
  }

  // 2b. OpenSky actual-departure delay propagation (air only)
  // If the flight has departed late, we propagate that delay to predicted arrival.
  if (s.mode === "air" && s.flight_number && s.eta && s.etd) {
    try {
      const tr = await opensky.fetch({
        mode: "air",
        flightNumber: s.flight_number,
        containerNumber: null, bookingNumber: null, awbNumber: null, carrierScac: null,
      });
      if (tr.actual_arrival) {
        // Already arrived per OpenSky: this IS the arrival
        sources.push({
          source: "air_flight",
          etaIso: tr.actual_arrival,
          weight: SOURCE_WEIGHTS.air_flight,
          note: `Flight already landed per OpenSky (${tr.vessel_or_flight ?? s.flight_number})`,
        });
      } else if (tr.actual_departure) {
        const scheduledEtdMs = new Date(s.etd as any).getTime();
        const actualDepMs = new Date(tr.actual_departure).getTime();
        const carrierEtaMs = new Date(s.eta as any).getTime();
        if (!isNaN(scheduledEtdMs) && !isNaN(actualDepMs) && !isNaN(carrierEtaMs)) {
          const departureDelayMs = actualDepMs - scheduledEtdMs;
          const projectedArrival = new Date(carrierEtaMs + departureDelayMs);
          sources.push({
            source: "air_flight",
            etaIso: projectedArrival.toISOString(),
            weight: SOURCE_WEIGHTS.air_flight,
            note: `Departure ${departureDelayMs > 0 ? "+" : ""}${(departureDelayMs / 3600_000).toFixed(1)}h vs scheduled (OpenSky)`,
          });
        }
      }
    } catch (err) {
      // OpenSky unavailable / not configured / no recent flight — silent skip
    }
  }

  // 3. Heuristic: carrier ETA + risk-score-derived delay days
  if (s.eta && s.expected_delay_days != null) {
    const base = new Date(s.eta as any);
    const delayDays = Number(s.expected_delay_days);
    if (!isNaN(base.getTime()) && !isNaN(delayDays) && delayDays > 0) {
      const d = new Date(base.getTime() + delayDays * 86400_000);
      sources.push({
        source: "heuristic",
        etaIso: d.toISOString(),
        weight: SOURCE_WEIGHTS.heuristic,
        note: `Carrier ETA + ${delayDays.toFixed(1)}d heuristic delay`,
      });
    }
  }

  // 4. Lane history mean — your own delivered shipments
  if (s.origin && s.destination && s.etd) {
    const etd = new Date(s.etd as any).getTime();
    if (!isNaN(etd)) {
      const meanTransitDays = await laneMeanTransitDays(s.origin, s.destination);
      if (meanTransitDays != null) {
        const d = new Date(etd + meanTransitDays * 86400_000);
        sources.push({
          source: "lane_history",
          etaIso: d.toISOString(),
          weight: SOURCE_WEIGHTS.lane_history,
          note: `Your historical mean transit on this lane: ${meanTransitDays.toFixed(1)}d`,
        });
      }

      // 5. Global lane mean — ocean: from the voyage observer
      const month = s.etd ? String(s.etd).slice(0, 7) : undefined;
      if (s.mode === "ocean") {
        const global = voyageObserver.getLaneMean(s.origin, s.destination, month);
        if (global) {
          const d = new Date(etd + global.meanDays * 86400_000);
          sources.push({
            source: "lane_global",
            etaIso: d.toISOString(),
            weight: SOURCE_WEIGHTS.lane_global,
            note: `Global AIS-observed mean: ${global.meanDays.toFixed(1)}d (${global.source})`,
          });
        }
      } else if (s.mode === "air") {
        // 5b. Global flight route mean — air: from the flight observer
        const flight = flightObserver.getRouteMean(s.origin, s.destination, month);
        if (flight) {
          const d = new Date(etd + (flight.meanHours / 24) * 86400_000);
          sources.push({
            source: "flight_global",
            etaIso: d.toISOString(),
            weight: SOURCE_WEIGHTS.flight_global,
            note: `Global OpenSky-observed mean: ${flight.meanHours.toFixed(1)}h (${flight.source})`,
          });
        }
      }
    }
  }

  if (sources.length === 0) {
    return { predicted_arrival: null, predicted_delay_days: null, prediction_confidence: 0, prediction_sources: [] };
  }

  // Weighted-average predicted timestamp
  const totalWeight = sources.reduce((a, b) => a + b.weight, 0);
  const weightedMs = sources.reduce((a, b) => a + new Date(b.etaIso).getTime() * (b.weight / totalWeight), 0);
  const predicted = new Date(weightedMs).toISOString();

  // Confidence: high when sources agree within ±2d, lower as they spread
  const times = sources.map((s) => new Date(s.etaIso).getTime());
  const spreadDays = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 86400_000 : 0;
  const confidence = Math.max(0.2, Math.min(1, 1 - spreadDays / 14)); // 14d spread → ~0 confidence

  // Delay vs carrier ETA
  const carrierEta = s.eta ? new Date(s.eta as any).getTime() : null;
  const delayDays = carrierEta ? (weightedMs - carrierEta) / 86400_000 : null;

  const result: PredictionResult = {
    predicted_arrival: predicted,
    predicted_delay_days: delayDays,
    prediction_confidence: Number(confidence.toFixed(2)),
    prediction_sources: sources,
  };

  await storage.updateShipmentTracking(s.id, {
    predicted_arrival: new Date(predicted) as any,
    predicted_delay_days: delayDays != null ? (delayDays.toFixed(2) as any) : null,
    prediction_confidence: (confidence.toFixed(2) as any),
    prediction_sources: sources as any,
    prediction_updated_at: new Date(),
  });

  return result;
}

/** Mean historical transit time in days for a given origin→destination lane. */
export async function laneMeanTransitDays(origin: string, destination: string): Promise<number | null> {
  const all = await storage.listShipments();
  const samples: number[] = [];
  const o = origin.trim().toLowerCase();
  const d = destination.trim().toLowerCase();
  for (const s of all) {
    if (s.status !== "delivered") continue;
    if (!s.etd || !s.actual_arrival) continue;
    if ((s.origin || "").trim().toLowerCase() !== o) continue;
    if ((s.destination || "").trim().toLowerCase() !== d) continue;
    const etd = new Date(s.etd as any).getTime();
    const arr = new Date(s.actual_arrival as any).getTime();
    if (isNaN(etd) || isNaN(arr) || arr <= etd) continue;
    samples.push((arr - etd) / 86400_000);
  }
  if (samples.length < MIN_LANE_HISTORY_SAMPLES) return null;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/** Called when AIS updates arrive. Runs arrival detection + re-predicts. */
export async function handleAisUpdate(mmsi: string): Promise<void> {
  const all = await storage.listShipments();
  const affected = all.filter((s) => s.vessel_mmsi === mmsi && s.status !== "delivered" && s.status !== "cancelled");
  for (const s of affected) {
    await maybeMarkArrived(s);
    await recomputePredictionForShipment(s.id);
  }
}

async function maybeMarkArrived(s: Shipment): Promise<void> {
  if (!s.vessel_mmsi) return;
  const pos = aisStream.getPosition(s.vessel_mmsi);
  if (!pos) return;

  const destPort = resolvePort(s.destination);
  if (!destPort) return;

  const distKm = haversineKm(pos.lat, pos.lon, destPort.lat, destPort.lon);
  if (distKm > destPort.radiusKm) return;

  // Moored near destination → immediate arrival
  const isMoored = pos.navStatus === 5;
  // At anchor near destination for > N hours → also arrival (vessel queuing)
  const isAtAnchor = pos.navStatus === 1;
  const posTime = new Date(pos.updatedAt).getTime();

  if (isMoored) {
    await recordArrival(s, posTime, "moored at destination", distKm, destPort.name);
    return;
  }
  if (isAtAnchor) {
    // We need dwell confirmation; approximate by checking shipment.ais_nav_status: if it was
    // already at_anchor >6h ago near dest, confirm now.
    const prevStatus = s.ais_nav_status;
    const prevUpdated = s.ais_static_updated_at ? new Date(s.ais_static_updated_at as any).getTime() : 0;
    if (prevStatus === 1 && posTime - prevUpdated > ARRIVAL_ANCHOR_THRESHOLD_HOURS * 3600_000) {
      await recordArrival(s, posTime, "at anchor near destination (queue)", distKm, destPort.name);
      return;
    }
  }
  // Always mirror latest nav status onto the shipment so we can detect dwell on the next update
  await storage.updateShipmentTracking(s.id, {
    ais_nav_status: pos.navStatus as any,
    ais_static_updated_at: new Date() as any,
  });
}

async function recordArrival(s: Shipment, arrivalMs: number, reason: string, distKm: number, portName: string): Promise<void> {
  const arrival = new Date(arrivalMs);
  const etaMs = s.eta ? new Date(s.eta as any).getTime() : null;
  const delayDays = etaMs ? (arrivalMs - etaMs) / 86400_000 : null;
  console.log(`[predictor] ${s.id} arrived at ${portName} (${distKm.toFixed(1)}km, ${reason}); delay ${delayDays?.toFixed(1) ?? "?"}d`);
  await storage.updateShipmentTracking(s.id, {
    status: "delivered",
    actual_arrival: arrival as any,
    actual_arrival_source: "ais_geofence",
    actual_delay_days: delayDays != null ? (delayDays.toFixed(2) as any) : null,
  });
}

/** Call this periodically to refresh predictions for all active shipments. */
export async function refreshAllPredictions(): Promise<{ total: number; updated: number }> {
  const all = await storage.listShipments();
  const active = all.filter((s) => s.status !== "delivered" && s.status !== "cancelled");
  let updated = 0;
  for (const s of active) {
    const r = await recomputePredictionForShipment(s.id);
    if (r && r.predicted_arrival) updated++;
  }
  return { total: active.length, updated };
}

interface MaeStat {
  sampleSize: number;
  maeDays: number | null;
  bias: number | null;
}
interface SourceMae extends MaeStat {
  source: string;
}

/**
 * Per-mode + per-source accuracy across delivered shipments.
 *
 * For each delivered shipment we compute (actual_arrival - predicted_arrival) in
 * days. MAE = mean absolute error. Bias = signed mean (positive = model is
 * overoptimistic, predictions arrive earlier than reality).
 *
 * We also break down by:
 *   - mode (ocean / air): tells you which side of the app is more accurate
 *   - source (carrier / ais_vessel / heuristic / lane_history / lane_global /
 *     air_flight / flight_global): tells you WHICH signal is doing the work
 *     and which one is leading you astray
 */
export async function computePredictionAccuracy(): Promise<{
  overall: MaeStat;
  byMode: { ocean: MaeStat; air: MaeStat };
  bySource: SourceMae[];
}> {
  const all = await storage.listShipments();
  const delivered = all.filter((s) => s.status === "delivered" && s.predicted_arrival && s.actual_arrival);

  const compute = (rows: Array<{ predMs: number; actMs: number }>): MaeStat => {
    if (rows.length === 0) return { sampleSize: 0, maeDays: null, bias: null };
    let absSum = 0;
    let signedSum = 0;
    for (const r of rows) {
      const diffDays = (r.actMs - r.predMs) / 86400_000;
      absSum += Math.abs(diffDays);
      signedSum += diffDays;
    }
    return {
      sampleSize: rows.length,
      maeDays: Number((absSum / rows.length).toFixed(2)),
      bias: Number((signedSum / rows.length).toFixed(2)),
    };
  };

  const consensusRows: Array<{ mode: string; predMs: number; actMs: number }> = [];
  const sourceBuckets = new Map<string, Array<{ predMs: number; actMs: number }>>();

  for (const s of delivered) {
    const predMs = new Date(s.predicted_arrival as any).getTime();
    const actMs = new Date(s.actual_arrival as any).getTime();
    if (isNaN(predMs) || isNaN(actMs)) continue;
    consensusRows.push({ mode: s.mode, predMs, actMs });

    const sources = (s.prediction_sources as any[]) ?? [];
    for (const src of sources) {
      const sMs = new Date(src.etaIso).getTime();
      if (isNaN(sMs)) continue;
      let bucket = sourceBuckets.get(src.source);
      if (!bucket) { bucket = []; sourceBuckets.set(src.source, bucket); }
      bucket.push({ predMs: sMs, actMs });
    }
  }

  const overall = compute(consensusRows);
  const ocean = compute(consensusRows.filter((r) => r.mode === "ocean"));
  const air = compute(consensusRows.filter((r) => r.mode === "air"));

  const bySource: SourceMae[] = [];
  sourceBuckets.forEach((rows, source) => {
    const stat = compute(rows);
    bySource.push({ source, ...stat });
  });
  bySource.sort((a, b) => (a.maeDays ?? 99) - (b.maeDays ?? 99));

  return { overall, byMode: { ocean, air }, bySource };
}
