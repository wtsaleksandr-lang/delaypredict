import type { TrackingProvider, TrackingQuery, NormalizedTracking } from "./types";
import { ProviderError } from "./types";
import { SeventeenTrackProvider } from "./providers/seventeentrack";
import { MaerskProvider } from "./providers/maersk";
import { HapagProvider } from "./providers/hapag";
import { CmaCgmProvider } from "./providers/cmacgm";

/**
 * Tracking provider registry.
 *
 * Resolution order (highest priority first):
 *   1. Carrier-direct adapters (Maersk, Hapag-Lloyd, CMA CGM) — free, authoritative.
 *   2. 17TRACK universal aggregator — broad coverage, free 100/mo.
 *
 * Adapters that aren't configured (no API key) are skipped automatically.
 */
const providers: TrackingProvider[] = [
  new MaerskProvider(),
  new HapagProvider(),
  new CmaCgmProvider(),
  new SeventeenTrackProvider(),
];

export function listProviders() {
  return providers.map((p) => ({ name: p.name, configured: p.isConfigured() }));
}

export async function resolveTracking(q: TrackingQuery): Promise<NormalizedTracking> {
  const candidates = providers.filter((p) => p.isConfigured() && p.supports(q));
  if (candidates.length === 0) {
    throw new ProviderError(
      "No tracking provider is configured for this shipment. Set MAERSK_CONSUMER_KEY, HAPAG_CLIENT_ID/SECRET, CMACGM_CLIENT_ID/SECRET, or SEVENTEENTRACK_API_KEY in your .env.",
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
