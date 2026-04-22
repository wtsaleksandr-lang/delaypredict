/**
 * Phase 3 — LLM-based route-risk extractor (Claude Haiku).
 *
 * Asks Claude to classify route/geopolitical risk based on the current date, the
 * origin→destination pair, and whatever recent news signals the scraper has put in
 * the intel cache. Cached per (origin, destination, ISO week) so we pay at most
 * once per week per route.
 *
 * No Anthropic SDK dep — straight fetch to https://api.anthropic.com/v1/messages.
 * Graceful fallback: if ANTHROPIC_API_KEY is missing, the detector returns null
 * and the rest of the oracle keeps working.
 */

import { promises as fs } from "fs";
import path from "path";
import { readIntelCache } from "./index";

const MODEL = "claude-haiku-4-5";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const CACHE_FILE = path.resolve(process.cwd(), "data", "llm-route-cache.json");

export type LlmRiskLevel = "Low" | "Med" | "High";
export interface LlmRouteRiskResult {
  level: LlmRiskLevel;
  rationale: string;
  confidence: number; // 0..1
  model: string;
  asOf: string;
  sourceEvidence?: string[];
}

interface CacheEntry {
  key: string;
  value: LlmRouteRiskResult;
}

// ── Cache (in-memory + file persistence) ─────────────────────────────────────

let memCache: Map<string, LlmRouteRiskResult> | null = null;

async function loadCache(): Promise<Map<string, LlmRouteRiskResult>> {
  if (memCache) return memCache;
  memCache = new Map();
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf-8");
    const arr: CacheEntry[] = JSON.parse(raw);
    for (const e of arr) memCache.set(e.key, e.value);
  } catch {
    /* first run — no cache file yet */
  }
  return memCache;
}

async function persistCache() {
  if (!memCache) return;
  const arr: CacheEntry[] = Array.from(memCache.entries()).map(([key, value]) => ({ key, value }));
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(arr, null, 2), "utf-8");
}

function isoWeekKey(d: Date): string {
  // ISO week number — good enough cache granularity (one refresh/week per route)
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function cacheKey(origin: string, destination: string, d: Date): string {
  return `${origin.trim().toLowerCase()}|${destination.trim().toLowerCase()}|${isoWeekKey(d)}`;
}

// ── LLM call ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a freight-route risk analyst. Given an origin, destination, and current date, classify the geopolitical and operational risk of shipping along that lane on a Low/Med/High scale.

Consider: active geopolitical conflicts, sanctions, overflight restrictions, canal capacity issues (Panama, Suez), port strikes, customs disruptions, known choke points, and any recent-news context you are given.

Respond ONLY with a strict JSON object, no prose before or after:
{"level":"Low"|"Med"|"High","rationale":"1-2 sentences citing the most important factors","confidence":0.0-1.0,"evidence":["short bullet 1","short bullet 2"]}

Rationale must be specific (mention the actual driver, e.g. "Red Sea rerouting via Cape of Good Hope" not just "geopolitical tension").`;

async function callClaude(userContent: string): Promise<LlmRouteRiskResult | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const body = {
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json: any = await res.json();
  const text: string = json?.content?.[0]?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM returned non-JSON: ${text.slice(0, 120)}`);

  const parsed = JSON.parse(match[0]);
  const level = parsed.level;
  if (!["Low", "Med", "High"].includes(level)) throw new Error(`Invalid level: ${level}`);
  return {
    level,
    rationale: String(parsed.rationale ?? "").trim(),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    model: MODEL,
    asOf: new Date().toISOString(),
    sourceEvidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 4).map(String) : undefined,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export function isLlmConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function detectLlmRouteRisk(opts: {
  origin: string;
  destination: string;
  etd?: string | null;
}): Promise<LlmRouteRiskResult | null> {
  if (!isLlmConfigured()) return null;
  if (!opts.origin || !opts.destination) return null;

  const date = opts.etd ? new Date(opts.etd) : new Date();
  if (isNaN(date.getTime())) return null;
  const key = cacheKey(opts.origin, opts.destination, date);

  const cache = await loadCache();
  const cached = cache.get(key);
  if (cached) return cached;

  // Pull scraper findings for this route (if any) so the LLM is grounded
  const intel = await readIntelCache();
  const relevantRoutes = (intel?.routes ?? []).filter((r) => {
    const haystack = `${opts.origin} ${opts.destination}`.toLowerCase();
    return haystack.includes(r.match.toLowerCase());
  });

  const userContent = [
    `Route: ${opts.origin} → ${opts.destination}`,
    `Shipment date: ${date.toISOString().slice(0, 10)}`,
    relevantRoutes.length > 0
      ? `Recent scraper findings for this route:\n${relevantRoutes.map((r) => `- [${r.level}] ${r.note}`).join("\n")}`
      : `No recent scraper findings for this specific route.`,
  ].join("\n");

  try {
    const result = await callClaude(userContent);
    if (!result) return null;
    cache.set(key, result);
    await persistCache();
    return result;
  } catch (err) {
    console.warn("[llmOracle] route-risk call failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// Dev / admin helpers
export async function clearLlmCache(): Promise<number> {
  const cache = await loadCache();
  const n = cache.size;
  cache.clear();
  await persistCache();
  return n;
}
