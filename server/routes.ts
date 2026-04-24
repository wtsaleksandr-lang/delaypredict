import type { Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { insertShipmentSchema, updateShipmentSchema, type Shipment } from "@shared/schema";
import { resolveTracking, listProviders } from "./tracking";
import { ProviderError, type NormalizedTracking } from "./tracking/types";
import { generatePersonalRef } from "./lib/refGenerator";
import { detectRiskFactors, readIntelCache } from "./intel";
import { runIntelRefresh } from "./intel/scraper";
import { isLlmConfigured, clearLlmCache } from "./intel/llmOracle";
import { aisStream } from "./tracking/vessels/aisstream";
import { refreshAllPredictions, computePredictionAccuracy, recomputePredictionForShipment } from "./intel/predictor";
import { voyageObserver } from "./intel/voyageObserver";

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
      if (!parsed.personal_ref || !parsed.personal_ref.trim()) {
        parsed.personal_ref = generatePersonalRef();
      }
      const created = await storage.createShipment(parsed);
      aisStream.scheduleReload();
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // Auto-detect risk factors from intel cache (used by the form)
  app.post("/api/risk/detect", async (req, res, next) => {
    try {
      const { mode, origin, destination, etd, eta, carrierScac } = req.body ?? {};
      const detected = await detectRiskFactors({ mode, origin, destination, etd, eta, carrierScac });
      res.json(detected);
    } catch (err) {
      next(err);
    }
  });

  // Intel cache inspection + manual refresh trigger
  app.get("/api/intel", async (_req, res, next) => {
    try {
      res.json(await readIntelCache());
    } catch (err) {
      next(err);
    }
  });
  app.post("/api/intel/refresh", async (_req, res, next) => {
    try {
      const result = await runIntelRefresh();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Voyage observer (global learning sensor)
  app.get("/api/voyage-observer", (_req, res) => {
    res.json(voyageObserver.getStats());
  });

  // Predictions admin
  app.post("/api/predictions/refresh", async (_req, res, next) => {
    try {
      res.json(await refreshAllPredictions());
    } catch (err) {
      next(err);
    }
  });
  app.post("/api/shipments/:id/predict", async (req, res, next) => {
    try {
      const r = await recomputePredictionForShipment(req.params.id, true);
      if (!r) return res.status(404).json({ message: "Not found or not active" });
      res.json(r);
    } catch (err) {
      next(err);
    }
  });
  app.get("/api/predictions/accuracy", async (_req, res, next) => {
    try {
      res.json(await computePredictionAccuracy());
    } catch (err) {
      next(err);
    }
  });

  // Vessel positions (AISStream)
  app.get("/api/vessels", (_req, res) => {
    res.json({
      configured: aisStream.isConfigured(),
      positions: aisStream.getAll(),
    });
  });
  app.get("/api/vessels/:mmsi", (req, res) => {
    const pos = aisStream.getPosition(req.params.mmsi);
    if (!pos) return res.status(404).json({ message: "No known position for this MMSI" });
    res.json(pos);
  });

  // LLM oracle admin: status + cache wipe
  app.get("/api/intel/llm", (_req, res) => {
    res.json({ configured: isLlmConfigured(), model: "claude-haiku-4-5" });
  });
  app.post("/api/intel/llm/clear", async (_req, res, next) => {
    try {
      const n = await clearLlmCache();
      res.json({ cleared: n });
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
      aisStream.scheduleReload();
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
      aisStream.scheduleReload();
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
