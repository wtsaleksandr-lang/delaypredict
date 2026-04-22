import type { TrackingProvider, TrackingQuery, NormalizedTracking, TrackingMilestone } from "../types";
import { ProviderError } from "../types";

/**
 * Maersk Track & Trace adapter.
 *
 *   Signup:        https://developer.maersk.com/  (free, self-serve)
 *                  Create app → subscribe to "Track & Trace Plus" product → get Consumer-Key
 *   Auth header:   Consumer-Key: <key>
 *   Free tier:     Sandbox + low-volume production for registered devs
 *
 * Endpoints below follow the public DCSA-aligned pattern. Verify the exact path
 * and event-schema versions on the live developer portal before relying on it.
 */
const BASE = "https://api.maersk.com/track-and-trace-private/events";

export class MaerskProvider implements TrackingProvider {
  name = "maersk";
  constructor(private readonly key = process.env.MAERSK_CONSUMER_KEY) {}

  isConfigured() {
    return !!this.key;
  }

  supports(q: TrackingQuery) {
    if (q.mode !== "ocean") return false;
    if (q.carrierScac && q.carrierScac.toUpperCase() !== "MAEU") return false;
    return !!(q.containerNumber || q.bookingNumber);
  }

  async fetch(q: TrackingQuery): Promise<NormalizedTracking> {
    if (!this.key) throw new ProviderError("MAERSK_CONSUMER_KEY not set");
    const params = new URLSearchParams();
    if (q.containerNumber) params.set("equipmentReference", q.containerNumber);
    if (q.bookingNumber) params.set("carrierBookingReference", q.bookingNumber);

    const res = await fetch(`${BASE}?${params}`, {
      headers: { "Consumer-Key": this.key, Accept: "application/json" },
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProviderError(`Maersk T&T ${res.status}`, res.status, json);

    const events: any[] = Array.isArray(json) ? json : json?.events ?? [];
    const milestones: TrackingMilestone[] = events.map((e) => ({
      type: mapMaerskEvent(e.eventType, e.shipmentEventTypeCode || e.transportEventTypeCode),
      description: `${e.eventType ?? ""} ${e.shipmentEventTypeCode ?? e.transportEventTypeCode ?? ""}`.trim() || "Event",
      location: e.location?.locationName ?? e.location?.UNLocationCode ?? null,
      occurred_at: e.eventDateTime || e.eventCreatedDateTime || new Date().toISOString(),
    }));

    return {
      provider: this.name,
      fetched_at: new Date().toISOString(),
      status: deriveStatus(milestones),
      carrier: "Maersk",
      vessel_or_flight: null,
      scheduled_departure: null,
      actual_departure: null,
      scheduled_arrival: null,
      actual_arrival: null,
      delay_days: null,
      milestones,
      raw: json,
    };
  }
}

function mapMaerskEvent(eventType?: string, code?: string): TrackingMilestone["type"] {
  const c = (code || "").toUpperCase();
  if (c === "DEPA") return "departed";
  if (c === "ARRI") return "arrived";
  if (c === "LOAD") return "loaded";
  if (c === "DISC") return "discharged";
  if (c === "GTIN") return "gate_in";
  if (c === "GTOT") return "gate_out";
  return "other";
}

function deriveStatus(milestones: TrackingMilestone[]): NormalizedTracking["status"] {
  if (milestones.some((m) => m.type === "delivered" || m.type === "gate_out")) return "delivered";
  if (milestones.some((m) => m.type === "arrived" || m.type === "discharged")) return "arrived";
  if (milestones.some((m) => m.type === "departed" || m.type === "loaded")) return "in_transit";
  return milestones.length ? "scheduled" : "unknown";
}
