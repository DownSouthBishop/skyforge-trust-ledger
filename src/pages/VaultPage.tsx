import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BookOpen, FileText, AlertCircle, Search, Globe, Cloud, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";

type NoteRow = {
  id: string;
  symbol: string | null;
  title: string;
  content: string;
  note_type: string;
  obsidian_path: string | null;
  synced_to_obsidian: boolean;
  created_at: string;
};

const TYPE_LABELS: Record<string, string> = {
  morning_brief: "Morning Brief",
  thesis: "Thesis",
  research: "Research",
  weekly_review: "Weekly Review",
  trade_log: "Trade Log",
};

const TYPE_COLORS: Record<string, string> = {
  morning_brief: "text-blue-400 border-blue-400/30 bg-blue-400/5",
  thesis: "text-amber-400 border-amber-400/30 bg-amber-400/5",
  research: "text-purple-400 border-purple-400/30 bg-purple-400/5",
  weekly_review: "text-green-400 border-green-400/30 bg-green-400/5",
  trade_log: "text-orange-400 border-orange-400/30 bg-orange-400/5",
};

const VaultPage = () => {
  const { user } = useAuth();
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<NoteRow | null>(null);
  const [filterType, setFilterType] = useState<string>("");
  const [researchSymbol, setResearchSymbol] = useState("");
  const [researching, setResearching] = useState(false);
  const [scanningForex, setScanningForex] = useState(false);

  // New filter state
  const [searchText, setSearchText] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [filterSymbol, setFilterSymbol] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);

  const loadNotes = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("research_notes")
      .select("id, symbol, title, content, note_type, obsidian_path, synced_to_obsidian, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100);
    setNotes((data ?? []) as NoteRow[]);
    setLoading(false);
  }, [user]);

  useEffect(() => { void loadNotes(); }, [loadNotes]);

  const handleResearch = async () => {
    const sym = researchSymbol.trim().toUpperCase();
    if (!sym || researching) return;
    setResearching(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/atlas_trade_thesis`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ user_id: user!.id, symbol: sym, asset_class: "equity" }),
        },
      );
      if (!res.ok) throw new Error("research failed");
      toast.success(`Thesis generated for ${sym} — check the note list.`);
      setResearchSymbol("");
      void loadNotes();
    } catch {
      toast.error("Research failed. Try again.");
    } finally {
      setResearching(false);
    }
  };

  const handleForexScan = async () => {
    if (scanningForex) return;
    setScanningForex(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/atlas_forex_scan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ user_id: user!.id }),
        },
      );
      if (!res.ok) throw new Error("scan failed");
      toast.success("Forex scan complete — notes added.");
      void loadNotes();
    } catch {
      toast.error("Forex scan failed.");
    } finally {
      setScanningForex(false);
    }
  };

  const handleSyncToObsidian = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("atlas_obsidian_sync", {
        body: { user_id: user!.id },
      });
      if (error) throw error;
      toast.success(`Synced ${data?.synced ?? 0} notes to Obsidian.`);
      void loadNotes();
    } catch {
      toast.error("Obsidian sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  const toggleGroup = (type: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // All unique symbols from all notes (not just filtered), sorted, max 15
  const allSymbols = Array.from(
    new Set(notes.map((n) => n.symbol).filter(Boolean) as string[])
  ).sort().slice(0, 15);

  const typeCounts = Object.keys(TYPE_LABELS).reduce<Record<string, number>>((acc, t) => {
    acc[t] = notes.filter((n) => n.note_type === t).length;
    return acc;
  }, {});

  // Apply filters: type → symbol → text search → date range
  const filtered = notes
    .filter((n) => !filterType || n.note_type === filterType)
    .filter((n) => !filterSymbol || n.symbol === filterSymbol)
    .filter((n) =>
      !searchText ||
      n.title.toLowerCase().includes(searchText.toLowerCase()) ||
      (n.symbol ?? "").toLowerCase().includes(searchText.toLowerCase())
    )
    .filter((n) => {
      if (fromDate && n.created_at < fromDate) return false;
      if (toDate && n.created_at > toDate + "T23:59:59") return false;
      return true;
    });

  // Group filtered notes by note_type
  const groupedFiltered = Object.keys(TYPE_LABELS).reduce<Record<string, NoteRow[]>>((acc, t) => {
    const group = filtered.filter((n) => n.note_type === t);
    if (group.length > 0) acc[t] = group;
    return acc;
  }, {} as Record<string, NoteRow[]>);

  // Also include any note_types not in TYPE_LABELS
  for (const n of filtered) {
    if (!(n.note_type in TYPE_LABELS) && !(n.note_type in groupedFiltered)) {
      groupedFiltered[n.note_type] = [];
    }
  }
  for (const n of filtered) {
    if (!(n.note_type in TYPE_LABELS)) {
      if (!groupedFiltered[n.note_type]) groupedFiltered[n.note_type] = [];
      if (!groupedFiltered[n.note_type].includes(n)) groupedFiltered[n.note_type].push(n);
    }
  }

  const groupKeys = Object.keys(groupedFiltered);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary font-display animate-pulse-glow tracking-widest text-sm">LOADING</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-sm font-display tracking-widest text-primary uppercase">Vault</h1>
          <p className="text-xs text-muted-foreground/60 mt-0.5">Research · Briefs · Trade logs · Obsidian sync</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <Input
              placeholder="Symbol (e.g. AAPL)"
              value={researchSymbol}
              onChange={(e) => setResearchSymbol(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleResearch(); }}
              className="h-8 w-36 bg-secondary/30 border-border/30 text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleResearch}
              disabled={researching || !researchSymbol.trim()}
              className="h-8 gap-1.5 text-xs border-amber-400/30 text-amber-400/80 hover:border-amber-400/60 hover:text-amber-400"
            >
              <Search className={`h-3 w-3 ${researching ? "animate-pulse" : ""}`} />
              {researching ? "Researching…" : "Research"}
            </Button>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleForexScan}
            disabled={scanningForex}
            className="h-8 gap-1.5 text-xs border-green-400/30 text-green-400/80 hover:border-green-400/60 hover:text-green-400"
          >
            <Globe className={`h-3 w-3 ${scanningForex ? "animate-pulse" : ""}`} />
            {scanningForex ? "Scanning…" : "Forex Scan"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleSyncToObsidian}
            disabled={syncing}
            className="h-8 gap-1.5 text-xs border-sky-400/30 text-sky-400/80 hover:border-sky-400/60 hover:text-sky-400"
          >
            <Cloud className={`h-3 w-3 ${syncing ? "animate-pulse" : ""}`} />
            {syncing ? "Syncing…" : "Sync to Obsidian"}
          </Button>
        </div>
      </div>

      {notes.length === 0 && (
        <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-primary/20 bg-primary/5 text-xs text-primary/80">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Atlas pushes research briefs here automatically. Morning briefs, trade theses, and weekly
            reviews will appear as you use the system. Obsidian sync activates in Phase 3.
          </span>
        </div>
      )}

      {notes.length > 0 && (
        <div className="space-y-3">
          {/* Type filter tabs + search row */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex gap-2 flex-wrap flex-1">
              <button
                onClick={() => setFilterType("")}
                className={`text-xs px-3 py-1 rounded-full border transition-colors ${!filterType ? "border-accent/60 bg-accent/10 text-accent" : "border-border/40 text-muted-foreground hover:border-border/70"}`}
              >
                All ({notes.length})
              </button>
              {Object.entries(TYPE_LABELS).filter(([t]) => typeCounts[t] > 0).map(([t, label]) => (
                <button
                  key={t}
                  onClick={() => setFilterType(filterType === t ? "" : t)}
                  className={`text-xs px-3 py-1 rounded-full border transition-colors ${filterType === t ? "border-accent/60 bg-accent/10 text-accent" : "border-border/40 text-muted-foreground hover:border-border/70"}`}
                >
                  {label} ({typeCounts[t]})
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50" />
              <Input
                placeholder="Search notes…"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="h-7 pl-7 w-44 bg-secondary/30 border-border/30 text-xs"
              />
            </div>
          </div>

          {/* Date range row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">From</span>
            <Input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-7 w-36 bg-secondary/30 border-border/30 text-xs"
            />
            <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">To</span>
            <Input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-7 w-36 bg-secondary/30 border-border/30 text-xs"
            />
            {(fromDate || toDate) && (
              <button
                onClick={() => { setFromDate(""); setToDate(""); }}
                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              >
                Clear dates
              </button>
            )}
          </div>

          {/* Symbol filter pills */}
          {allSymbols.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {allSymbols.map((sym) => (
                <button
                  key={sym}
                  onClick={() => setFilterSymbol(filterSymbol === sym ? "" : sym)}
                  className={`text-[10px] px-2.5 py-0.5 rounded-full border font-display transition-colors ${filterSymbol === sym ? "border-accent/60 bg-accent/10 text-accent" : "border-border/40 text-muted-foreground/70 hover:border-border/70 hover:text-muted-foreground"}`}
                >
                  {sym}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

        {/* Note list — grouped by note_type */}
        <div className="md:col-span-1 space-y-3">
          {filtered.length === 0 ? (
            <div className="glass-card p-8 text-center space-y-3">
              <BookOpen className="h-8 w-8 text-muted-foreground/30 mx-auto" />
              <p className="text-sm text-muted-foreground/50">
                {notes.length === 0 ? "No notes yet. Atlas writes here automatically." : "No notes match your filters."}
              </p>
            </div>
          ) : (
            groupKeys.map((type) => {
              const group = groupedFiltered[type];
              const isCollapsed = collapsedGroups.has(type);
              const label = TYPE_LABELS[type] ?? type;
              return (
                <div key={type} className="space-y-1">
                  <button
                    onClick={() => toggleGroup(type)}
                    className="w-full flex items-center justify-between px-2 py-1 rounded hover:bg-secondary/30 transition-colors group"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-display uppercase tracking-wider ${TYPE_COLORS[type]?.split(" ")[0] ?? "text-muted-foreground"}`}>
                        {label}
                      </span>
                      <span className="text-[10px] text-muted-foreground/40">{group.length}</span>
                    </div>
                    {isCollapsed
                      ? <ChevronDown className="h-3 w-3 text-muted-foreground/40" />
                      : <ChevronUp className="h-3 w-3 text-muted-foreground/40" />
                    }
                  </button>
                  {!isCollapsed && group.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => setSelected(n)}
                      className={`w-full text-left glass-card p-3 space-y-1 hover:border-accent/30 transition-colors ${selected?.id === n.id ? "border-accent/40 bg-accent/5" : ""}`}
                    >
                      <div className="flex items-start gap-2">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground/50 mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-foreground/90 truncate">{n.title}</div>
                          {n.symbol && <div className="text-[10px] text-accent/70 font-display">{n.symbol}</div>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 pl-5">
                        {n.synced_to_obsidian && (
                          <span className="text-[10px] text-green-400/60">synced</span>
                        )}
                        <span className="text-[10px] text-muted-foreground/30 ml-auto">
                          {new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>

        {/* Note viewer */}
        <div className="md:col-span-2">
          {selected ? (
            <div className="glass-card p-4 space-y-3 h-full">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-display text-foreground">{selected.title}</h2>
                  <div className="flex items-center gap-2 mt-1">
                    {selected.symbol && <span className="text-[10px] text-accent/70 font-display">{selected.symbol}</span>}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border capitalize ${TYPE_COLORS[selected.note_type] ?? "text-muted-foreground border-border/30"}`}>
                      {TYPE_LABELS[selected.note_type] ?? selected.note_type}
                    </span>
                    <span className="text-[10px] text-muted-foreground/40">
                      {new Date(selected.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                    </span>
                  </div>
                </div>
                {selected.obsidian_path && (
                  <span className="text-[10px] text-muted-foreground/40 font-mono shrink-0">{selected.obsidian_path}</span>
                )}
              </div>
              <div className="border-t border-border/20 pt-3">
                <pre className="text-xs text-foreground/70 whitespace-pre-wrap font-mono leading-relaxed">
                  {selected.content}
                </pre>
              </div>
            </div>
          ) : (
            <div className="glass-card p-8 flex flex-col items-center justify-center h-full min-h-48 space-y-3">
              <BookOpen className="h-10 w-10 text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground/40">Select a note to read</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VaultPage;
