import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import {
  Bot, Plus, ChevronRight, Zap, Brain, Shield, Activity,
  Download, RefreshCw, AlertTriangle, CheckCircle2, Clock,
  Cpu, MemoryStick, Network, X, Loader2
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatar_emoji: string;
  system_prompt: string;
  bio: string[];
  topics: string[];
  style_notes: string[];
  clients: string[];
  plugins: string[];
  capabilities: Capability[];
  auto_execute: boolean;
  reflect_after_sessions: number;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

interface Capability {
  name: string;
  description: string;
  examples: string[];
}

interface AgentMemory {
  memory_type: string;
  key: string;
  value: string;
  confidence: number;
  evidence_count: number;
}

interface AgentSession {
  id: string;
  outcome: string;
  autonomy_score: number;
  started_at: string;
  task_description: string;
  reflected: boolean;
}

interface AgentReflection {
  id: string;
  what_worked: string;
  what_failed: string;
  autonomy_delta: string;
  patterns: string;
  quality_score: number;
  created_at: string;
}

// ─── Spawn Form ────────────────────────────────────────────────────

function SpawnForm({ onSpawned, onClose }: { onSpawned: () => void; onClose: () => void }) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [clients, setClients] = useState<string[]>([]);
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState<"form" | "generating">("form");

  const clientOptions = ["twitter", "telegram", "discord", "slack"];

  const toggleClient = (c: string) =>
    setClients(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);

  const spawn = async () => {
    if (!name.trim() || !role.trim() || !description.trim()) {
      setError("Name, role, and description are required.");
      return;
    }
    setSpawning(true);
    setStep("generating");
    setError("");

    try {
      const { data, error: fnErr } = await supabase.functions.invoke("agent_spawn", {
        body: {
          user_id:     user!.id,
          name:        name.trim(),
          role:        role.trim(),
          description: description.trim(),
          clients,
        },
      });
      if (fnErr) throw fnErr;
      if (data?.error) throw new Error(data.error);
      onSpawned();
      onClose();
    } catch (err: unknown) {
      setError((err as Error).message ?? "Spawn failed.");
      setStep("form");
    } finally {
      setSpawning(false);
    }
  };

  const ROLE_PRESETS = [
    { label: "Social Media", role: "Social media manager", description: "Manages Twitter/X, Telegram, and Discord. Drafts posts, monitors mentions, schedules content, and maintains brand voice." },
    { label: "Marketing", role: "Growth & marketing strategist", description: "Plans campaigns, writes content calendars, analyzes performance metrics, and identifies growth opportunities." },
    { label: "Legal", role: "Legal compliance reviewer", description: "Reviews contracts, flags compliance risks, drafts legal summaries, and monitors regulatory requirements. Always recommends counsel for execution." },
    { label: "Research", role: "Intelligence & research analyst", description: "Deep research on markets, competitors, and opportunities. Synthesizes sources into structured briefings." },
    { label: "Operations", role: "Operations coordinator", description: "Tracks tasks, coordinates across systems, manages workflows, and surfaces blockers before they become problems." },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.85)" }}>
      <div className="relative w-full max-w-xl rounded-2xl border border-border/40 overflow-hidden"
           style={{ background: "linear-gradient(135deg, #0d0d0d 0%, #111318 100%)" }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/30">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                 style={{ background: "linear-gradient(135deg, #f97316, #ea580c)" }}>
              <Bot className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-sm font-semibold text-white tracking-wide">Spawn New Agent</div>
              <div className="text-xs text-zinc-500">Every agent inherits the autonomy baseline</div>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {step === "generating" ? (
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-16">
            <div className="relative">
              <div className="w-16 h-16 rounded-2xl border border-orange-500/30 flex items-center justify-center"
                   style={{ background: "linear-gradient(135deg, rgba(249,115,22,0.15), rgba(234,88,12,0.05))" }}>
                <Cpu className="w-8 h-8 text-orange-400 animate-pulse" />
              </div>
              <div className="absolute -right-1 -bottom-1 w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center">
                <Loader2 className="w-3 h-3 text-white animate-spin" />
              </div>
            </div>
            <div className="text-center">
              <div className="text-sm font-semibold text-white mb-1">Architecting {name}</div>
              <div className="text-xs text-zinc-500">Generating character, capabilities, and seed memory…</div>
            </div>
            <div className="flex flex-col gap-1.5 w-full max-w-xs">
              {["Defining identity and mission", "Generating capabilities", "Seeding baseline memory", "Writing to registry"].map((step, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-zinc-500">
                  <div className="w-1.5 h-1.5 rounded-full bg-orange-500/60 animate-pulse" style={{ animationDelay: `${i * 300}ms` }} />
                  {step}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="px-6 py-5 space-y-5">
            {/* Quick presets */}
            <div>
              <div className="text-xs text-zinc-500 mb-2 uppercase tracking-wider">Quick presets</div>
              <div className="flex flex-wrap gap-2">
                {ROLE_PRESETS.map(p => (
                  <button key={p.label}
                    onClick={() => { setRole(p.role); setDescription(p.description); if (!name) setName(p.label); }}
                    className="px-3 py-1 rounded-lg text-xs border transition-all"
                    style={{ borderColor: role === p.role ? "#f97316" : "rgba(255,255,255,0.1)",
                             color: role === p.role ? "#f97316" : "#a1a1aa",
                             background: role === p.role ? "rgba(249,115,22,0.1)" : "transparent" }}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Fields */}
            <div className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 mb-1.5 block">Agent name</label>
                <input value={name} onChange={e => setName(e.target.value)}
                  placeholder="e.g. Iris, Felix, Sage"
                  className="w-full bg-white/5 border border-border/30 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-orange-500/50 transition-colors" />
              </div>

              <div>
                <label className="text-xs text-zinc-400 mb-1.5 block">Role</label>
                <input value={role} onChange={e => setRole(e.target.value)}
                  placeholder="e.g. Social media manager"
                  className="w-full bg-white/5 border border-border/30 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-orange-500/50 transition-colors" />
              </div>

              <div>
                <label className="text-xs text-zinc-400 mb-1.5 block">What should this agent do?</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)}
                  rows={4}
                  placeholder="Describe its primary functions, what platforms or systems it touches, what it should never do, and how it should communicate…"
                  className="w-full bg-white/5 border border-border/30 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-orange-500/50 transition-colors resize-none" />
              </div>

              <div>
                <label className="text-xs text-zinc-400 mb-1.5 block">Clients (optional)</label>
                <div className="flex gap-2">
                  {clientOptions.map(c => (
                    <button key={c} onClick={() => toggleClient(c)}
                      className="px-3 py-1.5 rounded-lg text-xs border transition-all capitalize"
                      style={{ borderColor: clients.includes(c) ? "#f97316" : "rgba(255,255,255,0.1)",
                               color: clients.includes(c) ? "#f97316" : "#71717a",
                               background: clients.includes(c) ? "rgba(249,115,22,0.1)" : "transparent" }}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                {error}
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button onClick={onClose}
                className="flex-1 py-2.5 rounded-xl border border-border/30 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
                Cancel
              </button>
              <button onClick={spawn} disabled={spawning}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, #f97316, #ea580c)" }}>
                Spawn Agent
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Agent Detail Panel ────────────────────────────────────────────

function AgentDetail({ agent, onClose, onReflect }: {
  agent: Agent;
  onClose: () => void;
  onReflect: (agentId: string) => Promise<void>;
}) {
  const { user } = useAuth();
  const [tab, setTab] = useState<"overview" | "memory" | "sessions" | "reflections">("overview");
  const [memory, setMemory] = useState<AgentMemory[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [reflections, setReflections] = useState<AgentReflection[]>([]);
  const [loadingTab, setLoadingTab] = useState(false);
  const [reflecting, setReflecting] = useState(false);
  const [exportCopied, setExportCopied] = useState(false);

  const loadTab = useCallback(async (t: typeof tab) => {
    setLoadingTab(true);
    try {
      if (t === "memory") {
        const { data } = await supabase
          .from("agent_memory")
          .select("*")
          .eq("agent_id", agent.id)
          .order("confidence", { ascending: false });
        setMemory(data ?? []);
      } else if (t === "sessions") {
        const { data } = await supabase
          .from("agent_sessions")
          .select("*")
          .eq("agent_id", agent.id)
          .order("started_at", { ascending: false })
          .limit(20);
        setSessions(data ?? []);
      } else if (t === "reflections") {
        const { data } = await supabase
          .from("agent_reflections")
          .select("*")
          .eq("agent_id", agent.id)
          .order("created_at", { ascending: false })
          .limit(10);
        setReflections(data ?? []);
      }
    } finally {
      setLoadingTab(false);
    }
  }, [agent.id]);

  useEffect(() => {
    if (tab !== "overview") loadTab(tab);
  }, [tab, loadTab]);

  const triggerReflect = async () => {
    setReflecting(true);
    await onReflect(agent.id);
    setReflecting(false);
    if (tab === "reflections") loadTab("reflections");
  };

  const exportCharacter = async () => {
    const { data } = await supabase.rpc("export_agent_character", { p_agent_id: agent.id });
    if (data) {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setExportCopied(true);
      setTimeout(() => setExportCopied(false), 2000);
    }
  };

  const memoryTypeColor: Record<string, string> = {
    learned_pattern: "#f97316",
    capability:      "#22c55e",
    constraint:      "#ef4444",
    preference:      "#3b82f6",
    relationship:    "#a855f7",
    world_model:     "#14b8a6",
  };

  const outcomeColor = (o: string) => ({
    success: "#22c55e", partial: "#f97316", failed: "#ef4444", pending: "#71717a"
  }[o] ?? "#71717a");

  const TABS = [
    { key: "overview", label: "Overview", icon: Bot },
    { key: "memory", label: "Memory", icon: MemoryStick },
    { key: "sessions", label: "Sessions", icon: Activity },
    { key: "reflections", label: "Reflections", icon: Brain },
  ] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.85)" }}>
      <div className="relative w-full max-w-2xl max-h-[90vh] rounded-2xl border border-border/40 flex flex-col overflow-hidden"
           style={{ background: "linear-gradient(135deg, #0d0d0d 0%, #111318 100%)" }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/30 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
                 style={{ background: "rgba(249,115,22,0.1)", border: "1px solid rgba(249,115,22,0.2)" }}>
              {agent.avatar_emoji}
            </div>
            <div>
              <div className="text-sm font-semibold text-white">{agent.name}</div>
              <div className="text-xs text-zinc-500">{agent.role} · v{agent.version}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportCharacter}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/30 text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
              <Download className="w-3 h-3" />
              {exportCopied ? "Copied!" : "Export"}
            </button>
            <button onClick={triggerReflect} disabled={reflecting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
              style={{ background: "rgba(249,115,22,0.15)", color: "#f97316", border: "1px solid rgba(249,115,22,0.2)" }}>
              {reflecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Reflect
            </button>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors ml-1">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border/20 shrink-0">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button key={key} onClick={() => setTab(key)}
              className="flex items-center gap-1.5 px-4 py-3 text-xs transition-all relative"
              style={{ color: tab === key ? "#f97316" : "#71717a" }}>
              <Icon className="w-3.5 h-3.5" />
              {label}
              {tab === key && (
                <div className="absolute bottom-0 left-0 right-0 h-px" style={{ background: "#f97316" }} />
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loadingTab && tab !== "overview" ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="w-5 h-5 text-zinc-500 animate-spin" />
            </div>
          ) : (
            <>
              {/* Overview */}
              {tab === "overview" && (
                <div className="space-y-5">
                  <div>
                    <div className="text-xs text-zinc-500 mb-2 uppercase tracking-wider">System Prompt</div>
                    <div className="text-xs text-zinc-300 leading-relaxed bg-white/3 rounded-xl p-4 border border-border/20 max-h-40 overflow-y-auto font-mono">
                      {agent.system_prompt}
                    </div>
                  </div>

                  {agent.bio?.length > 0 && (
                    <div>
                      <div className="text-xs text-zinc-500 mb-2 uppercase tracking-wider">Bio</div>
                      <div className="space-y-1">
                        {agent.bio.map((b, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs text-zinc-400">
                            <div className="w-1 h-1 rounded-full bg-orange-500/60 mt-1.5 shrink-0" />
                            {b}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {agent.capabilities?.length > 0 && (
                    <div>
                      <div className="text-xs text-zinc-500 mb-2 uppercase tracking-wider">
                        Capabilities ({agent.capabilities.length})
                      </div>
                      <div className="space-y-2">
                        {agent.capabilities.map((c, i) => (
                          <div key={i} className="rounded-xl p-3 border border-border/20 bg-white/2">
                            <div className="flex items-center gap-2 mb-1">
                              <Zap className="w-3 h-3 text-orange-500" />
                              <span className="text-xs font-mono font-semibold text-orange-400">{c.name}</span>
                            </div>
                            <div className="text-xs text-zinc-400">{c.description}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: "Clients", value: agent.clients?.join(", ") || "None" },
                      { label: "Reflect every", value: `${agent.reflect_after_sessions} session(s)` },
                      { label: "Auto-execute", value: agent.auto_execute ? "Yes" : "Approval required" },
                    ].map(({ label, value }) => (
                      <div key={label} className="rounded-xl p-3 border border-border/20 bg-white/2">
                        <div className="text-xs text-zinc-500 mb-1">{label}</div>
                        <div className="text-xs text-zinc-200">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Memory */}
              {tab === "memory" && (
                <div className="space-y-2">
                  {memory.length === 0 ? (
                    <div className="text-center py-12">
                      <MemoryStick className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
                      <div className="text-sm text-zinc-500">No memories yet.</div>
                      <div className="text-xs text-zinc-600 mt-1">Run a session and trigger reflection to build memory.</div>
                    </div>
                  ) : memory.map((m, i) => (
                    <div key={i} className="rounded-xl p-3 border border-border/20 bg-white/2 flex gap-3 items-start">
                      <div className="shrink-0 mt-0.5">
                        <div className="w-2 h-2 rounded-full" style={{ background: memoryTypeColor[m.memory_type] ?? "#71717a" }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs font-semibold text-zinc-200">{m.key}</span>
                          <span className="text-xs px-1.5 py-0.5 rounded text-zinc-400"
                                style={{ background: `${memoryTypeColor[m.memory_type]}15`, color: memoryTypeColor[m.memory_type] ?? "#71717a" }}>
                            {m.memory_type}
                          </span>
                          <span className="text-xs text-zinc-600">{(m.confidence * 100).toFixed(0)}% conf</span>
                        </div>
                        <div className="text-xs text-zinc-400 leading-relaxed">{m.value}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Sessions */}
              {tab === "sessions" && (
                <div className="space-y-2">
                  {sessions.length === 0 ? (
                    <div className="text-center py-12">
                      <Activity className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
                      <div className="text-sm text-zinc-500">No sessions logged yet.</div>
                    </div>
                  ) : sessions.map((s) => (
                    <div key={s.id} className="rounded-xl p-3 border border-border/20 bg-white/2 flex items-start gap-3">
                      <div className="shrink-0 mt-0.5">
                        {s.outcome === "success"
                          ? <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "#22c55e" }} />
                          : s.outcome === "failed"
                          ? <AlertTriangle className="w-3.5 h-3.5" style={{ color: "#ef4444" }} />
                          : <Clock className="w-3.5 h-3.5 text-zinc-500" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-zinc-300 mb-1 truncate">{s.task_description}</div>
                        <div className="flex items-center gap-3 text-xs text-zinc-500">
                          <span style={{ color: outcomeColor(s.outcome) }}>{s.outcome}</span>
                          <span>Autonomy: {s.autonomy_score ? `${(s.autonomy_score * 100).toFixed(0)}%` : "—"}</span>
                          <span>{new Date(s.started_at).toLocaleDateString()}</span>
                          {!s.reflected && <span className="text-orange-500">• unreflected</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Reflections */}
              {tab === "reflections" && (
                <div className="space-y-4">
                  {reflections.length === 0 ? (
                    <div className="text-center py-12">
                      <Brain className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
                      <div className="text-sm text-zinc-500">No reflections yet.</div>
                      <div className="text-xs text-zinc-600 mt-1">Click "Reflect" to trigger a post-session analysis.</div>
                    </div>
                  ) : reflections.map((r) => (
                    <div key={r.id} className="rounded-xl border border-border/20 bg-white/2 overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-3 border-b border-border/15">
                        <div className="text-xs text-zinc-400">{new Date(r.created_at).toLocaleString()}</div>
                        <div className="text-xs px-2 py-0.5 rounded-full"
                             style={{ background: r.quality_score >= 0.7 ? "rgba(34,197,94,0.1)" : "rgba(249,115,22,0.1)",
                                      color: r.quality_score >= 0.7 ? "#22c55e" : "#f97316" }}>
                          Quality: {(r.quality_score * 100).toFixed(0)}%
                        </div>
                      </div>
                      <div className="p-4 space-y-3">
                        {[
                          { label: "What worked", value: r.what_worked, color: "#22c55e" },
                          { label: "What failed", value: r.what_failed, color: "#ef4444" },
                          { label: "Patterns noticed", value: r.patterns, color: "#f97316" },
                          { label: "Autonomy upgrade", value: r.autonomy_delta, color: "#3b82f6" },
                        ].filter(x => x.value).map(({ label, value, color }) => (
                          <div key={label}>
                            <div className="text-xs mb-1 font-medium" style={{ color }}>{label}</div>
                            <div className="text-xs text-zinc-400 leading-relaxed">{value}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Agent Card ────────────────────────────────────────────────────

function AgentCard({ agent, onClick }: { agent: Agent; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="group w-full text-left rounded-2xl border border-border/30 overflow-hidden transition-all duration-200 hover:border-orange-500/30"
      style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01))" }}>

      <div className="p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center text-2xl shrink-0"
                 style={{ background: "rgba(249,115,22,0.1)", border: "1px solid rgba(249,115,22,0.15)" }}>
              {agent.avatar_emoji}
            </div>
            <div>
              <div className="text-sm font-semibold text-white">{agent.name}</div>
              <div className="text-xs text-zinc-500">{agent.role}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${agent.is_active ? "bg-green-500" : "bg-zinc-600"}`} />
            <span className="text-xs text-zinc-600">v{agent.version}</span>
          </div>
        </div>

        {/* Capability pills */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {agent.capabilities?.slice(0, 4).map(c => (
            <div key={c.name} className="px-2 py-0.5 rounded-md text-xs font-mono"
                 style={{ background: "rgba(249,115,22,0.08)", color: "rgba(249,115,22,0.7)", border: "1px solid rgba(249,115,22,0.12)" }}>
              {c.name}
            </div>
          ))}
          {(agent.capabilities?.length ?? 0) > 4 && (
            <div className="px-2 py-0.5 rounded-md text-xs text-zinc-600 bg-white/3">
              +{agent.capabilities.length - 4} more
            </div>
          )}
        </div>

        {/* Meta row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs text-zinc-600">
            <div className="flex items-center gap-1">
              <Brain className="w-3 h-3" />
              Reflects every {agent.reflect_after_sessions}
            </div>
            {agent.clients?.length > 0 && (
              <div className="flex items-center gap-1">
                <Network className="w-3 h-3" />
                {agent.clients.join(", ")}
              </div>
            )}
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-zinc-600 group-hover:text-orange-500 transition-colors" />
        </div>
      </div>
    </button>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────

export default function AgentsPage() {
  const { user } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSpawn, setShowSpawn] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [reflectResult, setReflectResult] = useState<string>("");

  const loadAgents = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from("skyforge_agents")
      .select("*")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    setAgents(data ?? []);
    setLoading(false);
  }, [user]);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  const handleReflect = async (agentId: string) => {
    const { data } = await supabase.functions.invoke("agent_reflect", {
      body: { agent_id: agentId, user_id: user!.id },
    });
    setReflectResult(data?.status ?? "done");
    await loadAgents(); // refresh version number if bumped
  };

  // ── Stats ──

  const totalCapabilities = agents.reduce((s, a) => s + (a.capabilities?.length ?? 0), 0);
  const activeClients     = [...new Set(agents.flatMap(a => a.clients ?? []))];

  return (
    <div className="min-h-screen bg-background p-6 md:p-8">
      {/* Modals */}
      {showSpawn && (
        <SpawnForm
          onSpawned={() => { loadAgents(); }}
          onClose={() => setShowSpawn(false)}
        />
      )}
      {selectedAgent && (
        <AgentDetail
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
          onReflect={handleReflect}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Agent Network</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            Autonomous sub-agents. Each one learns after every session.
          </p>
        </div>
        <button onClick={() => setShowSpawn(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
          style={{ background: "linear-gradient(135deg, #f97316, #ea580c)" }}>
          <Plus className="w-4 h-4" />
          New Agent
        </button>
      </div>

      {/* Stats strip */}
      {agents.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          {[
            { label: "Agents", value: agents.length, icon: Bot, color: "#f97316" },
            { label: "Capabilities", value: totalCapabilities, icon: Zap, color: "#22c55e" },
            { label: "Active clients", value: activeClients.length, icon: Network, color: "#3b82f6" },
            { label: "Avg version", value: agents.length ? (agents.reduce((s, a) => s + a.version, 0) / agents.length).toFixed(1) : "—", icon: Brain, color: "#a855f7" },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="rounded-xl p-4 border border-border/20"
                 style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-3.5 h-3.5" style={{ color }} />
                <span className="text-xs text-zinc-500">{label}</span>
              </div>
              <div className="text-xl font-bold text-white">{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Atlas delegation note */}
      <div className="mb-6 rounded-xl p-4 border flex items-start gap-3"
           style={{ background: "rgba(249,115,22,0.04)", borderColor: "rgba(249,115,22,0.15)" }}>
        <Shield className="w-4 h-4 text-orange-500 shrink-0 mt-0.5" />
        <div>
          <div className="text-xs font-semibold text-orange-400 mb-0.5">Atlas Orchestration</div>
          <div className="text-xs text-zinc-500 leading-relaxed">
            Atlas automatically routes tasks to the appropriate agent based on capability matching.
            Every agent loads the baseline plugin: self-reflection after sessions, escalation to Atlas
            when out of scope, and persistent memory that compounds across sessions.
          </div>
        </div>
      </div>

      {/* Reflect result toast */}
      {reflectResult && (
        <div className="fixed bottom-6 right-6 flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium z-50"
             style={{ background: "#111318", border: "1px solid rgba(249,115,22,0.3)", color: "#f97316" }}>
          <Brain className="w-4 h-4" />
          Reflection: {reflectResult}
          <button onClick={() => setReflectResult("")} className="ml-2 text-zinc-500 hover:text-zinc-300">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Agent grid */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="w-6 h-6 text-zinc-600 animate-spin" />
        </div>
      ) : agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 rounded-2xl border border-border/20 border-dashed"
             style={{ background: "rgba(255,255,255,0.01)" }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
               style={{ background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.15)" }}>
            <Cpu className="w-7 h-7 text-orange-500/60" />
          </div>
          <div className="text-sm font-semibold text-zinc-400 mb-1">No agents yet</div>
          <div className="text-xs text-zinc-600 mb-5 text-center max-w-xs">
            Spawn your first sub-agent. Give it a role and description — Atlas handles the rest.
          </div>
          <button onClick={() => setShowSpawn(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white"
            style={{ background: "linear-gradient(135deg, #f97316, #ea580c)" }}>
            <Plus className="w-4 h-4" /> Spawn First Agent
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map(agent => (
            <AgentCard key={agent.id} agent={agent} onClick={() => setSelectedAgent(agent)} />
          ))}
        </div>
      )}
    </div>
  );
}
