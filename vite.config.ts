import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// BASE_PATH lets us serve the app under a URL prefix like /delaypredict/.
// Set via env at build time, e.g. BASE_PATH=/delaypredict/ npm run build
//
// Quirk: Git Bash on Windows (MSYS) silently converts Unix-style values like
// "/delaypredict" into Windows paths like "C:/Program Files/Git/delaypredict"
// when they're passed through child processes. We undo that here.
function sanitizeBase(raw: string): string {
  if (!raw || raw === "/") return "/";
  // If it looks like a Windows path (e.g. C:/Program Files/Git/foo), recover
  // just the last path segment as the intended URL prefix.
  const winMatch = raw.match(/^[A-Za-z]:[\\/]/);
  if (winMatch) {
    const segs = raw.split(/[\\/]+/).filter(Boolean);
    raw = "/" + (segs[segs.length - 1] || "");
  }
  if (!raw.startsWith("/")) raw = "/" + raw;
  if (!raw.endsWith("/")) raw = raw + "/";
  return raw;
}
const BASE = sanitizeBase(process.env.BASE_PATH || "/");

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
