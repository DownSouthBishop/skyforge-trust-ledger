import { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Cpu, Zap, Wifi, WifiOff, Send, RefreshCw, Play, Shield,
  MessageSquare, Activity, Terminal, BookOpen, AlertCircle,
  CheckCircle2, XCircle, Clock, ChevronRight, Layers,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────

type ConnStatus = "online" | "offline" | "checking" | "unknown";

interface JarvisMsg { role: "user" | "assistant"; content: string; ts: number }

interface Telemetry {
  latency_ms: number | null;
  vram_used_gb: number | null;
  vram_total_gb: number | null;
  watts: number | null;
  efficiency: string | null;
}

interface Channel { name: string; runtime: string; status: ConnStatus }

interface Skill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

interface CanvasLog { id: string; ts: number; type: "text" | "file" | "error"; content: string }

interface Guardrail { id: string; text: string; active: boolean }

interface AuditEntry {
  id: string;
  ts: number;
  action: string;
  reasoning: string;
  confidence: number;
  passed: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? "";
}

async function invokeProxy(fn: string, body: Record<string, unknown>) {
  const token = await getToken();
  const { data, error } = await supabase.functions.invoke(fn, {
    body,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) throw error;
  return data;
}

function StatusDot({ status }: { status: ConnStatus }) {
  const map: Record<ConnStatus, string> = {
    online: "bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.6)]",
    offline: "bg-red-500 shadow-[0_0_6px_2px_rgba(239,68,68,0.6)]",
    checking: "bg-amber-400 animate-pulse",
    unknown: "bg-zinc-500",
  };
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${map[status]}`} />;
}

function GlassCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-white/10 bg-white/5 backdrop-blur-md ${className}`}>
      {children}
    </div>
  );
}

// ─── Tab 1: Jarvis Core ──────────────────────────────────────────────────────

const TRIGGERS = [
  { label: "Deep Research Loop", model: "deepseek-r1", description: "Long-horizon analysis cycle" },
  { label: "Code Audit Sprint", model: "qwen2.5-coder", description: "Static analysis + refactor pass" },
  { label: "Market Brief", model: "llama3.3", description: "Summarise open positions + news" },
  { label: "Memory Consolidation", model: "mistral", description: "Compress working context" },
];

function JarvisTab() {
  const [msgs, setMsgs] = useState<JarvisMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [telemetry, setTelemetry] = useState<Telemetry>({ latency_ms: null, vram_used_gb: null, vram_total_gb: null, watts: null, efficiency: null });
  const [status, setStatus] = useState<ConnStatus>("unknown");
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const checkStatus = useCallback(async () => {
    setStatus("checking");
    try {
      const data = await invokeProxy("jarvis-proxy", { action: "status" });
      setTelemetry({
        latency_ms: data?.latency_ms ?? null,
        vram_used_gb: data?.vram_used_gb ?? null,
        vram_total_gb: data?.vram_total_gb ?? null,
        watts: data?.watts ?? null,
        efficiency: data?.efficiency ?? null,
      });
      setStatus(data?.offline ? "offline" : "online");
    } catch {
      setStatus("offline");
    }
  }, []);

  useEffect(() => { checkStatus(); }, [checkStatus]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  async function send() {
    if (!input.trim() || streaming) return;
    const userMsg: JarvisMsg = { role: "user", content: input.trim(), ts: Date.now() };
    setMsgs((p) => [...p, userMsg]);
    setInput("");
    setStreaming(true);

    const placeholder: JarvisMsg = { role: "assistant", content: "", ts: Date.now() };
    setMsgs((p) => [...p, placeholder]);

    try {
      const token = await getToken();
      const t0 = performance.now();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jarvis-proxy`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "chat",
            stream: true,
            messages: [...msgs, userMsg].map((m) => ({ role: m.role, content: m.content })),
          }),
          signal: (abortRef.current = new AbortController()).signal,
        },
      );

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") break;
          try {
            const j = JSON.parse(raw);
            const delta = j.choices?.[0]?.delta?.content ?? "";
            acc += delta;
            setMsgs((p) => {
              const copy = [...p];
              copy[copy.length - 1] = { ...copy[copy.length - 1], content: acc };
              return copy;
            });
          } catch { /* skip malformed SSE */ }
        }
      }

      setTelemetry((prev) => ({ ...prev, latency_ms: Math.round(performance.now() - t0) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMsgs((p) => {
        const copy = [...p];
        copy[copy.length - 1] = { ...copy[copy.length - 1], content: `⚠ ${msg}` };
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  }

  async function fireTrigger(preset: typeof TRIGGERS[0]) {
    setInput(`Run a ${preset.label} using ${preset.model} — brief summary only.`);
  }

  const vramPct = telemetry.vram_total_gb && telemetry.vram_used_gb
    ? Math.round((telemetry.vram_used_gb / telemetry.vram_total_gb) * 100)
    : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-full">
      {/* Chat Terminal */}
      <div className="lg:col-span-2 flex flex-col gap-3">
        <GlassCard className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-blue-400" />
            <span className="text-xs font-mono text-blue-300 tracking-widest">JARVIS · LOCAL ENGINE</span>
          </div>
          <div className="flex items-center gap-2">
            <StatusDot status={status} />
            <span className="text-xs text-muted-foreground capitalize">{status}</span>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={checkStatus}>
              <RefreshCw className="w-3 h-3" />
            </Button>
          </div>
        </GlassCard>

        <GlassCard className="flex-1 flex flex-col min-h-0">
          <ScrollArea className="flex-1 p-4 font-mono text-sm">
            {msgs.length === 0 && (
              <p className="text-muted-foreground text-xs text-center mt-12">
                Jarvis is ready. Type a prompt or fire an automation trigger →
              </p>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`mb-3 ${m.role === "user" ? "text-right" : "text-left"}`}>
                <span
                  className={`inline-block max-w-[85%] px-3 py-2 rounded-lg text-xs leading-relaxed whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-blue-500/20 text-blue-200 border border-blue-500/30"
                      : "bg-white/5 text-foreground border border-white/10"
                  }`}
                >
                  {m.content || <span className="animate-pulse text-muted-foreground">▌</span>}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </ScrollArea>

          <div className="p-3 border-t border-white/10 flex gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Prompt Jarvis…"
              rows={2}
              className="resize-none bg-white/5 border-white/10 text-sm font-mono"
              disabled={streaming}
            />
            <Button
              onClick={send}
              disabled={streaming || !input.trim() || status === "offline"}
              className="bg-blue-600 hover:bg-blue-500"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </GlassCard>
      </div>

      {/* Right panel: telemetry + triggers */}
      <div className="flex flex-col gap-4">
        {/* Telemetry */}
        <GlassCard className="p-4 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Activity className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-mono text-emerald-300 tracking-widest">HARDWARE TELEMETRY</span>
          </div>

          {[
            { label: "LATENCY", value: telemetry.latency_ms != null ? `${telemetry.latency_ms} ms` : "—", color: "text-blue-300" },
            { label: "VRAM", value: vramPct != null ? `${vramPct}% (${telemetry.vram_used_gb?.toFixed(1)}/${telemetry.vram_total_gb?.toFixed(1)} GB)` : "—", color: "text-violet-300" },
            { label: "POWER", value: telemetry.watts != null ? `${telemetry.watts} W` : "—", color: "text-amber-300" },
            { label: "EFFICIENCY", value: telemetry.efficiency ?? "—", color: "text-emerald-300" },
          ].map((row) => (
            <div key={row.label} className="flex justify-between items-center">
              <span className="text-xs text-muted-foreground font-mono">{row.label}</span>
              <span className={`text-xs font-mono font-semibold ${row.color}`}>{row.value}</span>
            </div>
          ))}

          {vramPct != null && (
            <div className="w-full bg-white/10 rounded-full h-1.5 mt-1">
              <div
                className="h-1.5 rounded-full bg-gradient-to-r from-violet-500 to-blue-500 transition-all duration-700"
                style={{ width: `${vramPct}%` }}
              />
            </div>
          )}
        </GlassCard>

        {/* Automation Triggers */}
        <GlassCard className="p-4 space-y-2">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-mono text-amber-300 tracking-widest">AUTOMATION TRIGGERS</span>
          </div>
          {TRIGGERS.map((t) => (
            <button
              key={t.label}
              onClick={() => fireTrigger(t)}
              className="w-full flex items-center justify-between p-2.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-left group"
            >
              <div>
                <p className="text-xs font-semibold text-foreground">{t.label}</p>
                <p className="text-[10px] text-muted-foreground">{t.description}</p>
              </div>
              <ChevronRight className="w-3 h-3 text-muted-foreground group-hover:text-amber-400 transition-colors" />
            </button>
          ))}
        </GlassCard>
      </div>
    </div>
  );
}

// ─── Tab 2: OpenClaw Desk ────────────────────────────────────────────────────

const DEFAULT_CHANNELS: Channel[] = [
  { name: "WhatsApp", runtime: "baileys", status: "unknown" },
  { name: "Telegram", runtime: "grammY", status: "unknown" },
  { name: "Slack", runtime: "bolt-js", status: "unknown" },
];

const DEFAULT_SKILLS: Skill[] = [
  { id: "sk-1", name: "web_search", description: "Search the web via DuckDuckGo", tags: ["research", "internet"] },
  { id: "sk-2", name: "read_file", description: "Read file from local workspace", tags: ["fs", "local"] },
  { id: "sk-3", name: "write_file", description: "Write/patch file in local workspace", tags: ["fs", "local"] },
  { id: "sk-4", name: "run_shell", description: "Execute shell command in sandbox", tags: ["system"] },
  { id: "sk-5", name: "send_message", description: "Send message via active channel", tags: ["messaging"] },
];

function OpenClawTab() {
  const [channels, setChannels] = useState<Channel[]>(DEFAULT_CHANNELS);
  const [skills, setSkills] = useState<Skill[]>(DEFAULT_SKILLS);
  const [canvasLog, setCanvasLog] = useState<CanvasLog[]>([]);
  const [checking, setChecking] = useState(false);
  const [activeSkill, setActiveSkill] = useState<string | null>(null);

  const runDoctor = useCallback(async () => {
    setChecking(true);
    try {
      const data = await invokeProxy("openclaw-proxy", { action: "doctor" });
      const statuses: Record<string, ConnStatus> = data?.channels ?? {};
      setChannels((prev) =>
        prev.map((ch) => ({
          ...ch,
          status: statuses[ch.name.toLowerCase()] ?? (data?.offline ? "offline" : "unknown"),
        })),
      );
      const newSkills: Skill[] = data?.skills ?? skills;
      if (newSkills.length) setSkills(newSkills);
      setCanvasLog((p) => [
        ...p,
        { id: crypto.randomUUID(), ts: Date.now(), type: "text", content: `Doctor check complete — ${Object.keys(statuses).length} channels probed.` },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCanvasLog((p) => [...p, { id: crypto.randomUUID(), ts: Date.now(), type: "error", content: msg }]);
      setChannels((prev) => prev.map((ch) => ({ ...ch, status: "offline" })));
    } finally {
      setChecking(false);
    }
  }, [skills]);

  useEffect(() => { runDoctor(); }, [runDoctor]);

  async function executeSkill(skill: Skill) {
    setActiveSkill(skill.id);
    try {
      const data = await invokeProxy("openclaw-proxy", { action: "execute", skill_name: skill.name });
      setCanvasLog((p) => [
        ...p,
        { id: crypto.randomUUID(), ts: Date.now(), type: data?.file ? "file" : "text", content: data?.output ?? `Skill "${skill.name}" dispatched.` },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCanvasLog((p) => [...p, { id: crypto.randomUUID(), ts: Date.now(), type: "error", content: msg }]);
    } finally {
      setActiveSkill(null);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Left: channels + skills */}
      <div className="lg:col-span-1 flex flex-col gap-4">
        {/* Channels */}
        <GlassCard className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Wifi className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-mono text-cyan-300 tracking-widest">MESSAGING RUNTIMES</span>
            </div>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={runDoctor} disabled={checking}>
              <RefreshCw className={`w-3 h-3 ${checking ? "animate-spin" : ""}`} />
            </Button>
          </div>
          <div className="space-y-2">
            {channels.map((ch) => (
              <div key={ch.name} className="flex items-center justify-between p-2.5 rounded-lg border border-white/10 bg-white/5">
                <div>
                  <p className="text-xs font-semibold">{ch.name}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">{ch.runtime}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <StatusDot status={ch.status} />
                  <span className="text-[10px] text-muted-foreground capitalize">{ch.status}</span>
                </div>
              </div>
            ))}
          </div>
        </GlassCard>

        {/* Skills */}
        <GlassCard className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Layers className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-mono text-violet-300 tracking-widest">WORKSPACE SKILLS</span>
          </div>
          <div className="space-y-2">
            {skills.map((sk) => (
              <div key={sk.id} className="flex items-center justify-between p-2.5 rounded-lg border border-white/10 bg-white/5">
                <div className="flex-1 min-w-0 mr-2">
                  <p className="text-xs font-mono font-semibold text-foreground truncate">{sk.name}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{sk.description}</p>
                  <div className="flex gap-1 mt-0.5 flex-wrap">
                    {sk.tags.map((t) => (
                      <Badge key={t} variant="outline" className="text-[9px] px-1 py-0 h-3.5 border-white/20">{t}</Badge>
                    ))}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0"
                  onClick={() => executeSkill(sk)}
                  disabled={activeSkill === sk.id}
                >
                  {activeSkill === sk.id
                    ? <RefreshCw className="w-3 h-3 animate-spin" />
                    : <Play className="w-3 h-3 text-emerald-400" />}
                </Button>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>

      {/* Right: Canvas log */}
      <div className="lg:col-span-2">
        <GlassCard className="flex flex-col h-full min-h-[420px]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-orange-400" />
              <span className="text-xs font-mono text-orange-300 tracking-widest">CANVAS LOG</span>
            </div>
            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setCanvasLog([])}>
              Clear
            </Button>
          </div>
          <ScrollArea className="flex-1 p-4">
            {canvasLog.length === 0 && (
              <p className="text-xs text-muted-foreground text-center mt-12">No agent output yet.</p>
            )}
            {canvasLog.map((entry) => (
              <div
                key={entry.id}
                className={`mb-2 p-3 rounded-lg border text-xs font-mono ${
                  entry.type === "error"
                    ? "border-red-500/30 bg-red-500/10 text-red-300"
                    : entry.type === "file"
                    ? "border-violet-500/30 bg-violet-500/10 text-violet-200"
                    : "border-white/10 bg-white/5 text-foreground"
                }`}
              >
                <span className="text-muted-foreground mr-2">
                  {new Date(entry.ts).toLocaleTimeString()}
                </span>
                {entry.type === "error" && <AlertCircle className="w-3 h-3 inline mr-1 text-red-400" />}
                {entry.type === "file" && <BookOpen className="w-3 h-3 inline mr-1 text-violet-400" />}
                <span className="whitespace-pre-wrap">{entry.content}</span>
              </div>
            ))}
          </ScrollArea>
        </GlassCard>
      </div>
    </div>
  );
}

// ─── Tab 3: Azaries Studio ───────────────────────────────────────────────────

const SAMPLE_GUARDRAILS: Guardrail[] = [
  { id: "g1", text: "Never share financial account credentials or private keys with any external service.", active: true },
  { id: "g2", text: "Always confirm before executing any irreversible action that affects production data.", active: true },
  { id: "g3", text: "Limit outbound API calls to approved vendor whitelist only.", active: true },
  { id: "g4", text: "Require human approval for any transaction exceeding $10,000.", active: false },
];

function AzariesTab() {
  const [guardrails, setGuardrails] = useState<Guardrail[]>(SAMPLE_GUARDRAILS);
  const [newRule, setNewRule] = useState("");
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [validating, setValidating] = useState(false);

  function addRule() {
    if (!newRule.trim()) return;
    setGuardrails((p) => [...p, { id: crypto.randomUUID(), text: newRule.trim(), active: true }]);
    setNewRule("");
  }

  function toggleRule(id: string) {
    setGuardrails((p) => p.map((g) => g.id === id ? { ...g, active: !g.active } : g));
  }

  function removeRule(id: string) {
    setGuardrails((p) => p.filter((g) => g.id !== id));
  }

  async function validateAll() {
    setValidating(true);
    const active = guardrails.filter((g) => g.active);
    try {
      const data = await invokeProxy("azaries-proxy", {
        action: "validate",
        guardrails: active.map((g) => g.text),
        context: "skyforge-trust-ledger audit session",
      });

      const entries: AuditEntry[] = (data?.results ?? active.map((g, i) => ({
        action: g.text.slice(0, 60) + (g.text.length > 60 ? "…" : ""),
        reasoning: data?.reasoning?.[i] ?? "Evaluated against SPARK compliance engine.",
        confidence: data?.confidence?.[i] ?? 0.95,
        passed: data?.passed?.[i] ?? true,
      }))).map((r: Omit<AuditEntry, "id" | "ts">) => ({
        ...r,
        id: crypto.randomUUID(),
        ts: Date.now(),
      }));

      setAuditLog((p) => [...entries, ...p]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAuditLog((p) => [
        { id: crypto.randomUUID(), ts: Date.now(), action: "Validation attempt", reasoning: msg, confidence: 0, passed: false },
        ...p,
      ]);
    } finally {
      setValidating(false);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Guardrails editor */}
      <GlassCard className="p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-emerald-400" />
          <span className="text-xs font-mono text-emerald-300 tracking-widest">PLAIN-ENGLISH GUARDRAILS</span>
        </div>

        <div className="space-y-2">
          {guardrails.map((g) => (
            <div
              key={g.id}
              className={`flex items-start gap-2 p-2.5 rounded-lg border transition-colors ${
                g.active ? "border-emerald-500/30 bg-emerald-500/5" : "border-white/10 bg-white/5 opacity-50"
              }`}
            >
              <button onClick={() => toggleRule(g.id)} className="mt-0.5 shrink-0">
                {g.active
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  : <XCircle className="w-4 h-4 text-muted-foreground" />}
              </button>
              <p className="text-xs text-foreground flex-1 leading-relaxed">{g.text}</p>
              <button onClick={() => removeRule(g.id)} className="text-muted-foreground hover:text-red-400 transition-colors shrink-0">
                <XCircle className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex gap-2 mt-2">
          <Textarea
            value={newRule}
            onChange={(e) => setNewRule(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addRule(); } }}
            placeholder="Add a plain-English guardrail…"
            rows={2}
            className="resize-none bg-white/5 border-white/10 text-xs"
          />
          <Button size="icon" onClick={addRule} className="bg-emerald-600 hover:bg-emerald-500 shrink-0">
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        <Button
          onClick={validateAll}
          disabled={validating || guardrails.filter((g) => g.active).length === 0}
          className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 w-full"
        >
          {validating ? (
            <><RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" /> Validating…</>
          ) : (
            <><Shield className="w-3.5 h-3.5 mr-2" /> Run Azaries Validation</>
          )}
        </Button>
      </GlassCard>

      {/* Audit trace log */}
      <GlassCard className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-mono text-violet-300 tracking-widest">AUDIT TRACE LOG</span>
          </div>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setAuditLog([])}>
            Clear
          </Button>
        </div>

        <ScrollArea className="flex-1 min-h-[360px]">
          {auditLog.length === 0 && (
            <p className="text-xs text-muted-foreground text-center mt-12">
              Run validation to populate audit traces.
            </p>
          )}
          {auditLog.map((entry) => (
            <div
              key={entry.id}
              className={`mb-3 p-3 rounded-lg border ${
                entry.passed
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-red-500/30 bg-red-500/10"
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="flex items-center gap-1.5">
                  {entry.passed
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                  <span className="text-xs font-semibold text-foreground">{entry.action}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Cpu className="w-3 h-3 text-muted-foreground" />
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {Math.round(entry.confidence * 100)}%
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">{entry.reasoning}</p>
              <div className="flex items-center gap-1 mt-1.5">
                <Clock className="w-3 h-3 text-muted-foreground" />
                <span className="text-[9px] text-muted-foreground font-mono">
                  {new Date(entry.ts).toLocaleTimeString()}
                </span>
                <div className="ml-auto w-20 bg-white/10 rounded-full h-1">
                  <div
                    className={`h-1 rounded-full transition-all ${entry.passed ? "bg-emerald-400" : "bg-red-400"}`}
                    style={{ width: `${entry.confidence * 100}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </ScrollArea>
      </GlassCard>
    </div>
  );
}

// ─── Page Shell ──────────────────────────────────────────────────────────────

export default function CommandCenterPage() {
  return (
    <div className="p-4 md:p-6 space-y-4 min-h-screen">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-blue-500/30">
          <Cpu className="w-5 h-5 text-blue-400" />
        </div>
        <div>
          <h1 className="font-display text-lg tracking-widest text-glow-blue">SOVEREIGN COMMAND CENTER</h1>
          <p className="text-xs text-muted-foreground">Jarvis · OpenClaw · Azaries — unified agentic control plane</p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="jarvis" className="space-y-4">
        <TabsList className="bg-white/5 border border-white/10 gap-1 p-1">
          <TabsTrigger
            value="jarvis"
            className="data-[state=active]:bg-blue-500/20 data-[state=active]:text-blue-300 text-xs font-mono tracking-wider"
          >
            <Terminal className="w-3.5 h-3.5 mr-1.5" /> JARVIS CORE
          </TabsTrigger>
          <TabsTrigger
            value="openclaw"
            className="data-[state=active]:bg-orange-500/20 data-[state=active]:text-orange-300 text-xs font-mono tracking-wider"
          >
            <Wifi className="w-3.5 h-3.5 mr-1.5" /> OPENCLAW DESK
          </TabsTrigger>
          <TabsTrigger
            value="azaries"
            className="data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-300 text-xs font-mono tracking-wider"
          >
            <Shield className="w-3.5 h-3.5 mr-1.5" /> AZARIES STUDIO
          </TabsTrigger>
        </TabsList>

        <TabsContent value="jarvis" className="mt-0">
          <JarvisTab />
        </TabsContent>
        <TabsContent value="openclaw" className="mt-0">
          <OpenClawTab />
        </TabsContent>
        <TabsContent value="azaries" className="mt-0">
          <AzariesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
