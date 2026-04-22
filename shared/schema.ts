import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, numeric, jsonb, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Users (kept for optional future internal auth) ─────────────────────────────
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// ── Shipments ─────────────────────────────────────────────────────────────────
export const shipments = pgTable("shipments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  // Identifiers
  personal_ref: text("personal_ref"),
  mode: text("mode").notNull(), // 'ocean' | 'air'
  booking_number: text("booking_number"),
  container_number: text("container_number"),
  awb_number: text("awb_number"),
  flight_number: text("flight_number"),
  carrier_scac: text("carrier_scac"), // e.g. MAEU, MSCU, HLCU, CMDU, ONEY

  // Route
  origin: text("origin"),
  destination: text("destination"),
  etd: date("etd"),
  eta: date("eta"),

  // Calc snapshot
  inputs_json: jsonb("inputs_json").notNull(),
  result_json: jsonb("result_json").notNull(),
  risk_score: numeric("risk_score"),
  base_delay_probability: numeric("base_delay_probability"),
  expected_delay_days: numeric("expected_delay_days"),
  best_trigger: integer("best_trigger"),
  best_ev: numeric("best_ev"),
  recommendation: text("recommendation"),

  // P&L
  cost: numeric("cost"),
  sale_price: numeric("sale_price"),
  insurance_premium: numeric("insurance_premium"),
  insurance_chosen_trigger: integer("insurance_chosen_trigger"),

  // Tracking
  tracking_provider: text("tracking_provider"),
  tracking_status: text("tracking_status"),
  tracking_last_polled: timestamp("tracking_last_polled"),
  tracking_last_event_at: timestamp("tracking_last_event_at"),
  actual_departure: date("actual_departure"),
  actual_arrival: date("actual_arrival"),
  actual_delay_days: numeric("actual_delay_days"),
  tracking_payload: jsonb("tracking_payload"),

  // Lifecycle
  status: text("status").notNull().default("planned"), // planned | in_transit | delivered | delayed | cancelled
  notes: text("notes"),

  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export type Shipment = typeof shipments.$inferSelect;

// Zod schemas for input validation (used by both server and client forms)
export const ShipmentModeSchema = z.enum(["ocean", "air"]);
export type ShipmentMode = z.infer<typeof ShipmentModeSchema>;

export const insertShipmentSchema = z.object({
  personal_ref: z.string().optional().nullable(),
  mode: ShipmentModeSchema,
  booking_number: z.string().optional().nullable(),
  container_number: z.string().optional().nullable(),
  awb_number: z.string().optional().nullable(),
  flight_number: z.string().optional().nullable(),
  carrier_scac: z.string().optional().nullable(),
  origin: z.string().optional().nullable(),
  destination: z.string().optional().nullable(),
  etd: z.string().optional().nullable(),
  eta: z.string().optional().nullable(),
  inputs_json: z.any(),
  result_json: z.any(),
  risk_score: z.number().optional().nullable(),
  base_delay_probability: z.number().optional().nullable(),
  expected_delay_days: z.number().optional().nullable(),
  best_trigger: z.number().int().optional().nullable(),
  best_ev: z.number().optional().nullable(),
  recommendation: z.string().optional().nullable(),
  cost: z.number().optional().nullable(),
  sale_price: z.number().optional().nullable(),
  insurance_premium: z.number().optional().nullable(),
  insurance_chosen_trigger: z.number().int().optional().nullable(),
  status: z.string().optional(),
  notes: z.string().optional().nullable(),
});

export type InsertShipment = z.infer<typeof insertShipmentSchema>;

export const updateShipmentSchema = insertShipmentSchema.partial();
export type UpdateShipment = z.infer<typeof updateShipmentSchema>;
