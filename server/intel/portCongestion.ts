/**
 * AIS-derived port congestion signal.
 *
 * Counts vessels currently at anchor (nav status 1) within a radius of a port.
 * High anchor counts mean a queue is forming — vessels waiting for berths or
 * pilots — which translates to arrival delay for anyone joining the queue.
 *
 * The thresholds below are coarse and learned from observation:
 *   - "normal" anchor count varies wildly (Singapore can have 50+ as baseline,
 *     a small port might have 0-2).
 *   - Without per-port baselines we use absolute thresholds, treating any port
 *     as congested when 15+ vessels are at anchor and severely congested at
 *     30+. This will over-flag huge transshipment hubs and under-flag small
 *     ports — the right fix is a per-port baseline learned over 30+ days,
 *     which we'll add later when we have enough observations.
 *
 * Source: aisStream is already running globally via voyageObserver, so the
 * vessel cache contains positions for thousands of ships at any moment.
 */

import { resolvePort, haversineKm } from "./ports";
import { aisStream } from "../tracking/vessels/aisstream";

const ANCHOR_RADIUS_KM = 50;
const ANCHOR_NAV_STATUS = 1;

export interface PortCongestionResult {
  port: string;
  unlocode: string | null;
  anchoredCount: number;
  severity: "low" | "moderate" | "high" | "severe";
  delayDays: number;
  source: string;
}

export function getPortCongestion(portHint: string | null | undefined): PortCongestionResult | null {
  if (!portHint) return null;
  const port = resolvePort(portHint);
  if (!port || port.kind !== "ocean") return null;

  const all = aisStream.getAll();
  if (all.length === 0) return null; // AIS not yet warm

  let anchored = 0;
  for (const v of all) {
    if (v.navStatus !== ANCHOR_NAV_STATUS) continue;
    const d = haversineKm(v.lat, v.lon, port.lat, port.lon);
    if (d <= ANCHOR_RADIUS_KM) anchored += 1;
  }

  // Severity bands + delay heuristic. We bias the delay low because port
  // congestion only adds delay if YOUR vessel arrives during the queue, not
  // because there's a queue right now. Treat as a soft signal.
  let severity: PortCongestionResult["severity"];
  let delayDays: number;
  if (anchored >= 30) { severity = "severe"; delayDays = 2.0; }
  else if (anchored >= 15) { severity = "high"; delayDays = 1.0; }
  else if (anchored >= 8) { severity = "moderate"; delayDays = 0.4; }
  else { severity = "low"; delayDays = 0; }

  return {
    port: port.name,
    unlocode: port.unlocode ?? null,
    anchoredCount: anchored,
    severity,
    delayDays,
    source: `${anchored} vessels at anchor within ${ANCHOR_RADIUS_KM}km of ${port.name}`,
  };
}
