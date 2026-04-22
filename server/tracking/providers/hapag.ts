import type { TrackingProvider, TrackingQuery, NormalizedTracking, TrackingMilestone } from "../types";
import { ProviderError } from "../types";

/**
 * Hapag-Lloyd Track & Trace adapter (DCSA standard).
 *
 *   Signup:        https://api-portal.hlag.com/  (free, self-serve, IBM API Connect)
 *                  Subscribe to "Tracing" / "Events" product → get Client ID + Secret
 *   Auth headers:  X-IBM-Client-Id, X-IBM-Client-Secret
 *
 * Endpoint follows DCSA Track & Trace v2 spec; verify exact path on the live portal.
 */
const BASE = "https://api.hlag.com/hlag/external/v2/events";

export class HapagProvider implements TrackingProvider {
  name = "hapag";
  constructor(
    private readonly clientId = process.env.HAPAG_CLIENT_ID,
    private readonly clientSecret = process.env.HAPAG_CLIENT_SECRET,
  ) {}

  isConfigured() {
    return !!(this.clientId && this.clientSecret);
  }

  supports(q: TrackingQuery) {
    if (q.mode !== "ocean") return false;
    if (q.carrierScac && q.carrierScac.toUpperCase() !== "HLCU") return false;
    return !!(q.containerNumber || q.bookingNumber);
  }

  async fetch(q: TrackingQuery): Promise<NormalizedTracking> {
    if (!this.clientId || !this.clientSecret) {
      throw new ProviderError("HAPAG_CLIENT_ID / HAPAG_CLIENT_SECRET not set");
    }
    const params = new URLSearchParams();
    if (q.containerNumber) params.set("equipmentReference", q.containerNumber);
    if (q.bookingNumber) params.set("carrierBookingReference", q.bookingNumber);

    const res = await fetch(`${BASE}?${params}`, {
      headers: {
        "X-IBM-Client-Id": this.clientId,
        "X-IBM-Client-Secret": this.clientSecret,
        Accept: "application/json",
      },
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProviderError(`Hapag T&T ${res.status}`, res.status, json);

    const events: any[] = Array.isArray(json) ? json : json?.events ?? [];
    const milestones: TrackingMilestone[] = events.map((e) => ({
      type: "other",
      description: e.eventClassifierCode ? `${e.eventClassifierCode} ${e.eventType ?? ""}`.trim() : "Event",
      location: e.eventLocation?.locationName ?? e.eventLocation?.UNLocationCode ?? null,
      occurred_at: e.eventDateTime || e.eventCreatedDateTime || new Date().toISOString(),
    }));

    return {
      provider: this.name,
      fetched_at: new Date().toISOString(),
      status: milestones.length ? "in_transit" : "unknown",
      carrier: "Hapag-Lloyd",
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
