/**
 * AISStream.io — free real-time AIS feed via WebSocket.
 *
 *   Signup:        https://aisstream.io  (free, self-serve)
 *   Auth:          API key sent in the initial subscription JSON
 *   Endpoint:      wss://stream.aisstream.io/v0/stream
 *   Free tier:     Fair-use; plenty for tracking a small fleet of vessels
 *
 * We maintain ONE websocket connection that subscribes to all vessels currently
 * referenced by any shipment (via shipment.vessel_mmsi). When that set changes,
 * we close and re-open with an updated subscription. The latest position per
 * MMSI is kept in memory and persisted to data/vessel-positions.json.
 *
 * No fall-through retry at the provider level — if AISStream is down or the
 * key is missing, the rest of the app keeps working; the report page just
 * hides the vessel-position block.
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

export interface VesselPosition {
  mmsi: string;
  shipName: string | null;
  lat: number;
  lon: number;
  sogKnots: number | null;  // speed over ground
  cogDeg: number | null;    // course over ground
  updatedAt: string;        // ISO
}

class AisStreamSubscriber {
  private ws: WebSocket | null = null;
  private positions = new Map<string, VesselPosition>();
  private subscribed = new Set<string>(); // MMSIs currently in the active subscription
  private reconnectAttempt = 0;
  private reloadTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private started = false;

  isConfigured(): boolean {
    return !!process.env.AISSTREAM_API_KEY;
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

  getAll(): VesselPosition[] {
    return Array.from(this.positions.values());
  }

  /** Triggered externally when shipments change. Debounced so rapid writes don't thrash. */
  scheduleReload(): void {
    if (!this.isConfigured()) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.reload().catch((err) => console.error("[aisstream] reload failed:", err)), RELOAD_DEBOUNCE_MS);
  }

  private async reload(): Promise<void> {
    const wanted = await this.collectTrackedMmsis();
    // If the subscription set hasn't changed, keep the existing socket.
    const sameSet = wanted.size === this.subscribed.size && Array.from(wanted).every((m) => this.subscribed.has(m));
    if (sameSet && this.ws && this.ws.readyState === WebSocket.OPEN) return;

    // Close any existing connection and open a new one with the new subscription
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
        FilterMessageTypes: ["PositionReport"],
      };
      ws.send(JSON.stringify(subscriptionMsg));
      console.log(`[aisstream] connected; watching ${this.subscribed.size} vessel(s)`);
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
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * Math.pow(2, this.reconnectAttempt - 1));
    console.log(`[aisstream] socket closed; reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})`);
    setTimeout(() => {
      if (!this.closing && this.subscribed.size > 0) this.connect();
    }, delay);
  }

  private handleMessage(msg: any): void {
    if (msg?.MessageType !== "PositionReport") return;
    const meta = msg.MetaData ?? {};
    const pos = msg.Message?.PositionReport ?? {};
    const mmsi = String(meta.MMSI ?? pos.UserID ?? "");
    if (!mmsi) return;
    if (typeof pos.Latitude !== "number" || typeof pos.Longitude !== "number") return;

    const updated: VesselPosition = {
      mmsi,
      shipName: typeof meta.ShipName === "string" ? meta.ShipName.trim() : null,
      lat: pos.Latitude,
      lon: pos.Longitude,
      sogKnots: typeof pos.Sog === "number" ? pos.Sog : null,
      cogDeg: typeof pos.Cog === "number" ? pos.Cog : null,
      updatedAt: meta.time_utc ? new Date(meta.time_utc).toISOString() : new Date().toISOString(),
    };
    this.positions.set(mmsi, updated);
    this.schedulePersist();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch((err) => console.warn("[aisstream] persist failed:", err));
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    const arr = Array.from(this.positions.values());
    await fs.writeFile(CACHE_FILE, JSON.stringify(arr, null, 2), "utf-8");
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = await fs.readFile(CACHE_FILE, "utf-8");
      const arr: VesselPosition[] = JSON.parse(raw);
      for (const p of arr) this.positions.set(p.mmsi, p);
    } catch {
      /* first run — no file yet */
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

export const aisStream = new AisStreamSubscriber();
