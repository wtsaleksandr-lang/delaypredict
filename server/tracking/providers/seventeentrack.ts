import type { TrackingProvider, TrackingQuery, NormalizedTracking, TrackingMilestone } from "../types";
import { ProviderError } from "../types";

/**
 * 17TRACK adapter — universal aggregator covering 3200+ carriers,
 * including ocean containers and air waybills.
 *
 *   Signup:        https://api.17track.net/  (admin.17track.net/api)
 *   Free tier:     ~100 new tracking registrations / month
 *   Auth header:   17token: <key>
 *   Rate:          3 req/s, up to 40 numbers per request
 *
 * Two-step flow: (1) register the number, (2) get tracking info.
 * We do them in sequence on first lookup, then just step (2) on refresh.
 */
const BASE = "https://api.17track.net/track/v2";

export class SeventeenTrackProvider implements TrackingProvider {
  name = "17track";
  constructor(private readonly token: string | undefined = process.env.SEVENTEENTRACK_API_KEY) {}

  isConfigured() {
    return !!this.token;
  }

  supports(q: TrackingQuery) {
    return !!(q.containerNumber || q.awbNumber);
  }

  private async call(endpoint: string, body: unknown) {
    if (!this.token) throw new ProviderError("17TRACK API key not set");
    const res = await fetch(`${BASE}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "17token": this.token,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ProviderError(`17TRACK ${endpoint} ${res.status}`, res.status, json);
    }
    return json;
  }

  async fetch(q: TrackingQuery): Promise<NormalizedTracking> {
    const number = q.containerNumber || q.awbNumber;
    if (!number) throw new ProviderError("17TRACK requires container or AWB number");

    // carrier code: 17TRACK uses numeric codes; leave undefined for auto-detect
    const reg = [{ number }];

    // Register (idempotent — re-registering the same number returns its current state)
    await this.call("/register", reg).catch((err) => {
      // Ignore "already registered" type responses
      if (err instanceof ProviderError && err.status && err.status < 500) return;
      throw err;
    });

    // Fetch info
    const info: any = await this.call("/gettrackinfo", reg);
    const accepted = info?.data?.accepted?.[0];
    const events: any[] = accepted?.track_info?.tracking?.providers?.[0]?.events ?? [];

    const milestones: TrackingMilestone[] = events.map((e) => ({
      type: "other",
      description: e.description || e.stage || "Event",
      location: e.location || null,
      occurred_at: e.time_iso || e.time_utc || new Date().toISOString(),
    }));

    const latestStage: string | undefined = accepted?.track_info?.latest_status?.status;
    const status =
      latestStage === "Delivered"
        ? "delivered"
        : latestStage === "InTransit"
          ? "in_transit"
          : latestStage === "Exception" || latestStage === "Undelivered"
            ? "delayed"
            : "unknown";

    return {
      provider: this.name,
      fetched_at: new Date().toISOString(),
      status,
      carrier: accepted?.track_info?.tracking?.providers?.[0]?.provider?.name ?? null,
      vessel_or_flight: null,
      scheduled_departure: null,
      actual_departure: null,
      scheduled_arrival: null,
      actual_arrival: status === "delivered" ? milestones[0]?.occurred_at ?? null : null,
      delay_days: null,
      milestones,
      raw: info,
    };
  }
}
