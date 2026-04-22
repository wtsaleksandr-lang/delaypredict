import type { TrackingProvider, TrackingQuery, NormalizedTracking } from "./types";
import { ProviderError } from "./types";
import { SeventeenTrackProvider } from "./providers/seventeentrack";
import { MaerskProvider } from "./providers/maersk";
import { HapagProvider } from "./providers/hapag";
import { CmaCgmProvider } from "./providers/cmacgm";
import { OpenSkyProvider } from "./providers/opensky";

/**
 * Tracking provider registry.
 *
 * Resolution order (highest priority first):
 *   1. Carrier-direct ocean adapters (Maersk, Hapag-Lloyd, CMA CGM) — free, authoritative.
 *   2. 17TRACK universal aggregator — broad coverage, free 100/mo (ocean + air).
 *   3. OpenSky Network for air, by flight number — completely free, no signup.
 *
 * Adapters that aren't configured (no API key) are skipped automatically.
 */
const providers: TrackingProvider[] = [
  new MaerskProvider(),
  new HapagProvider(),
  new CmaCgmProvider(),
  new SeventeenTrackProvider(),
  new OpenSkyProvider(),
];

export function listProviders() {
  return providers.map((p) => ({ name: p.name, configured: p.isConfigured() }));
}

export async function resolveTracking(q: TrackingQuery): Promise<NormalizedTracking> {
  const candidates = providers.filter((p) => p.isConfigured() && p.supports(q));
  if (candidates.length === 0) {
    throw new ProviderError(
      "No tracking provider can handle this shipment. For ocean: set MAERSK_CONSUMER_KEY, HAPAG_CLIENT_ID/SECRET, CMACGM_CLIENT_ID/SECRET, or SEVENTEENTRACK_API_KEY. For air: add a flight number (OpenSky is free) or SEVENTEENTRACK_API_KEY.",
    );
  }
  let lastErr: unknown;
  for (const p of candidates) {
    try {
      return await p.fetch(q);
    } catch (err) {
      lastErr = err;
      console.warn(`[tracking] provider "${p.name}" failed; trying next.`, err instanceof Error ? err.message : err);
    }
  }
  throw lastErr instanceof Error ? lastErr : new ProviderError("All providers failed");
}
