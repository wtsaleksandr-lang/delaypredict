/**
 * App settings store — Postgres-backed (Neon).
 *
 * Used to persist API keys and feature toggles without touching the host's
 * environment. `getSecret(name)` checks the in-memory cache (which mirrors
 * the `app_settings` table) first, then falls back to `process.env[name]`
 * so existing env-based deploys keep working.
 *
 * Why Postgres: the previous JSON-file backing store lived under `data/`
 * which was wiped on every Replit redeploy.
 */

import { eq } from "drizzle-orm";
import { appSettings } from "@shared/schema";
import { getDb } from "../db";

const SECRET_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "AISSTREAM_API_KEY",
  "SEVENTEENTRACK_API_KEY",
  "MAERSK_CONSUMER_KEY",
  "HAPAG_CLIENT_ID",
  "HAPAG_CLIENT_SECRET",
  "CMACGM_CLIENT_ID",
  "CMACGM_CLIENT_SECRET",
  "OPENSKY_CLIENT_ID",
  "OPENSKY_CLIENT_SECRET",
]);

const KNOWN_KEYS: Array<{
  key: string;
  label: string;
  description: string;
  type: "secret" | "toggle" | "url";
  group: string;
}> = [
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", description: "Claude — used for shipment doc extraction + LLM route oracle. Get one at console.anthropic.com.", type: "secret", group: "AI" },
  { key: "AISSTREAM_API_KEY", label: "AISStream API key", description: "Live vessel positions + ETA via AIS. Free tier at aisstream.io.", type: "secret", group: "Vessel tracking" },
  { key: "ENABLE_VOYAGE_OBSERVER", label: "Enable global voyage observer", description: "Set to 'true' to learn lane transit-time medians from all global AIS traffic (requires AISSTREAM key).", type: "toggle", group: "Vessel tracking" },
  { key: "OPENSKY_CLIENT_ID", label: "OpenSky client ID", description: "Live flight tracking (departures + arrivals at cargo hubs). Free dev account at opensky-network.org.", type: "secret", group: "Flight tracking" },
  { key: "OPENSKY_CLIENT_SECRET", label: "OpenSky client secret", description: "Pairs with OPENSKY_CLIENT_ID.", type: "secret", group: "Flight tracking" },
  { key: "SEVENTEENTRACK_API_KEY", label: "17track API key", description: "Air + ocean tracking aggregator. Optional fallback when carrier APIs aren't available.", type: "secret", group: "Tracking" },
  { key: "MAERSK_CONSUMER_KEY", label: "Maersk consumer key", description: "Maersk Track & Trace API. Apply at developer.maersk.com.", type: "secret", group: "Carrier APIs" },
  { key: "HAPAG_CLIENT_ID", label: "Hapag-Lloyd client ID", description: "Hapag-Lloyd Track API. Apply at api-portal.hlag.com.", type: "secret", group: "Carrier APIs" },
  { key: "HAPAG_CLIENT_SECRET", label: "Hapag-Lloyd client secret", description: "Pairs with HAPAG_CLIENT_ID.", type: "secret", group: "Carrier APIs" },
  { key: "CMACGM_CLIENT_ID", label: "CMA CGM client ID", description: "CMA CGM Track & Trace. Apply at developers.cma-cgm.com.", type: "secret", group: "Carrier APIs" },
  { key: "CMACGM_CLIENT_SECRET", label: "CMA CGM client secret", description: "Pairs with CMACGM_CLIENT_ID.", type: "secret", group: "Carrier APIs" },
];

let cache: Record<string, string> | null = null;
let loadPromise: Promise<void> | null = null;

async function load(): Promise<void> {
  try {
    const rows = await getDb().select().from(appSettings);
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    cache = map;
  } catch (err: any) {
    console.warn("[appSettings] DB read failed:", err?.message ?? err);
    cache = {};
  }
}

async function ensureLoaded(): Promise<void> {
  if (cache !== null) return;
  if (!loadPromise) loadPromise = load();
  await loadPromise;
}

export function isSecret(key: string): boolean {
  return SECRET_KEYS.has(key);
}

function maskValue(v: string): string {
  if (!v) return "";
  if (v.length <= 6) return "•".repeat(v.length);
  return v.slice(0, 3) + "•".repeat(Math.max(4, v.length - 6)) + v.slice(-3);
}

/**
 * Read a setting. Order: in-memory cache (settings file) → process.env.
 * Returns undefined if neither is set.
 */
export async function getSetting(key: string): Promise<string | undefined> {
  await ensureLoaded();
  const stored = cache?.[key];
  if (stored && stored.length > 0) return stored;
  const env = process.env[key];
  return env && env.length > 0 ? env : undefined;
}

/** Synchronous variant — assumes the cache is preloaded. Use for hot paths only after preloadSettings(). */
export function getSettingSync(key: string): string | undefined {
  const stored = cache?.[key];
  if (stored && stored.length > 0) return stored;
  const env = process.env[key];
  return env && env.length > 0 ? env : undefined;
}

/** Convenience: same as getSetting, but typed for "I'm reading an API key". */
export const getSecret = getSetting;
export const getSecretSync = getSettingSync;

/** Force-load the cache once at boot so getSettingSync works immediately. */
export async function preloadSettings(): Promise<void> {
  await ensureLoaded();
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  await ensureLoaded();
  if (!cache) cache = {};
  const db = getDb();
  if (value == null || value === "") {
    delete cache[key];
    await db.delete(appSettings).where(eq(appSettings.key, key));
  } else {
    cache[key] = value;
    // Upsert: insert or update the value, refresh updated_at
    await db
      .insert(appSettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updated_at: new Date() },
      });
  }
}

export async function listSettingsForUI(): Promise<{
  keys: typeof KNOWN_KEYS;
  values: Record<string, { set: boolean; source: "settings" | "env" | "none"; preview: string }>;
}> {
  await ensureLoaded();
  const values: Record<string, { set: boolean; source: "settings" | "env" | "none"; preview: string }> = {};
  for (const { key } of KNOWN_KEYS) {
    const stored = cache?.[key];
    const env = process.env[key];
    if (stored && stored.length > 0) {
      values[key] = { set: true, source: "settings", preview: isSecret(key) ? maskValue(stored) : stored };
    } else if (env && env.length > 0) {
      values[key] = { set: true, source: "env", preview: isSecret(key) ? maskValue(env) : env };
    } else {
      values[key] = { set: false, source: "none", preview: "" };
    }
  }
  return { keys: KNOWN_KEYS, values };
}
