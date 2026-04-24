/**
 * Global Flight Observer (air freight equivalent of VoyageObserver).
 *
 * Periodically polls OpenSky's /flights/departure endpoint for major cargo hubs.
 * For each completed flight (has both departure + arrival airport + timestamps),
 * records duration into a (origin_iata, destination_iata, year-month) bucket.
 *
 * Storage:
 *   data/flight-route-stats.json — rolling aggregates the predictor reads
 *
 * Why polling, not streaming:
 *   OpenSky has no websocket; /flights/all and /flights/departure are paged
 *   REST endpoints. Default-role quota is 4000 credits/day. We poll ~20 hubs
 *   every hour, which is well under budget.
 *
 * Hub list comes from server/intel/ports.ts (kind="air"). Their `iata` field
 * gives us the 3-letter codes; we convert to 4-letter ICAO via IATA_TO_ICAO
 * for the OpenSky query.
 */

import { promises as fs } from "fs";
import path from "path";
import { listPorts } from "./ports";

const STATS_FILE = path.resolve(process.cwd(), "data", "flight-route-stats.json");
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const POLL_WINDOW_HOURS = 6;
const MIN_FLIGHT_HOURS = 0.5;
const MAX_FLIGHT_HOURS = 20;
const PERSIST_DEBOUNCE_MS = 30_000;

const AUTH_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const API = "https://opensky-network.org/api";

// IATA → ICAO mapping for our cargo hubs. OpenSky uses ICAO airport codes.
const IATA_TO_ICAO: Record<string, string> = {
  HKG: "VHHH", PVG: "ZSPD", DXB: "OMDB", ANC: "PANC", MEM: "KMEM", SDF: "KSDF",
  LAX: "KLAX", ORD: "KORD", MIA: "KMIA", JFK: "KJFK", FRA: "EDDF", AMS: "EHAM",
  CDG: "LFPG", LHR: "EGLL", ICN: "RKSI", NRT: "RJAA", SIN: "WSSS", TPE: "RCTP",
  DOH: "OTHH", IST: "LTFM",
};
const ICAO_TO_IATA: Record<string, string> = Object.fromEntries(
  Object.entries(IATA_TO_ICAO).map(([iata, icao]) => [icao, iata]),
);

interface RouteStat {
  origin: string;       // IATA
  destination: string;  // IATA
  month: string;        // YYYY-MM
  count: number;
  meanHours: number;
  p50: number;
  minHours: number;
  maxHours: number;
  lastObservedAt: string;
}

class FlightObserver {
  private routeStats = new Map<string, RouteStat>(); // key: `${origin}|${dest}|${month}`
  private samples = new Map<string, number[]>();
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private observationsTotal = 0;
  private started = false;

  isEnabled(): boolean {
    return !!(process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.loadCache();
    if (!this.isEnabled()) {
      console.log("[flightObserver] disabled — set OPENSKY_CLIENT_ID + OPENSKY_CLIENT_SECRET to learn from global flights");
      return;
    }
    // First sweep 2 min after boot, then hourly
    setTimeout(() => this.tick().catch((err) => console.error("[flightObserver] tick failed:", err)), 2 * 60 * 1000);
    this.timer = setInterval(() => this.tick().catch((err) => console.error("[flightObserver] tick failed:", err)), POLL_INTERVAL_MS);
    console.log(`[flightObserver] started — polling ${this.hubsToPoll().length} hubs every ${POLL_INTERVAL_MS / 60000} min`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
  }

  private hubsToPoll(): string[] {
    return listPorts()
      .filter((p) => p.kind === "air" && p.iata && IATA_TO_ICAO[p.iata])
      .map((p) => IATA_TO_ICAO[p.iata!]);
  }

  private async getToken(): Promise<string | null> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 30_000) return this.cachedToken.token;
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", process.env.OPENSKY_CLIENT_ID!);
    body.set("client_secret", process.env.OPENSKY_CLIENT_SECRET!);
    const r = await fetch(AUTH_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!r.ok) throw new Error(`OpenSky auth ${r.status}`);
    const j: any = await r.json();
    this.cachedToken = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 1800) * 1000 };
    return this.cachedToken.token;
  }

  private async tick(): Promise<void> {
    const token = await this.getToken().catch((err) => {
      console.warn("[flightObserver] token fetch failed:", err instanceof Error ? err.message : err);
      return null;
    });
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const end = Math.floor(Date.now() / 1000);
    const begin = end - POLL_WINDOW_HOURS * 3600;

    const hubs = this.hubsToPoll();
    let observationsThisTick = 0;
    let totalFlightsSeen = 0;
    let hubsOk = 0;
    let hubsErr = 0;

    for (const icao of hubs) {
      try {
        const url = `${API}/flights/departure?airport=${icao}&begin=${begin}&end=${end}`;
        const r = await fetch(url, { headers });
        if (!r.ok) {
          if (r.status !== 404) console.warn(`[flightObserver] ${icao} → ${r.status}`);
          hubsErr += 1;
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        hubsOk += 1;
        const flights: any[] = await r.json();
        const list = Array.isArray(flights) ? flights : [];
        totalFlightsSeen += list.length;
        for (const f of list) {
          const obs = this.parseFlight(f);
          if (obs) {
            this.recordObservation(obs);
            observationsThisTick++;
          }
        }
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        hubsErr += 1;
        console.warn(`[flightObserver] ${icao} failed:`, err instanceof Error ? err.message : err);
      }
    }

    // Always log so we can see the tick happened, even when 0 observations were recorded
    console.log(
      `[flightObserver] tick: ${observationsThisTick} hub-to-hub observations recorded ` +
      `(saw ${totalFlightsSeen} departures across ${hubsOk}/${hubs.length} hubs, ${hubsErr} errors). ` +
      `Total observed lifetime: ${this.observationsTotal}, routes learned: ${this.routeStats.size}`,
    );
    if (observationsThisTick > 0) this.schedulePersist();
  }

  private parseFlight(f: any): { originIata: string; destIata: string; durationHours: number; arrivedAt: string } | null {
    const depIcao = f.estDepartureAirport;
    const arrIcao = f.estArrivalAirport;
    if (!depIcao || !arrIcao) return null;
    const depIata = ICAO_TO_IATA[depIcao];
    const arrIata = ICAO_TO_IATA[arrIcao];
    // Only record flights between hubs we care about (cargo airports)
    if (!depIata || !arrIata) return null;
    if (depIata === arrIata) return null;

    const durationSec = (f.lastSeen ?? 0) - (f.firstSeen ?? 0);
    const durationHours = durationSec / 3600;
    if (!isFinite(durationHours)) return null;
    if (durationHours < MIN_FLIGHT_HOURS || durationHours > MAX_FLIGHT_HOURS) return null;

    return {
      originIata: depIata,
      destIata: arrIata,
      durationHours,
      arrivedAt: new Date(f.lastSeen * 1000).toISOString(),
    };
  }

  private recordObservation(obs: { originIata: string; destIata: string; durationHours: number; arrivedAt: string }): void {
    const month = obs.arrivedAt.slice(0, 7);
    const key = `${obs.originIata}|${obs.destIata}|${month}`;
    let s = this.samples.get(key);
    if (!s) { s = []; this.samples.set(key, s); }
    s.push(obs.durationHours);
    if (s.length > 500) s.splice(0, s.length - 500);

    const sorted = [...s].sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const p50 = sorted[Math.floor(sorted.length / 2)];
    this.routeStats.set(key, {
      origin: obs.originIata,
      destination: obs.destIata,
      month,
      count: s.length,
      meanHours: Number(mean.toFixed(2)),
      p50: Number(p50.toFixed(2)),
      minHours: Number(sorted[0].toFixed(2)),
      maxHours: Number(sorted[sorted.length - 1].toFixed(2)),
      lastObservedAt: obs.arrivedAt,
    });
    this.observationsTotal += 1;
  }

  // ── Public read API ────────────────────────────────────────────────────────

  getRouteMean(originHint: string, destinationHint: string, month?: string): { meanHours: number; sampleSize: number; source: string } | null {
    const o = matchIata(originHint);
    const d = matchIata(destinationHint);
    if (!o || !d) return null;

    if (month) {
      const exact = this.routeStats.get(`${o}|${d}|${month}`);
      if (exact && exact.count >= 3) return { meanHours: exact.meanHours, sampleSize: exact.count, source: `${month} (${exact.count})` };
    }
    let totalCount = 0;
    let weightedSum = 0;
    let lastSeen = "";
    this.routeStats.forEach((v, k) => {
      if (!k.startsWith(`${o}|${d}|`)) return;
      totalCount += v.count;
      weightedSum += v.meanHours * v.count;
      if (!lastSeen || v.lastObservedAt > lastSeen) lastSeen = v.lastObservedAt;
    });
    if (totalCount === 0) return null;
    return {
      meanHours: Number((weightedSum / totalCount).toFixed(2)),
      sampleSize: totalCount,
      source: `pooled (${totalCount} obs, latest ${lastSeen.slice(0, 10)})`,
    };
  }

  getStats(): {
    enabled: boolean;
    hubsPolled: number;
    routesLearned: number;
    observationsTotal: number;
    topRoutes: Array<{ origin: string; destination: string; count: number; meanHours: number }>;
  } {
    const routes = new Map<string, { origin: string; destination: string; count: number; sum: number }>();
    this.routeStats.forEach((stat) => {
      const k = `${stat.origin}|${stat.destination}`;
      const cur = routes.get(k);
      if (cur) {
        cur.count += stat.count;
        cur.sum += stat.meanHours * stat.count;
      } else {
        routes.set(k, { origin: stat.origin, destination: stat.destination, count: stat.count, sum: stat.meanHours * stat.count });
      }
    });
    const topRoutes = Array.from(routes.values())
      .map((l) => ({ origin: l.origin, destination: l.destination, count: l.count, meanHours: Number((l.sum / l.count).toFixed(2)) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    return {
      enabled: this.isEnabled(),
      hubsPolled: this.hubsToPoll().length,
      routesLearned: routes.size,
      observationsTotal: this.observationsTotal,
      topRoutes,
    };
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch((err) => console.warn("[flightObserver] persist failed:", err));
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(STATS_FILE), { recursive: true });
    await fs.writeFile(
      STATS_FILE,
      JSON.stringify({ stats: Array.from(this.routeStats.values()), observationsTotal: this.observationsTotal }, null, 2),
      "utf-8",
    );
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = await fs.readFile(STATS_FILE, "utf-8");
      const data = JSON.parse(raw);
      const stats: RouteStat[] = data.stats ?? [];
      for (const s of stats) {
        const k = `${s.origin}|${s.destination}|${s.month}`;
        this.routeStats.set(k, s);
        this.samples.set(k, new Array(s.count).fill(s.meanHours));
      }
      this.observationsTotal = data.observationsTotal ?? stats.reduce((a, s) => a + s.count, 0);
    } catch { /* fresh */ }
  }
}

function matchIata(text: string | null | undefined): string | null {
  if (!text) return null;
  const upper = text.trim().toUpperCase();
  // Accept either explicit IATA code or hub name containing IATA in parens
  if (/^[A-Z]{3}$/.test(upper) && IATA_TO_ICAO[upper]) return upper;
  for (const iata of Object.keys(IATA_TO_ICAO)) {
    if (upper.includes(iata)) return iata;
  }
  return null;
}

export const flightObserver = new FlightObserver();
