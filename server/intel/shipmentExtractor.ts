/**
 * LLM-based shipment briefing extractor.
 *
 * Given one or more files (PDFs, images, .eml, .msg, .txt, .html), asks
 * Claude Haiku 4.5 to extract structured shipment fields. The files are
 * treated as describing ONE shipment together (multi-file briefing).
 *
 * Returns a partial Shipment shape — only fields the LLM was confident about.
 * Caller fills in the rest with defaults.
 */

import { promises as fs } from "fs";

const MODEL = "claude-haiku-4-5";
const ENDPOINT = "https://api.anthropic.com/v1/messages";

export interface ExtractedShipment {
  mode?: "ocean" | "air";
  origin?: string;
  destination?: string;
  etd?: string; // YYYY-MM-DD
  eta?: string; // YYYY-MM-DD
  booking_number?: string;
  container_number?: string;
  awb_number?: string;
  flight_number?: string;
  carrier_scac?: string;
  carrier_name?: string;
  vessel_name?: string;
  voyage_number?: string;
  shipper_name?: string;
  receiver_name?: string;
  cargo_description?: string;
  weight_kg?: number;
  volume_cbm?: number;
  containers?: Array<{ number?: string; type?: string; quantity?: number }>;
  notes?: string;
  confidence: number; // 0..1
}

interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

const SYSTEM_PROMPT = `You are a freight-document parser. The user will give you 1+ files describing a single shipment (booking confirmation, packing list, BOL, email screenshot, or similar). Extract the shipment metadata into strict JSON.

Output ONLY a JSON object, no prose:
{
  "mode": "ocean" | "air",
  "origin": "<port or city, free text from doc>",
  "destination": "<port or city>",
  "etd": "YYYY-MM-DD",
  "eta": "YYYY-MM-DD",
  "booking_number": "<carrier booking ref>",
  "container_number": "<11-char ISO container>",
  "awb_number": "<air waybill>",
  "flight_number": "<IATA or ICAO>",
  "carrier_scac": "<4-letter SCAC>",
  "carrier_name": "<full carrier name as written>",
  "vessel_name": "<ship name in CAPS>",
  "voyage_number": "<voyage ref>",
  "shipper_name": "<consignor>",
  "receiver_name": "<consignee>",
  "cargo_description": "<short cargo summary>",
  "weight_kg": <number>,
  "volume_cbm": <number>,
  "containers": [{"number": "...", "type": "20GP|40GP|40HC|...", "quantity": 1}],
  "notes": "<short free-text note about anything unusual>",
  "confidence": 0.0-1.0
}

Rules:
- Omit fields you cannot find. Don't invent values.
- For ocean shipments use UNLOCODE-style port codes if present, else free-text.
- For mode: pick "air" if you see AWB/flight, "ocean" if you see container/vessel/booking, otherwise pick the more likely one based on context.
- Dates must be YYYY-MM-DD. If only a partial date is shown (e.g. "May 15"), assume current or next year and emit the full ISO date.
- Confidence: 1.0 = all fields verified, 0.5 = some inference, 0.2 = mostly guessed.`;

export function isExtractorConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function extractFromFiles(files: UploadedFile[]): Promise<ExtractedShipment> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set — needed for shipment extraction");
  if (files.length === 0) throw new Error("No files provided");

  // Build multimodal user content
  const content: any[] = [];
  for (const f of files) {
    if (isImage(f.mimetype, f.originalname)) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: imageMediaType(f.mimetype, f.originalname),
          data: f.buffer.toString("base64"),
        },
      });
    } else if (isPdf(f.mimetype, f.originalname)) {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: f.buffer.toString("base64"),
        },
      });
    } else {
      // Treat as text — works for .txt, .eml, .html
      const text = f.buffer.toString("utf-8").slice(0, 50_000);
      content.push({ type: "text", text: `--- ${f.originalname} ---\n${text}` });
    }
  }
  content.push({ type: "text", text: "Extract the shipment fields from the file(s) above. Return JSON only." });

  const body = {
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json: any = await res.json();
  const text: string = json?.content?.[0]?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM returned non-JSON: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(match[0]);
  if (!parsed.confidence) parsed.confidence = 0.5;
  return parsed as ExtractedShipment;
}

function isImage(mime: string, name: string): boolean {
  if (mime.startsWith("image/")) return true;
  return /\.(png|jpg|jpeg|webp|gif)$/i.test(name);
}
function isPdf(mime: string, name: string): boolean {
  return mime === "application/pdf" || /\.pdf$/i.test(name);
}
function imageMediaType(mime: string, name: string): string {
  if (mime.startsWith("image/")) return mime;
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}
