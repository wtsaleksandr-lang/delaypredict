import { type User, type InsertUser, type Shipment, type InsertShipment, type UpdateShipment } from "@shared/schema";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

export interface IStorage {
  // Users (kept for optional future internal auth)
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // Shipments
  listShipments(): Promise<Shipment[]>;
  getShipment(id: string): Promise<Shipment | undefined>;
  createShipment(data: InsertShipment): Promise<Shipment>;
  updateShipment(id: string, data: UpdateShipment): Promise<Shipment | undefined>;
  updateShipmentTracking(id: string, patch: Partial<Shipment>): Promise<Shipment | undefined>;
  deleteShipment(id: string): Promise<boolean>;
  listShipmentsNeedingTrackingRefresh(maxAgeMs: number): Promise<Shipment[]>;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const SHIPMENTS_FILE = path.join(DATA_DIR, "shipments.json");

// File-backed JSON storage. Good enough for personal/internal use.
// Swap to PostgresStorage later if multiple users / concurrency become a concern.
export class JsonFileStorage implements IStorage {
  private users = new Map<string, User>();
  private shipments = new Map<string, Shipment>();
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded = false;

  private async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const raw = await fs.readFile(SHIPMENTS_FILE, "utf-8");
      const parsed: Shipment[] = JSON.parse(raw);
      for (const s of parsed) {
        // Re-hydrate Date fields that JSON serialized as strings
        const reh: any = { ...s };
        for (const k of ["created_at", "updated_at", "tracking_last_polled", "tracking_last_event_at"]) {
          if (reh[k] && typeof reh[k] === "string") reh[k] = new Date(reh[k]);
        }
        this.shipments.set(s.id, reh as Shipment);
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error("[storage] failed to load shipments:", err);
      }
    }
  }

  private persist() {
    // Serialize writes so concurrent calls don't clobber the file
    this.writeQueue = this.writeQueue.then(async () => {
      const list = Array.from(this.shipments.values());
      const tmp = SHIPMENTS_FILE + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(list, null, 2), "utf-8");
      await fs.rename(tmp, SHIPMENTS_FILE);
    }).catch((err) => {
      console.error("[storage] persist failed:", err);
    });
    return this.writeQueue;
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }
  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find((u) => u.username === username);
  }
  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  async listShipments(): Promise<Shipment[]> {
    await this.ensureLoaded();
    return Array.from(this.shipments.values()).sort((a, b) => {
      const at = a.created_at instanceof Date ? a.created_at.getTime() : new Date(a.created_at as any).getTime();
      const bt = b.created_at instanceof Date ? b.created_at.getTime() : new Date(b.created_at as any).getTime();
      return bt - at;
    });
  }

  async getShipment(id: string): Promise<Shipment | undefined> {
    await this.ensureLoaded();
    return this.shipments.get(id);
  }

  async createShipment(data: InsertShipment): Promise<Shipment> {
    await this.ensureLoaded();
    const id = randomUUID();
    const now = new Date();
    const shipment = {
      id,
      personal_ref: data.personal_ref ?? null,
      mode: data.mode,
      booking_number: data.booking_number ?? null,
      container_number: data.container_number ?? null,
      awb_number: data.awb_number ?? null,
      flight_number: data.flight_number ?? null,
      carrier_scac: data.carrier_scac ?? null,
      origin: data.origin ?? null,
      destination: data.destination ?? null,
      etd: data.etd ?? null,
      eta: data.eta ?? null,
      inputs_json: data.inputs_json,
      result_json: data.result_json,
      risk_score: data.risk_score?.toString() ?? null,
      base_delay_probability: data.base_delay_probability?.toString() ?? null,
      expected_delay_days: data.expected_delay_days?.toString() ?? null,
      best_trigger: data.best_trigger ?? null,
      best_ev: data.best_ev?.toString() ?? null,
      recommendation: data.recommendation ?? null,
      cost: data.cost?.toString() ?? null,
      sale_price: data.sale_price?.toString() ?? null,
      insurance_premium: data.insurance_premium?.toString() ?? null,
      insurance_chosen_trigger: data.insurance_chosen_trigger ?? null,
      tracking_provider: null,
      tracking_status: null,
      tracking_last_polled: null,
      tracking_last_event_at: null,
      actual_departure: null,
      actual_arrival: null,
      actual_delay_days: null,
      tracking_payload: null,
      status: data.status ?? "planned",
      notes: data.notes ?? null,
      created_at: now,
      updated_at: now,
    } as unknown as Shipment;
    this.shipments.set(id, shipment);
    await this.persist();
    return shipment;
  }

  async updateShipment(id: string, data: UpdateShipment): Promise<Shipment | undefined> {
    await this.ensureLoaded();
    const existing = this.shipments.get(id);
    if (!existing) return undefined;
    const merged = {
      ...existing,
      ...Object.fromEntries(
        Object.entries(data).map(([k, v]) => {
          // Numeric fields are stored as string in pg-numeric mapping
          if (
            ["risk_score", "base_delay_probability", "expected_delay_days", "best_ev", "cost", "sale_price", "insurance_premium", "actual_delay_days"].includes(k) &&
            typeof v === "number"
          ) {
            return [k, v.toString()];
          }
          return [k, v];
        }),
      ),
      updated_at: new Date(),
    } as Shipment;
    this.shipments.set(id, merged);
    await this.persist();
    return merged;
  }

  async updateShipmentTracking(id: string, patch: Partial<Shipment>): Promise<Shipment | undefined> {
    await this.ensureLoaded();
    const existing = this.shipments.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...patch, updated_at: new Date() } as Shipment;
    this.shipments.set(id, merged);
    await this.persist();
    return merged;
  }

  async deleteShipment(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.shipments.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  async listShipmentsNeedingTrackingRefresh(maxAgeMs: number): Promise<Shipment[]> {
    await this.ensureLoaded();
    const now = Date.now();
    return Array.from(this.shipments.values()).filter((s) => {
      if (s.status === "delivered" || s.status === "cancelled") return false;
      if (!s.container_number && !s.awb_number) return false;
      const last = s.tracking_last_polled instanceof Date ? s.tracking_last_polled.getTime() : (s.tracking_last_polled ? new Date(s.tracking_last_polled as any).getTime() : 0);
      return now - last > maxAgeMs;
    });
  }
}

export const storage: IStorage = new JsonFileStorage();
