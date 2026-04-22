import { storage } from "../storage";
import { resolveTracking } from "../tracking";
import { listProviders } from "../tracking";

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 min between sweeps
const STALE_AFTER_MS = 60 * 60 * 1000; // refresh shipments older than 1h
const MAX_PER_SWEEP = 20;

let timer: NodeJS.Timeout | undefined;

async function sweep() {
  const configured = listProviders().some((p) => p.configured);
  if (!configured) return; // nothing to do without any provider key

  try {
    const due = await storage.listShipmentsNeedingTrackingRefresh(STALE_AFTER_MS);
    const batch = due.slice(0, MAX_PER_SWEEP);
    if (batch.length === 0) return;

    console.log(`[trackingPoller] refreshing ${batch.length} shipment(s)`);
    for (const s of batch) {
      try {
        const tr = await resolveTracking({
          mode: s.mode as "ocean" | "air",
          containerNumber: s.container_number,
          bookingNumber: s.booking_number,
          awbNumber: s.awb_number,
          flightNumber: s.flight_number,
          carrierScac: s.carrier_scac,
        });
        let actual_delay_days: string | null = null;
        if (tr.actual_arrival && s.eta) {
          const eta = new Date(s.eta as any).getTime();
          const arr = new Date(tr.actual_arrival).getTime();
          if (!isNaN(eta) && !isNaN(arr)) actual_delay_days = ((arr - eta) / 86_400_000).toFixed(2);
        }
        await storage.updateShipmentTracking(s.id, {
          tracking_provider: tr.provider,
          tracking_status: tr.status,
          tracking_last_polled: new Date(),
          tracking_last_event_at: tr.milestones[0]?.occurred_at ? new Date(tr.milestones[0].occurred_at) : null,
          actual_departure: tr.actual_departure ? (new Date(tr.actual_departure) as any) : null,
          actual_arrival: tr.actual_arrival ? (new Date(tr.actual_arrival) as any) : null,
          actual_delay_days: actual_delay_days as any,
          tracking_payload: tr as any,
          status:
            tr.status === "delivered"
              ? "delivered"
              : tr.status === "delayed"
                ? "delayed"
                : tr.status === "in_transit" || tr.status === "arrived"
                  ? "in_transit"
                  : s.status,
        });
      } catch (err) {
        console.warn(`[trackingPoller] ${s.id}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[trackingPoller] sweep failed:", err);
  }
}

export function startTrackingPoller() {
  if (timer) return;
  // Run a sweep shortly after boot, then on interval
  setTimeout(sweep, 30_000);
  timer = setInterval(sweep, POLL_INTERVAL_MS);
  console.log(`[trackingPoller] started; sweep every ${POLL_INTERVAL_MS / 60000} min`);
}

export function stopTrackingPoller() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
