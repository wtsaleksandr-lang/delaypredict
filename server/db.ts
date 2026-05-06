import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@shared/schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Lazy Drizzle client — initialised on first call so modules that import
 * { db } from "./db" don't crash at boot when DATABASE_URL is missing
 * (the server will fail later with a clearer error from any caller).
 */
export function getDb() {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (Neon Postgres connection string).");
  const sql = neon(url);
  _db = drizzle(sql, { schema });
  return _db;
}
