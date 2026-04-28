import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import type { Shipment } from "@shared/schema";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Plus, Ship, Plane, Package, TrendingUp, TrendingDown,
  AlertTriangle, Target, Globe, Search, X, RotateCcw, Loader2,
  Upload, Sparkles, FileText,
} from "lucide-react";
import { fmtUSD, fmt, riskBand } from "@/lib/calculations";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Helpers ──────────────────────────────────────────────────────────────────
function n(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const x = parseFloat(v);
  return isNaN(x) ? 0 : x;
}
function dateOnly(v: any): string {
  if (!v) return "";
  return String(v).slice(0, 10);
}
function fmtMoney(value: number | null | undefined): string {
  if (value == null) return "";
  if (!Number.isFinite(value)) return "";
  return fmtUSD(value);
}

// Status visual config — colored dot + label, freight-copilot style
const STATUS_OPTIONS: Array<{ value: string; label: string; dot: string; text: string }> = [
  { value: "planned", label: "Planned", dot: "bg-slate-400", text: "text-slate-300" },
  { value: "in_transit", label: "In transit", dot: "bg-blue-500", text: "text-blue-300" },
  { value: "delayed", label: "Delayed", dot: "bg-red-500", text: "text-red-300" },
  { value: "delivered", label: "Delivered", dot: "bg-emerald-500", text: "text-emerald-300" },
  { value: "cancelled", label: "Cancelled", dot: "bg-zinc-500", text: "text-zinc-400" },
];

// ── Column config ────────────────────────────────────────────────────────────
type CellKind = "text" | "money" | "date" | "status" | "mode" | "ref" | "risk" | "delay" | "profit" | "notes" | "insurance";

interface ColDef {
  key: string;
  label: string;
  kind: CellKind;
  editable?: boolean;
  filter?: "text" | "select";
  filterOptions?: string[];
  sticky?: boolean;
  className?: string;
}

const COLUMNS: ColDef[] = [
  { key: "status", label: "Status", kind: "status", editable: true, filter: "select", filterOptions: STATUS_OPTIONS.map((s) => s.value), sticky: true },
  { key: "personal_ref", label: "Ref", kind: "ref", filter: "text", sticky: true },
  { key: "created_at", label: "Created", kind: "date" },
  { key: "mode", label: "Mode", kind: "mode", filter: "select", filterOptions: ["ocean", "air"] },
  { key: "container_number", label: "Container", kind: "text", editable: true, filter: "text" },
  { key: "awb_number", label: "AWB", kind: "text", editable: true, filter: "text" },
  { key: "origin", label: "Origin", kind: "text", editable: true, filter: "text" },
  { key: "destination", label: "Destination", kind: "text", editable: true, filter: "text" },
  { key: "etd", label: "ETD", kind: "date", editable: true },
  { key: "eta", label: "ETA", kind: "date", editable: true },
  { key: "predicted_arrival", label: "Predicted", kind: "date" },
  { key: "actual_arrival", label: "Actual", kind: "date" },
  { key: "risk_score", label: "Risk", kind: "risk", filter: "text" },
  { key: "predicted_delay_days", label: "Pred. Delay", kind: "delay" },
  { key: "actual_delay_days", label: "Actual Delay", kind: "delay" },
  { key: "insurance_recommendation", label: "Insurance", kind: "insurance", filter: "select", filterOptions: ["INSURE", "OPTIONAL", "SKIP"] },
  { key: "carrier_scac", label: "Carrier", kind: "text", editable: true, filter: "text" },
  { key: "vessel_name", label: "Vessel/Flight", kind: "text", editable: true, filter: "text" },
  { key: "cost", label: "Cost", kind: "money", editable: true },
  { key: "sale_price", label: "Sale", kind: "money", editable: true },
  { key: "profit", label: "Net P&L", kind: "profit" },
  { key: "notes", label: "Notes", kind: "notes", editable: true, filter: "text" },
];

// Cell value extractor (handles computed cells like "profit" and "insurance")
function rawCellValue(s: Shipment, col: ColDef): any {
  if (col.key === "profit") {
    const cost = n(s.cost);
    const sale = n(s.sale_price);
    const premium = n(s.insurance_premium);
    return premium > 0 ? sale - cost - premium : sale - cost;
  }
  if (col.key === "insurance_recommendation") {
    return s.recommendation || "";
  }
  return (s as any)[col.key];
}

function bestTriggerPremium(s: Shipment): number | null {
  const r = s.result_json as any;
  if (!r?.best?.premium) return null;
  return Number(r.best.premium);
}
function bestTriggerLabel(s: Shipment): string {
  const r = s.result_json as any;
  if (!r?.best) return "";
  const unit = r.triggerUnit === "hour" ? "h" : "d";
  return `${r.best.trigger}${unit}`;
}

// String value used for filtering/searching
function filterValueFor(s: Shipment, col: ColDef): string {
  const v = rawCellValue(s, col);
  if (v == null) return "";
  if (col.kind === "date") return dateOnly(v);
  return String(v);
}

// ── Drag-to-pan hook ─────────────────────────────────────────────────────────
function useDragToPan(ref: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let isDown = false;
    let startX = 0;
    let scrollLeft = 0;
    const md = (e: MouseEvent) => {
      // Don't grab on interactive elements
      const t = e.target as HTMLElement;
      if (t.closest("button, a, input, select, textarea, [data-no-drag]")) return;
      isDown = true;
      el.classList.add("is-dragging");
      startX = e.pageX - el.offsetLeft;
      scrollLeft = el.scrollLeft;
    };
    const mu = () => {
      isDown = false;
      el.classList.remove("is-dragging");
    };
    const mm = (e: MouseEvent) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - el.offsetLeft;
      el.scrollLeft = scrollLeft - (x - startX);
    };
    el.addEventListener("mousedown", md);
    window.addEventListener("mouseup", mu);
    el.addEventListener("mousemove", mm);
    el.addEventListener("mouseleave", mu);
    return () => {
      el.removeEventListener("mousedown", md);
      window.removeEventListener("mouseup", mu);
      el.removeEventListener("mousemove", mm);
      el.removeEventListener("mouseleave", mu);
    };
  }, [ref]);
}

// ── Status dot ───────────────────────────────────────────────────────────────
function StatusDot({ status, onChange }: { status: string; onChange?: (v: string) => void }) {
  const cfg = STATUS_OPTIONS.find((s) => s.value === status) || STATUS_OPTIONS[0];
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative inline-flex" data-no-drag>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (onChange) setOpen(true);
            }}
            className={`w-3 h-3 rounded-full ${cfg.dot} ring-2 ring-transparent hover:ring-foreground/20 transition`}
            aria-label={cfg.label}
          />
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">{cfg.label} (double-click to change)</TooltipContent>
      </Tooltip>
      {open && (
        <div ref={popRef} className="absolute top-5 left-0 z-50 bg-popover border border-border rounded-md shadow-lg p-1 min-w-[140px]">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange?.(s.value);
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 text-xs px-2 py-1 rounded hover:bg-accent text-left"
            >
              <span className={`w-2.5 h-2.5 rounded-full ${s.dot}`} />
              <span className={s.text}>{s.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Inline editable cell ─────────────────────────────────────────────────────
function EditableCell({
  value, onSave, type = "text", className = "",
}: { value: any; onSave: (v: any) => void; type?: "text" | "number" | "date"; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value == null ? "" : String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value == null ? "" : String(value));
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit() {
    const trimmed = draft.trim();
    const cur = value == null ? "" : String(value);
    if (trimmed !== cur) {
      if (type === "number") {
        const n = trimmed === "" ? null : parseFloat(trimmed);
        onSave(n != null && Number.isFinite(n) ? n : null);
      } else if (type === "date") {
        onSave(trimmed || null);
      } else {
        onSave(trimmed || null);
      }
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={type}
        value={type === "date" ? draft.slice(0, 10) : draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          else if (e.key === "Escape") { setDraft(value == null ? "" : String(value)); setEditing(false); }
        }}
        onClick={(e) => e.stopPropagation()}
        data-no-drag
        className={`w-full bg-background border border-primary rounded px-1 py-0.5 text-xs outline-none ${className}`}
      />
    );
  }
  return (
    <span
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
      className={`block truncate cursor-text ${className}`}
      title="Double-click to edit"
    >
      {value == null || value === "" ? <span className="text-muted-foreground/40">—</span> : String(value)}
    </span>
  );
}

// ── Cell renderer ────────────────────────────────────────────────────────────
function Cell({
  shipment, col, onEdit, onOpenNotes,
}: {
  shipment: Shipment;
  col: ColDef;
  onEdit: (key: string, value: any) => void;
  onOpenNotes: (s: Shipment) => void;
}) {
  const v = rawCellValue(shipment, col);

  switch (col.kind) {
    case "status":
      return <StatusDot status={shipment.status} onChange={(nv) => onEdit("status", nv)} />;

    case "ref":
      return <span className="font-mono text-xs font-bold text-foreground truncate">{shipment.personal_ref || "—"}</span>;

    case "mode": {
      const Icon = shipment.mode === "air" ? Plane : Ship;
      return <Icon className="w-3.5 h-3.5 text-muted-foreground" />;
    }

    case "date": {
      const d = dateOnly(v);
      if (col.editable) return <EditableCell value={d} type="date" onSave={(nv) => onEdit(col.key, nv)} />;
      return d ? <span className="text-xs tabular-nums">{d}</span> : <span className="text-muted-foreground/40">—</span>;
    }

    case "money": {
      const num = n(v);
      if (col.editable) return <EditableCell value={v == null ? "" : num} type="number" onSave={(nv) => onEdit(col.key, nv)} className="text-right tabular-nums" />;
      return <span className="text-xs tabular-nums text-right block">{fmtMoney(num)}</span>;
    }

    case "profit": {
      const net = n(v);
      const tone = net > 0 ? "text-emerald-500" : net < 0 ? "text-red-400" : "text-muted-foreground";
      return <span className={`text-xs tabular-nums font-bold ${tone}`}>{net !== 0 ? fmtMoney(net) : "—"}</span>;
    }

    case "risk": {
      const score = n(v);
      if (score === 0) return <span className="text-muted-foreground/40">—</span>;
      const band = riskBand(score);
      const tone = band === "high" ? "text-red-400" : band === "moderate" ? "text-amber-500" : "text-emerald-500";
      return <span className={`text-xs tabular-nums font-bold ${tone}`}>{Math.round(score)}</span>;
    }

    case "delay": {
      const d = n(v);
      if (v == null) return <span className="text-muted-foreground/40">—</span>;
      const tone = d > 2 ? "text-red-400" : d > 0 ? "text-amber-500" : "text-emerald-500";
      return <span className={`text-xs tabular-nums font-bold ${tone}`}>{d > 0 ? "+" : ""}{fmt(d, 1)}d</span>;
    }

    case "insurance": {
      const rec = (shipment.recommendation as string) || "";
      if (!rec) return <span className="text-muted-foreground/40">—</span>;
      const premium = bestTriggerPremium(shipment);
      const trig = bestTriggerLabel(shipment);
      const tone =
        rec === "INSURE" ? "text-emerald-500 bg-emerald-500/10 border-emerald-500/30" :
        rec === "OPTIONAL" ? "text-amber-500 bg-amber-500/10 border-amber-500/30" :
        "text-muted-foreground bg-muted border-border";
      return (
        <span className="inline-flex items-center gap-1.5 text-[11px]">
          <span className={`font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${tone}`}>{rec}</span>
          {trig && <span className="font-mono text-muted-foreground">{trig}</span>}
          {premium != null && <span className="tabular-nums text-muted-foreground">{fmtUSD(premium)}</span>}
        </span>
      );
    }
    case "notes": {
      const text = (v as string) || "";
      return (
        <span
          onDoubleClick={(e) => { e.stopPropagation(); onOpenNotes(shipment); }}
          className="block truncate cursor-text text-xs text-muted-foreground"
          title="Double-click to edit notes"
        >
          {text || <span className="text-muted-foreground/40">—</span>}
        </span>
      );
    }

    case "text":
    default: {
      const display = v == null ? "" : String(v);
      if (col.editable) return <EditableCell value={display} onSave={(nv) => onEdit(col.key, nv)} />;
      return display ? <span className="text-xs">{display}</span> : <span className="text-muted-foreground/40">—</span>;
    }
  }
}

// ── Notes modal ──────────────────────────────────────────────────────────────
function NotesModal({
  shipment, onClose, onSave,
}: { shipment: Shipment | null; onClose: () => void; onSave: (notes: string) => void }) {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (shipment) setDraft(shipment.notes || "");
  }, [shipment]);
  if (!shipment) return null;
  return (
    <Dialog open={!!shipment} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Notes — {shipment.personal_ref}</DialogTitle>
        </DialogHeader>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Free-form notes about this shipment…"
          className="min-h-[200px] font-mono text-sm"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { onSave(draft); onClose(); }}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function ShipmentsList() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const wrapRef = useRef<HTMLDivElement>(null);
  useDragToPan(wrapRef);

  const { data: shipments, isLoading } = useQuery<Shipment[]>({ queryKey: ["/api/shipments"] });
  const { data: accuracy } = useQuery<{
    overall: { sampleSize: number; maeDays: number | null; bias: number | null };
    byMode: { ocean: any; air: any };
    bySource: Array<{ source: string; sampleSize: number; maeDays: number | null; bias: number | null }>;
  }>({ queryKey: ["/api/predictions/accuracy"] });
  const { data: observer } = useQuery<{
    enabled: boolean; vesselsTracked: number; lanesLearned: number; observationsTotal: number;
    topLanes: Array<{ origin: string; destination: string; count: number; meanDays: number }>;
  }>({ queryKey: ["/api/voyage-observer"], refetchInterval: 30_000 });
  const { data: flightObs } = useQuery<{
    enabled: boolean; hubsPolled: number; routesLearned: number; observationsTotal: number;
    topRoutes: Array<{ origin: string; destination: string; count: number; meanHours: number }>;
  }>({ queryKey: ["/api/flight-observer"], refetchInterval: 60_000 });

  const [globalSearch, setGlobalSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [notesTarget, setNotesTarget] = useState<Shipment | null>(null);

  // ── File-drop extraction state ─────────────────────────────────────────────
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: extractorStatus } = useQuery<{ configured: boolean; model: string }>({
    queryKey: ["/api/shipments/extract/status"],
  });
  const extractMut = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      const r = await fetch(import.meta.env.BASE_URL.replace(/\/$/, "") + "/api/shipments/extract", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`${r.status}: ${text || r.statusText}`);
      }
      return r.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/shipments"] });
      setPendingFiles([]);
      const conf = Math.round((data.extracted?.confidence ?? 0.5) * 100);
      toast({
        title: `Extracted ${data.shipment.personal_ref}`,
        description: `${data.extracted?.origin || "?"} → ${data.extracted?.destination || "?"} (confidence ${conf}%)`,
      });
      navigate(`/shipments/${data.shipment.id}`);
    },
    onError: (err: any) => toast({ title: "Extraction failed", description: String(err?.message || err), variant: "destructive" }),
  });

  // Add files (from drop, click, or paste)
  function addFiles(list: FileList | File[]) {
    const arr = Array.from(list).filter((f) => f.size > 0 && f.size <= 20 * 1024 * 1024);
    if (arr.length === 0) return;
    setPendingFiles((prev) => [...prev, ...arr].slice(0, 8));
  }

  // Listen for paste events anywhere on the page (Ctrl+V from screenshot)
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        addFiles(files);
        toast({ title: `Captured ${files.length} pasted file(s)`, description: "Click Extract & create to process" });
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [toast]);

  // Mutations
  const patchMut = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: any }) => {
      const r = await apiRequest("PATCH", `/api/shipments/${id}`, body);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/shipments"] }),
    onError: (err: any) => toast({ title: "Save failed", description: String(err?.message || err), variant: "destructive" }),
  });
  const blankMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/shipments/blank", { mode: "ocean" });
      return r.json();
    },
    onSuccess: (created: Shipment) => {
      qc.invalidateQueries({ queryKey: ["/api/shipments"] });
      toast({ title: "Blank row added", description: created.personal_ref });
    },
  });
  const deleteMut = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/shipments/${id}`); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/shipments"] }),
  });

  function handleEdit(id: string, key: string, value: any) {
    patchMut.mutate({ id, body: { [key]: value } });
  }

  // Derived
  const filtered = useMemo(() => {
    let rows = shipments ?? [];
    if (globalSearch.trim()) {
      const needle = globalSearch.trim().toLowerCase();
      rows = rows.filter((s) =>
        COLUMNS.some((c) => filterValueFor(s, c).toLowerCase().includes(needle)),
      );
    }
    const activeFilters = Object.entries(filters).filter(([, v]) => v !== "" && v != null);
    if (activeFilters.length > 0) {
      rows = rows.filter((s) => {
        for (const [key, needle] of activeFilters) {
          const col = COLUMNS.find((c) => c.key === key);
          if (!col) continue;
          const haystack = filterValueFor(s, col);
          if (col.filter === "select") {
            if (haystack !== needle) return false;
          } else if (!haystack.toLowerCase().includes(String(needle).toLowerCase())) {
            return false;
          }
        }
        return true;
      });
    }
    return rows;
  }, [shipments, globalSearch, filters]);

  // KPI totals
  const totals = (shipments ?? []).reduce(
    (acc, s) => {
      acc.count += 1;
      acc.cost += n(s.cost);
      acc.sale += n(s.sale_price);
      acc.premium += n(s.insurance_premium);
      const score = n(s.risk_score);
      const band = riskBand(score);
      acc.high += band === "high" ? 1 : 0;
      acc.delayed += s.status === "delayed" ? 1 : 0;
      return acc;
    },
    { count: 0, cost: 0, sale: 0, premium: 0, high: 0, delayed: 0 },
  );
  const grossMargin = totals.sale - totals.cost;
  const hasFilters = globalSearch !== "" || Object.values(filters).some((v) => v !== "" && v != null);

  return (
    <div className="max-w-[1600px] mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Shipments</h1>
          <p className="text-sm text-muted-foreground">All ocean &amp; air freight shipments — click row to open, double-click cell to edit.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => blankMut.mutate()} disabled={blankMut.isPending} data-testid="button-add-blank-row">
            {blankMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />} Add blank row
          </Button>
          <Link href="/shipments/new">
            <Button data-testid="button-new-shipment"><Plus className="w-4 h-4 mr-2" /> New Shipment</Button>
          </Link>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 mb-6">
        <Card><CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Shipments</p>
          <p className="text-xl font-bold tabular-nums">{totals.count}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Gross Margin</p>
          <p className={`text-xl font-bold tabular-nums ${grossMargin >= 0 ? "text-emerald-500" : "text-red-400"}`}>{fmtUSD(grossMargin)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Premium Spent</p>
          <p className="text-xl font-bold tabular-nums">{fmtUSD(totals.premium)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> High Risk
          </p>
          <p className="text-xl font-bold tabular-nums text-red-400">{totals.high}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Delayed Now</p>
          <p className="text-xl font-bold tabular-nums text-amber-500">{totals.delayed}</p>
        </CardContent></Card>
        <Card><CardContent className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <Target className="w-3 h-3" /> Predict MAE
          </p>
          <p className={`text-xl font-bold tabular-nums ${
            accuracy?.overall.maeDays == null ? "text-muted-foreground" :
            accuracy.overall.maeDays < 1 ? "text-emerald-500" :
            accuracy.overall.maeDays < 3 ? "text-amber-500" : "text-red-400"
          }`}>
            {accuracy?.overall.maeDays != null ? `${accuracy.overall.maeDays.toFixed(1)}d` : "—"}
          </p>
          <p className="text-[10px] text-muted-foreground">{accuracy?.overall.sampleSize ?? 0} delivered</p>
        </CardContent></Card>
      </div>

      {/* Voyage observer */}
      {observer && (
        <Card className="mb-4 border-l-4 border-primary/40">
          <CardContent className="p-4">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-md bg-primary/15"><Globe className="w-5 h-5 text-primary" /></div>
                <div>
                  <p className="text-sm font-semibold">Global Voyage Observer{" "}
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${observer.enabled ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-zinc-500/20 text-zinc-400 border-zinc-500/40"}`}>{observer.enabled ? "on" : "off"}</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">Vessels: {observer.vesselsTracked.toLocaleString()} · Lanes: {observer.lanesLearned} · Voyages: {observer.observationsTotal}</p>
                </div>
              </div>
              {observer.topLanes.length > 0 && (
                <div className="flex flex-wrap gap-1.5 max-w-[600px]">
                  {observer.topLanes.slice(0, 5).map((l, i) => (
                    <span key={i} className="text-[10px] bg-muted/50 border border-border rounded px-1.5 py-0.5 font-mono">
                      {l.origin}→{l.destination}: {l.meanDays}d ({l.count})
                    </span>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Flight observer */}
      {flightObs && (
        <Card className="mb-4 border-l-4 border-primary/40">
          <CardContent className="p-4">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-md bg-primary/15"><Plane className="w-5 h-5 text-primary" /></div>
                <div>
                  <p className="text-sm font-semibold">Global Flight Observer{" "}
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${flightObs.enabled ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-zinc-500/20 text-zinc-400 border-zinc-500/40"}`}>{flightObs.enabled ? "on" : "off"}</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">Hubs: {flightObs.hubsPolled} · Routes: {flightObs.routesLearned} · Flights: {flightObs.observationsTotal}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* File-drop briefing extractor */}
      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="flex items-start gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-primary mt-0.5" />
            <div>
              <p className="text-sm font-semibold">Auto-extract from a booking briefing</p>
              <p className="text-xs text-muted-foreground">
                Drop a booking confirmation, BOL, packing list, screenshot, email — Claude reads them and creates a pre-filled shipment.
                {extractorStatus && !extractorStatus.configured && (
                  <span className="text-amber-400 ml-1">⚠ ANTHROPIC_API_KEY not set — extractor disabled.</span>
                )}
              </p>
            </div>
          </div>
          <div
            onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-md py-6 px-4 text-center cursor-pointer transition-colors ${
              dragActive ? "border-primary bg-primary/10" : "border-border hover:border-primary/50 hover:bg-accent/30"
            }`}
            data-testid="drop-zone"
          >
            <Upload className="w-6 h-6 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm font-medium">
              <strong>Drop files</strong>, click to browse, or press <kbd className="px-1.5 py-0.5 text-[10px] bg-muted rounded border border-border">Ctrl+V</kbd> to paste a screenshot
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">
              PDF · PNG · JPG · WEBP · EML · MSG · HTML · TXT — multiple files describe ONE shipment (max 8, 20 MB each)
            </p>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              accept="application/pdf,image/png,image/jpeg,image/webp,image/gif,message/rfc822,application/vnd.ms-outlook,text/html,text/plain,.pdf,.png,.jpg,.jpeg,.webp,.gif,.eml,.msg,.html,.htm,.txt"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = ""; // allow re-selecting the same file
              }}
            />
          </div>
          {pendingFiles.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Pending ({pendingFiles.length})</p>
              <ul className="space-y-1">
                {pendingFiles.map((f, i) => (
                  <li key={i} className="flex items-center justify-between text-xs bg-muted/40 border border-border rounded px-2 py-1">
                    <span className="flex items-center gap-2">
                      <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="font-mono">{f.name}</span>
                      <span className="text-muted-foreground">({Math.round(f.size / 1024)} KB)</span>
                    </span>
                    <button onClick={() => setPendingFiles((p) => p.filter((_, idx) => idx !== i))} className="text-muted-foreground hover:text-red-400">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2 mt-2">
                <Button
                  size="sm"
                  onClick={() => extractMut.mutate(pendingFiles)}
                  disabled={extractMut.isPending || !extractorStatus?.configured}
                  data-testid="button-extract"
                >
                  {extractMut.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
                  Extract &amp; create shipment
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPendingFiles([])}>Clear</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Search + clear filters */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={globalSearch}
            onChange={(e) => setGlobalSearch(e.target.value)}
            placeholder="Search ref / origin / destination / vessel / carrier / notes…"
            className="pl-8"
          />
        </div>
        {hasFilters && (
          <Button variant="outline" size="sm" onClick={() => { setGlobalSearch(""); setFilters({}); }}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Clear filters
          </Button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length}{filtered.length !== (shipments?.length ?? 0) ? ` of ${shipments?.length ?? 0}` : ""} rows
        </span>
      </div>

      <p className="text-[11px] text-muted-foreground mb-2">
        <strong>Tips:</strong> click row to open · double-click cell to edit · double-click <em>Notes</em> for full editor · click status dot to change · drag table to pan
      </p>

      {/* Table */}
      <div ref={wrapRef} className="ship-table-wrap">
        <table className="ship-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} data-sticky={c.sticky ? "true" : undefined}>{c.label}</th>
              ))}
              <th>·</th>
            </tr>
            <tr className="ship-filter-row">
              {COLUMNS.map((c) => (
                <th key={c.key} data-sticky={c.sticky ? "true" : undefined}>
                  {c.filter === "select" ? (
                    <select
                      value={filters[c.key] || ""}
                      onChange={(e) => setFilters((p) => ({ ...p, [c.key]: e.target.value }))}
                      className="filter-input"
                    >
                      <option value="">all</option>
                      {(c.filterOptions || []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : c.filter === "text" ? (
                    <input
                      type="text"
                      value={filters[c.key] || ""}
                      onChange={(e) => setFilters((p) => ({ ...p, [c.key]: e.target.value }))}
                      placeholder="filter"
                      className="filter-input"
                    />
                  ) : null}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={COLUMNS.length + 1} className="text-center text-sm text-muted-foreground py-6">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="text-center text-sm text-muted-foreground py-10">
                  {hasFilters ? "No shipments match the current filters." : (
                    <div>
                      <Package className="w-8 h-8 mx-auto mb-2 text-muted-foreground/60" />
                      <p>No shipments yet.</p>
                      <p className="text-xs mt-1">Click <strong>+ Add blank row</strong> or <strong>New Shipment</strong> to get started.</p>
                    </div>
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((s) => (
                <tr
                  key={s.id}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("[data-no-drag], button, a, input, select, textarea")) return;
                    navigate(`/shipments/${s.id}`);
                  }}
                  className="ship-row"
                  data-testid={`row-shipment-${s.id}`}
                >
                  {COLUMNS.map((c) => (
                    <td key={c.key} data-sticky={c.sticky ? "true" : undefined} className={c.className}>
                      <Cell shipment={s} col={c} onEdit={(k, v) => handleEdit(s.id, k, v)} onOpenNotes={setNotesTarget} />
                    </td>
                  ))}
                  <td className="actions-cell">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); if (confirm(`Delete ${s.personal_ref}?`)) deleteMut.mutate(s.id); }}
                      className="text-muted-foreground hover:text-red-400 px-1"
                      title="Delete"
                      data-no-drag
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <NotesModal
        shipment={notesTarget}
        onClose={() => setNotesTarget(null)}
        onSave={(notes) => {
          if (notesTarget) handleEdit(notesTarget.id, "notes", notes);
        }}
      />
    </div>
  );
}
