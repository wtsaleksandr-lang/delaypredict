/**
 * Shipment auto-prefill helper.
 *
 * Given any one of {booking_number, container_number, awb_number}, calls the
 * tracking provider chain and extracts as many shipment fields as possible:
 *   - origin / destination (port codes from first/last events)
 *   - etd / eta (first departure event / last arrival or scheduled)
 *   - vessel name (from any event mentioning a vessel)
 *   - vessel mmsi (looked up from the AIS observer cache by name)
 *   - transshipment count (intermediate ports visited)
 */

import { resolveTracking } from "./index";
import { aisStream } from "./vessels/aisstream";
import type { NormalizedTracking, TrackingMilestone } from "./types";

export interface PrefillRequest {
  mode?: "ocean" | "air";
  booking_number?: string | null;
  container_number?: string | null;
  awb_number?: string | null;
  flight_number?: string | null;
  carrier_scac?: string | null;
}

export interface PrefillResult {
  matched_via: string;
  fields: {
    origin?: string;
    destination?: string;
    etd?: string;
    eta?: string;
    actual_departure?: string;
    actual_arrival?: string;
    vessel_name?: string;
    vessel_mmsi?: string;
    transshipments?: number;
    carrier?: string;
  };
  raw_milestone_count: number;
  vessel_match_candidates?: Array<{ mmsi: string; shipName: string; lastSeenAt: string }>;
  warnings: string[];
}

const DEPARTURE_TYPES = new Set(["departed", "loaded", "gate_in"]);
const ARRIVAL_TYPES = new Set(["arrived", "discharged", "gate_out", "delivered", "landed"]);
const TRANSSHIPMENT_TYPES = new Set(["transshipment", "discharged", "loaded"]);

export async function prefillShipment(req: PrefillRequest): Promise<PrefillResult> {
  const mode = req.mode ?? (req.flight_number || req.awb_number ? "air" : "ocean");
  const tr = await resolveTracking({
    mode,
    containerNumber: req.container_number ?? null,
    bookingNumber: req.booking_number ?? null,
    awbNumber: req.awb_number ?? null,
    flightNumber: req.flight_number ?? null,
    carrierScac: req.carrier_scac ?? null,
  });

  const fields: PrefillResult["fields"] = {};
  const warnings: string[] = [];

  // Carrier
  if (tr.carrier) fields.carrier = tr.carrier;

  // Vessel/flight name
  if (tr.vessel_or_flight) fields.vessel_name = tr.vessel_or_flight;

  // Departure / arrival times — prefer ACTUAL where present, otherwise scheduled
  if (tr.actual_departure) fields.actual_departure = tr.actual_departure;
  if (tr.actual_arrival) fields.actual_arrival = tr.actual_arrival;
  if (tr.scheduled_departure) fields.etd = tr.scheduled_departure;
  if (tr.scheduled_arrival) fields.eta = tr.scheduled_arrival;

  // Walk milestones to extract origin/destination/transshipments
  const sorted = [...tr.milestones].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
  );

  // Origin = location of first DEPARTURE-class event (or first event if none classified)
  const firstDep = sorted.find((m) => DEPARTURE_TYPES.has(m.type)) ?? sorted[0];
  if (firstDep?.location) fields.origin = firstDep.location;
  if (firstDep && !fields.etd) fields.etd = firstDep.occurred_at;

  // Destination = location of last ARRIVAL-class event (or last event if none)
  const arrivals = sorted.filter((m) => ARRIVAL_TYPES.has(m.type));
  const lastArr = arrivals.length > 0 ? arrivals[arrivals.length - 1] : sorted[sorted.length - 1];
  if (lastArr?.location) fields.destination = lastArr.location;
  if (lastArr && !fields.eta) fields.eta = lastArr.occurred_at;

  // Transshipments: distinct intermediate locations between origin and destination
  if (sorted.length > 2 && fields.origin && fields.destination) {
    const intermediate = new Set<string>();
    for (const m of sorted.slice(1, -1)) {
      if (m.location && m.location !== fields.origin && m.location !== fields.destination) {
        intermediate.add(m.location);
      }
    }
    fields.transshipments = intermediate.size;
  }

  // Vessel name → MMSI from AIS observer cache
  let candidates: PrefillResult["vessel_match_candidates"];
  if (fields.vessel_name) {
    const matches = aisStream.lookupByName(fields.vessel_name);
    if (matches.length === 1) {
      fields.vessel_mmsi = matches[0].mmsi;
    } else if (matches.length > 1) {
      candidates = matches.slice(0, 5).map((m) => ({
        mmsi: m.mmsi,
        shipName: m.shipName,
        lastSeenAt: m.lastSeenAt,
      }));
      warnings.push(`Vessel name "${fields.vessel_name}" matches ${matches.length} ships in AIS cache — pick one.`);
    } else {
      warnings.push(`Vessel "${fields.vessel_name}" not yet seen in AIS cache. Live-position tracking unavailable until it next transmits.`);
    }
  }

  // Sanity warnings
  if (!fields.origin) warnings.push("Couldn't determine origin from carrier events.");
  if (!fields.destination) warnings.push("Couldn't determine destination from carrier events.");

  return {
    matched_via: tr.provider,
    fields,
    raw_milestone_count: tr.milestones.length,
    vessel_match_candidates: candidates,
    warnings,
  };
}
