/**
 * Pure-code season risk: given (date, origin, destination) return a Low/Med/High
 * assessment with a human-readable rationale.
 *
 * No API or external data source — this is date+geography logic only.
 */

export type SeasonRisk = "Low" | "Med" | "High";

interface SeasonHit {
  value: SeasonRisk;
  rationale: string;
}

const ASIAN_PORTS = /shanghai|ningbo|shenzhen|yantian|qingdao|xiamen|tianjin|dalian|guangzhou|pvg|sha|hkg|hongkong|hong kong|singapore|sin|busan|incheon|icn|taipei|kaohsiung|tpe|narita|kix|haneda|hnd/i;
const US_WEST = /los angeles|long beach|oakland|seattle|tacoma|lax|ord|sfo|lgb|sea/i;
const US_EAST = /new york|savannah|norfolk|charleston|jfk|ewr|sav|nyc/i;
const GULF_PORTS = /houston|new orleans|mobile|tampa|miami|mia/i;
const EUROPE_NW = /rotterdam|antwerp|hamburg|felixstowe|le havre|bremerhaven|amsterdam|ams|lhr|fra|cdg/i;
const RED_SEA = /suez|jeddah|aqaba|djibouti|red sea/i;

export function detectSeasonRisk(
  date: Date,
  origin = "",
  destination = "",
): SeasonHit {
  const month = date.getUTCMonth() + 1; // 1-12
  const day = date.getUTCDate();
  const route = `${origin} ${destination}`.toLowerCase();

  const hits: string[] = [];
  let level: SeasonRisk = "Low";

  // Chinese New Year window — rolling window around late Jan / mid Feb
  const cny = cnyWindow(date.getUTCFullYear());
  if (ASIAN_PORTS.test(origin) && withinRange(date, cny.start, cny.end)) {
    level = "High";
    hits.push(`Chinese New Year port/factory closures (${formatShort(cny.start)}–${formatShort(cny.end)})`);
  }

  // Pacific typhoon season affecting trans-Pacific & intra-Asia
  if (ASIAN_PORTS.test(route) && month >= 6 && month <= 10) {
    level = bumpRisk(level, month >= 8 && month <= 9 ? "High" : "Med");
    hits.push(`Pacific typhoon season (peak Aug–Sep)`);
  }

  // Atlantic hurricane season — US East/Gulf ↔ Europe
  if ((US_EAST.test(route) || GULF_PORTS.test(route)) && month >= 8 && month <= 10) {
    level = bumpRisk(level, month === 9 ? "High" : "Med");
    hits.push(`Atlantic hurricane season (peak Sep)`);
  }

  // Winter North Pacific gales — US West Coast lanes Dec–Feb
  if (US_WEST.test(route) && (month === 12 || month <= 2)) {
    level = bumpRisk(level, "Med");
    hits.push(`Winter N. Pacific storms (Dec–Feb)`);
  }

  // European winter weather + fog — affects air freight via major EU hubs
  if (EUROPE_NW.test(route) && (month === 12 || month <= 2)) {
    level = bumpRisk(level, "Med");
    hits.push(`European winter weather / fog disruptions (Dec–Feb)`);
  }

  // Red Sea / Suez seasonal sandstorms (less major but real)
  if (RED_SEA.test(route) && month >= 3 && month <= 5) {
    level = bumpRisk(level, "Med");
    hits.push(`Red Sea sandstorm season (Mar–May)`);
  }

  // Peak-shipping surge before Western holidays — Aug–Oct pull-forward for Asia→US/EU
  if (ASIAN_PORTS.test(origin) && (US_WEST.test(destination) || US_EAST.test(destination) || EUROPE_NW.test(destination)) && month >= 8 && month <= 10) {
    level = bumpRisk(level, "Med");
    hits.push(`Peak-shipping surge ahead of Q4 retail (Aug–Oct)`);
  }

  return {
    value: level,
    rationale: hits.length ? hits.join("; ") : `No seasonal concerns for ${origin || "origin"} → ${destination || "destination"} in ${monthName(month)}`,
  };
}

function bumpRisk(a: SeasonRisk, b: SeasonRisk): SeasonRisk {
  const order = { Low: 0, Med: 1, High: 2 };
  return order[a] >= order[b] ? a : b;
}

function withinRange(d: Date, start: Date, end: Date): boolean {
  return d >= start && d <= end;
}

function formatShort(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function monthName(m: number): string {
  return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1];
}

/**
 * Approximate CNY date windows (7 days before through 14 days after) for 2024–2030.
 * Chinese factory/port closures typically 1-2 weeks, longer for smaller factories.
 */
function cnyWindow(year: number): { start: Date; end: Date } {
  const dates: Record<number, [number, number]> = {
    2024: [2, 10],
    2025: [1, 29],
    2026: [2, 17],
    2027: [2, 6],
    2028: [1, 26],
    2029: [2, 13],
    2030: [2, 3],
  };
  const [m, d] = dates[year] ?? [2, 5];
  const cnyDate = new Date(Date.UTC(year, m - 1, d));
  const start = new Date(cnyDate.getTime() - 7 * 86400000);
  const end = new Date(cnyDate.getTime() + 14 * 86400000);
  return { start, end };
}
