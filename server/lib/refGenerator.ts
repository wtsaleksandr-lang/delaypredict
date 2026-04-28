/**
 * Personal-reference generator.
 *
 *   Mode "sequential" (default) — DP-0001, DP-0002, ... — readable, sortable,
 *   matches the freight-copilot S00001 style.
 *
 *   Mode "datestamp" — DP-20260424-A7K9 — the original generator. Useful when
 *   you don't want a single-counter file (e.g. multiple replicas).
 *
 * Selected via env var REF_STYLE=sequential|datestamp; defaults to sequential.
 */

import { promises as fs } from "fs";
import path from "path";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

const COUNTER_FILE = path.resolve(process.cwd(), "data", "ref-counter.json");
let cachedCounter: number | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function nextSequential(): Promise<number> {
  if (cachedCounter == null) {
    try {
      const raw = await fs.readFile(COUNTER_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      cachedCounter = typeof parsed.next === "number" ? parsed.next : 1;
    } catch {
      cachedCounter = 1;
    }
  }
  const next = cachedCounter as number;
  cachedCounter = next + 1;
  // Persist (chained, fire-and-forget — we never block on this)
  const toWrite = cachedCounter;
  writeChain = writeChain
    .then(async () => {
      await fs.mkdir(path.dirname(COUNTER_FILE), { recursive: true });
      await fs.writeFile(COUNTER_FILE, JSON.stringify({ next: toWrite }), "utf-8");
    })
    .catch((err) => console.warn("[refGenerator] persist failed:", err));
  return next;
}

function datestamp(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `DP-${yyyy}${mm}${dd}-${suffix}`;
}

export async function generatePersonalRef(d: Date = new Date()): Promise<string> {
  const mode = (process.env.REF_STYLE || "sequential").toLowerCase();
  if (mode === "datestamp") return datestamp(d);
  const n = await nextSequential();
  return `DP-${String(n).padStart(4, "0")}`;
}
