import type { TrackingProvider, TrackingQuery, NormalizedTracking, TrackingMilestone } from "../types";
import { ProviderError } from "../types";

/**
 * CMA CGM Track & Trace adapter.
 *
 *   Signup:        https://apis.cma-cgm.com/  (free dev account, approval gated)
 *                  Subscribe to Track & Trace product → get OAuth2 client credentials
 *   Auth:          OAuth2 client_credentials → Bearer token
 *
 * Endpoints below follow the public reference; verify on the live portal before going live.
 */
const TOKEN_URL = "https://apis.cma-cgm.com/auth/oauth/v1/token";
const BASE = "https://apis.cma-cgm.com/operation/v2/tracking";

export class CmaCgmProvider implements TrackingProvider {
  name = "cmacgm";
  private cachedToken?: { token: string; expiresAt: number };

  constructor(
    private readonly clientId = process.env.CMACGM_CLIENT_ID,
    private readonly clientSecret = process.env.CMACGM_CLIENT_SECRET,
  ) {}

  isConfigured() {
    return !!(this.clientId && this.clientSecret);
  }

  supports(q: TrackingQuery) {
    if (q.mode !== "ocean") return false;
    if (q.carrierScac && !["CMDU", "ANNU", "APLU", "CHVW"].includes(q.carrierScac.toUpperCase())) return false;
    return !!(q.containerNumber || q.bookingNumber);
  }

  private async getToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 30_000) {
      return this.cachedToken.token;
    }
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", this.clientId!);
    body.set("client_secret", this.clientSecret!);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProviderError(`CMA CGM token ${res.status}`, res.status, json);
    this.cachedToken = {
      token: json.access_token,
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    };
    return this.cachedToken.token;
  }

  async fetch(q: TrackingQuery): Promise<NormalizedTracking> {
    if (!this.isConfigured()) throw new ProviderError("CMACGM credentials not set");
    const token = await this.getToken();
    const params = new URLSearchParams();
    if (q.containerNumber) params.set("containerNumber", q.containerNumber);
    if (q.bookingNumber) params.set("bookingReference", q.bookingNumber);

    const res = await fetch(`${BASE}?${params}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProviderError(`CMA CGM T&T ${res.status}`, res.status, json);

    const events: any[] = json?.events ?? json?.shipmentEvents ?? [];
    const milestones: TrackingMilestone[] = events.map((e: any) => ({
      type: "other",
      description: e.eventName || e.eventCode || "Event",
      location: e.location?.name ?? null,
      occurred_at: e.eventDate || e.timestamp || new Date().toISOString(),
    }));

    return {
      provider: this.name,
      fetched_at: new Date().toISOString(),
      status: milestones.length ? "in_transit" : "unknown",
      carrier: "CMA CGM",
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
