import { useEffect, useMemo, useState } from "react";
import {
  Target, Flame, Copy, Trash2, X, Tag, FileText, BookOpen,
  TrendingUp, ShieldAlert, Sparkles, ListOrdered, Brain, Plus, ChevronDown, ChevronUp,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import skyforgeEagle from "@/assets/skyforge-eagle.jpeg";

// ─── Play types ──────────────────────────────────────────────────────────────

type PlayRow = {
  id: string;
  user_id: string;
  play_type: string;
  title: string;
  description: string | null;
  status: string;
  capital_deployed: number | null;
  expected_roi_pct: number | null;
  actual_roi_pct: number | null;
  opened_at: string;
  closed_at: string | null;
  outcome_notes: string | null;
  source: string | null;
  legal_basis: string | null;
  created_at: string;
};

const PLAY_TYPE_COLORS: Record<string, string> = {
  earnings_iv_crush:  "text-purple-400 border-purple-400/40 bg-purple-400/10",
  credit_float:       "text-blue-400 border-blue-400/40 bg-blue-400/10",
  index_rebalance:    "text-cyan-400 border-cyan-400/40 bg-cyan-400/10",
  yield_spread:       "text-amber-400 border-amber-400/40 bg-amber-400/10",
  bonus_capture:      "text-green-400 border-green-400/40 bg-green-400/10",
  other:              "text-muted-foreground border-border/40 bg-secondary/30",
};

const PLAY_TYPE_LABELS: Record<string, string> = {
  earnings_iv_crush:  "Earnings IV Crush",
  credit_float:       "Credit Float",
  index_rebalance:    "Index Rebalance",
  yield_spread:       "Yield Spread",
  bonus_capture:      "Bonus Capture",
  other:              "Other",
};

const PLAY_TYPE_OPTIONS = [
  "earnings_iv_crush",
  "credit_float",
  "index_rebalance",
  "yield_spread",
  "bonus_capture",
  "other",
];

const BAR_COLORS = ["#818cf8", "#34d399", "#f59e0b", "#38bdf8", "#a78bfa", "#6ee7b7"];

function daysBetween(start: string, end?: string | null): number {
  const a = new Date(start).getTime();
  const b = end ? new Date(end).getTime() : Date.now();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function fmtCurrency(v: number | null | undefined): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

// ─── Arsenal types ────────────────────────────────────────────────────────────

interface ArsenalItem {
  id: string;
  title: string;
  type: string;
  content: string;
  use_count: number;
  win_count: number;
  source: string;
}

type CategoryKey = "setups" | "playbooks" | "risk-rules" | "thesis" | "criteria" | "directives" | "reference";

const CATEGORIES: { key: CategoryKey; label: string; icon: typeof Target; keywords: RegExp }[] = [
  { key: "setups",      label: "Setups",      icon: TrendingUp,  keywords: /\b(setup|entry|pattern|breakout|pullback|reversal|signal)\b/i },
  { key: "playbooks",   label: "Playbooks",   icon: BookOpen,    keywords: /\b(playbook|system|strategy|approach|method|framework)\b/i },
  { key: "risk-rules",  label: "Risk Rules",  icon: ShieldAlert, keywords: /\b(risk|stop.?loss|position.?size|drawdown|limit|max|rule)\b/i },
  { key: "thesis",      label: "Templates",   icon: Brain,       keywords: /\b(thesis|template|analysis|research|due.?diligence)\b/i },
  { key: "criteria",    label: "Criteria",    icon: ListOrdered, keywords: /\b(criteria|checklist|filter|screen|condition|requirement)\b/i },
  { key: "directives",  label: "Directives",  icon: Flame,       keywords: /\b(directive|protocol|sop|process|step|procedure)\b/i },
  { key: "reference",   label: "Reference",   icon: FileText,    keywords: /^$/ },
];

const categorize = (it: ArsenalItem): CategoryKey => {
  const t = (it.type || "").toLowerCase();
  const direct = CATEGORIES.find((c) => c.key === t);
  if (direct) return direct.key;
  const haystack = `${it.title}\n${it.content}`;
  for (const c of CATEGORIES) {
    if (c.key === "reference") continue;
    if (c.keywords.test(haystack)) return c.key;
  }
  return "reference";
};

// ─── Component ────────────────────────────────────────────────────────────────

const ArsenalPage = () => {
  const { user } = useAuth();

  // ── Arsenal state ──
  const [items, setItems] = useState<ArsenalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"all" | CategoryKey>("all");
  const [openItem, setOpenItem] = useState<ArsenalItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ArsenalItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Plays state ──
  const [plays, setPlays] = useState<PlayRow[]>([]);
  const [playsLoading, setPlaysLoading] = useState(true);
  const [showPlayForm, setShowPlayForm] = useState(false);
  const [playsExpanded, setPlaysExpanded] = useState(true);
  const [addingPlay, setAddingPlay] = useState(false);

  // New play form fields
  const [playTitle, setPlayTitle] = useState("");
  const [playType, setPlayType] = useState("earnings_iv_crush");
  const [playDesc, setPlayDesc] = useState("");
  const [playCapital, setPlayCapital] = useState("");
  const [playExpectedRoi, setPlayExpectedRoi] = useState("");
  const [playLegalBasis, setPlayLegalBasis] = useState("");

  useEffect(() => {
    if (!user) return;
    void load();
    void loadPlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("arsenal_items")
      .select("*")
      .eq("user_id", user!.id);
    const rows = (data ?? []) as ArsenalItem[];
    rows.sort((a, b) => {
      const ar = a.use_count > 0 ? a.win_count / a.use_count : -1;
      const br = b.use_count > 0 ? b.win_count / b.use_count : -1;
      return br - ar;
    });
    setItems(rows);
    setLoading(false);
  };

  const loadPlays = async () => {
    setPlaysLoading(true);
    const { data } = await supabase
      .from("atlas_plays")
      .select("*")
      .eq("user_id", user!.id)
      .order("created_at", { ascending: false });
    setPlays((data ?? []) as PlayRow[]);
    setPlaysLoading(false);
  };

  const handleAddPlay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playTitle.trim() || addingPlay) return;
    setAddingPlay(true);
    try {
      const { error } = await supabase.from("atlas_plays").insert({
        user_id: user!.id,
        play_type: playType,
        title: playTitle.trim(),
        description: playDesc.trim() || null,
        capital_deployed: playCapital ? parseFloat(playCapital) : null,
        expected_roi_pct: playExpectedRoi ? parseFloat(playExpectedRoi) : null,
        legal_basis: playLegalBasis.trim() || null,
        status: "active",
        source: "manual",
        opened_at: new Date().toISOString(),
      });
      if (error) throw error;
      toast.success("Play added successfully.");
      setPlayTitle("");
      setPlayType("earnings_iv_crush");
      setPlayDesc("");
      setPlayCapital("");
      setPlayExpectedRoi("");
      setPlayLegalBasis("");
      setShowPlayForm(false);
      void loadPlays();
    } catch {
      toast.error("Failed to add play.");
    } finally {
      setAddingPlay(false);
    }
  };

  // ── Derived play data ──
  const activePlays = useMemo(() => plays.filter((p) => p.status === "active"), [plays]);
  const completedPlays = useMemo(() => plays.filter((p) => p.status === "completed"), [plays]);

  const totalCapital = useMemo(
    () => activePlays.reduce((sum, p) => sum + (p.capital_deployed ?? 0), 0),
    [activePlays],
  );

  const weightedRoi = useMemo(() => {
    const totalCap = activePlays.reduce((s, p) => s + (p.capital_deployed ?? 0), 0);
    if (totalCap === 0) return null;
    const weighted = activePlays.reduce(
      (s, p) => s + (p.expected_roi_pct ?? 0) * (p.capital_deployed ?? 0),
      0,
    );
    return weighted / totalCap;
  }, [activePlays]);

  const atlasCount = useMemo(
    () => plays.filter((p) => p.source === "atlas_opportunity_scan").length,
    [plays],
  );
  const manualCount = useMemo(
    () => plays.filter((p) => p.source !== "atlas_opportunity_scan").length,
    [plays],
  );

  const roiByType = useMemo(() => {
    const map: Record<string, { sum: number; count: number }> = {};
    for (const p of completedPlays) {
      if (p.actual_roi_pct == null) continue;
      if (!map[p.play_type]) map[p.play_type] = { sum: 0, count: 0 };
      map[p.play_type].sum += p.actual_roi_pct;
      map[p.play_type].count += 1;
    }
    return Object.entries(map).map(([type, { sum, count }]) => ({
      type: PLAY_TYPE_LABELS[type] ?? type,
      avg: parseFloat((sum / count).toFixed(2)),
    }));
  }, [completedPlays]);

  // ── Arsenal derived ──
  const grouped = useMemo(() => {
    const map: Record<CategoryKey, ArsenalItem[]> = {
      setups: [], playbooks: [], "risk-rules": [], thesis: [], criteria: [], directives: [], reference: [],
    };
    for (const it of items) map[categorize(it)].push(it);
    return map;
  }, [items]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const cat of CATEGORIES) c[cat.key] = grouped[cat.key].length;
    return c;
  }, [grouped, items]);

  const visibleItems = useMemo(() => {
    if (activeTab === "all") return items;
    return grouped[activeTab];
  }, [activeTab, items, grouped]);

  const handleCopy = async (it: ArsenalItem, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await navigator.clipboard.writeText(it.content);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed");
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    const { error } = await supabase
      .from("arsenal_items")
      .delete()
      .eq("id", confirmDelete.id);
    setDeleting(false);
    if (error) {
      toast.error("Delete failed");
      return;
    }
    setItems((prev) => prev.filter((x) => x.id !== confirmDelete.id));
    if (openItem?.id === confirmDelete.id) setOpenItem(null);
    setConfirmDelete(null);
    toast.success("Removed from arsenal");
  };

  const renderCard = (it: ArsenalItem) => {
    const wins = it.win_count;
    const uses = it.use_count;
    const winRate = uses > 0 ? (wins / uses) * 100 : null;
    const cat = categorize(it);
    const catMeta = CATEGORIES.find((c) => c.key === cat)!;
    const Icon = catMeta.icon;
    return (
      <button
        key={it.id}
        onClick={() => setOpenItem(it)}
        className="glass-card p-5 space-y-3 text-left hover:border-accent/40 hover:bg-primary/5 transition-colors group"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2 min-w-0">
            <Icon className="h-4 w-4 text-accent mt-0.5 shrink-0" />
            <h3 className="text-base font-display tracking-wide text-foreground truncate">
              {it.title}
            </h3>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[10px] px-2 py-0.5 rounded-full border border-primary/30 text-primary uppercase tracking-wider">
              {catMeta.label}
            </span>
          </div>
        </div>
        <p className="text-sm text-muted-foreground line-clamp-4 whitespace-pre-wrap">
          {it.content}
        </p>
        <div className="flex items-center justify-between pt-2 border-t border-border/30">
          {uses > 0 ? (
            <div className="flex items-center gap-2">
              <Flame className="h-3 w-3 text-accent" />
              <span className="text-xs text-accent font-medium">
                {wins} of {uses} closes
                {winRate !== null && ` · ${Math.round(winRate)}%`}
              </span>
            </div>
          ) : (
            <span className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">Unused</span>
          )}
          <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => handleCopy(it, e)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleCopy(it);
                }
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary cursor-pointer"
              aria-label="Copy"
            >
              <Copy className="h-3.5 w-3.5" />
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(it);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfirmDelete(it);
                }
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive cursor-pointer"
              aria-label="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </span>
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">

      {/* ══════════════════ LIVE PLAYS SECTION ══════════════════ */}
      <div className="space-y-4">
        {/* Section header */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <button
              onClick={() => setPlaysExpanded((v) => !v)}
              className="flex items-center gap-2 group"
            >
              <h2 className="text-sm font-display tracking-widest text-primary uppercase group-hover:text-primary/80 transition-colors">
                Live Plays
              </h2>
              {playsExpanded
                ? <ChevronUp className="h-3.5 w-3.5 text-primary/60" />
                : <ChevronDown className="h-3.5 w-3.5 text-primary/60" />
              }
            </button>
            <p className="text-xs text-muted-foreground/60 mt-0.5">Active capital positions · Performance tracking</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowPlayForm((v) => !v)}
            className="h-8 gap-1.5 text-xs border-accent/30 text-accent/80 hover:border-accent/60 hover:text-accent"
          >
            {showPlayForm ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            {showPlayForm ? "Cancel" : "New Play"}
          </Button>
        </div>

        {playsExpanded && (
          <div className="space-y-4">
            {/* New play form */}
            {showPlayForm && (
              <div className="glass-card p-4 space-y-3">
                <h3 className="text-xs font-display tracking-wider text-foreground/80 uppercase">Add Play</h3>
                <form onSubmit={handleAddPlay} className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Title *</label>
                      <Input
                        value={playTitle}
                        onChange={(e) => setPlayTitle(e.target.value)}
                        placeholder="e.g. NVDA earnings IV crush"
                        className="h-8 bg-secondary/30 border-border/30 text-sm"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Play Type</label>
                      <select
                        value={playType}
                        onChange={(e) => setPlayType(e.target.value)}
                        className="w-full h-8 rounded-md border border-border/30 bg-secondary/30 text-sm px-3 text-foreground focus:outline-none focus:ring-1 focus:ring-accent/40"
                      >
                        {PLAY_TYPE_OPTIONS.map((t) => (
                          <option key={t} value={t}>{PLAY_TYPE_LABELS[t] ?? t}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Description</label>
                    <textarea
                      value={playDesc}
                      onChange={(e) => setPlayDesc(e.target.value)}
                      placeholder="Thesis, mechanics, timing…"
                      rows={3}
                      className="w-full rounded-md border border-border/30 bg-secondary/30 text-sm px-3 py-2 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Capital Deployed ($)</label>
                      <Input
                        type="number"
                        value={playCapital}
                        onChange={(e) => setPlayCapital(e.target.value)}
                        placeholder="0"
                        className="h-8 bg-secondary/30 border-border/30 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Expected ROI %</label>
                      <Input
                        type="number"
                        step="0.01"
                        value={playExpectedRoi}
                        onChange={(e) => setPlayExpectedRoi(e.target.value)}
                        placeholder="0.00"
                        className="h-8 bg-secondary/30 border-border/30 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Legal Basis</label>
                      <Input
                        value={playLegalBasis}
                        onChange={(e) => setPlayLegalBasis(e.target.value)}
                        placeholder="e.g. IRC §1256"
                        className="h-8 bg-secondary/30 border-border/30 text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={addingPlay || !playTitle.trim()}
                      className="h-8 text-xs"
                    >
                      {addingPlay ? "Adding…" : "Add Play"}
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {/* Performance summary cards */}
            {!playsLoading && plays.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="glass-card p-3 space-y-1">
                  <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Total Capital in Plays</div>
                  <div className="text-lg font-display text-primary">{fmtCurrency(totalCapital)}</div>
                  <div className="text-[10px] text-muted-foreground/50">{activePlays.length} active position{activePlays.length !== 1 ? "s" : ""}</div>
                </div>
                <div className="glass-card p-3 space-y-1">
                  <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Weighted Expected ROI</div>
                  <div className={`text-lg font-display ${weightedRoi == null ? "text-muted-foreground/40" : weightedRoi >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {weightedRoi == null ? "—" : fmtPct(weightedRoi)}
                  </div>
                  <div className="text-[10px] text-muted-foreground/50">by capital weight</div>
                </div>
                <div className="glass-card p-3 space-y-1">
                  <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Atlas vs Manual</div>
                  <div className="text-lg font-display text-primary">{atlasCount} <span className="text-sm text-muted-foreground/50">/ {manualCount}</span></div>
                  <div className="text-[10px] text-muted-foreground/50">Atlas scanned · Manual added</div>
                </div>
              </div>
            )}

            {/* Loading state */}
            {playsLoading && (
              <div className="text-xs text-muted-foreground/50 animate-pulse">Loading plays…</div>
            )}

            {/* No plays yet */}
            {!playsLoading && plays.length === 0 && (
              <div className="glass-card p-6 text-center space-y-2">
                <TrendingUp className="h-8 w-8 text-muted-foreground/20 mx-auto" />
                <p className="text-xs text-muted-foreground/50">No plays yet. Add your first play above.</p>
              </div>
            )}

            {/* Active play cards */}
            {!playsLoading && activePlays.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {activePlays.map((p) => {
                  const typeColor = PLAY_TYPE_COLORS[p.play_type] ?? PLAY_TYPE_COLORS.other;
                  const isAtlas = p.source === "atlas_opportunity_scan";
                  const days = daysBetween(p.opened_at, p.status === "active" ? null : p.closed_at);
                  const isCompleted = p.status === "completed";
                  const roiDelta = isCompleted && p.actual_roi_pct != null && p.expected_roi_pct != null
                    ? p.actual_roi_pct - p.expected_roi_pct
                    : null;
                  return (
                    <div key={p.id} className="glass-card p-4 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-display text-foreground truncate">{p.title}</div>
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${typeColor}`}>
                              {PLAY_TYPE_LABELS[p.play_type] ?? p.play_type}
                            </span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${isAtlas ? "text-blue-400 border-blue-400/40 bg-blue-400/10" : "text-muted-foreground border-border/40 bg-secondary/30"}`}>
                              {isAtlas ? "Atlas" : "Manual"}
                            </span>
                            <span className="text-[10px] px-2 py-0.5 rounded-full border border-border/30 text-muted-foreground/60">
                              {p.status}
                            </span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-display text-foreground">{fmtCurrency(p.capital_deployed)}</div>
                          <div className="text-[10px] text-muted-foreground/50 mt-0.5">{days}d running</div>
                        </div>
                      </div>

                      {p.description && (
                        <p className="text-xs text-muted-foreground/70 line-clamp-2">{p.description}</p>
                      )}

                      <div className="flex items-center justify-between pt-2 border-t border-border/20">
                        <div className="space-y-0.5">
                          <div className="text-[10px] text-muted-foreground/50">Expected ROI</div>
                          <div className="text-xs font-display text-amber-400">{fmtPct(p.expected_roi_pct)}</div>
                        </div>
                        {isCompleted && p.actual_roi_pct != null && (
                          <div className="space-y-0.5 text-right">
                            <div className="text-[10px] text-muted-foreground/50">Actual ROI</div>
                            <div className={`text-xs font-display ${p.actual_roi_pct >= 0 ? "text-green-400" : "text-red-400"}`}>
                              {fmtPct(p.actual_roi_pct)}
                              {roiDelta != null && (
                                <span className="text-[10px] text-muted-foreground/50 ml-1">
                                  ({roiDelta >= 0 ? "+" : ""}{roiDelta.toFixed(2)}% vs exp)
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                        {p.legal_basis && (
                          <div className="text-[10px] text-muted-foreground/40 font-mono">{p.legal_basis}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ROI by play_type bar chart */}
            {!playsLoading && roiByType.length > 0 && (
              <div className="glass-card p-4 space-y-3">
                <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Avg Actual ROI by Play Type (Completed)</div>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={roiByType} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                    <XAxis
                      dataKey="type"
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => `${v}%`}
                    />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 11 }}
                      formatter={(v: number) => [`${v.toFixed(2)}%`, "Avg ROI"]}
                    />
                    <Bar dataKey="avg" radius={[3, 3, 0, 0]}>
                      {roiByType.map((_, i) => (
                        <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══════════════════ STRATEGIES SECTION ══════════════════ */}
      <div>
        <h1 className="text-xl md:text-2xl font-display tracking-wider text-primary text-glow-blue">STRATEGIES</h1>
        <p className="text-xs text-muted-foreground/60 mt-0.5">Trading playbooks · Setups · Risk rules · Templates</p>
      </div>

      {loading && <div className="text-muted-foreground text-sm">Loading…</div>}

      {!loading && items.length === 0 && (
        <div className="glass-card p-10 flex flex-col items-center justify-center text-center space-y-6 min-h-[400px] relative overflow-hidden">
          <img
            src={skyforgeEagle}
            alt=""
            className="absolute inset-0 w-full h-full object-cover opacity-10"
            loading="lazy"
          />
          <div className="relative z-10 space-y-4">
            <Target className="h-16 w-16 text-primary/30 mx-auto" />
            <h2 className="text-lg font-display tracking-widest text-primary/60">EMPTY</h2>
            <p className="text-sm text-muted-foreground max-w-md">
              Atlas will save trading playbooks, setups, risk rules, and thesis templates here as you work together.
            </p>
          </div>
        </div>
      )}

      {!loading && items.length > 0 && (
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList className="flex-wrap h-auto bg-secondary/40 border border-border/30">
            <TabsTrigger value="all" className="data-[state=active]:bg-primary/15 data-[state=active]:text-primary">
              All <span className="ml-1.5 text-[10px] opacity-60">{counts.all}</span>
            </TabsTrigger>
            {CATEGORIES.map((c) => {
              const Icon = c.icon;
              const n = counts[c.key] ?? 0;
              if (n === 0 && c.key !== "reference") return null;
              return (
                <TabsTrigger
                  key={c.key}
                  value={c.key}
                  className="data-[state=active]:bg-primary/15 data-[state=active]:text-primary"
                >
                  <Icon className="h-3.5 w-3.5 mr-1.5" />
                  {c.label}
                  <span className="ml-1.5 text-[10px] opacity-60">{n}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value={activeTab} className="mt-4">
            {visibleItems.length === 0 ? (
              <div className="glass-card p-8 text-center text-sm text-muted-foreground">
                Nothing in this category yet.
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {visibleItems.map(renderCard)}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      {/* Detail dialog */}
      <Dialog open={!!openItem} onOpenChange={(o) => !o && setOpenItem(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col bg-card border-border/50">
          {openItem && (
            <>
              <DialogHeader>
                <div className="flex items-start justify-between gap-3 pr-8">
                  <div className="space-y-2 min-w-0">
                    <DialogTitle className="font-display tracking-wide text-lg text-foreground">
                      {openItem.title}
                    </DialogTitle>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] px-2 py-0.5 rounded-full border border-primary/30 text-primary uppercase tracking-wider inline-flex items-center gap-1">
                        <Tag className="h-3 w-3" />
                        {CATEGORIES.find((c) => c.key === categorize(openItem))?.label}
                      </span>
                      {openItem.use_count > 0 && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full border border-accent/40 text-accent uppercase tracking-wider inline-flex items-center gap-1">
                          <Flame className="h-3 w-3" />
                          {openItem.win_count}/{openItem.use_count}
                        </span>
                      )}
                      {openItem.source && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full border border-border/40 text-muted-foreground uppercase tracking-wider inline-flex items-center gap-1">
                          <Sparkles className="h-3 w-3" />
                          {openItem.source.replace(/_/g, " ")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </DialogHeader>

              <div className="flex-1 overflow-y-auto py-4 px-1">
                <pre className="whitespace-pre-wrap font-sans text-sm text-foreground/90 leading-relaxed">
                  {openItem.content}
                </pre>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-border/30">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setConfirmDelete(openItem);
                  }}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
                >
                  <Trash2 className="h-4 w-4 mr-2" /> Delete
                </Button>
                <Button size="sm" onClick={() => handleCopy(openItem)}>
                  <Copy className="h-4 w-4 mr-2" /> Copy
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this asset?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.title} will be permanently removed from your arsenal. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ArsenalPage;
