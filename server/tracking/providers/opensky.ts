import type { TrackingProvider, TrackingQuery, NormalizedTracking, TrackingMilestone } from "../types";
import { ProviderError } from "../types";

/**
 * OpenSky Network — free flight-status data.
 *
 *   Signup:        https://opensky-network.org (Account → Create API client)
 *   Auth:          OAuth2 client_credentials (basic auth deprecated March 2026)
 *   Free quota:    4000 credits / day on the default role
 *
 * Env vars:
 *   OPENSKY_CLIENT_ID       (e.g. "ops08@example.ca-api-client")
 *   OPENSKY_CLIENT_SECRET
 *
 * Token endpoint:
 *   https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token
 */
const AUTH_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const API = "https://opensky-network.org/api";

interface TokenBundle {
  token: string;
  expiresAt: number; // epoch ms
}

export class OpenSkyProvider implements TrackingProvider {
  name = "opensky";
  private cached: TokenBundle | null = null;

  constructor(
    private readonly clientId = process.env.OPENSKY_CLIENT_ID,
    private readonly clientSecret = process.env.OPENSKY_CLIENT_SECRET,
  ) {}

  isConfigured() {
    // Anonymous /states/all still works for low volume; auth just raises quotas.
    // Return true so the adapter is always tried for air queries.
    return true;
  }

  supports(q: TrackingQuery) {
    return q.mode === "air" && !!q.flightNumber;
  }

  private async getToken(): Promise<string | null> {
    if (!this.clientId || !this.clientSecret) return null;
    if (this.cached && this.cached.expiresAt > Date.now() + 30_000) {
      return this.cached.token;
    }
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", this.clientId);
    body.set("client_secret", this.clientSecret);

    const res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`OpenSky auth ${res.status}: ${text.slice(0, 140)}`, res.status);
    }
    const json: any = await res.json();
    if (!json.access_token) throw new ProviderError("OpenSky auth: no access_token in response");
    this.cached = {
      token: json.access_token,
      expiresAt: Date.now() + (Number(json.expires_in) || 1800) * 1000,
    };
    return this.cached.token;
  }

  private async authedHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = await this.getToken().catch((err) => {
      console.warn("[opensky] token fetch failed, falling back to anonymous:", err instanceof Error ? err.message : err);
      return null;
    });
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async fetch(q: TrackingQuery): Promise<NormalizedTracking> {
    if (!q.flightNumber) throw new ProviderError("OpenSky requires a flight number");
    const callsign = q.flightNumber.replace(/\s+/g, "").toUpperCase();

    const end = Math.floor(Date.now() / 1000);
    const begin = end - 3 * 24 * 3600;
    const headers = await this.authedHeaders();

    // Try /flights/all first
    let flights: any[] = [];
    try {
      const r = await fetch(`${API}/flights/all?begin=${begin}&end=${end}`, { headers });
      if (r.ok) {
        const all = await r.json();
        flights = (Array.isArray(all) ? all : []).filter(
          (f: any) => (f.callsign || "").trim().toUpperCase() === callsign,
        );
      } else if (r.status === 401) {
        throw new ProviderError("OpenSky 401 — check OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET", 401);
      }
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401) throw err;
      /* fall through */
    }

    if (flights.length === 0) {
      const r = await fetch(`${API}/states/all`, { headers });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new ProviderError(`OpenSky ${r.status}: ${text.slice(0, 120)}`, r.status);
      }
      const data: any = await r.json();
      const states: any[] = data?.states ?? [];
      const match = states.find((s) => (s[1] || "").trim().toUpperCase() === callsign);
      const milestones: TrackingMilestone[] = match
        ? [{
            type: "in_flight",
            description: `In flight — ${match[2] ?? "unknown origin country"} (alt ${Math.round(match[7] ?? 0)}m)`,
            location: null,
            occurred_at: new Date((match[3] ?? Date.now() / 1000) * 1000).toISOString(),
          }]
        : [];
      return {
        provider: this.name,
        fetched_at: new Date().toISOString(),
        status: match ? "in_transit" : "unknown",
        carrier: null,
        vessel_or_flight: callsign,
        scheduled_departure: null,
        actual_departure: null,
        scheduled_arrival: null,
        actual_arrival: null,
        delay_days: null,
        milestones,
        raw: match ?? null,
      };
    }

    flights.sort((a, b) => (b.firstSeen ?? 0) - (a.firstSeen ?? 0));
    const f = flights[0];
    const dep = f.firstSeen ? new Date(f.firstSeen * 1000) : null;
    const arr = f.lastSeen ? new Date(f.lastSeen * 1000) : null;
    const milestones: TrackingMilestone[] = [];
    if (dep) milestones.push({ type: "departed", description: `Departed ${f.estDepartureAirport ?? ""}`.trim(), location: f.estDepartureAirport, occurred_at: dep.toISOString() });
    if (arr) milestones.push({ type: "landed", description: `Landed ${f.estArrivalAirport ?? ""}`.trim(), location: f.estArrivalAirport, occurred_at: arr.toISOString() });

    return {
      provider: this.name,
      fetched_at: new Date().toISOString(),
      status: arr ? "arrived" : dep ? "in_transit" : "unknown",
      carrier: null,
      vessel_or_flight: callsign,
      scheduled_departure: null,
      actual_departure: dep?.toISOString() ?? null,
      scheduled_arrival: null,
      actual_arrival: arr?.toISOString() ?? null,
      delay_days: null,
      milestones,
      raw: f,
    };
  }
}
