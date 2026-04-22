/**
 * Weekly intel scraper — Playwright-based.
 *
 * Visits a curated list of public pages that publish port-congestion indicators,
 * carrier on-time performance summaries, and geopolitical/route advisories,
 * extracts signals, and writes them into data/intel.json for the risk oracle.
 *
 * Philosophy: keep each source a small, independent "collector" function. When a
 * source breaks (HTML changes), only that one collector breaks and the cache
 * keeps the rest. The oracle degrades gracefully — missing data just means the
 * factor falls back to its local default.
 *
 * ── Add your own sources by writing a new collector and listing it in COLLECTORS. ──
 */

import { chromium, type Browser } from "playwright";
import { writeIntelCache, type IntelCache } from "./index";

interface CollectorResult {
  ports?: Record<string, { level: "Low" | "Med" | "High"; note: string }>;
  routes?: Array<{ match: string; level: "Low" | "Med" | "High"; note: string }>;
  carriers?: Record<string, { onTimePct?: number; note: string }>;
  source: string;
  ok: boolean;
  error?: string;
}

type Collector = (browser: Browser) => Promise<CollectorResult>;

// ── Collectors ────────────────────────────────────────────────────────────────

// NOTE: These are starting-point templates. Each uses a public URL and a selector
// that's reasonable at the time of writing, but pages change — keep an eye on the
// logs from /api/intel/refresh and tune the selectors when something breaks.

const collectPortLosAngeles: Collector = async (browser) => {
  const source = "Port of Los Angeles — TurnTime Stats";
  try {
    const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (DelayPredict intel scraper)" });
    const page = await ctx.newPage();
    await page.goto("https://www.portoflosangeles.org/business/statistics/container-statistics/recent-container-statistics", { timeout: 30000, waitUntil: "domcontentloaded" });
    const text = (await page.locator("body").innerText()).slice(0, 8000);
    await ctx.close();
    // Very light heuristic — look for dwell-time keywords and high/low signals.
    const dwell = /truck turn.*?(\d{1,2}\.\d|\d{2,3})\s*(minutes|min|hours|hrs)/i.exec(text);
    const level = /record|delay|congest/i.test(text) ? "Med" : "Low";
    return {
      source,
      ok: true,
      ports: {
        "Los Angeles": { level, note: dwell ? `LA dwell signal: ${dwell[0]}` : `No strong congestion signal this week` },
        "LAX": { level, note: `LA port — same as above` },
      },
    };
  } catch (err) {
    return { source, ok: false, error: String(err instanceof Error ? err.message : err) };
  }
};

const collectBIMCOAdvisories: Collector = async (browser) => {
  const source = "BIMCO — Safety & Security advisories (news feed)";
  try {
    const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (DelayPredict intel scraper)" });
    const page = await ctx.newPage();
    await page.goto("https://www.bimco.org/news", { timeout: 30000, waitUntil: "domcontentloaded" });
    const headlines = await page.locator("a").allTextContents();
    const text = headlines.join(" | ").toLowerCase();
    await ctx.close();

    const routes: CollectorResult["routes"] = [];
    if (/red sea|houthi|suez/.test(text)) {
      routes.push({ match: "suez", level: "High", note: "Red Sea / Suez advisories in BIMCO news feed this week" });
      routes.push({ match: "red sea", level: "High", note: "Red Sea / Suez advisories in BIMCO news feed this week" });
    }
    if (/panama canal|water level|drought/.test(text)) {
      routes.push({ match: "panama", level: "Med", note: "Panama Canal water-level mentions in BIMCO this week" });
    }
    if (/strike|port workers|labor action/.test(text)) {
      routes.push({ match: "strike", level: "Med", note: "Port labor action mentions in BIMCO this week (verify the specific port)" });
    }
    return { source, ok: true, routes };
  } catch (err) {
    return { source, ok: false, error: String(err instanceof Error ? err.message : err) };
  }
};

const collectMaritimeExec: Collector = async (browser) => {
  const source = "Maritime Executive — headlines";
  try {
    const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (DelayPredict intel scraper)" });
    const page = await ctx.newPage();
    await page.goto("https://maritime-executive.com/editorials", { timeout: 30000, waitUntil: "domcontentloaded" });
    const text = (await page.locator("body").innerText()).slice(0, 8000).toLowerCase();
    await ctx.close();

    const ports: CollectorResult["ports"] = {};
    if (/shanghai.*(congest|delay|blank sail)/.test(text)) ports["Shanghai"] = { level: "Med", note: "Shanghai congestion mentions in Maritime Executive this week" };
    if (/long beach.*(congest|delay)/.test(text) || /lbc.*(congest|delay)/.test(text)) ports["Long Beach"] = { level: "Med", note: "Long Beach congestion mentions this week" };
    if (/rotterdam.*(congest|strike|delay)/.test(text)) ports["Rotterdam"] = { level: "Med", note: "Rotterdam disruption mentions this week" };
    return { source, ok: true, ports };
  } catch (err) {
    return { source, ok: false, error: String(err instanceof Error ? err.message : err) };
  }
};

const COLLECTORS: Collector[] = [collectPortLosAngeles, collectBIMCOAdvisories, collectMaritimeExec];

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runIntelRefresh(): Promise<{ asOf: string; sources: string[]; errors: Array<{ source: string; error: string }> }> {
  const asOf = new Date().toISOString();
  const errors: Array<{ source: string; error: string }> = [];
  const ports: IntelCache["ports"] = {};
  const routes: IntelCache["routes"] = [];
  const carriers: IntelCache["carriers"] = {};
  const sources: string[] = [];

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Most common cause: chromium binary not installed. Degrade gracefully — still write an empty cache.
    const cache: IntelCache = { asOf, ports, routes, carriers, sources: [`Chromium unavailable: ${msg}. Run \`npx playwright install chromium\`.`] };
    await writeIntelCache(cache);
    return { asOf, sources: cache.sources, errors: [{ source: "playwright", error: msg }] };
  }

  for (const collector of COLLECTORS) {
    try {
      const r = await collector(browser);
      sources.push(`${r.source} [${r.ok ? "OK" : "FAIL"}${r.error ? ": " + r.error : ""}]`);
      if (!r.ok) {
        errors.push({ source: r.source, error: r.error ?? "unknown" });
        continue;
      }
      if (r.ports) Object.assign(ports, r.ports);
      if (r.routes) routes.push(...r.routes);
      if (r.carriers) Object.assign(carriers, r.carriers);
    } catch (err) {
      errors.push({ source: "collector", error: String(err instanceof Error ? err.message : err) });
    }
  }

  await browser.close();

  const cache: IntelCache = { asOf, ports, routes, carriers, sources };
  await writeIntelCache(cache);
  return { asOf, sources, errors };
}

// Weekly scheduler — call from server bootstrap.
let intelTimer: NodeJS.Timeout | undefined;
const WEEKLY_MS = 7 * 24 * 3600 * 1000;
export function startIntelScheduler() {
  if (intelTimer) return;
  // Run first sweep 5 min after boot, then weekly
  setTimeout(() => {
    runIntelRefresh().catch((err) => console.error("[intel] refresh failed:", err));
  }, 5 * 60 * 1000);
  intelTimer = setInterval(() => {
    runIntelRefresh().catch((err) => console.error("[intel] refresh failed:", err));
  }, WEEKLY_MS);
  console.log(`[intel] scheduler started — weekly refresh`);
}
