import type { Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { insertShipmentSchema, updateShipmentSchema, type Shipment } from "@shared/schema";
import { resolveTracking, listProviders } from "./tracking";
import { ProviderError, type NormalizedTracking } from "./tracking/types";

function applyTrackingToShipment(s: Shipment, tr: NormalizedTracking): Partial<Shipment> {
  // Compute delay days vs ETA if we have an actual_arrival
  let actual_delay_days: string | null = null;
  if (tr.actual_arrival && s.eta) {
    const eta = new Date(s.eta as any).getTime();
    const arr = new Date(tr.actual_arrival).getTime();
    if (!isNaN(eta) && !isNaN(arr)) {
      actual_delay_days = ((arr - eta) / 86_400_000).toFixed(2);
    }
  }
  return {
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
  };
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // Provider config status
  app.get("/api/tracking/providers", (_req, res) => {
    res.json(listProviders());
  });

  // List
  app.get("/api/shipments", async (_req, res, next) => {
    try {
      res.json(await storage.listShipments());
    } catch (err) {
      next(err);
    }
  });

  // Get one
  app.get("/api/shipments/:id", async (req, res, next) => {
    try {
      const s = await storage.getShipment(req.params.id);
      if (!s) return res.status(404).json({ message: "Not found" });
      res.json(s);
    } catch (err) {
      next(err);
    }
  });

  // Create
  app.post("/api/shipments", async (req, res, next) => {
    try {
      const parsed = insertShipmentSchema.parse(req.body);
      const created = await storage.createShipment(parsed);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // Update (user-editable fields only)
  app.patch("/api/shipments/:id", async (req, res, next) => {
    try {
      const parsed = updateShipmentSchema.parse(req.body);
      const updated = await storage.updateShipment(req.params.id, parsed);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // Delete
  app.delete("/api/shipments/:id", async (req, res, next) => {
    try {
      const ok = await storage.deleteShipment(req.params.id);
      if (!ok) return res.status(404).json({ message: "Not found" });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Manual tracking refresh
  app.post("/api/shipments/:id/refresh-tracking", async (req, res, next) => {
    try {
      const s = await storage.getShipment(req.params.id);
      if (!s) return res.status(404).json({ message: "Not found" });
      try {
        const tr = await resolveTracking({
          mode: s.mode as "ocean" | "air",
          containerNumber: s.container_number,
          bookingNumber: s.booking_number,
          awbNumber: s.awb_number,
          flightNumber: s.flight_number,
          carrierScac: s.carrier_scac,
        });
        const updated = await storage.updateShipmentTracking(s.id, applyTrackingToShipment(s, tr));
        res.json({ tracking: tr, shipment: updated });
      } catch (err) {
        if (err instanceof ProviderError) {
          return res.status(err.status === 404 ? 404 : 502).json({ message: err.message });
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  return httpServer;
}
