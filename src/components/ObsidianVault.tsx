import { useState, useEffect, useCallback, useRef } from "react";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Search, Plus, Pin, PinOff, Trash2, Edit3, Check, X,
  BookOpen, Lightbulb, TrendingUp, Brain, Layers, Cpu, User,
  GitBranch, Clock, Tag,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KnowledgeNode {
  id: string;
  user_id: string;
  title: string;
  content: string;
  tags: string[];
  links: string[];
  node_type: "note" | "insight" | "pattern" | "lesson" | "concept" | "trade_thesis" | "entity";
  source: "manual" | "atlas" | "conversation";
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

const TYPE_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  note:         { label: "Note",        icon: BookOpen,   color: "text-blue-400" },
  insight:      { label: "Insight",     icon: Lightbulb,  color: "text-yellow-400" },
  pattern:      { label: "Pattern",     icon: Layers,     color: "text-purple-400" },
  lesson:       { label: "Lesson",      icon: Brain,      color: "text-green-400" },
  concept:      { label: "Concept",     icon: Cpu,        color: "text-cyan-400" },
  trade_thesis: { label: "Trade Thesis",icon: TrendingUp, color: "text-orange-400" },
  entity:       { label: "Entity",      icon: User,       color: "text-pink-400" },
};

// ─── Markdown renderer ────────────────────────────────────────────────────────

function renderInlineFormatting(text: string, key: string): React.ReactNode {
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**"))
      parts.push(<strong key={`${key}-b-${i++}`} className="font-semibold text-primary">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*"))
      parts.push(<em key={`${key}-i-${i++}`} className="italic">{tok.slice(1, -1)}</em>);
    else
      parts.push(<code key={`${key}-c-${i++}`} className="bg-muted px-1 rounded text-xs font-mono">{tok.slice(1, -1)}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function renderInline(
  text: string,
  allTitles: string[],
  onLink: (t: string) => void,
  lineKey: string,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const wlRx = /\[\[([^\]]+)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = wlRx.exec(text)) !== null) {
    if (m.index > last)
      parts.push(renderInlineFormatting(text.slice(last, m.index), `${lineKey}-pre-${i}`));
    const title = m[1];
    const exists = allTitles.includes(title);
    parts.push(
      <span
        key={`${lineKey}-wl-${i++}`}
        onClick={() => onLink(title)}
        className={`cursor-pointer rounded px-1 text-xs font-medium transition-colors ${
          exists
            ? "text-accent bg-accent/10 hover:bg-accent/20"
            : "text-muted-foreground bg-muted/40 hover:bg-muted line-through"
        }`}
      >
        [[{title}]]
      </span>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length)
    parts.push(renderInlineFormatting(text.slice(last), `${lineKey}-suf-${i}`));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function MarkdownView({
  content,
  allTitles,
  onLinkClick,
}: {
  content: string;
  allTitles: string[];
  onLinkClick: (title: string) => void;
}) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  const listBuf: React.ReactNode[] = [];

  function flushList() {
    if (!listBuf.length) return;
    elements.push(
      <ul key={`ul-${elements.length}`} className="list-disc pl-5 space-y-0.5 my-1.5 text-sm text-primary/90">
        {[...listBuf]}
      </ul>
    );
    listBuf.length = 0;
  }

  lines.forEach((line, idx) => {
    const lk = `l-${idx}`;
    if (/^### /.test(line)) {
      flushList();
      elements.push(<h3 key={lk} className="text-sm font-semibold text-primary mt-3 mb-1">{renderInline(line.slice(4), allTitles, onLinkClick, lk)}</h3>);
    } else if (/^## /.test(line)) {
      flushList();
      elements.push(<h2 key={lk} className="text-base font-semibold text-primary mt-4 mb-1.5">{renderInline(line.slice(3), allTitles, onLinkClick, lk)}</h2>);
    } else if (/^# /.test(line)) {
      flushList();
      elements.push(<h1 key={lk} className="text-lg font-bold text-primary mt-4 mb-2">{renderInline(line.slice(2), allTitles, onLinkClick, lk)}</h1>);
    } else if (/^[-*] /.test(line)) {
      listBuf.push(<li key={lk}>{renderInline(line.slice(2), allTitles, onLinkClick, lk)}</li>);
    } else if (/^> /.test(line)) {
      flushList();
      elements.push(
        <blockquote key={lk} className="border-l-2 border-accent/50 pl-3 italic text-muted-foreground my-1 text-sm">
          {renderInline(line.slice(2), allTitles, onLinkClick, lk)}
        </blockquote>
      );
    } else if (line === "---" || line === "***") {
      flushList();
      elements.push(<hr key={lk} className="border-border/40 my-3" />);
    } else if (line.trim() === "") {
      flushList();
      elements.push(<div key={lk} className="h-2" />);
    } else {
      flushList();
      elements.push(
        <p key={lk} className="text-sm text-primary/90 leading-relaxed">
          {renderInline(line, allTitles, onLinkClick, lk)}
        </p>
      );
    }
  });
  flushList();
  return <div className="space-y-0.5">{elements}</div>;
}

// ─── Graph view ───────────────────────────────────────────────────────────────

function GraphView({
  selected,
  notes,
  onSelect,
}: {
  selected: KnowledgeNode;
  notes: KnowledgeNode[];
  onSelect: (n: KnowledgeNode) => void;
}) {
  const W = 420, H = 280, CX = W / 2, CY = H / 2;

  const linkedSet = new Set(selected.links);
  const connected = notes.filter(
    (n) => n.id !== selected.id && (linkedSet.has(n.title) || n.links.includes(selected.title))
  );
  const unconnected = notes.filter(
    (n) => n.id !== selected.id && !linkedSet.has(n.title) && !n.links.includes(selected.title)
  ).slice(0, 8);

  const R_inner = 100;
  const R_outer = 170;

  function nodePos(arr: KnowledgeNode[], R: number, offset = 0) {
    return arr.map((n, i) => {
      const angle = (2 * Math.PI * i) / arr.length - Math.PI / 2 + offset;
      return { n, x: CX + R * Math.cos(angle), y: CY + R * Math.sin(angle) };
    });
  }

  const innerNodes = nodePos(connected, R_inner);
  const outerNodes = nodePos(unconnected, R_outer, 0.3);

  function truncate(s: string, len: number) {
    return s.length > len ? s.slice(0, len - 1) + "…" : s;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-56 select-none">
      {/* Outer dim lines */}
      {outerNodes.map(({ n, x, y }) => (
        <line key={`ol-${n.id}`} x1={CX} y1={CY} x2={x} y2={y}
          stroke="hsl(var(--border))" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.4" />
      ))}
      {/* Inner connection lines */}
      {innerNodes.map(({ n, x, y }) => (
        <line key={`il-${n.id}`} x1={CX} y1={CY} x2={x} y2={y}
          stroke="hsl(var(--accent))" strokeWidth="1" opacity="0.35" />
      ))}
      {/* Outer nodes (unconnected, dimmed) */}
      {outerNodes.map(({ n, x, y }) => (
        <g key={`on-${n.id}`} onClick={() => onSelect(n)} className="cursor-pointer" opacity="0.45">
          <circle cx={x} cy={y} r="14" fill="hsl(var(--muted))" stroke="hsl(var(--border))" strokeWidth="1" />
          <text x={x} y={y + 3} textAnchor="middle" fontSize="6.5" fill="hsl(var(--muted-foreground))">
            {truncate(n.title, 9)}
          </text>
        </g>
      ))}
      {/* Inner nodes (connected) */}
      {innerNodes.map(({ n, x, y }) => (
        <g key={`in-${n.id}`} onClick={() => onSelect(n)} className="cursor-pointer">
          <circle cx={x} cy={y} r="22" fill="hsl(var(--muted))" stroke="hsl(var(--accent))" strokeWidth="1" />
          <text x={x} y={y + 3} textAnchor="middle" fontSize="7" fill="hsl(var(--primary))" fontWeight="500">
            {truncate(n.title, 11)}
          </text>
        </g>
      ))}
      {/* Center node */}
      <circle cx={CX} cy={CY} r="32" fill="hsl(var(--accent)/0.15)" stroke="hsl(var(--accent))" strokeWidth="1.5" />
      <text x={CX} y={CY + 3} textAnchor="middle" fontSize="8.5" fill="hsl(var(--accent))" fontWeight="600">
        {truncate(selected.title, 14)}
      </text>
      {connected.length === 0 && unconnected.length === 0 && (
        <text x={CX} y={CY + 50} textAnchor="middle" fontSize="9" fill="hsl(var(--muted-foreground))">
          No connections yet
        </text>
      )}
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const ALL_TYPES = Object.keys(TYPE_CONFIG);

export function ObsidianVault() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [notes, setNotes] = useState<KnowledgeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<KnowledgeNode | null>(null);
  const [view, setView] = useState<"read" | "edit" | "graph">("read");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [showNew, setShowNew] = useState(false);

  // Edit state
  const [editTitle, setEditTitle]   = useState("");
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags]     = useState("");
  const [editLinks, setEditLinks]   = useState("");
  const [editType, setEditType]     = useState<KnowledgeNode["node_type"]>("note");
  const [saving, setSaving]         = useState(false);
  const [deleting, setDeleting]     = useState(false);

  const [newTitle, setNewTitle]     = useState("");
  const [creating, setCreating]     = useState(false);

  const detailRef = useRef<HTMLDivElement>(null);

  // ── Load ──────────────────────────────────────────────────────────────────

  const loadNotes = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("atlas_knowledge")
      .select("*")
      .eq("user_id", user.id)
      .order("pinned", { ascending: false })
      .order("updated_at", { ascending: false });
    if (error) {
      toast({ title: "Failed to load vault", description: error.message, variant: "destructive" });
    } else {
      setNotes((data as unknown as KnowledgeNode[]) ?? []);
    }
    setLoading(false);
  }, [user, toast]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  // ── Filter ────────────────────────────────────────────────────────────────

  const filtered = notes.filter((n) => {
    const q = search.toLowerCase();
    if (typeFilter !== "all" && n.node_type !== typeFilter) return false;
    if (!q) return true;
    return (
      n.title.toLowerCase().includes(q) ||
      n.content.toLowerCase().includes(q) ||
      n.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  // ── Select ────────────────────────────────────────────────────────────────

  function selectNote(n: KnowledgeNode) {
    setSelected(n);
    setView("read");
    detailRef.current?.scrollTo({ top: 0 });
  }

  function selectByTitle(title: string) {
    const found = notes.find((n) => n.title === title);
    if (found) selectNote(found);
  }

  // ── Edit ──────────────────────────────────────────────────────────────────

  function startEdit() {
    if (!selected) return;
    setEditTitle(selected.title);
    setEditContent(selected.content);
    setEditTags(selected.tags.join(", "));
    setEditLinks(selected.links.join(", "));
    setEditType(selected.node_type);
    setView("edit");
  }

  async function saveEdit() {
    if (!selected || !user) return;
    setSaving(true);
    const updates = {
      title:     editTitle.trim(),
      content:   editContent,
      tags:      editTags.split(",").map((t) => t.trim()).filter(Boolean),
      links:     editLinks.split(",").map((t) => t.trim()).filter(Boolean),
      node_type: editType,
    };
    const { error } = await supabase
      .from("atlas_knowledge")
      .update(updates)
      .eq("id", selected.id);
    if (error) {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    } else {
      const updated = { ...selected, ...updates } as KnowledgeNode;
      setNotes((prev) => prev.map((n) => (n.id === selected.id ? updated : n)));
      setSelected(updated);
      setView("read");
      toast({ title: "Saved" });
    }
    setSaving(false);
  }

  // ── Pin ───────────────────────────────────────────────────────────────────

  async function togglePin(n: KnowledgeNode) {
    const { error } = await supabase
      .from("atlas_knowledge")
      .update({ pinned: !n.pinned })
      .eq("id", n.id);
    if (!error) {
      const updated = { ...n, pinned: !n.pinned };
      setNotes((prev) => prev.map((x) => (x.id === n.id ? updated : x)));
      if (selected?.id === n.id) setSelected(updated);
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async function deleteNote() {
    if (!selected) return;
    setDeleting(true);
    const { error } = await supabase
      .from("atlas_knowledge")
      .delete()
      .eq("id", selected.id);
    if (error) {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== selected.id));
      setSelected(null);
      toast({ title: "Note deleted" });
    }
    setDeleting(false);
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async function createNote() {
    if (!user || !newTitle.trim()) return;
    setCreating(true);
    const { data, error } = await supabase
      .from("atlas_knowledge")
      .insert({
        user_id:   user.id,
        title:     newTitle.trim(),
        content:   "",
        tags:      [],
        links:     [],
        node_type: "note",
        source:    "manual",
        pinned:    false,
      })
      .select()
      .single();
    if (error) {
      toast({ title: "Create failed", description: error.message, variant: "destructive" });
    } else {
      const newNode = data as unknown as KnowledgeNode;
      setNotes((prev) => [newNode, ...prev]);
      setSelected(newNode);
      setShowNew(false);
      setNewTitle("");
      startEdit();
    }
    setCreating(false);
  }

  const allTitles = notes.map((n) => n.title);

  // ── Backlinks ─────────────────────────────────────────────────────────────

  const backlinks = selected
    ? notes.filter((n) => n.id !== selected.id && n.links.includes(selected.title))
    : [];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-lg border border-border/30">
      {/* ── Left panel: note list ──────────────────────────────────────────── */}
      <div className="w-64 shrink-0 flex flex-col border-r border-border/30 bg-sidebar">
        {/* Header */}
        <div className="p-3 border-b border-border/30 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-display tracking-widest text-accent uppercase">Vault</span>
            <button
              onClick={() => setShowNew(true)}
              className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/10 text-muted-foreground hover:text-accent transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search vault…"
              className="pl-6 h-7 text-xs bg-muted/30 border-border/30"
            />
          </div>
          {/* Type filter */}
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setTypeFilter("all")}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${typeFilter === "all" ? "bg-accent/20 text-accent" : "text-muted-foreground hover:text-primary"}`}
            >
              All
            </button>
            {ALL_TYPES.map((t) => {
              const cfg = TYPE_CONFIG[t];
              return (
                <button
                  key={t}
                  onClick={() => setTypeFilter(typeFilter === t ? "all" : t)}
                  className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${typeFilter === t ? "bg-accent/20 text-accent" : "text-muted-foreground hover:text-primary"}`}
                >
                  {cfg.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* New note input */}
        {showNew && (
          <div className="p-2 border-b border-border/30 bg-accent/5 flex gap-1.5">
            <Input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createNote()}
              placeholder="Note title…"
              className="h-7 text-xs flex-1"
              autoFocus
            />
            <button
              onClick={createNote}
              disabled={creating || !newTitle.trim()}
              className="text-accent hover:text-accent/80 disabled:opacity-40"
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              onClick={() => { setShowNew(false); setNewTitle(""); }}
              className="text-muted-foreground hover:text-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-xs text-muted-foreground text-center">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground text-center">
              {search ? "No matches" : "Vault is empty — Atlas will fill it as you talk."}
            </div>
          ) : (
            filtered.map((n) => {
              const cfg = TYPE_CONFIG[n.node_type];
              const Icon = cfg.icon;
              const isActive = selected?.id === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => selectNote(n)}
                  className={`w-full text-left px-3 py-2.5 border-b border-border/20 transition-colors group ${
                    isActive ? "bg-accent/10 border-l-2 border-l-accent" : "hover:bg-muted/30"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${cfg.color}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span className={`text-xs font-medium truncate ${isActive ? "text-accent" : "text-primary"}`}>
                          {n.title}
                        </span>
                        {n.pinned && <Pin className="h-2.5 w-2.5 text-muted-foreground shrink-0" />}
                      </div>
                      {n.tags.length > 0 && (
                        <div className="flex flex-wrap gap-0.5 mt-0.5">
                          {n.tags.slice(0, 3).map((t) => (
                            <span key={t} className="text-[9px] text-muted-foreground">#{t}</span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-[9px] ${n.source === "atlas" ? "text-accent/60" : "text-muted-foreground"}`}>
                          {n.source === "atlas" ? "Atlas" : "Manual"}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {new Date(n.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Stats footer */}
        <div className="p-2 border-t border-border/30 text-[10px] text-muted-foreground flex items-center gap-3">
          <span>{notes.length} notes</span>
          <span>{notes.filter((n) => n.source === "atlas").length} by Atlas</span>
        </div>
      </div>

      {/* ── Right panel: detail / editor / graph ───────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-muted-foreground">
            <GitBranch className="h-10 w-10 mb-3 opacity-20" />
            <p className="text-sm font-medium">Select a note or create one</p>
            <p className="text-xs mt-1 opacity-70 max-w-xs">
              Atlas automatically saves insights here as you have conversations. You can also add notes manually.
            </p>
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30 shrink-0">
              {/* View tabs */}
              <div className="flex items-center gap-1 bg-muted/30 rounded-md p-0.5 text-xs">
                {(["read", "edit", "graph"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => { if (v === "edit") startEdit(); else setView(v); }}
                    className={`px-2.5 py-1 rounded transition-colors capitalize ${
                      view === v ? "bg-accent/20 text-accent" : "text-muted-foreground hover:text-primary"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <div className="flex-1" />
              {/* Actions */}
              {view !== "edit" && (
                <>
                  <button
                    onClick={() => togglePin(selected)}
                    className="text-muted-foreground hover:text-primary transition-colors"
                    title={selected.pinned ? "Unpin" : "Pin"}
                  >
                    {selected.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={startEdit}
                    className="text-muted-foreground hover:text-primary transition-colors"
                    title="Edit"
                  >
                    <Edit3 className="h-4 w-4" />
                  </button>
                  <button
                    onClick={deleteNote}
                    disabled={deleting}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </>
              )}
              {view === "edit" && (
                <>
                  <Button size="sm" onClick={saveEdit} disabled={saving} className="h-7 text-xs">
                    <Check className="h-3.5 w-3.5 mr-1" />
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setView("read")} disabled={saving} className="h-7 text-xs">
                    <X className="h-3.5 w-3.5 mr-1" />
                    Cancel
                  </Button>
                </>
              )}
            </div>

            <div ref={detailRef} className="flex-1 overflow-y-auto">
              {/* ── Read view ─────────────────────────────────────────────── */}
              {view === "read" && (
                <div className="p-5 space-y-4 max-w-2xl">
                  {/* Title + meta */}
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      {(() => {
                        const cfg = TYPE_CONFIG[selected.node_type];
                        const Icon = cfg.icon;
                        return <Icon className={`h-4 w-4 ${cfg.color}`} />;
                      })()}
                      <h2 className="text-base font-semibold text-primary">{selected.title}</h2>
                      {selected.pinned && <Pin className="h-3.5 w-3.5 text-muted-foreground" />}
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(selected.updated_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span className={selected.source === "atlas" ? "text-accent/80" : ""}>
                        {selected.source === "atlas" ? "Saved by Atlas" : selected.source === "conversation" ? "From conversation" : "Manual"}
                      </span>
                      <span className="capitalize">{TYPE_CONFIG[selected.node_type].label}</span>
                    </div>
                  </div>

                  {/* Tags */}
                  {selected.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {selected.tags.map((t) => (
                        <span
                          key={t}
                          onClick={() => setSearch(t)}
                          className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-muted/50 text-muted-foreground rounded cursor-pointer hover:bg-muted hover:text-primary transition-colors"
                        >
                          <Tag className="h-2.5 w-2.5" />
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Content */}
                  <div className="text-sm leading-relaxed">
                    {selected.content ? (
                      <MarkdownView
                        content={selected.content}
                        allTitles={allTitles}
                        onLinkClick={selectByTitle}
                      />
                    ) : (
                      <p className="text-muted-foreground italic text-sm">No content yet. Click Edit to add some.</p>
                    )}
                  </div>

                  {/* Outgoing links */}
                  {selected.links.length > 0 && (
                    <div className="border-t border-border/30 pt-3">
                      <p className="text-[10px] font-display tracking-widest text-muted-foreground uppercase mb-2">Links</p>
                      <div className="flex flex-wrap gap-1.5">
                        {selected.links.map((link) => {
                          const exists = allTitles.includes(link);
                          return (
                            <button
                              key={link}
                              onClick={() => selectByTitle(link)}
                              disabled={!exists}
                              className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                                exists
                                  ? "border-accent/30 text-accent hover:bg-accent/10"
                                  : "border-border/30 text-muted-foreground line-through cursor-default"
                              }`}
                            >
                              [[{link}]]
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Backlinks */}
                  {backlinks.length > 0 && (
                    <div className="border-t border-border/30 pt-3">
                      <p className="text-[10px] font-display tracking-widest text-muted-foreground uppercase mb-2">
                        Backlinks ({backlinks.length})
                      </p>
                      <div className="space-y-1.5">
                        {backlinks.map((bl) => {
                          const cfg = TYPE_CONFIG[bl.node_type];
                          const Icon = cfg.icon;
                          return (
                            <button
                              key={bl.id}
                              onClick={() => selectNote(bl)}
                              className="flex items-center gap-2 text-xs text-muted-foreground hover:text-primary transition-colors"
                            >
                              <Icon className={`h-3 w-3 ${cfg.color}`} />
                              <span>{bl.title}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Edit view ─────────────────────────────────────────────── */}
              {view === "edit" && (
                <div className="p-5 space-y-4 max-w-2xl">
                  <div className="space-y-1">
                    <label className="text-[10px] font-display tracking-widest text-muted-foreground uppercase">Title</label>
                    <Input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="text-sm font-medium"
                      placeholder="Note title"
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-display tracking-widest text-muted-foreground uppercase">Type</label>
                    <div className="flex flex-wrap gap-1.5">
                      {ALL_TYPES.map((t) => {
                        const cfg = TYPE_CONFIG[t];
                        return (
                          <button
                            key={t}
                            onClick={() => setEditType(t as KnowledgeNode["node_type"])}
                            className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                              editType === t
                                ? "border-accent bg-accent/10 text-accent"
                                : "border-border/30 text-muted-foreground hover:text-primary"
                            }`}
                          >
                            {cfg.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-display tracking-widest text-muted-foreground uppercase">Content (Markdown)</label>
                    <Textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="text-sm font-mono resize-none min-h-[280px] leading-relaxed"
                      placeholder="Write in markdown. Use [[Note Title]] to link to other notes."
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] font-display tracking-widest text-muted-foreground uppercase flex items-center gap-1">
                        <Tag className="h-2.5 w-2.5" /> Tags (comma-separated)
                      </label>
                      <Input
                        value={editTags}
                        onChange={(e) => setEditTags(e.target.value)}
                        className="text-xs"
                        placeholder="trading, psychology, pattern"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-display tracking-widest text-muted-foreground uppercase flex items-center gap-1">
                        <GitBranch className="h-2.5 w-2.5" /> Links (comma-separated titles)
                      </label>
                      <Input
                        value={editLinks}
                        onChange={(e) => setEditLinks(e.target.value)}
                        className="text-xs"
                        placeholder="Risk Management, FOMO Pattern"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* ── Graph view ────────────────────────────────────────────── */}
              {view === "graph" && (
                <div className="p-5">
                  <p className="text-[10px] font-display tracking-widest text-muted-foreground uppercase mb-3">
                    Connection Map — {selected.title}
                  </p>
                  <div className="rounded-lg border border-border/30 bg-muted/10">
                    <GraphView selected={selected} notes={notes} onSelect={selectNote} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Bright ring = directly linked. Dim nodes = rest of vault. Click any node to navigate.
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
