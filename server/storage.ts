import { type User, type InsertUser, type Shipment, type InsertShipment, type UpdateShipment, shipments as shipmentsTable, users as usersTable } from "@shared/schema";
import { eq, and, sql, desc, isNotNull, lt, ne, or } from "drizzle-orm";
import { getDb } from "./db";

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

/**
 * Lock the policy reference ETD/ETA the moment a shipment first moves into
 * in_transit (or actual_departure becomes known). Mutates `merged` in place.
 * Once policy_eta_locked is set, later carrier ETA updates MUST NOT overwrite it.
 */
function maybeLockPolicyEta(prev: Shipment, merged: Shipment): void {
  if (merged.policy_eta_locked) return;

  const movingToInTransit =
    prev.status !== "in_transit" &&
    (merged.status === "in_transit" || (merged.actual_departure && !prev.actual_departure));

  if (!movingToInTransit) return;
  if (!merged.eta) return;

  (merged as any).policy_etd_locked = merged.etd ?? prev.etd ?? null;
  (merged as any).policy_eta_locked = merged.eta ?? prev.eta ?? null;
  (merged as any).policy_locked_at = new Date();
}

/**
 * Convert numeric inputs (TS `number`) to the `string` shape Drizzle expects
 * for pg-numeric columns. Pass-through for everything else.
 */
function coerceNumericFields(data: Record<string, any>): Record<string, any> {
  const NUMERIC = new Set([
    "risk_score", "base_delay_probability", "expected_delay_days",
    "best_ev", "cost", "sale_price", "insurance_premium", "actual_delay_days",
    "prediction_confidence", "predicted_delay_days",
  ]);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = NUMERIC.has(k) && typeof v === "number" ? String(v) : v;
  }
  return out;
}

class PgStorage implements IStorage {
  private get db() { return getDb(); }

  async getUser(id: string): Promise<User | undefined> {
    const rows = await this.db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    return rows[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const rows = await this.db.select().from(usersTable).where(eq(usersTable.username, username)).limit(1);
    return rows[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const rows = await this.db.insert(usersTable).values(insertUser).returning();
    return rows[0];
  }

  async listShipments(): Promise<Shipment[]> {
    return await this.db.select().from(shipmentsTable).orderBy(desc(shipmentsTable.created_at));
  }

  async getShipment(id: string): Promise<Shipment | undefined> {
    const rows = await this.db.select().from(shipmentsTable).where(eq(shipmentsTable.id, id)).limit(1);
    return rows[0];
  }

  async createShipment(data: InsertShipment): Promise<Shipment> {
    const insertValues = coerceNumericFields({
      ...data,
      status: data.status ?? "planned",
    });
    const rows = await this.db.insert(shipmentsTable).values(insertValues as any).returning();
    return rows[0];
  }

  async updateShipment(id: string, data: UpdateShipment): Promise<Shipment | undefined> {
    const existing = await this.getShipment(id);
    if (!existing) return undefined;

    const patch: any = { ...coerceNumericFields(data as Record<string, any>), updated_at: new Date() };

    // Compute the post-update shipment shape locally so the lock helper can
    // see both before and after state, then apply any lock fields it sets.
    const merged = { ...existing, ...patch } as Shipment;
    maybeLockPolicyEta(existing, merged);
    if (merged.policy_eta_locked && !existing.policy_eta_locked) {
      patch.policy_etd_locked = merged.policy_etd_locked;
      patch.policy_eta_locked = merged.policy_eta_locked;
      patch.policy_locked_at = merged.policy_locked_at;
    }

    const rows = await this.db
      .update(shipmentsTable)
      .set(patch)
      .where(eq(shipmentsTable.id, id))
      .returning();
    return rows[0];
  }

  async updateShipmentTracking(id: string, patch: Partial<Shipment>): Promise<Shipment | undefined> {
    const existing = await this.getShipment(id);
    if (!existing) return undefined;

    const update: any = { ...patch, updated_at: new Date() };
    const merged = { ...existing, ...update } as Shipment;
    maybeLockPolicyEta(existing, merged);
    if (merged.policy_eta_locked && !existing.policy_eta_locked) {
      update.policy_etd_locked = merged.policy_etd_locked;
      update.policy_eta_locked = merged.policy_eta_locked;
      update.policy_locked_at = merged.policy_locked_at;
    }

    const rows = await this.db
      .update(shipmentsTable)
      .set(update)
      .where(eq(shipmentsTable.id, id))
      .returning();
    return rows[0];
  }

  async deleteShipment(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(shipmentsTable)
      .where(eq(shipmentsTable.id, id))
      .returning({ id: shipmentsTable.id });
    return rows.length > 0;
  }

  async listShipmentsNeedingTrackingRefresh(maxAgeMs: number): Promise<Shipment[]> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    // Active shipments (not delivered/cancelled) that have a trackable id
    // and were last polled before the cutoff (or never).
    return await this.db
      .select()
      .from(shipmentsTable)
      .where(
        and(
          ne(shipmentsTable.status, "delivered"),
          ne(shipmentsTable.status, "cancelled"),
          or(isNotNull(shipmentsTable.container_number), isNotNull(shipmentsTable.awb_number)),
          or(
            sql`${shipmentsTable.tracking_last_polled} IS NULL`,
            lt(shipmentsTable.tracking_last_polled, cutoff),
          ),
        ),
      );
  }
}

export const storage: IStorage = new PgStorage();
