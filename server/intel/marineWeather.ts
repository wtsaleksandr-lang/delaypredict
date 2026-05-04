/**
 * Open-Meteo Marine integration.
 *
 * For an in-flight ocean voyage we sample ~5 waypoints along the great-circle
 * path between origin and destination ports, query Open-Meteo Marine for the
 * next 7 days at each, and return a weather-driven delay estimate.
 *
 * Open-Meteo Marine is free, requires no API key, and has no rate limit. URL:
 *   https://marine-api.open-meteo.com/v1/marine
 *
 * The signal we care about is forecast wave height. Conventional vessel-ops
 * thresholds:
 *   <= 3m         → normal speed, no delay
 *   3-4m          → minor speed reduction
 *   4-6m          → significant slowdown, 0.5-1d delay per heavy day
 *   > 6m          → reroute or storm avoidance, 1-2d delay per heavy day
 *
 * Cached 6h per waypoint to avoid hammering the API.
 */

import { resolvePort } from "./ports";

const ENDPOINT = "https://marine-api.open-meteo.com/v1/marine";
const FORECAST_DAYS = 7;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  maxWaveHeight: number;
  hoursOver4m: number;
  hoursOver6m: number;
}
const cache = new Map<string, CacheEntry>();

export interface MarineRiskResult {
  delayDays: number;
  maxWaveHeightM: number;
  hoursOver4m: number;
  hoursOver6m: number;
  waypointsSampled: number;
  source: string;
}

/** Linear interpolation along the great-circle between two coordinates. */
function interpolateGreatCircle(lat1: number, lon1: number, lat2: number, lon2: number, f: number): { lat: number; lon: number } {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const lam1 = lon1 * toRad;
  const lam2 = lon2 * toRad;
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((phi2 - phi1) / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin((lam2 - lam1) / 2) ** 2,
  ));
  if (d === 0) return { lat: lat1, lon: lon1 };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(phi1) * Math.cos(lam1) + B * Math.cos(phi2) * Math.cos(lam2);
  const y = A * Math.cos(phi1) * Math.sin(lam1) + B * Math.cos(phi2) * Math.sin(lam2);
  const z = A * Math.sin(phi1) + B * Math.sin(phi2);
  return {
    lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg,
    lon: Math.atan2(y, x) * toDeg,
  };
}

async function queryWaypoint(lat: number, lon: number): Promise<CacheEntry | null> {
  // Round to 1 decimal (~11 km) for cache key — fine for marine weather scales
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const url = `${ENDPOINT}?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&hourly=wave_height&forecast_days=${FORECAST_DAYS}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      // Open-Meteo returns 400 for over-land coordinates — treat as no data, not failure
      if (r.status === 400) return null;
      throw new Error(`Open-Meteo ${r.status}`);
    }
    const j: any = await r.json();
    const heights: number[] = j?.hourly?.wave_height ?? [];
    if (heights.length === 0) return null;
    const maxWave = heights.reduce((a, b) => (b > a ? b : a), 0);
    const hoursOver4 = heights.filter((h) => h > 4).length;
    const hoursOver6 = heights.filter((h) => h > 6).length;
    const entry: CacheEntry = {
      fetchedAt: Date.now(),
      maxWaveHeight: Number(maxWave.toFixed(2)),
      hoursOver4m: hoursOver4,
      hoursOver6m: hoursOver6,
    };
    cache.set(key, entry);
    return entry;
  } catch (err) {
    // Network/timeout — return null, predictor falls back gracefully
    return null;
  }
}

/**
 * Sample N waypoints along the great-circle from origin to destination and
 * return the worst-case marine forecast across them.
 */
export async function getMarineRiskForLane(
  originHint: string | null | undefined,
  destinationHint: string | null | undefined,
): Promise<MarineRiskResult | null> {
  if (!originHint || !destinationHint) return null;
  const origin = resolvePort(originHint);
  const dest = resolvePort(destinationHint);
  if (!origin || !dest) return null;
  if (origin.kind !== "ocean" || dest.kind !== "ocean") return null;

  // Sample 5 waypoints at f = 0.1, 0.3, 0.5, 0.7, 0.9 (skip exact endpoints which are usually inside port basins, ~no waves reported)
  const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
  const points = fractions.map((f) => interpolateGreatCircle(origin.lat, origin.lon, dest.lat, dest.lon, f));
  const results = await Promise.all(points.map((p) => queryWaypoint(p.lat, p.lon)));
  const valid = results.filter((r): r is CacheEntry => r !== null);
  if (valid.length === 0) return null;

  const maxWave = valid.reduce((a, b) => (b.maxWaveHeight > a ? b.maxWaveHeight : a), 0);
  const hoursOver4 = valid.reduce((a, b) => a + b.hoursOver4m, 0);
  const hoursOver6 = valid.reduce((a, b) => a + b.hoursOver6m, 0);

  // Delay heuristic: every 24 hours of 4-6m waves crossed by the route adds
  // ~0.3 days; every 24 hours over 6m adds ~0.7 days. Bounded to avoid
  // runaway delay estimates from a single waypoint with persistent storm.
  const delayDays = Number((Math.min(hoursOver4 / 24 * 0.3 + hoursOver6 / 24 * 0.7, 4)).toFixed(2));

  let severity = "calm";
  if (maxWave > 6) severity = "severe storm forecast";
  else if (maxWave > 4) severity = "rough seas forecast";
  else if (maxWave > 3) severity = "moderate waves";

  return {
    delayDays,
    maxWaveHeightM: Number(maxWave.toFixed(1)),
    hoursOver4m: hoursOver4,
    hoursOver6m: hoursOver6,
    waypointsSampled: valid.length,
    source: `${severity} (max ${maxWave.toFixed(1)}m, ${hoursOver4}h>4m next ${FORECAST_DAYS}d)`,
  };
}
