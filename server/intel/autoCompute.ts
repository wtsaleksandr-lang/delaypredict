/**
 * Auto-compute pipeline that runs whenever a shipment is created.
 *
 * Goal: a single drop-a-file action should produce a fully-populated
 * shipment with risk score, expected delay, predicted ETA, and live
 * tracking primed — no manual page visits required.
 *
 * Steps:
 *   1. Build CalcInputs from extracted/known fields with sensible defaults
 *   2. Detect risk factors via the oracle (season, carrier reliability,
 *      schedule buffer, port congestion from intel cache)
 *   3. Apply detected values to CalcInputs (where the user hasn't overridden)
 *   4. Run calculate() → risk score, base prob, expected delay, triggers
 *   5. Save the calc snapshot back onto the shipment row
 *   6. Fire-and-forget: tracking refresh (if container/AWB/flight present)
 *      and predictor consensus ETA
 *
 * Returns the updated shipment so the caller can return it to the client.
 */

import { storage } from "../storage";
import type { Shipment } from "@shared/schema";
import {
  calculate,
  type CalcInputs,
  type FreightMode,
  type CongestionLevel,
  type SeasonRisk,
  type RouteRisk,
  type CarrierReliability,
  type BufferTightness,
} from "@shared/calculations";
import { detectRiskFactors } from "./index";
import { recomputePredictionForShipment } from "./predictor";
import { resolveTracking } from "../tracking";

function defaultInputs(mode: FreightMode): CalcInputs {
  return {
    mode,
    originPort: "",
    destinationPort: "",
    etd: "",
    eta: "",
    transshipments: 0,
    insuredLimit: 5000,
    riskTier: null,
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
}

export async function autoComputeShipment(s: Shipment): Promise<Shipment> {
  const mode: FreightMode = s.mode === "air" ? "air" : "ocean";
  const inputs = defaultInputs(mode);
  inputs.originPort = s.origin || "";
  inputs.destinationPort = s.destination || "";
  inputs.etd = s.etd ? String(s.etd) : "";
  inputs.eta = s.eta ? String(s.eta) : "";

  // 1. Run the risk oracle to fill in factors we can detect automatically
  let detection: any = null;
  try {
    detection = await detectRiskFactors({
      mode,
      origin: s.origin,
      destination: s.destination,
      etd: s.etd ? String(s.etd) : null,
      eta: s.eta ? String(s.eta) : null,
      carrierScac: s.carrier_scac,
    });
    if (detection) {
      if (detection.season?.value) inputs.seasonRisk = detection.season.value as SeasonRisk;
      if (detection.route?.value) inputs.routeRisk = detection.route.value as RouteRisk;
      if (detection.carrier?.value) inputs.carrierReliability = detection.carrier.value as CarrierReliability;
      if (detection.buffer?.value) inputs.bufferTightness = detection.buffer.value as BufferTightness;
      if (detection.port_origin?.value) inputs.originCongestion = detection.port_origin.value as CongestionLevel;
      if (detection.port_destination?.value) inputs.destCongestion = detection.port_destination.value as CongestionLevel;
    }
  } catch (err) {
    console.warn("[autoCompute] risk oracle failed:", err instanceof Error ? err.message : err);
  }

  // 2. Run the calculator
  const result = calculate(inputs);

  // 3. Persist the calc snapshot
  await storage.updateShipmentTracking(s.id, {
    inputs_json: { ...inputs, _autoComputed: true, _detection: detection } as any,
    result_json: result as any,
    risk_score: String(result.riskScore) as any,
    base_delay_probability: String(result.baseDelayProbability) as any,
    expected_delay_days: String(result.expectedDelayDays) as any,
    best_trigger: result.best.trigger,
    best_ev: String(result.best.ev) as any,
    recommendation: result.best.recommendation,
  });

  // 4. Fire-and-forget: live tracking (if any tracking provider matches)
  if (s.container_number || s.booking_number || s.awb_number || (s.flight_number && mode === "air")) {
    void (async () => {
      try {
        const tr = await resolveTracking({
          mode,
          containerNumber: s.container_number,
          bookingNumber: s.booking_number,
          awbNumber: s.awb_number,
          flightNumber: s.flight_number,
          carrierScac: s.carrier_scac,
        });
        let actual_delay_days: string | null = null;
        if (tr.actual_arrival && s.eta) {
          const eta = new Date(s.eta as any).getTime();
          const arr = new Date(tr.actual_arrival).getTime();
          if (!isNaN(eta) && !isNaN(arr)) actual_delay_days = ((arr - eta) / 86_400_000).toFixed(2);
        }
        await storage.updateShipmentTracking(s.id, {
          tracking_provider: tr.provider,
          tracking_status: tr.status,
          tracking_last_polled: new Date(),
          tracking_last_event_at: tr.milestones[0]?.occurred_at ? new Date(tr.milestones[0].occurred_at) : null,
          actual_departure: tr.actual_departure ? (new Date(tr.actual_departure) as any) : null,
          actual_arrival: tr.actual_arrival ? (new Date(tr.actual_arrival) as any) : null,
          actual_delay_days: actual_delay_days as any,
          tracking_payload: tr as any,
          status:
            tr.status === "delivered" ? "delivered" :
            tr.status === "delayed" ? "delayed" :
            tr.status === "in_transit" || tr.status === "arrived" ? "in_transit" :
            s.status,
        });
      } catch {
        /* tracking provider failed or no key — silent */
      }
    })();
  }

  // 5. Fire-and-forget: prediction consensus ETA (force, bypass cache)
  void recomputePredictionForShipment(s.id, true).catch((err) =>
    console.warn("[autoCompute] prediction failed:", err instanceof Error ? err.message : err),
  );

  // Return the freshly-updated row (read it back so the response is current)
  return (await storage.getShipment(s.id)) ?? s;
}
