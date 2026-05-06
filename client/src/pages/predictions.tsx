import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Shipment, LaneBookmark } from "@shared/schema";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sparkles,
  Upload,
  FileText,
  X,
  Loader2,
  Globe,
  Plane,
  Star,
  StarOff,
  Trash2,
  Plus,
  TrendingUp,
  AlertTriangle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface VoyageStats {
  enabled: boolean;
  vesselsTracked: number;
  lanesLearned: number;
  observationsTotal: number;
  topLanes: Array<{ origin: string; destination: string; count: number; meanDays: number }>;
}
interface FlightStats {
  enabled: boolean;
  hubsPolled: number;
  routesLearned: number;
  observationsTotal: number;
  topRoutes: Array<{ origin: string; destination: string; count: number; meanHours: number }>;
  lastTickAt: string | null;
  lastTickResult: { flightsSeen: number; observations: number; hubsOk: number; hubsErr: number } | null;
  lastTokenError: string | null;
}

const NORTH_AMERICA_COUNTRIES = new Set(["US", "CA", "MX"]);

function isNorthAmericaCode(code: string): boolean {
  if (!code || code.length < 2) return false;
  return NORTH_AMERICA_COUNTRIES.has(code.slice(0, 2).toUpperCase());
}

function laneTouchesNorthAmerica(origin: string, destination: string): boolean {
  return isNorthAmericaCode(origin) || isNorthAmericaCode(destination);
}

export default function Predictions() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  // ── Data fetches ─────────────────────────────────────────────────────────
  const { data: shipments } = useQuery<Shipment[]>({ queryKey: ["/api/shipments"] });
  const { data: voyage } = useQuery<VoyageStats>({
    queryKey: ["/api/voyage-observer"],
    refetchInterval: 30_000,
  });
  const { data: flight } = useQuery<FlightStats>({
    queryKey: ["/api/flight-observer"],
    refetchInterval: 60_000,
  });
  const { data: bookmarks } = useQuery<LaneBookmark[]>({ queryKey: ["/api/bookmarks"] });
  const { data: extractorStatus } = useQuery<{ configured: boolean }>({
    queryKey: ["/api/shipments/extract/status"],
  });

  // ── File-drop extraction (mirrors shipments-list.tsx) ───────────────────
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const extractMut = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      const r = await fetch(import.meta.env.BASE_URL.replace(/\/$/, "") + "/api/shipments/extract", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text().catch(() => ""))}`);
      return r.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/shipments"] });
      setPendingFiles([]);
      navigate(`/shipments/${data.shipment.id}`);
    },
    onError: (err: any) =>
      toast({ title: "Extraction failed", description: String(err?.message || err), variant: "destructive" }),
  });

  function addFiles(list: FileList | File[]) {
    const arr = Array.from(list).filter((f) => f.size > 0 && f.size <= 20 * 1024 * 1024);
    if (arr.length === 0) return;
    setPendingFiles((prev) => [...prev, ...arr].slice(0, 8));
  }

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
        toast({ title: `Captured ${files.length} pasted file(s)`, description: "Click Extract to process." });
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [toast]);

  // ── Bookmark mutations ──────────────────────────────────────────────────
  const addBookmarkMut = useMutation({
    mutationFn: async (vars: { origin: string; destination: string; mode: "ocean" | "air"; label?: string }) => {
      const r = await apiRequest("POST", "/api/bookmarks", vars);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/bookmarks"] });
      toast({ title: "Lane bookmarked" });
    },
    onError: (err: any) => toast({ title: "Bookmark failed", description: String(err?.message ?? err), variant: "destructive" }),
  });

  const removeBookmarkMut = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/bookmarks/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/bookmarks"] }),
  });

  // ── Filter toggles ──────────────────────────────────────────────────────
  const [naOnly, setNaOnly] = useState(true); // USA/Canada filter on by default

  const visibleVoyageLanes = useMemo(() => {
    const all = voyage?.topLanes ?? [];
    return naOnly ? all.filter((l) => laneTouchesNorthAmerica(l.origin, l.destination)) : all;
  }, [voyage?.topLanes, naOnly]);

  const visibleFlightRoutes = useMemo(() => {
    const all = flight?.topRoutes ?? [];
    return naOnly ? all.filter((r) => laneTouchesNorthAmerica(r.origin, r.destination)) : all;
  }, [flight?.topRoutes, naOnly]);

  // ── Per-bookmark aggregated ETA stats from delivered shipments ──────────
  const bookmarkStats = useMemo(() => {
    const map = new Map<
      string,
      { delivered: number; meanDelayDays: number | null; pctOnTime: number | null }
    >();
    if (!shipments || !bookmarks) return map;

    for (const bm of bookmarks) {
      const matching = shipments.filter(
        (s) =>
          (s.origin ?? "").trim().toUpperCase() === bm.origin &&
          (s.destination ?? "").trim().toUpperCase() === bm.destination &&
          s.mode === bm.mode &&
          s.status === "delivered" &&
          s.actual_arrival &&
          s.eta,
      );
      if (matching.length === 0) {
        map.set(bm.id, { delivered: 0, meanDelayDays: null, pctOnTime: null });
        continue;
      }
      let sum = 0;
      let onTime = 0;
      for (const s of matching) {
        const claimed = new Date(s.eta as any).getTime();
        const actual = new Date(s.actual_arrival as any).getTime();
        const delayDays = (actual - claimed) / 86400_000;
        sum += delayDays;
        if (delayDays <= 0.5) onTime += 1;
      }
      map.set(bm.id, {
        delivered: matching.length,
        meanDelayDays: Number((sum / matching.length).toFixed(1)),
        pctOnTime: Number(((onTime / matching.length) * 100).toFixed(0)),
      });
    }
    return map;
  }, [shipments, bookmarks]);

  // ── Most-delayed lanes from user's delivered shipments ──────────────────
  const userDelayedLanes = useMemo(() => {
    if (!shipments) return [];
    const buckets = new Map<
      string,
      { origin: string; destination: string; mode: string; count: number; sumDelay: number }
    >();
    for (const s of shipments) {
      if (s.status !== "delivered" || !s.actual_arrival || !s.eta) continue;
      const o = (s.origin ?? "").trim().toUpperCase();
      const d = (s.destination ?? "").trim().toUpperCase();
      if (!o || !d) continue;
      const k = `${o}|${d}|${s.mode}`;
      const cur = buckets.get(k) ?? { origin: o, destination: d, mode: s.mode, count: 0, sumDelay: 0 };
      const delayDays = (new Date(s.actual_arrival as any).getTime() - new Date(s.eta as any).getTime()) / 86400_000;
      cur.count += 1;
      cur.sumDelay += delayDays;
      buckets.set(k, cur);
    }
    return Array.from(buckets.values())
      .map((l) => ({ ...l, meanDelayDays: Number((l.sumDelay / l.count).toFixed(1)) }))
      .filter((l) => l.count >= 1)
      .sort((a, b) => b.meanDelayDays - a.meanDelayDays)
      .slice(0, 10);
  }, [shipments]);

  const isBookmarked = (origin: string, destination: string, mode: string): LaneBookmark | undefined =>
    bookmarks?.find(
      (b) =>
        b.origin === origin.toUpperCase() && b.destination === destination.toUpperCase() && b.mode === mode,
    );

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Predictions</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Drop a booking briefing to start tracking. See most-delayed lanes + bookmark routes you ship.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={naOnly}
            onChange={(e) => setNaOnly(e.target.checked)}
            className="accent-primary"
            data-testid="filter-north-america"
          />
          USA / Canada only
        </label>
      </div>

      {/* Hero file drop */}
      <Card
        className={`border-primary/20 ${
          (shipments?.length ?? 0) === 0 ? "bg-gradient-to-br from-primary/5 via-card to-card" : ""
        }`}
      >
        <CardContent className="p-5">
          <div className="flex items-start gap-2 mb-3">
            <Sparkles className="w-5 h-5 text-primary mt-0.5" />
            <div>
              <p className="text-base font-semibold">Drop a booking briefing → we extract everything</p>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
                Booking confirmation, BOL/AWB, packing list, email, or pasted screenshot. Claude pulls origin,
                destination, ETD/ETA, carrier, container/AWB, weight, commodity. We compute risk and recommend
                the optimal insurance trigger.
                {extractorStatus && !extractorStatus.configured && (
                  <span className="text-amber-400 block mt-1">
                    ⚠ Anthropic API key not set — open <strong>API keys & secrets</strong> in the footer to enable extraction.
                  </span>
                )}
              </p>
            </div>
          </div>
          <div
            onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg text-center cursor-pointer transition-all py-8 px-4 ${
              dragActive
                ? "border-primary bg-primary/10"
                : "border-border hover:border-primary/50 hover:bg-accent/30"
            }`}
            data-testid="drop-zone"
          >
            <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm font-medium">
              <strong>Drop files</strong>, click to browse, or press{" "}
              <kbd className="px-1.5 py-0.5 text-[10px] bg-muted rounded border border-border">Ctrl+V</kbd>{" "}
              to paste a screenshot
            </p>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              PDF · PNG · JPG · WEBP · EML · MSG · HTML · TXT — multiple files describe one shipment
            </p>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              accept="application/pdf,image/png,image/jpeg,image/webp,image/gif,message/rfc822,application/vnd.ms-outlook,text/html,text/plain"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          {pendingFiles.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <ul className="space-y-1">
                {pendingFiles.map((f, i) => (
                  <li key={i} className="flex items-center justify-between text-xs bg-muted/40 border border-border rounded px-2 py-1">
                    <span className="flex items-center gap-2">
                      <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="font-mono">{f.name}</span>
                      <span className="text-muted-foreground">({Math.round(f.size / 1024)} KB)</span>
                    </span>
                    <button
                      onClick={() => setPendingFiles((p) => p.filter((_, idx) => idx !== i))}
                      className="text-muted-foreground hover:text-red-400"
                    >
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
                >
                  {extractMut.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Extract & create shipment
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPendingFiles([])}>
                  Clear
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bookmarked lanes */}
      <BookmarkedLanesCard
        bookmarks={bookmarks ?? []}
        stats={bookmarkStats}
        onAdd={(o, d, m) => addBookmarkMut.mutate({ origin: o, destination: d, mode: m })}
        onRemove={(id) => removeBookmarkMut.mutate(id)}
      />

      {/* Most-delayed lanes from user's delivered shipments */}
      {userDelayedLanes.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5" />
              <div>
                <p className="text-sm font-semibold">Your most-delayed lanes</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Average <strong>Actual − Claimed ETA</strong> across your delivered shipments. Higher = chronically late.
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left py-1.5 font-medium">Lane</th>
                    <th className="text-left font-medium">Mode</th>
                    <th className="text-right font-medium">Delivered</th>
                    <th className="text-right font-medium">Avg delay (Actual − Claimed)</th>
                    <th className="text-right font-medium pr-2">Bookmark</th>
                  </tr>
                </thead>
                <tbody>
                  {userDelayedLanes.map((l) => {
                    const bm = isBookmarked(l.origin, l.destination, l.mode);
                    return (
                      <tr key={`${l.origin}|${l.destination}|${l.mode}`} className="border-b border-border/40">
                        <td className="py-1.5 font-mono">{l.origin} → {l.destination}</td>
                        <td className="capitalize text-muted-foreground">{l.mode}</td>
                        <td className="text-right tabular-nums">{l.count}</td>
                        <td className={`text-right tabular-nums font-semibold ${
                          l.meanDelayDays > 3 ? "text-red-400" : l.meanDelayDays > 0.5 ? "text-amber-400" : "text-emerald-400"
                        }`}>
                          {l.meanDelayDays > 0 ? "+" : ""}{l.meanDelayDays}d
                        </td>
                        <td className="text-right pr-2">
                          {bm ? (
                            <Button size="sm" variant="ghost" onClick={() => removeBookmarkMut.mutate(bm.id)} title="Remove bookmark" className="h-7 px-2">
                              <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => addBookmarkMut.mutate({ origin: l.origin, destination: l.destination, mode: l.mode as "ocean" | "air" })} title="Bookmark this lane" className="h-7 px-2">
                              <StarOff className="w-3.5 h-3.5 text-muted-foreground" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Voyage observer + Flight observer cards */}
      <ObserverCard
        title="Global Voyage Observer"
        icon={Globe}
        enabled={voyage?.enabled ?? false}
        line1={`Vessels: ${(voyage?.vesselsTracked ?? 0).toLocaleString()} · Lanes: ${voyage?.lanesLearned ?? 0} · Voyages: ${voyage?.observationsTotal ?? 0}`}
        topItems={visibleVoyageLanes.map((l) => ({
          key: `${l.origin}|${l.destination}`,
          origin: l.origin,
          destination: l.destination,
          mode: "ocean" as const,
          count: l.count,
          metricLabel: `${l.meanDays}d`,
          metricTooltip: (
            <>
              <p className="font-semibold">{l.origin} → {l.destination}</p>
              <p>Average observed transit: <strong>{l.meanDays} days</strong></p>
              <p>Sample size: <strong>{l.count}</strong> completed voyages observed via global AIS</p>
              <p className="text-muted-foreground/80 pt-1 border-t border-border/50">
                Used to calibrate Predicted ETA on this lane.
              </p>
            </>
          ),
        }))}
        bookmarks={bookmarks ?? []}
        onAddBookmark={(o, d) => addBookmarkMut.mutate({ origin: o, destination: d, mode: "ocean" })}
        onRemoveBookmark={(id) => removeBookmarkMut.mutate(id)}
        emptyHint={
          naOnly && (voyage?.topLanes?.length ?? 0) > 0 && visibleVoyageLanes.length === 0
            ? "No USA/Canada lanes observed yet — uncheck the filter to see global lanes."
            : null
        }
      />

      <ObserverCard
        title="Global Flight Observer"
        icon={Plane}
        enabled={flight?.enabled ?? false}
        line1={`Hubs: ${flight?.hubsPolled ?? 0} · Routes: ${flight?.routesLearned ?? 0} · Flights: ${flight?.observationsTotal ?? 0}`}
        diagnostic={
          flight && flight.enabled && flight.observationsTotal === 0
            ? flight.lastTokenError
              ? `OpenSky auth: ${flight.lastTokenError}`
              : flight.lastTickAt == null
              ? "First poll runs ~2 min after server boot — check back shortly."
              : `Last poll ${new Date(flight.lastTickAt).toLocaleTimeString()} — ${flight.lastTickResult?.flightsSeen ?? 0} flights seen, ${flight.lastTickResult?.observations ?? 0} hub-to-hub matches.`
            : !flight?.enabled
            ? "Set OPENSKY_CLIENT_ID + OPENSKY_CLIENT_SECRET in API keys & secrets (footer) to enable flight learning."
            : null
        }
        topItems={visibleFlightRoutes.map((r) => ({
          key: `${r.origin}|${r.destination}`,
          origin: r.origin,
          destination: r.destination,
          mode: "air" as const,
          count: r.count,
          metricLabel: `${r.meanHours}h`,
          metricTooltip: (
            <>
              <p className="font-semibold">{r.origin} → {r.destination}</p>
              <p>Average observed flight time: <strong>{r.meanHours} hours</strong></p>
              <p>Sample size: <strong>{r.count}</strong> completed flights via OpenSky</p>
              <p className="text-muted-foreground/80 pt-1 border-t border-border/50">
                Used to calibrate Predicted ETA for the same hub pair.
              </p>
            </>
          ),
        }))}
        bookmarks={bookmarks ?? []}
        onAddBookmark={(o, d) => addBookmarkMut.mutate({ origin: o, destination: d, mode: "air" })}
        onRemoveBookmark={(id) => removeBookmarkMut.mutate(id)}
        emptyHint={null}
      />
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

interface ObserverItem {
  key: string;
  origin: string;
  destination: string;
  mode: "ocean" | "air";
  count: number;
  metricLabel: string;
  metricTooltip: React.ReactNode;
}

function ObserverCard({
  title,
  icon: Icon,
  enabled,
  line1,
  diagnostic,
  topItems,
  bookmarks,
  onAddBookmark,
  onRemoveBookmark,
  emptyHint,
}: {
  title: string;
  icon: typeof Globe;
  enabled: boolean;
  line1: string;
  diagnostic?: string | null;
  topItems: ObserverItem[];
  bookmarks: LaneBookmark[];
  onAddBookmark: (origin: string, destination: string) => void;
  onRemoveBookmark: (id: string) => void;
  emptyHint: string | null;
}) {
  return (
    <Card className="border-l-4 border-primary/40">
      <CardContent className="p-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-md bg-primary/15">
              <Icon className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold">
                {title}{" "}
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
                    enabled
                      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                      : "bg-zinc-500/20 text-zinc-400 border-zinc-500/40"
                  }`}
                >
                  {enabled ? "on" : "off"}
                </span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{line1}</p>
              {diagnostic && <p className="text-[11px] text-amber-400 mt-1">{diagnostic}</p>}
            </div>
          </div>
          {topItems.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 max-w-[640px]">
              {topItems.slice(0, 8).map((item) => {
                const bm = bookmarks.find(
                  (b) => b.origin === item.origin && b.destination === item.destination && b.mode === item.mode,
                );
                return (
                  <Tooltip key={item.key}>
                    <TooltipTrigger asChild>
                      <span
                        className={`inline-flex items-center gap-1 text-[10px] border rounded px-1.5 py-0.5 font-mono cursor-pointer transition ${
                          bm
                            ? "bg-amber-500/10 border-amber-500/40 text-amber-300"
                            : "bg-muted/50 border-border hover:bg-muted"
                        }`}
                        onClick={() =>
                          bm ? onRemoveBookmark(bm.id) : onAddBookmark(item.origin, item.destination)
                        }
                      >
                        {bm ? (
                          <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                        ) : (
                          <StarOff className="w-3 h-3 opacity-50" />
                        )}
                        {item.origin}→{item.destination}: {item.metricLabel} ({item.count})
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs text-xs leading-relaxed">
                      <div className="space-y-1">
                        {item.metricTooltip}
                        <p className="text-muted-foreground/80 italic">Click to {bm ? "un-" : ""}bookmark.</p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ) : emptyHint ? (
            <p className="text-[11px] text-muted-foreground/70 italic max-w-xs">{emptyHint}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function BookmarkedLanesCard({
  bookmarks,
  stats,
  onAdd,
  onRemove,
}: {
  bookmarks: LaneBookmark[];
  stats: Map<string, { delivered: number; meanDelayDays: number | null; pctOnTime: number | null }>;
  onAdd: (origin: string, destination: string, mode: "ocean" | "air") => void;
  onRemove: (id: string) => void;
}) {
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [mode, setMode] = useState<"ocean" | "air">("ocean");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!origin.trim() || !destination.trim()) return;
    onAdd(origin.trim(), destination.trim(), mode);
    setOrigin("");
    setDestination("");
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-start gap-2">
            <Star className="w-4 h-4 text-amber-400 mt-0.5" />
            <div>
              <p className="text-sm font-semibold">Tracked lanes</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Bookmark routes you ship often. Stats below = your delivered shipments on this lane,
                showing <strong>Claimed vs Actual ETA</strong> drift.
              </p>
            </div>
          </div>
          <form onSubmit={submit} className="flex items-center gap-1.5 text-xs">
            <Input
              placeholder="Origin (e.g. CNSHA, JFK)"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              className="h-8 w-40 text-xs"
              data-testid="bookmark-origin"
            />
            <span className="text-muted-foreground">→</span>
            <Input
              placeholder="Destination"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              className="h-8 w-40 text-xs"
              data-testid="bookmark-destination"
            />
            <Select value={mode} onValueChange={(v) => setMode(v as "ocean" | "air")}>
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ocean">Ocean</SelectItem>
                <SelectItem value="air">Air</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" size="sm" className="h-8" disabled={!origin.trim() || !destination.trim()}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add
            </Button>
          </form>
        </div>

        {bookmarks.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No tracked lanes yet — add one above, or click the star on any lane below to track it.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left py-1.5 font-medium">Lane</th>
                  <th className="text-left font-medium">Mode</th>
                  <th className="text-right font-medium">Delivered</th>
                  <th className="text-right font-medium">On-time %</th>
                  <th className="text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      Actual − Claimed
                      <Tooltip>
                        <TooltipTrigger asChild><TrendingUp className="w-3 h-3 text-muted-foreground cursor-help" /></TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs">
                          Average drift between Claimed ETA (the carrier's published ETA) and Actual ETA across your delivered shipments on this lane. Positive = late; negative = early.
                        </TooltipContent>
                      </Tooltip>
                    </span>
                  </th>
                  <th className="text-right font-medium pr-2"></th>
                </tr>
              </thead>
              <tbody>
                {bookmarks.map((b) => {
                  const s = stats.get(b.id);
                  return (
                    <tr key={b.id} className="border-b border-border/40">
                      <td className="py-1.5">
                        <span className="font-mono">{b.origin} → {b.destination}</span>
                        {b.label && b.label !== `${b.origin} → ${b.destination}` && (
                          <span className="ml-2 text-muted-foreground italic">({b.label})</span>
                        )}
                      </td>
                      <td className="capitalize text-muted-foreground">{b.mode}</td>
                      <td className="text-right tabular-nums">{s?.delivered ?? 0}</td>
                      <td className="text-right tabular-nums">{s?.pctOnTime != null ? `${s.pctOnTime}%` : "—"}</td>
                      <td className={`text-right tabular-nums font-semibold ${
                        s?.meanDelayDays == null ? "text-muted-foreground" :
                        s.meanDelayDays > 3 ? "text-red-400" :
                        s.meanDelayDays > 0.5 ? "text-amber-400" : "text-emerald-400"
                      }`}>
                        {s?.meanDelayDays != null ? `${s.meanDelayDays > 0 ? "+" : ""}${s.meanDelayDays}d` : "—"}
                      </td>
                      <td className="text-right pr-2">
                        <Button size="sm" variant="ghost" onClick={() => onRemove(b.id)} className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
