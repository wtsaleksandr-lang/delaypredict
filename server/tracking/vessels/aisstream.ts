/**
 * AISStream.io — free real-time AIS feed via WebSocket.
 *
 * Handles two message types:
 *   - PositionReport → lat/lon/speed/course/nav-status
 *   - ShipStaticData → destination (UNLOCODE), vessel-declared ETA, draught,
 *                      IMO, callsign, dimensions
 *
 * Maintains ONE persistent WebSocket that subscribes to the set of MMSIs
 * referenced by active shipments. Downstream consumers register update
 * callbacks and react when a given MMSI's position or static data changes
 * (arrival detection, prediction refresh, etc.).
 */

import WebSocket from "ws";
import { promises as fs } from "fs";
import path from "path";
import { storage } from "../../storage";

const ENDPOINT = "wss://stream.aisstream.io/v0/stream";
const CACHE_FILE = path.resolve(process.cwd(), "data", "vessel-positions.json");
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 5_000;
const RELOAD_DEBOUNCE_MS = 2_000;

// Navigational status codes used by AIS PositionReport
export const NAV_STATUS_LABELS: Record<number, string> = {
  0: "Under way using engine",
  1: "At anchor",
  2: "Not under command",
  3: "Restricted manoeuvrability",
  4: "Constrained by draught",
  5: "Moored",
  6: "Aground",
  7: "Fishing",
  8: "Under way sailing",
  15: "Undefined",
};

export interface VesselPosition {
  mmsi: string;
  shipName: string | null;
  lat: number;
  lon: number;
  sogKnots: number | null;
  cogDeg: number | null;
  navStatus: number | null;
  navStatusLabel: string | null;
  updatedAt: string;
}

export interface VesselStatic {
  mmsi: string;
  destination: string | null;    // UNLOCODE, per AIS payload
  etaRaw: { month: number; day: number; hour: number; minute: number } | null;
  etaIso: string | null;          // inferred-year ISO timestamp
  draughtMeters: number | null;
  imo: number | null;
  callSign: string | null;
  vesselTypeCode: number | null;
  updatedAt: string;
}

type VesselUpdate =
  | { kind: "position"; mmsi: string; position: VesselPosition }
  | { kind: "static"; mmsi: string; staticData: VesselStatic };

type UpdateHandler = (u: VesselUpdate) => void | Promise<void>;

class AisStreamSubscriber {
  private ws: WebSocket | null = null;
  private positions = new Map<string, VesselPosition>();
  private staticData = new Map<string, VesselStatic>();
  private subscribed = new Set<string>();
  private reconnectAttempt = 0;
  private reloadTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private started = false;
  private handlers: UpdateHandler[] = [];

  isConfigured(): boolean {
    return !!process.env.AISSTREAM_API_KEY;
  }

  onUpdate(handler: UpdateHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.loadCache();
    if (!this.isConfigured()) {
      console.log("[aisstream] AISSTREAM_API_KEY not set — vessel tracking disabled");
      return;
    }
    this.scheduleReload();
  }

  stop(): void {
    this.closing = true;
    this.ws?.close();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
  }

  getPosition(mmsi: string): VesselPosition | undefined {
    return this.positions.get(String(mmsi));
  }
  getStatic(mmsi: string): VesselStatic | undefined {
    return this.staticData.get(String(mmsi));
  }
  getAll(): Array<VesselPosition & { staticData?: VesselStatic }> {
    return Array.from(this.positions.values()).map((p) => ({
      ...p,
      staticData: this.staticData.get(p.mmsi),
    }));
  }

  scheduleReload(): void {
    if (!this.isConfigured()) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(
      () => this.reload().catch((err) => console.error("[aisstream] reload failed:", err)),
      RELOAD_DEBOUNCE_MS,
    );
  }

  private async reload(): Promise<void> {
    const wanted = await this.collectTrackedMmsis();
    const sameSet =
      wanted.size === this.subscribed.size &&
      Array.from(wanted).every((m) => this.subscribed.has(m));
    if (sameSet && this.ws && this.ws.readyState === WebSocket.OPEN) return;

    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
    }
    this.subscribed = wanted;

    if (wanted.size === 0) {
      console.log("[aisstream] no shipments have vessel_mmsi set; socket idle");
      return;
    }
    this.connect();
  }

  private connect(): void {
    if (this.closing) return;
    const key = process.env.AISSTREAM_API_KEY!;
    const ws = new WebSocket(ENDPOINT);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      const subscriptionMsg = {
        APIKey: key,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FiltersShipMMSI: Array.from(this.subscribed),
        FilterMessageTypes: ["PositionReport", "ShipStaticData"],
      };
      ws.send(JSON.stringify(subscriptionMsg));
      console.log(`[aisstream] connected; watching ${this.subscribed.size} vessel(s) (position + static)`);
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch (err) {
        console.warn("[aisstream] parse failed:", err instanceof Error ? err.message : err);
      }
    });

    ws.on("close", () => this.handleClose());
    ws.on("error", (err) => console.warn("[aisstream] ws error:", err.message));
  }

  private handleClose(): void {
    if (this.closing) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * Math.pow(2, this.reconnectAttempt - 1),
    );
    console.log(`[aisstream] socket closed; reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})`);
    setTimeout(() => {
      if (!this.closing && this.subscribed.size > 0) this.connect();
    }, delay);
  }

  private handleMessage(msg: any): void {
    if (msg?.MessageType === "PositionReport") return this.handlePosition(msg);
    if (msg?.MessageType === "ShipStaticData") return this.handleStatic(msg);
  }

  private handlePosition(msg: any): void {
    const meta = msg.MetaData ?? {};
    const pr = msg.Message?.PositionReport ?? {};
    const mmsi = String(meta.MMSI ?? pr.UserID ?? "");
    if (!mmsi) return;
    if (typeof pr.Latitude !== "number" || typeof pr.Longitude !== "number") return;

    const navStatus = typeof pr.NavigationalStatus === "number" ? pr.NavigationalStatus : null;
    const updated: VesselPosition = {
      mmsi,
      shipName: typeof meta.ShipName === "string" ? meta.ShipName.trim() : null,
      lat: pr.Latitude,
      lon: pr.Longitude,
      sogKnots: typeof pr.Sog === "number" ? pr.Sog : null,
      cogDeg: typeof pr.Cog === "number" ? pr.Cog : null,
      navStatus,
      navStatusLabel: navStatus != null ? NAV_STATUS_LABELS[navStatus] ?? null : null,
      updatedAt: meta.time_utc ? new Date(meta.time_utc).toISOString() : new Date().toISOString(),
    };
    this.positions.set(mmsi, updated);
    this.schedulePersist();
    this.notify({ kind: "position", mmsi, position: updated });
  }

  private handleStatic(msg: any): void {
    const meta = msg.MetaData ?? {};
    const sd = msg.Message?.ShipStaticData ?? {};
    const mmsi = String(meta.MMSI ?? sd.UserID ?? "");
    if (!mmsi) return;

    const etaRaw = sd.Eta && typeof sd.Eta === "object" ? {
      month: Number(sd.Eta.Month) || 0,
      day: Number(sd.Eta.Day) || 0,
      hour: Number(sd.Eta.Hour) || 0,
      minute: Number(sd.Eta.Minute) || 0,
    } : null;

    const updated: VesselStatic = {
      mmsi,
      destination: typeof sd.Destination === "string" ? sd.Destination.trim() || null : null,
      etaRaw,
      etaIso: inferEtaYear(etaRaw),
      draughtMeters: typeof sd.MaximumStaticDraught === "number" ? sd.MaximumStaticDraught : null,
      imo: typeof sd.ImoNumber === "number" ? sd.ImoNumber : null,
      callSign: typeof sd.CallSign === "string" ? sd.CallSign.trim() : null,
      vesselTypeCode: typeof sd.Type === "number" ? sd.Type : null,
      updatedAt: meta.time_utc ? new Date(meta.time_utc).toISOString() : new Date().toISOString(),
    };
    this.staticData.set(mmsi, updated);
    this.schedulePersist();
    this.notify({ kind: "static", mmsi, staticData: updated });
  }

  private async notify(u: VesselUpdate): Promise<void> {
    for (const h of this.handlers) {
      try {
        await h(u);
      } catch (err) {
        console.warn("[aisstream] handler error:", err instanceof Error ? err.message : err);
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch((err) => console.warn("[aisstream] persist failed:", err));
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    const payload = {
      positions: Array.from(this.positions.values()),
      staticData: Array.from(this.staticData.values()),
    };
    await fs.writeFile(CACHE_FILE, JSON.stringify(payload, null, 2), "utf-8");
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = await fs.readFile(CACHE_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      const positions = Array.isArray(parsed) ? parsed : parsed.positions ?? [];
      const statics = Array.isArray(parsed) ? [] : parsed.staticData ?? [];
      for (const p of positions) this.positions.set(p.mmsi, p);
      for (const s of statics) this.staticData.set(s.mmsi, s);
    } catch {
      /* first run */
    }
  }

  private async collectTrackedMmsis(): Promise<Set<string>> {
    const all = await storage.listShipments();
    const out = new Set<string>();
    for (const s of all) {
      if (s.status === "delivered" || s.status === "cancelled") continue;
      const m = (s.vessel_mmsi || "").trim();
      if (/^\d{9}$/.test(m)) out.add(m);
    }
    return out;
  }
}

/** AIS ETA is month/day/hour/minute with no year — pick the nearest plausible year. */
function inferEtaYear(eta: { month: number; day: number; hour: number; minute: number } | null): string | null {
  if (!eta || eta.month < 1 || eta.month > 12 || eta.day < 1 || eta.day > 31) return null;
  const now = new Date();
  // Try current year; if that date is >60 days in the past, bump to next year.
  let year = now.getUTCFullYear();
  let candidate = new Date(Date.UTC(year, eta.month - 1, eta.day, eta.hour, eta.minute));
  if (candidate.getTime() < now.getTime() - 60 * 86400000) {
    year += 1;
    candidate = new Date(Date.UTC(year, eta.month - 1, eta.day, eta.hour, eta.minute));
  }
  return candidate.toISOString();
}

export const aisStream = new AisStreamSubscriber();
export type { UpdateHandler };
