/**
 * Global Voyage Observer.
 *
 * Subscribes (passively, via the existing AISStream feed) to ALL container-class
 * vessels worldwide and stitches their voyages into observations. Aggregates by
 * (origin_port, destination_port, year-month) into rolling transit-time stats
 * that the predictor uses as a "global lane history" source — so we learn from
 * thousands of real voyages instead of just our own.
 *
 * Storage:
 *   data/voyage-vessel-state.json — current per-vessel state (small)
 *   data/voyage-lane-stats.json   — aggregated lane stats (small)
 *   data/voyage-observations.jsonl — append-only log of completed voyages
 *                                     (only kept for transparency; predictor
 *                                     reads only the aggregated stats file)
 *
 * Design decisions:
 *  - We never trust the AIS-declared destination directly (often "FOR ORDERS",
 *    blank, or wrong UNLOCODE). We only emit observations when the vessel
 *    actually moors near a known port in our table. The "destination" is the
 *    port it actually arrived at.
 *  - Origin is the previous port the vessel moored at (state machine).
 *  - Container ships are AIS Type codes 70-79.
 *  - Voyages shorter than 12 hours are dropped (port-hopping noise).
 *  - Voyages longer than 60 days are dropped (state-machine drift).
 */

import { promises as fs } from "fs";
import path from "path";
import { aisStream } from "../tracking/vessels/aisstream";
import type { VesselPosition } from "../tracking/vessels/aisstream";
import { resolvePort, haversineKm, listPorts, type PortEntry } from "./ports";

const STATE_FILE = path.resolve(process.cwd(), "data", "voyage-vessel-state.json");
const LANE_STATS_FILE = path.resolve(process.cwd(), "data", "voyage-lane-stats.json");
const OBSERVATIONS_FILE = path.resolve(process.cwd(), "data", "voyage-observations.jsonl");
const PERSIST_DEBOUNCE_MS = 30_000;

const MIN_VOYAGE_HOURS = 12;
const MAX_VOYAGE_DAYS = 60;
const ARRIVAL_RADIUS_BUFFER_KM = 5; // add to per-port radius to be lenient
const CONTAINER_SHIP_TYPES = new Set([70, 71, 72, 73, 74, 75, 76, 77, 78, 79]);

interface VesselState {
  mmsi: string;
  vesselTypeCode: number | null;
  // Last port we observed this vessel moored/anchored at:
  lastPortUnlocode: string | null;
  lastPortName: string | null;
  lastDepartedAt: string | null; // ISO when vessel left last port
  // Rolling tracker so we can detect "moored for >X minutes"
  lastNavStatus: number | null;
  lastSeenAt: string | null;
}

interface VoyageObservation {
  mmsi: string;
  origin_unlocode: string;
  origin_name: string;
  destination_unlocode: string;
  destination_name: string;
  departed_at: string;
  arrived_at: string;
  transit_days: number;
  vessel_type: number | null;
  observed_at: string;
}

interface LaneStat {
  origin: string;       // UNLOCODE
  destination: string;  // UNLOCODE
  month: string;        // YYYY-MM
  count: number;
  meanTransitDays: number;
  p50: number;
  minDays: number;
  maxDays: number;
  lastObservedAt: string;
}

class VoyageObserver {
  private states = new Map<string, VesselState>();
  private laneStats = new Map<string, LaneStat>(); // key: `${origin}|${dest}|${month}`
  private allLaneSamples = new Map<string, number[]>(); // for percentile recompute, key `${origin}|${dest}|${month}`
  private persistTimer: NodeJS.Timeout | null = null;
  private started = false;
  private observationsTotal = 0;

  isEnabled(): boolean {
    return process.env.ENABLE_VOYAGE_OBSERVER === "true" && !!process.env.AISSTREAM_API_KEY;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.isEnabled()) {
      console.log("[voyageObserver] disabled — set ENABLE_VOYAGE_OBSERVER=true (and AISSTREAM_API_KEY) to learn from global AIS");
      return;
    }
    await this.loadAll();
    aisStream.onUpdate(async (u) => {
      try {
        if (u.kind === "position") this.handlePosition(u.mmsi, u.position);
        else if (u.kind === "static") this.handleStatic(u.mmsi, u.staticData.vesselTypeCode);
      } catch (err) {
        console.warn("[voyageObserver] handler failed:", err instanceof Error ? err.message : err);
      }
    });
    console.log(`[voyageObserver] started — vessels tracked: ${this.states.size}, lanes learned: ${this.laneStats.size}`);
  }

  // ── AIS handlers ───────────────────────────────────────────────────────────

  private handleStatic(mmsi: string, typeCode: number | null): void {
    let s = this.states.get(mmsi);
    if (!s) {
      s = this.blankState(mmsi);
      this.states.set(mmsi, s);
    }
    if (typeCode != null) s.vesselTypeCode = typeCode;
    this.schedulePersist();
  }

  private handlePosition(mmsi: string, pos: VesselPosition): void {
    let s = this.states.get(mmsi);
    if (!s) {
      s = this.blankState(mmsi);
      this.states.set(mmsi, s);
    }
    // Defer container-ship filter until we know vessel type. If type unknown, give it some grace.
    if (s.vesselTypeCode != null && !CONTAINER_SHIP_TYPES.has(s.vesselTypeCode)) {
      // Non-container vessel — drop early to keep state map small
      this.states.delete(mmsi);
      return;
    }

    s.lastNavStatus = pos.navStatus;
    s.lastSeenAt = pos.updatedAt;

    const port = portWithinRadius(pos.lat, pos.lon);
    if (port && port.unlocode) {
      // Moored or at anchor near a port → mark "at port"
      const isStationary = pos.navStatus === 5 || pos.navStatus === 1 || (pos.sogKnots != null && pos.sogKnots < 1);
      if (isStationary) {
        // Are we arriving at a NEW port (different from where we last departed)?
        if (s.lastPortUnlocode !== port.unlocode) {
          if (s.lastPortUnlocode && s.lastDepartedAt) {
            this.emitObservation(s, port, pos);
          }
          // Update state to reflect arrival at this port
          s.lastPortUnlocode = port.unlocode;
          s.lastPortName = port.name;
          s.lastDepartedAt = null;
        }
      }
    } else {
      // Not at any known port. If we were at a port before and now we're moving, mark departure.
      if (s.lastPortUnlocode && !s.lastDepartedAt && pos.sogKnots != null && pos.sogKnots > 3) {
        s.lastDepartedAt = pos.updatedAt;
      }
    }

    this.schedulePersist();
  }

  private emitObservation(s: VesselState, arrivedPort: PortEntry, pos: VesselPosition): void {
    if (!s.lastPortUnlocode || !s.lastDepartedAt || !arrivedPort.unlocode) return;
    const dep = new Date(s.lastDepartedAt).getTime();
    const arr = new Date(pos.updatedAt).getTime();
    if (isNaN(dep) || isNaN(arr) || arr <= dep) return;
    const transitDays = (arr - dep) / 86400_000;
    if (transitDays < MIN_VOYAGE_HOURS / 24) return;
    if (transitDays > MAX_VOYAGE_DAYS) return;
    if (s.lastPortUnlocode === arrivedPort.unlocode) return;

    const obs: VoyageObservation = {
      mmsi: s.mmsi,
      origin_unlocode: s.lastPortUnlocode,
      origin_name: s.lastPortName || s.lastPortUnlocode,
      destination_unlocode: arrivedPort.unlocode,
      destination_name: arrivedPort.name,
      departed_at: s.lastDepartedAt,
      arrived_at: pos.updatedAt,
      transit_days: Number(transitDays.toFixed(2)),
      vessel_type: s.vesselTypeCode,
      observed_at: new Date().toISOString(),
    };

    this.appendObservationToFile(obs).catch((err) =>
      console.warn("[voyageObserver] obs append failed:", err instanceof Error ? err.message : err),
    );
    this.updateLaneStats(obs);
    this.observationsTotal += 1;
  }

  private updateLaneStats(obs: VoyageObservation): void {
    const month = obs.arrived_at.slice(0, 7); // YYYY-MM
    const key = `${obs.origin_unlocode}|${obs.destination_unlocode}|${month}`;
    let samples = this.allLaneSamples.get(key);
    if (!samples) {
      samples = [];
      this.allLaneSamples.set(key, samples);
    }
    samples.push(obs.transit_days);
    if (samples.length > 500) samples.splice(0, samples.length - 500); // cap memory

    const sorted = [...samples].sort((a, b) => a - b);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const stat: LaneStat = {
      origin: obs.origin_unlocode,
      destination: obs.destination_unlocode,
      month,
      count: samples.length,
      meanTransitDays: Number(mean.toFixed(2)),
      p50: Number(p50.toFixed(2)),
      minDays: Number(sorted[0].toFixed(2)),
      maxDays: Number(sorted[sorted.length - 1].toFixed(2)),
      lastObservedAt: obs.arrived_at,
    };
    this.laneStats.set(key, stat);
  }

  // ── Public read API ────────────────────────────────────────────────────────

  /** Return mean transit days for a lane, optionally month-aware. */
  getLaneMean(originHint: string, destinationHint: string, month?: string): { meanDays: number; sampleSize: number; source: string } | null {
    const o = resolvePort(originHint);
    const d = resolvePort(destinationHint);
    if (!o?.unlocode || !d?.unlocode) return null;

    // 1. Try same-month
    if (month) {
      const exact = this.laneStats.get(`${o.unlocode}|${d.unlocode}|${month}`);
      if (exact && exact.count >= 3) return { meanDays: exact.meanTransitDays, sampleSize: exact.count, source: `${month} (${exact.count})` };
    }
    // 2. Pool all months for this lane
    let totalCount = 0;
    let weightedSum = 0;
    let lastSeen: string = "";
    this.laneStats.forEach((v, k) => {
      if (!k.startsWith(`${o.unlocode}|${d.unlocode}|`)) return;
      totalCount += v.count;
      weightedSum += v.meanTransitDays * v.count;
      if (!lastSeen || v.lastObservedAt > lastSeen) lastSeen = v.lastObservedAt;
    });
    if (totalCount === 0) return null;
    return {
      meanDays: Number((weightedSum / totalCount).toFixed(2)),
      sampleSize: totalCount,
      source: `pooled across months (${totalCount} obs, latest ${lastSeen.slice(0, 10)})`,
    };
  }

  getStats(): {
    enabled: boolean;
    vesselsTracked: number;
    lanesLearned: number;
    observationsTotal: number;
    topLanes: Array<{ origin: string; destination: string; count: number; meanDays: number }>;
  } {
    const lanes = new Map<string, { origin: string; destination: string; count: number; sum: number }>();
    this.laneStats.forEach((stat) => {
      const k = `${stat.origin}|${stat.destination}`;
      const cur = lanes.get(k);
      if (cur) {
        cur.count += stat.count;
        cur.sum += stat.meanTransitDays * stat.count;
      } else {
        lanes.set(k, { origin: stat.origin, destination: stat.destination, count: stat.count, sum: stat.meanTransitDays * stat.count });
      }
    });
    const topLanes = Array.from(lanes.values())
      .map((l) => ({ origin: l.origin, destination: l.destination, count: l.count, meanDays: Number((l.sum / l.count).toFixed(2)) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    return {
      enabled: this.isEnabled(),
      vesselsTracked: this.states.size,
      lanesLearned: lanes.size,
      observationsTotal: this.observationsTotal,
      topLanes,
    };
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private blankState(mmsi: string): VesselState {
    return {
      mmsi,
      vesselTypeCode: null,
      lastPortUnlocode: null,
      lastPortName: null,
      lastDepartedAt: null,
      lastNavStatus: null,
      lastSeenAt: null,
    };
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch((err) => console.warn("[voyageObserver] persist failed:", err));
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(
      STATE_FILE,
      JSON.stringify(Array.from(this.states.values()), null, 2),
      "utf-8",
    );
    await fs.writeFile(
      LANE_STATS_FILE,
      JSON.stringify({ stats: Array.from(this.laneStats.values()), observationsTotal: this.observationsTotal }, null, 2),
      "utf-8",
    );
  }

  private async loadAll(): Promise<void> {
    try {
      const raw = await fs.readFile(STATE_FILE, "utf-8");
      const arr: VesselState[] = JSON.parse(raw);
      for (const s of arr) this.states.set(s.mmsi, s);
    } catch { /* fresh */ }
    try {
      const raw = await fs.readFile(LANE_STATS_FILE, "utf-8");
      const data = JSON.parse(raw);
      const stats: LaneStat[] = data.stats ?? [];
      for (const s of stats) {
        const k = `${s.origin}|${s.destination}|${s.month}`;
        this.laneStats.set(k, s);
        // Re-seed samples (we don't keep raw, so reconstruct an approximation)
        this.allLaneSamples.set(k, new Array(s.count).fill(s.meanTransitDays));
      }
      this.observationsTotal = data.observationsTotal ?? stats.reduce((a, s) => a + s.count, 0);
    } catch { /* fresh */ }
  }

  private async appendObservationToFile(obs: VoyageObservation): Promise<void> {
    await fs.mkdir(path.dirname(OBSERVATIONS_FILE), { recursive: true });
    await fs.appendFile(OBSERVATIONS_FILE, JSON.stringify(obs) + "\n", "utf-8");
  }
}

function portWithinRadius(lat: number, lon: number): PortEntry | null {
  const all = listPorts();
  for (const p of all) {
    if (p.kind !== "ocean") continue;
    const d = haversineKm(lat, lon, p.lat, p.lon);
    if (d <= p.radiusKm + ARRIVAL_RADIUS_BUFFER_KM) return p;
  }
  return null;
}

export const voyageObserver = new VoyageObserver();
