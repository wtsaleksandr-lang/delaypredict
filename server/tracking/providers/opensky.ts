import type { TrackingProvider, TrackingQuery, NormalizedTracking, TrackingMilestone } from "../types";
import { ProviderError } from "../types";

/**
 * OpenSky Network — completely free, no signup, no key.
 * Returns recent flight data by callsign (e.g. LH8400) for cargo-on-passenger-flight tracking.
 *
 *   Base:          https://opensky-network.org/api
 *   Auth:          none (anonymous is rate-limited but works for low volume)
 *   Coverage:      Any flight with ADS-B, which is ~every commercial flight worldwide.
 *
 * Limits: anonymous gets a small daily quota; consider registering (still free)
 * for higher limits and set OPENSKY_USER + OPENSKY_PASS to use Basic auth.
 */
const BASE = "https://opensky-network.org/api";

function basicAuthHeader(user?: string, pass?: string): Record<string, string> {
  if (!user || !pass) return {};
  const b64 = Buffer.from(`${user}:${pass}`).toString("base64");
  return { Authorization: `Basic ${b64}` };
}

export class OpenSkyProvider implements TrackingProvider {
  name = "opensky";
  constructor(
    private readonly user = process.env.OPENSKY_USER,
    private readonly pass = process.env.OPENSKY_PASS,
  ) {}

  isConfigured() {
    // Anonymous works; this provider is always considered "configured" so long as it can be called.
    return true;
  }

  supports(q: TrackingQuery) {
    return q.mode === "air" && !!q.flightNumber;
  }

  async fetch(q: TrackingQuery): Promise<NormalizedTracking> {
    if (!q.flightNumber) throw new ProviderError("OpenSky requires a flight number");

    // Callsigns in OpenSky are ICAO (3-letter airline + digits). Accept either IATA (e.g. LH8400) or ICAO;
    // this is a best-effort pass-through — improve by maintaining an IATA→ICAO airline map.
    const callsign = q.flightNumber.replace(/\s+/g, "").toUpperCase();

    // Time window: last 3 days
    const end = Math.floor(Date.now() / 1000);
    const begin = end - 3 * 24 * 3600;

    const headers = { Accept: "application/json", ...basicAuthHeader(this.user, this.pass) };

    // Try matching by callsign over the last 3 days via /flights/all (only reachable when authed, actually);
    // fallback to /states/all filtered by callsign.
    let flights: any[] = [];
    try {
      const url = `${BASE}/flights/all?begin=${begin}&end=${end}`;
      const r = await fetch(url, { headers });
      if (r.ok) {
        const all = await r.json();
        flights = (Array.isArray(all) ? all : []).filter((f: any) => (f.callsign || "").trim().toUpperCase() === callsign);
      }
    } catch {
      /* ignore; try states next */
    }

    if (flights.length === 0) {
      // Fallback: current airborne states
      const r = await fetch(`${BASE}/states/all`, { headers });
      if (!r.ok) throw new ProviderError(`OpenSky ${r.status}`, r.status);
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

    // Use the most recent matching flight
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
