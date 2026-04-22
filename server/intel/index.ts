import { detectSeasonRisk, type SeasonRisk } from "./seasonRules";
import { detectCarrierReliability, type ReliabilityHit } from "./carrierReliability";
import { detectScheduleBuffer, type BufferHit } from "./scheduleBuffer";
import { promises as fs } from "fs";
import path from "path";

export interface RiskFactorDetection {
  season?: { value: SeasonRisk; rationale: string; source: string };
  carrier?: ReliabilityHit & { source: string };
  buffer?: BufferHit & { source: string };
  port_origin?: { value: "Low" | "Med" | "High"; rationale: string; source: string; asOf?: string };
  port_destination?: { value: "Low" | "Med" | "High"; rationale: string; source: string; asOf?: string };
  route?: { value: "Low" | "Med" | "High"; rationale: string; source: string; asOf?: string };
  intelAsOf?: string;
}

export interface IntelQuery {
  mode?: "ocean" | "air";
  origin?: string | null;
  destination?: string | null;
  etd?: string | null;
  eta?: string | null;
  carrierScac?: string | null;
}

const INTEL_FILE = path.resolve(process.cwd(), "data", "intel.json");

export interface IntelCache {
  asOf: string;
  ports: Record<string, { level: "Low" | "Med" | "High"; note: string }>;
  routes: Array<{ match: string; level: "Low" | "Med" | "High"; note: string }>;
  carriers: Record<string, { onTimePct?: number; note: string }>;
  sources: string[];
}

export async function readIntelCache(): Promise<IntelCache | null> {
  try {
    const raw = await fs.readFile(INTEL_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeIntelCache(cache: IntelCache): Promise<void> {
  await fs.mkdir(path.dirname(INTEL_FILE), { recursive: true });
  await fs.writeFile(INTEL_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

export async function detectRiskFactors(q: IntelQuery): Promise<RiskFactorDetection> {
  const out: RiskFactorDetection = {};
  const cache = await readIntelCache();

  // Season (fully local logic)
  if (q.etd) {
    const season = detectSeasonRisk(new Date(q.etd), q.origin || "", q.destination || "");
    out.season = { ...season, source: "Seasonal rules (local)" };
  }

  // Carrier reliability (static table, can be overridden by cache)
  if (q.carrierScac) {
    const rel = detectCarrierReliability(q.carrierScac);
    const overlay = cache?.carriers?.[q.carrierScac.toUpperCase()];
    if (overlay?.onTimePct != null) {
      out.carrier = {
        value: overlay.onTimePct >= 70 ? "High" : overlay.onTimePct >= 55 ? "Avg" : "Low",
        onTimePct: overlay.onTimePct,
        rationale: overlay.note || rel.rationale,
        source: "Intel cache",
        asOf: cache?.asOf,
      };
    } else {
      out.carrier = { ...rel, source: rel.source || "Sea-Intelligence static table" };
    }
  }

  // Schedule buffer (needs history)
  const buf = await detectScheduleBuffer(q);
  out.buffer = { ...buf, source: "Your historical shipments" };

  // Port congestion — purely from intel cache
  if (cache?.ports && q.origin) {
    const originKey = matchPortKey(q.origin, Object.keys(cache.ports));
    if (originKey) {
      const p = cache.ports[originKey];
      out.port_origin = { value: p.level, rationale: p.note, source: "Intel scraper", asOf: cache.asOf };
    }
  }
  if (cache?.ports && q.destination) {
    const destKey = matchPortKey(q.destination, Object.keys(cache.ports));
    if (destKey) {
      const p = cache.ports[destKey];
      out.port_destination = { value: p.level, rationale: p.note, source: "Intel scraper", asOf: cache.asOf };
    }
  }

  // Route / geopolitical risk — from intel cache route rules
  if (cache?.routes && (q.origin || q.destination)) {
    const haystack = `${q.origin ?? ""} ${q.destination ?? ""}`.toLowerCase();
    const hit = cache.routes.find((r) => haystack.includes(r.match.toLowerCase()));
    if (hit) {
      out.route = { value: hit.level, rationale: hit.note, source: "Intel scraper", asOf: cache.asOf };
    }
  }

  out.intelAsOf = cache?.asOf;
  return out;
}

function matchPortKey(name: string, keys: string[]): string | undefined {
  const n = name.toLowerCase();
  return keys.find((k) => n.includes(k.toLowerCase()) || k.toLowerCase().includes(n));
}
