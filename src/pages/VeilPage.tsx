import { useEffect, useState, useCallback } from "react";
import { supabase as _sb } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  RefreshCw, Zap, Brain, GitBranch, Star,
  Plus, Trash2, ToggleLeft, ToggleRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const db = _sb as any;

// ── Types ──────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  slug: string;
  avatar_emoji: string;
  version: number;
}

interface AgentSession {
  id: string;
  agent_id: string;
  task_description: string;
  outcome: string | null;
  outcome_notes: string | null;
  autonomy_score: number | null;
  started_at: string;
  reflected: boolean;
}

interface AgentReflection {
  id: string;
  agent_id: string;
  what_worked: string;
  what_failed: string;
  patterns: string;
  blind_spots: string;
  autonomy_delta: string;
  capability_gaps: string;
  quality_score: number | null;
  created_at: string;
}

interface CrossMemory {
  id: string;
  source_agent: string;
  summary: string;
  topic: string | null;
  created_at: string;
}

interface AgentMemory {
  id: string;
  agent_id: string;
  memory_type: string;
  key: string;
  value: string;
  confidence: number;
}

interface CharacterState {
  id: string;
  agent_id: string;
  developmental_stage: "early" | "developing" | "mature" | "senior";
  character_summary: string | null;
  voice_evolution: string | null;
  earned_strengths: string[];
  known_blind_spots: string[];
  sycophancy_score: number;
  calibration_score: number;
  formative_event_count: number;
  updated_at: string;
}

interface RelationshipLedger {
  id: string;
  agent_a_slug: string;
  agent_b_slug: string;
  interaction_count: number;
  agreement_count: number;
  disagreement_count: number;
  current_dynamic: string;
  relationship_summary: string | null;
  domain_deference: Record<string, string>;
  last_interaction_at: string | null;
}

interface FormativeEvent {
  id: string;
  agent_id: string;
  event_summary: string;
  belief_before: string | null;
  belief_after: string | null;
  character_implication: string | null;
  domain: string | null;
  impact_score: number;
  created_at: string;
}

interface Directive {
  id: string;
  title: string;
  prompt_text: string;
  is_active: boolean;
  scope: string;
  category: string;
  sort_order: number;
  created_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function agentColor(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 360;
  return `hsl(${h} 65% 60%)`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function confidenceBar(score: number, invertColor = false) {
  const pct = Math.round(score * 100);
  const good = pct >= 80 ? "#4ade80" : pct >= 50 ? "#facc15" : "#f87171";
  const color = invertColor ? (pct <= 20 ? "#4ade80" : pct <= 50 ? "#facc15" : "#f87171") : good;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[10px] tabular-nums" style={{ color }}>{pct}%</span>
    </div>
  );
}

function qualityDot(score: number) {
  const color = score >= 0.8 ? "#4ade80" : score >= 0.5 ? "#facc15" : "#f87171";
  return <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color }} />;
}

const STAGE_COLORS: Record<string, string> = {
  early: "#60a5fa",
  developing: "#facc15",
  mature: "#4ade80",
  senior: "#c084fc",
};

const DYNAMIC_COLORS: Record<string, string> = {
  peer: "#a1a1aa",
  mentor_a: "#4ade80",
  mentor_b: "#60a5fa",
  challenger: "#f87171",
  collaborator: "#fb923c",
  rival: "#c084fc",
};

const CATEGORY_COLORS: Record<string, string> = {
  communication: "#60a5fa",
  reasoning: "#c084fc",
  output_format: "#fb923c",
  persona: "#facc15",
  epistemic: "#4ade80",
};

const PRESET_DIRECTIVES = [
  { title: "Get to the point", prompt_text: "Be extremely direct. Skip preamble, skip conclusions, skip 'In summary'. Open with the answer. Every word must earn its place.", category: "communication" },
  { title: "Pros and cons", prompt_text: "For every recommendation or decision, structure your response as: PROS (bullet list) then CONS (bullet list). Do not skip either side.", category: "reasoning" },
  { title: "Caveman mode", prompt_text: "Speak in short, blunt sentences. Big words = bad. Small words = good. Say exactly what you mean. No fluff.", category: "persona" },
  { title: "Devil's advocate", prompt_text: "Challenge every assumption. Before agreeing with anything, find the strongest counterargument. Label it [CHALLENGE] when you push back.", category: "epistemic" },
  { title: "Bullet only", prompt_text: "All responses must be bulleted lists. No paragraphs. No prose. Just bullets.", category: "output_format" },
  { title: "Cite confidence", prompt_text: "Tag every claim with your confidence: [HIGH], [MEDIUM], or [LOW]. Never state anything without its confidence tag.", category: "epistemic" },
];

// ── Component ──────────────────────────────────────────────────────────────────

const TABS = ["Activity", "Reflections", "Memory", "Cross-Agent", "Character", "Relationships", "Directives", "Growth"] as const;
type Tab = typeof TABS[number];

export default function VeilPage() {
  const { user } = useAuth();

  const [tab, setTab]                 = useState<Tab>("Activity");
  const [agents, setAgents]           = useState<Agent[]>([]);
  const [sessions, setSessions]       = useState<AgentSession[]>([]);
  const [reflections, setRef]         = useState<AgentReflection[]>([]);
  const [crossMem, setCross]          = useState<CrossMemory[]>([]);
  const [memories, setMem]            = useState<AgentMemory[]>([]);
  const [chars, setChars]             = useState<CharacterState[]>([]);
  const [rels, setRels]               = useState<RelationshipLedger[]>([]);
  const [events, setEvents]           = useState<FormativeEvent[]>([]);
  const [directives, setDirectives]   = useState<Directive[]>([]);
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);
  const [expandedRef, setExpandedRef] = useState<string | null>(null);

  // directive form state
  const [showForm, setShowForm]       = useState(false);
  const [newTitle, setNewTitle]       = useState("");
  const [newPrompt, setNewPrompt]     = useState("");
  const [newCategory, setNewCategory] = useState("communication");
  const [newScope, setNewScope]       = useState("all");
  const [saving, setSaving]           = useState(false);

  const agentMap = Object.fromEntries(agents.map(a => [a.id, a]));
  const agentBySlug = Object.fromEntries(agents.map(a => [a.slug, a]));
  const charMap = Object.fromEntries(chars.map(c => [c.agent_id, c]));

  const load = useCallback(async () => {
    if (!user) return;
    setRefreshing(true);
    try {
      const [ag, se, re, cr, me, ch, rl, ev, dir] = await Promise.all([
        db.from("skyforge_agents").select("id,name,slug,avatar_emoji,version").eq("user_id", user.id).eq("is_active", true).order("created_at"),
        db.from("agent_sessions").select("id,agent_id,task_description,outcome,outcome_notes,autonomy_score,started_at,reflected").order("started_at", { ascending: false }).limit(40),
        db.from("agent_reflections").select("id,agent_id,what_worked,what_failed,patterns,blind_spots,autonomy_delta,capability_gaps,quality_score,created_at").order("created_at", { ascending: false }).limit(20),
        db.from("agent_cross_memory").select("id,source_agent,summary,topic,created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(60),
        db.from("agent_memory").select("id,agent_id,memory_type,key,value,confidence").order("confidence", { ascending: false }).limit(60),
        db.from("agent_character_state").select("*").eq("user_id", user.id),
        db.from("agent_relationship_ledger").select("*").eq("user_id", user.id),
        db.from("agent_formative_events").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(40),
        db.from("operator_directives").select("*").eq("user_id", user.id).order("sort_order").order("created_at"),
      ]);
      setAgents(ag.data ?? []);
      setSessions(se.data ?? []);
      setRef(re.data ?? []);
      setCross(cr.data ?? []);
      setMem(me.data ?? []);
      setChars(ch.data ?? []);
      setRels(rl.data ?? []);
      setEvents(ev.data ?? []);
      setDirectives(dir.data ?? []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  // realtime: cross-memory inserts
  useEffect(() => {
    if (!user) return;
    const ch = db.channel("veil_cross_memory")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_cross_memory", filter: `user_id=eq.${user.id}` },
        (p: { new: CrossMemory }) => setCross(prev => [p.new, ...prev].slice(0, 60)))
      .subscribe();
    return () => { void db.removeChannel(ch); };
  }, [user]);

  // stats
  const today = new Date().toISOString().slice(0, 10);
  const sessionsToday = sessions.filter(s => s.started_at.startsWith(today)).length;
  const pendingReflections = sessions.filter(s => !s.reflected).length;
  const avgQuality = reflections.length ? (reflections.reduce((a, r) => a + (r.quality_score ?? 0), 0) / reflections.length).toFixed(2) : "—";

  async function toggleDirective(id: string, current: boolean) {
    await db.from("operator_directives").update({ is_active: !current }).eq("id", id);
    setDirectives(prev => prev.map(d => d.id === id ? { ...d, is_active: !current } : d));
  }

  async function deleteDirective(id: string) {
    await db.from("operator_directives").delete().eq("id", id);
    setDirectives(prev => prev.filter(d => d.id !== id));
  }

  async function createDirective() {
    if (!user || !newTitle.trim() || !newPrompt.trim()) return;
    setSaving(true);
    const { data } = await db.from("operator_directives").insert({
      user_id: user.id,
      title: newTitle.trim(),
      prompt_text: newPrompt.trim(),
      category: newCategory,
      scope: newScope,
      is_active: true,
    }).select().single();
    if (data) setDirectives(prev => [...prev, data]);
    setNewTitle(""); setNewPrompt(""); setShowForm(false); setSaving(false);
  }

  async function addPreset(p: typeof PRESET_DIRECTIVES[0]) {
    if (!user) return;
    const { data } = await db.from("operator_directives").insert({
      user_id: user.id, title: p.title, prompt_text: p.prompt_text,
      category: p.category, scope: "all", is_active: false,
    }).select().single();
    if (data) setDirectives(prev => [...prev, data]);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary/40 font-display tracking-widest text-sm animate-pulse">LIFTING THE VEIL…</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header */}
      <div className="shrink-0 border-b border-border/30 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-lg tracking-widest text-primary text-glow-blue">THE VEIL</h1>
            <p className="text-xs text-muted-foreground/50 mt-0.5">Behind-the-scenes agent activity — what they're doing, thinking, and learning</p>
          </div>
          <Button size="sm" variant="ghost" onClick={load} disabled={refreshing} className="gap-1.5 text-xs text-muted-foreground">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-4 gap-3 mt-4">
          {[
            { icon: Zap,       label: "Sessions today",      value: sessionsToday },
            { icon: Brain,     label: "Awaiting reflection", value: pendingReflections },
            { icon: Star,      label: "Avg quality score",   value: avgQuality },
            { icon: GitBranch, label: "Cross-agent signals", value: crossMem.length },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="bg-secondary/10 border border-border/20 rounded-lg px-3 py-2">
              <div className="flex items-center gap-1.5 text-muted-foreground/50 mb-1">
                <Icon className="h-3 w-3" />
                <span className="text-[10px] uppercase tracking-wider">{label}</span>
              </div>
              <div className="text-lg font-display text-primary">{value}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-1 mt-4">
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                tab === t ? "bg-accent/20 text-accent" : "text-muted-foreground/60 hover:text-muted-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4">

        {/* ── Activity ── */}
        {tab === "Activity" && (
          <div className="space-y-2 max-w-3xl">
            {sessions.length === 0 && (
              <p className="text-xs text-muted-foreground/40 text-center py-12">No agent sessions recorded yet.</p>
            )}
            {sessions.map(s => {
              const ag = agentMap[s.agent_id];
              const outcomeColor = s.outcome === "success" ? "#4ade80" : s.outcome === "failure" ? "#f87171" : "#a1a1aa";
              return (
                <div key={s.id} className="flex gap-3 items-start bg-secondary/5 border border-border/20 rounded-lg px-4 py-3 hover:bg-secondary/10 transition-colors">
                  <div className="text-xl shrink-0 mt-0.5">{ag?.avatar_emoji ?? "🤖"}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-primary" style={{ color: ag ? agentColor(ag.slug) : undefined }}>
                        {ag?.name ?? "Unknown agent"}
                      </span>
                      {s.outcome && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border" style={{ color: outcomeColor, borderColor: outcomeColor + "40" }}>
                          {s.outcome}
                        </span>
                      )}
                      {!s.reflected && <span className="text-[10px] text-yellow-400/70">• awaiting reflection</span>}
                      <span className="ml-auto text-[10px] text-muted-foreground/40">{timeAgo(s.started_at)}</span>
                    </div>
                    <p className="text-xs text-foreground/80 leading-relaxed">{s.task_description || "—"}</p>
                    {s.outcome_notes && <p className="text-[11px] text-muted-foreground/50 mt-1 italic">{s.outcome_notes}</p>}
                    {s.autonomy_score != null && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground/40">Autonomy</span>
                        {confidenceBar(s.autonomy_score)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Reflections ── */}
        {tab === "Reflections" && (
          <div className="space-y-3 max-w-3xl">
            {reflections.length === 0 && (
              <p className="text-xs text-muted-foreground/40 text-center py-12">No reflections yet. Agents reflect automatically after sessions.</p>
            )}
            {reflections.map(r => {
              const ag = agentMap[r.agent_id];
              const open = expandedRef === r.id;
              return (
                <div key={r.id} className="border border-border/20 rounded-lg overflow-hidden bg-secondary/5">
                  <button
                    onClick={() => setExpandedRef(open ? null : r.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-secondary/10 transition-colors text-left"
                  >
                    <span className="text-lg shrink-0">{ag?.avatar_emoji ?? "🤖"}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium" style={{ color: ag ? agentColor(ag.slug) : undefined }}>{ag?.name ?? "Unknown"}</span>
                        {qualityDot(r.quality_score ?? 0)}
                        <span className="text-[10px] text-muted-foreground/40">score {(r.quality_score ?? 0).toFixed(2)}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground/40">{timeAgo(r.created_at)}</span>
                      </div>
                      {!open && <p className="text-[11px] text-muted-foreground/60 mt-0.5 truncate">{r.what_worked}</p>}
                    </div>
                    <span className="text-muted-foreground/30 text-xs ml-2">{open ? "▲" : "▼"}</span>
                  </button>
                  {open && (
                    <div className="border-t border-border/20 px-4 py-3 grid grid-cols-2 gap-4 text-xs">
                      {[
                        { label: "What worked",      value: r.what_worked,     color: "#4ade80" },
                        { label: "What failed",      value: r.what_failed,     color: "#f87171" },
                        { label: "Patterns noticed", value: r.patterns,        color: "#60a5fa" },
                        { label: "Blind spots",      value: r.blind_spots,     color: "#facc15" },
                        { label: "Autonomy delta",   value: r.autonomy_delta,  color: "#c084fc" },
                        { label: "Capability gaps",  value: r.capability_gaps, color: "#fb923c" },
                      ].map(({ label, value, color }) => (
                        <div key={label} className="space-y-1">
                          <div className="text-[10px] uppercase tracking-wider" style={{ color }}>{label}</div>
                          <p className="text-foreground/70 leading-relaxed">{value || "—"}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Memory ── */}
        {tab === "Memory" && (
          <div className="space-y-4">
            {memories.length === 0 && <p className="text-xs text-muted-foreground/40 text-center py-12">No agent memories recorded yet.</p>}
            {agents.map(ag => {
              const agMems = memories.filter(m => m.agent_id === ag.id);
              if (!agMems.length) return null;
              const grouped: Record<string, AgentMemory[]> = {};
              for (const m of agMems) { (grouped[m.memory_type] ||= []).push(m); }
              return (
                <div key={ag.id} className="border border-border/20 rounded-lg overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-secondary/10 border-b border-border/20">
                    <span className="text-base">{ag.avatar_emoji}</span>
                    <span className="text-xs font-medium" style={{ color: agentColor(ag.slug) }}>{ag.name}</span>
                    <span className="text-[10px] text-muted-foreground/40 ml-auto">v{ag.version} · {agMems.length} beliefs</span>
                  </div>
                  <div className="p-4 space-y-4">
                    {Object.entries(grouped).map(([type, mems]) => (
                      <div key={type}>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/40 mb-2">{type.replace(/_/g, " ")}</div>
                        <div className="space-y-2">
                          {mems.map(m => (
                            <div key={m.id} className="space-y-1">
                              <span className="text-[11px] font-medium text-foreground/80">{m.key}</span>
                              <p className="text-xs text-foreground/60 leading-relaxed">{m.value}</p>
                              {confidenceBar(m.confidence)}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Cross-Agent ── */}
        {tab === "Cross-Agent" && (
          <div className="space-y-2 max-w-3xl">
            <p className="text-[11px] text-muted-foreground/40 mb-4">
              Signals agents have written into the shared channel — observations, decisions, and moments they've flagged for other agents.
            </p>
            {crossMem.length === 0 && <p className="text-xs text-muted-foreground/40 text-center py-12">No cross-agent signals yet.</p>}
            {crossMem.map(c => {
              const ag = agentBySlug[c.source_agent];
              return (
                <div key={c.id} className="flex gap-3 items-start px-4 py-3 bg-secondary/5 border border-border/20 rounded-lg">
                  <div className="text-base shrink-0 mt-0.5">{ag?.avatar_emoji ?? "🤖"}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[11px] font-medium" style={{ color: ag ? agentColor(ag.slug) : "#a1a1aa" }}>
                        {ag?.name ?? c.source_agent}
                      </span>
                      {c.topic && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground/50">{c.topic}</span>}
                      <span className="ml-auto text-[10px] text-muted-foreground/40">{timeAgo(c.created_at)}</span>
                    </div>
                    <p className="text-xs text-foreground/75 leading-relaxed">{c.summary}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Character ── */}
        {tab === "Character" && (
          <div className="space-y-4 max-w-3xl">
            <p className="text-[11px] text-muted-foreground/40 mb-2">
              Updated every Sunday by the weekly synthesis. Shows who each agent is becoming — their stage, voice, strengths, and blind spots earned through real sessions.
            </p>
            {agents.length === 0 && <p className="text-xs text-muted-foreground/40 text-center py-12">No agents found.</p>}
            {agents.map(ag => {
              const ch = charMap[ag.id];
              const stage = ch?.developmental_stage ?? "early";
              const stageColor = STAGE_COLORS[stage] ?? "#a1a1aa";
              return (
                <div key={ag.id} className="border border-border/20 rounded-lg overflow-hidden bg-secondary/5">
                  {/* Agent header */}
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-border/20 bg-secondary/10">
                    <span className="text-xl">{ag.avatar_emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium" style={{ color: agentColor(ag.slug) }}>{ag.name}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full border font-display tracking-wide"
                          style={{ color: stageColor, borderColor: stageColor + "40", background: stageColor + "10" }}>
                          {stage.toUpperCase()}
                        </span>
                        {ch && <span className="text-[10px] text-muted-foreground/40 ml-auto">updated {timeAgo(ch.updated_at)}</span>}
                      </div>
                      {ch?.character_summary && (
                        <p className="text-[11px] text-foreground/70 mt-1 leading-relaxed">{ch.character_summary}</p>
                      )}
                      {!ch && <p className="text-[11px] text-muted-foreground/40 mt-1">No character data yet — runs Sunday after first week of sessions.</p>}
                    </div>
                  </div>

                  {ch && (
                    <div className="p-4 grid grid-cols-2 gap-4">
                      {/* Voice evolution */}
                      {ch.voice_evolution && (
                        <div className="col-span-2">
                          <div className="text-[10px] uppercase tracking-wider text-blue-400/70 mb-1">Voice evolution</div>
                          <p className="text-xs text-foreground/60 leading-relaxed italic">{ch.voice_evolution}</p>
                        </div>
                      )}

                      {/* Earned strengths */}
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-green-400/70 mb-2">Earned strengths</div>
                        {(ch.earned_strengths ?? []).length === 0
                          ? <p className="text-xs text-muted-foreground/40">None yet</p>
                          : <ul className="space-y-1">{ch.earned_strengths.map((s, i) => (
                              <li key={i} className="text-xs text-foreground/70 flex gap-1.5 items-start">
                                <span className="text-green-400/50 shrink-0 mt-0.5">✓</span>{s}
                              </li>
                            ))}</ul>
                        }
                      </div>

                      {/* Known blind spots */}
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-yellow-400/70 mb-2">Known blind spots</div>
                        {(ch.known_blind_spots ?? []).length === 0
                          ? <p className="text-xs text-muted-foreground/40">None identified</p>
                          : <ul className="space-y-1">{ch.known_blind_spots.map((s, i) => (
                              <li key={i} className="text-xs text-foreground/70 flex gap-1.5 items-start">
                                <span className="text-yellow-400/50 shrink-0 mt-0.5">△</span>{s}
                              </li>
                            ))}</ul>
                        }
                      </div>

                      {/* Scores */}
                      <div className="col-span-2 grid grid-cols-2 gap-4 pt-2 border-t border-border/10">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/40 mb-1.5">
                            Sycophancy score <span className="text-[9px] normal-case">(lower = better)</span>
                          </div>
                          {confidenceBar(ch.sycophancy_score ?? 0.5, true)}
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/40 mb-1.5">
                            Calibration score <span className="text-[9px] normal-case">(higher = better)</span>
                          </div>
                          {confidenceBar(ch.calibration_score ?? 0.5)}
                        </div>
                      </div>

                      {/* Formative events count */}
                      <div className="col-span-2 text-[10px] text-muted-foreground/30">
                        {ch.formative_event_count} formative event{ch.formative_event_count !== 1 ? "s" : ""} recorded
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Relationships ── */}
        {tab === "Relationships" && (
          <div className="space-y-4 max-w-3xl">
            <p className="text-[11px] text-muted-foreground/40 mb-2">
              How agents relate to each other — their dynamic, who defers to whom, and how that's shifting over time.
            </p>
            {rels.length === 0 && (
              <div className="text-center py-12 space-y-2">
                <p className="text-xs text-muted-foreground/40">No relationship data yet.</p>
                <p className="text-[11px] text-muted-foreground/30">Relationships are assessed each Sunday after agents have been active together.</p>
              </div>
            )}
            {rels.map(r => {
              const agA = agentBySlug[r.agent_a_slug];
              const agB = agentBySlug[r.agent_b_slug];
              const dynColor = DYNAMIC_COLORS[r.current_dynamic] ?? "#a1a1aa";
              const agreementRate = r.interaction_count > 0
                ? Math.round((r.agreement_count / r.interaction_count) * 100)
                : null;
              return (
                <div key={r.id} className="border border-border/20 rounded-lg overflow-hidden bg-secondary/5">
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-border/20 bg-secondary/10">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{agA?.avatar_emoji ?? "🤖"}</span>
                      <span className="text-xs font-medium" style={{ color: agA ? agentColor(r.agent_a_slug) : "#a1a1aa" }}>
                        {agA?.name ?? r.agent_a_slug}
                      </span>
                    </div>
                    <span className="text-muted-foreground/30 text-xs">↔</span>
                    <div className="flex items-center gap-2">
                      <span className="text-base">{agB?.avatar_emoji ?? "🤖"}</span>
                      <span className="text-xs font-medium" style={{ color: agB ? agentColor(r.agent_b_slug) : "#a1a1aa" }}>
                        {agB?.name ?? r.agent_b_slug}
                      </span>
                    </div>
                    <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full border font-display tracking-wide"
                      style={{ color: dynColor, borderColor: dynColor + "40", background: dynColor + "10" }}>
                      {r.current_dynamic.replace("_", " ")}
                    </span>
                  </div>
                  <div className="p-4 space-y-3">
                    {r.relationship_summary && (
                      <p className="text-xs text-foreground/70 leading-relaxed">{r.relationship_summary}</p>
                    )}
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div className="bg-secondary/10 rounded-lg py-2">
                        <div className="text-sm font-display text-primary">{r.interaction_count}</div>
                        <div className="text-[10px] text-muted-foreground/40">interactions</div>
                      </div>
                      <div className="bg-secondary/10 rounded-lg py-2">
                        <div className="text-sm font-display" style={{ color: "#4ade80" }}>{r.agreement_count}</div>
                        <div className="text-[10px] text-muted-foreground/40">agreements</div>
                      </div>
                      <div className="bg-secondary/10 rounded-lg py-2">
                        <div className="text-sm font-display" style={{ color: "#f87171" }}>{r.disagreement_count}</div>
                        <div className="text-[10px] text-muted-foreground/40">challenges</div>
                      </div>
                    </div>
                    {agreementRate !== null && (
                      <div>
                        <div className="text-[10px] text-muted-foreground/40 mb-1">Agreement rate</div>
                        {confidenceBar(agreementRate / 100)}
                      </div>
                    )}
                    {Object.keys(r.domain_deference ?? {}).length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/40 mb-1.5">Domain deference</div>
                        <div className="space-y-1">
                          {Object.entries(r.domain_deference).map(([domain, who]) => (
                            <div key={domain} className="flex items-center justify-between text-xs">
                              <span className="text-foreground/60">{domain}</span>
                              <span className="text-muted-foreground/50">{who} leads</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {r.last_interaction_at && (
                      <div className="text-[10px] text-muted-foreground/30">Last active {timeAgo(r.last_interaction_at)}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Directives ── */}
        {tab === "Directives" && (
          <div className="max-w-3xl space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground/40">
                Drop a directive and every agent immediately follows it. Toggle off to return to default behavior.
              </p>
              <Button size="sm" variant="ghost" onClick={() => setShowForm(!showForm)} className="gap-1.5 text-xs">
                <Plus className="h-3.5 w-3.5" />
                New
              </Button>
            </div>

            {/* Create form */}
            {showForm && (
              <div className="border border-border/30 rounded-lg p-4 space-y-3 bg-secondary/10">
                <div className="text-xs font-medium text-primary">New directive</div>
                <input
                  className="w-full bg-secondary/20 border border-border/30 rounded-md px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/30 outline-none focus:border-accent/50"
                  placeholder="Title (e.g. 'Be blunt')"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                />
                <textarea
                  className="w-full bg-secondary/20 border border-border/30 rounded-md px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/30 outline-none focus:border-accent/50 resize-none"
                  placeholder="Prompt text — the actual instruction injected into every agent's system prompt..."
                  rows={3}
                  value={newPrompt}
                  onChange={e => setNewPrompt(e.target.value)}
                />
                <div className="flex gap-2">
                  <select
                    className="flex-1 bg-secondary/20 border border-border/30 rounded-md px-3 py-1.5 text-xs text-foreground outline-none"
                    value={newCategory}
                    onChange={e => setNewCategory(e.target.value)}
                  >
                    {["communication", "reasoning", "output_format", "persona", "epistemic"].map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <select
                    className="flex-1 bg-secondary/20 border border-border/30 rounded-md px-3 py-1.5 text-xs text-foreground outline-none"
                    value={newScope}
                    onChange={e => setNewScope(e.target.value)}
                  >
                    <option value="all">All agents</option>
                    {agents.map(a => <option key={a.slug} value={`agent:${a.slug}`}>{a.name} only</option>)}
                  </select>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="ghost" onClick={() => setShowForm(false)} className="text-xs">Cancel</Button>
                  <Button size="sm" onClick={createDirective} disabled={saving || !newTitle.trim() || !newPrompt.trim()} className="text-xs">
                    Create & activate
                  </Button>
                </div>
              </div>
            )}

            {/* Active directives */}
            {directives.length > 0 && (
              <div className="space-y-2">
                {directives.map(d => {
                  const catColor = CATEGORY_COLORS[d.category] ?? "#a1a1aa";
                  return (
                    <div key={d.id} className={`border rounded-lg px-4 py-3 transition-all ${d.is_active ? "border-accent/30 bg-accent/5" : "border-border/20 bg-secondary/5"}`}>
                      <div className="flex items-start gap-3">
                        <button onClick={() => toggleDirective(d.id, d.is_active)} className="shrink-0 mt-0.5 hover:opacity-80 transition-opacity">
                          {d.is_active
                            ? <ToggleRight className="h-5 w-5 text-accent" />
                            : <ToggleLeft className="h-5 w-5 text-muted-foreground/30" />
                          }
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-medium text-foreground/90">{d.title}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: catColor, background: catColor + "15" }}>{d.category}</span>
                            {d.scope !== "all" && (
                              <span className="text-[10px] text-muted-foreground/40">{d.scope.replace("agent:", "")} only</span>
                            )}
                          </div>
                          <p className="text-[11px] text-foreground/60 leading-relaxed">{d.prompt_text}</p>
                        </div>
                        <button onClick={() => deleteDirective(d.id)} className="shrink-0 hover:text-red-400 text-muted-foreground/20 transition-colors">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {directives.length === 0 && !showForm && (
              <p className="text-xs text-muted-foreground/40 text-center py-8">No directives yet. Create one above or add a preset below.</p>
            )}

            {/* Presets */}
            <div className="border-t border-border/10 pt-4">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/30 mb-3">Preset directives</div>
              <div className="grid grid-cols-2 gap-2">
                {PRESET_DIRECTIVES.filter(p => !directives.some(d => d.title === p.title)).map(p => {
                  const catColor = CATEGORY_COLORS[p.category] ?? "#a1a1aa";
                  return (
                    <button
                      key={p.title}
                      onClick={() => addPreset(p)}
                      className="text-left border border-dashed border-border/20 rounded-lg px-3 py-2.5 hover:border-border/40 hover:bg-secondary/5 transition-all"
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[10px] font-medium text-foreground/70">{p.title}</span>
                        <span className="text-[9px] px-1 rounded" style={{ color: catColor, background: catColor + "15" }}>{p.category}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground/40 leading-relaxed line-clamp-2">{p.prompt_text}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── Growth ── */}
        {tab === "Growth" && (
          <div className="max-w-3xl space-y-6">
            <p className="text-[11px] text-muted-foreground/40">
              The living record of what changed agents. Formative events, stage progressions, and the daily synthesis of collective learning.
            </p>

            {/* Stage progression — all agents at a glance */}
            {agents.length > 0 && (
              <div className="border border-border/20 rounded-lg p-4">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/30 mb-3">Developmental stages</div>
                <div className="space-y-3">
                  {agents.map(ag => {
                    const ch = charMap[ag.id];
                    const stage = ch?.developmental_stage ?? "early";
                    const stageColor = STAGE_COLORS[stage] ?? "#a1a1aa";
                    const stageNum = ["early", "developing", "mature", "senior"].indexOf(stage);
                    const pct = ((stageNum + 1) / 4) * 100;
                    return (
                      <div key={ag.id} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{ag.avatar_emoji}</span>
                          <span className="text-xs" style={{ color: agentColor(ag.slug) }}>{ag.name}</span>
                          <span className="ml-auto text-[10px]" style={{ color: stageColor }}>{stage}</span>
                        </div>
                        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: stageColor }} />
                        </div>
                        {ch && (
                          <div className="text-[10px] text-muted-foreground/30">
                            {ch.formative_event_count} formative event{ch.formative_event_count !== 1 ? "s" : ""}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Formative events timeline */}
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/30 mb-3">Formative events</div>
              {events.length === 0 ? (
                <p className="text-xs text-muted-foreground/40 text-center py-8">No formative events yet. These appear after the weekly synthesis runs and detects a moment that genuinely changed an agent's beliefs.</p>
              ) : (
                <div className="space-y-3">
                  {events.map(ev => {
                    const ag = agentMap[ev.agent_id];
                    const impactColor = ev.impact_score >= 0.8 ? "#c084fc" : ev.impact_score >= 0.5 ? "#fb923c" : "#60a5fa";
                    return (
                      <div key={ev.id} className="border border-border/20 rounded-lg p-4 bg-secondary/5 space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="text-base">{ag?.avatar_emoji ?? "🤖"}</span>
                          <span className="text-xs font-medium" style={{ color: ag ? agentColor(ag.slug) : "#a1a1aa" }}>{ag?.name ?? "Unknown"}</span>
                          {ev.domain && <span className="text-[10px] px-1.5 py-0.5 bg-white/5 rounded text-muted-foreground/50">{ev.domain}</span>}
                          <span className="ml-auto text-[10px]" style={{ color: impactColor }}>impact {Math.round(ev.impact_score * 100)}%</span>
                          <span className="text-[10px] text-muted-foreground/30">{timeAgo(ev.created_at)}</span>
                        </div>
                        <p className="text-xs text-foreground/80 leading-relaxed">{ev.event_summary}</p>
                        {(ev.belief_before || ev.belief_after) && (
                          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/10">
                            {ev.belief_before && (
                              <div>
                                <div className="text-[10px] text-red-400/60 mb-1">Before</div>
                                <p className="text-[11px] text-foreground/60 leading-relaxed italic">{ev.belief_before}</p>
                              </div>
                            )}
                            {ev.belief_after && (
                              <div>
                                <div className="text-[10px] text-green-400/60 mb-1">After</div>
                                <p className="text-[11px] text-foreground/60 leading-relaxed italic">{ev.belief_after}</p>
                              </div>
                            )}
                          </div>
                        )}
                        {ev.character_implication && (
                          <p className="text-[10px] text-purple-400/60 italic border-l-2 border-purple-400/20 pl-3">{ev.character_implication}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Daily synthesis history */}
            {crossMem.filter(c => c.topic === "daily_synthesis" || c.topic === "character_synthesis").length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/30 mb-3">Synthesis log</div>
                <div className="space-y-2">
                  {crossMem
                    .filter(c => c.topic === "daily_synthesis" || c.topic === "character_synthesis")
                    .slice(0, 15)
                    .map(c => (
                      <div key={c.id} className="px-4 py-3 bg-secondary/5 border border-border/10 rounded-lg">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground/40">{c.topic?.replace("_", " ")}</span>
                          <span className="ml-auto text-[10px] text-muted-foreground/30">{timeAgo(c.created_at)}</span>
                        </div>
                        <p className="text-xs text-foreground/65 leading-relaxed">{c.summary}</p>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
