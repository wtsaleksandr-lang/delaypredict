import { aisStream } from "../tracking/vessels/aisstream";
import { handleAisUpdate, refreshAllPredictions } from "../intel/predictor";
import { storage } from "../storage";

const PERIODIC_MS = 15 * 60 * 1000; // 15 min

let timer: NodeJS.Timeout | undefined;

export function startPredictionJobs() {
  if (timer) return;

  // Subscribe to AIS updates so we recompute the moment data arrives
  aisStream.onUpdate(async (u) => {
    try {
      if (u.kind === "static") {
        // Mirror AIS static data onto any shipment that uses this vessel
        await syncAisStaticToShipments(u.mmsi);
      }
      await handleAisUpdate(u.mmsi);
    } catch (err) {
      console.warn("[predictor] AIS update handler failed:", err instanceof Error ? err.message : err);
    }
  });

  // Periodic sweep (catches shipments with no AIS data — carrier ETA + history only)
  const tick = async () => {
    try {
      const r = await refreshAllPredictions();
      if (r.updated > 0) console.log(`[predictor] refreshed predictions for ${r.updated}/${r.total} active shipments`);
    } catch (err) {
      console.error("[predictor] periodic refresh failed:", err);
    }
  };
  setTimeout(tick, 60_000); // first sweep 1 min after boot
  timer = setInterval(tick, PERIODIC_MS);
  console.log(`[predictor] jobs started — refresh every ${PERIODIC_MS / 60000} min`);
}

async function syncAisStaticToShipments(mmsi: string): Promise<void> {
  const staticData = aisStream.getStatic(mmsi);
  if (!staticData) return;
  const all = await storage.listShipments();
  for (const s of all) {
    if (s.vessel_mmsi !== mmsi) continue;
    if (s.status === "delivered" || s.status === "cancelled") continue;
    await storage.updateShipmentTracking(s.id, {
      ais_destination: staticData.destination as any,
      ais_eta: staticData.etaIso ? (new Date(staticData.etaIso) as any) : null,
      ais_static_updated_at: new Date() as any,
    });
  }
}
