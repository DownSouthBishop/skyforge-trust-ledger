import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { BookOpen, FileText, AlertCircle } from "lucide-react";

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

  const filtered = filterType ? notes.filter((n) => n.note_type === filterType) : notes;

  const typeCounts = Object.keys(TYPE_LABELS).reduce<Record<string, number>>((acc, t) => {
    acc[t] = notes.filter((n) => n.note_type === t).length;
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary font-display animate-pulse-glow tracking-widest text-sm">LOADING</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      <div>
        <h1 className="text-sm font-display tracking-widest text-primary uppercase">Vault</h1>
        <p className="text-xs text-muted-foreground/60 mt-0.5">Research · Briefs · Trade logs · Obsidian sync</p>
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

      {/* Filter tabs */}
      {notes.length > 0 && (
        <div className="flex gap-2 flex-wrap">
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
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

        {/* Note list */}
        <div className="md:col-span-1 space-y-2">
          {filtered.length === 0 ? (
            <div className="glass-card p-8 text-center space-y-3">
              <BookOpen className="h-8 w-8 text-muted-foreground/30 mx-auto" />
              <p className="text-sm text-muted-foreground/50">No notes yet. Atlas writes here automatically.</p>
            </div>
          ) : (
            filtered.map((n) => (
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
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border capitalize ${TYPE_COLORS[n.note_type] ?? "text-muted-foreground border-border/30"}`}>
                    {TYPE_LABELS[n.note_type] ?? n.note_type}
                  </span>
                  {n.synced_to_obsidian && (
                    <span className="text-[10px] text-green-400/60">synced</span>
                  )}
                  <span className="text-[10px] text-muted-foreground/30 ml-auto">
                    {new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                </div>
              </button>
            ))
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
                <pre className="text-xs text-foreground/70 whitespace-pre-wrap font-sans leading-relaxed">
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
