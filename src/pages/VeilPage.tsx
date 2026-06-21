import { useEffect, useState, useCallback } from "react";
import { supabase as _sb } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { RefreshCw, Zap, Brain, Eye, GitBranch, Star, AlertCircle } from "lucide-react";
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
  quality_score: number;
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

function confidenceBar(score: number) {
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? "#4ade80" : pct >= 50 ? "#facc15" : "#f87171";
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

// ── Component ──────────────────────────────────────────────────────────────────

const TABS = ["Activity", "Reflections", "Memory", "Cross-Agent"] as const;
type Tab = typeof TABS[number];

export default function VeilPage() {
  const { user } = useAuth();

  const [tab, setTab]               = useState<Tab>("Activity");
  const [agents, setAgents]         = useState<Agent[]>([]);
  const [sessions, setSessions]     = useState<AgentSession[]>([]);
  const [reflections, setRef]       = useState<AgentReflection[]>([]);
  const [crossMem, setCross]        = useState<CrossMemory[]>([]);
  const [memories, setMem]          = useState<AgentMemory[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedRef, setExpandedRef] = useState<string | null>(null);

  const agentMap = Object.fromEntries(agents.map(a => [a.id, a]));
  const agentBySlug = Object.fromEntries(agents.map(a => [a.slug, a]));

  const load = useCallback(async () => {
    if (!user) return;
    setRefreshing(true);
    try {
      const [ag, se, re, cr, me] = await Promise.all([
        db.from("skyforge_agents").select("id,name,slug,avatar_emoji,version").eq("user_id", user.id).eq("is_active", true).order("created_at"),
        db.from("agent_sessions").select("id,agent_id,task_description,outcome,outcome_notes,autonomy_score,started_at,reflected").order("started_at", { ascending: false }).limit(40),
        db.from("agent_reflections").select("id,agent_id,what_worked,what_failed,patterns,blind_spots,autonomy_delta,capability_gaps,quality_score,created_at").order("created_at", { ascending: false }).limit(20),
        db.from("agent_cross_memory").select("id,source_agent,summary,topic,created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(60),
        db.from("agent_memory").select("id,agent_id,memory_type,key,value,confidence").order("confidence", { ascending: false }).limit(60),
      ]);
      setAgents(ag.data ?? []);
      setSessions(se.data ?? []);
      setRef(re.data ?? []);
      setCross(cr.data ?? []);
      setMem(me.data ?? []);
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
  const avgQuality = reflections.length ? (reflections.reduce((a, r) => a + r.quality_score, 0) / reflections.length).toFixed(2) : "—";

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
            { icon: Zap,          label: "Sessions today",       value: sessionsToday },
            { icon: Brain,        label: "Awaiting reflection",  value: pendingReflections },
            { icon: Star,         label: "Avg quality score",    value: avgQuality },
            { icon: GitBranch,    label: "Cross-agent signals",  value: crossMem.length },
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
        <div className="flex gap-1 mt-4">
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
                      {!s.reflected && (
                        <span className="text-[10px] text-yellow-400/70">• awaiting reflection</span>
                      )}
                      <span className="ml-auto text-[10px] text-muted-foreground/40">{timeAgo(s.started_at)}</span>
                    </div>
                    <p className="text-xs text-foreground/80 leading-relaxed">{s.task_description || "—"}</p>
                    {s.outcome_notes && (
                      <p className="text-[11px] text-muted-foreground/50 mt-1 italic">{s.outcome_notes}</p>
                    )}
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
                  {/* Card header */}
                  <button
                    onClick={() => setExpandedRef(open ? null : r.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-secondary/10 transition-colors text-left"
                  >
                    <span className="text-lg shrink-0">{ag?.avatar_emoji ?? "🤖"}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium" style={{ color: ag ? agentColor(ag.slug) : undefined }}>
                          {ag?.name ?? "Unknown"}
                        </span>
                        {qualityDot(r.quality_score)}
                        <span className="text-[10px] text-muted-foreground/40">score {r.quality_score.toFixed(2)}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground/40">{timeAgo(r.created_at)}</span>
                      </div>
                      {!open && (
                        <p className="text-[11px] text-muted-foreground/60 mt-0.5 truncate">{r.what_worked}</p>
                      )}
                    </div>
                    <span className="text-muted-foreground/30 text-xs ml-2">{open ? "▲" : "▼"}</span>
                  </button>

                  {/* Expanded body */}
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
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] font-medium text-foreground/80">{m.key}</span>
                              </div>
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
            {memories.length === 0 && (
              <p className="text-xs text-muted-foreground/40 text-center py-12">No agent memories recorded yet.</p>
            )}
          </div>
        )}

        {/* ── Cross-Agent ── */}
        {tab === "Cross-Agent" && (
          <div className="space-y-2 max-w-3xl">
            <p className="text-[11px] text-muted-foreground/40 mb-4">
              Signals agents have written into the shared channel — observations, decisions, and moments they've flagged for other agents to know about.
            </p>
            {crossMem.length === 0 && (
              <p className="text-xs text-muted-foreground/40 text-center py-12">No cross-agent signals yet.</p>
            )}
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
                      {c.topic && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground/50">{c.topic}</span>
                      )}
                      <span className="ml-auto text-[10px] text-muted-foreground/40">{timeAgo(c.created_at)}</span>
                    </div>
                    <p className="text-xs text-foreground/75 leading-relaxed">{c.summary}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
