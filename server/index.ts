// Load .env on local hosts (Replit/etc inject env directly, but local Node doesn't).
// Must run before any module reads process.env.
import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { startTrackingPoller } from "./jobs/trackingPoller";
import { startIntelScheduler } from "./intel/scraper";
import { aisStream } from "./tracking/vessels/aisstream";
import { startPredictionJobs } from "./jobs/predictionJobs";
import { voyageObserver } from "./intel/voyageObserver";
import { flightObserver } from "./intel/flightObserver";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// ── Path-prefix support (e.g. served under /delaypredict/) ────────────────────
// When BASE_PATH is set, strip it from the URL so the rest of the routes match
// as if served from /. The frontend bundle is built with the same prefix.
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/$/, "");
if (BASE_PATH) {
  app.use((req, _res, next) => {
    if (req.url === BASE_PATH) req.url = "/";
    else if (req.url.startsWith(BASE_PATH + "/")) req.url = req.url.substring(BASE_PATH.length);
    next();
  });
  console.log(`[express] base path: ${BASE_PATH}`);
}

// ── Basic HTTP auth (single shared password) ──────────────────────────────────
// Activated when BASIC_AUTH_USER + BASIC_AUTH_PASS are set. Browser-native popup.
const AUTH_USER = process.env.BASIC_AUTH_USER;
const AUTH_PASS = process.env.BASIC_AUTH_PASS;
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      if (user === AUTH_USER && pass === AUTH_PASS) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="DelayPredict"');
    res.status(401).send("Authentication required");
  });
  console.log(`[express] basic auth enabled for user "${AUTH_USER}"`);
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  // reusePort is a Linux-only socket option; Windows + macOS will throw ENOTSUP.
  const listenOpts: any = { port, host: "0.0.0.0" };
  if (process.platform === "linux") listenOpts.reusePort = true;
  httpServer.listen(listenOpts, () => {
    log(`serving on port ${port}`);
    startTrackingPoller();
    startIntelScheduler();
    aisStream.start().catch((err) => console.error("[aisstream] start failed:", err));
    voyageObserver.start().catch((err) => console.error("[voyageObserver] start failed:", err));
    flightObserver.start().catch((err) => console.error("[flightObserver] start failed:", err));
    startPredictionJobs();
  });
})();
