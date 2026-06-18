import { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Cpu, Zap, Send, RefreshCw, Play, Shield,
  MessageSquare, Activity, Terminal, BookOpen,
  CheckCircle2, XCircle, Clock, ChevronRight, Layers, AlertCircle,
} from "lucide-react";

const SUPABASE_URL = "https://hycpzeskartlkybsfkbh.supabase.co";

// ─── Shared helpers ──────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? "";
}

type ApiMsg = { role: "user" | "assistant"; content: string };

interface StreamResult { text: string; latency_ms: number }

async function streamAtlas(
  messages: ApiMsg[],
  system: string,
  onDelta: (t: string) => void,
  signal: AbortSignal,
): Promise<StreamResult> {
  const token = await getToken();
  const t0 = performance.now();

  const res = await fetch(`${SUPABASE_URL}/functions/v1/atlas-core`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "chat", messages, system, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = "";

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw === "[DONE]") break outer;
      try {
        const j = JSON.parse(raw);
        // Anthropic SSE format
        const delta =
          j.delta?.text ??
          j.choices?.[0]?.delta?.content ??
          "";
        if (delta) { acc += delta; onDelta(delta); }
      } catch { /* skip */ }
    }
  }

  return { text: acc, latency_ms: Math.round(performance.now() - t0) };
}

// ─── UI primitives ───────────────────────────────────────────────────────────

function GlassCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-white/10 bg-white/5 backdrop-blur-md ${className}`}>
      {children}
    </div>
  );
}

// ─── Tab 1: Jarvis Core ──────────────────────────────────────────────────────

const JARVIS_SYSTEM = `You are Jarvis — a concise, technical local-execution AI running inside the Skyforge Command Center.
You specialise in analysis, code, research loops, and automation planning.
Respond in a direct, engineer-to-engineer tone. Use markdown where helpful. Be brief unless depth is requested.`;

const TRIGGERS = [
  { label: "Deep Research Loop", prompt: "Outline a 5-step deep research loop for the current market environment. List each step with a one-line action." },
  { label: "Code Audit Sprint", prompt: "Describe a systematic code-audit sprint checklist: security, performance, maintainability. Bullet points only." },
  { label: "Market Brief", prompt: "Summarise what macro factors a trader should watch this week in under 150 words." },
  { label: "Memory Consolidation", prompt: "Give me a concise template for compressing a working-session context log into structured memory entries." },
];

interface JarvisMsg { role: "user" | "assistant"; content: string; ts: number }

function JarvisTab() {
  const [msgs, setMsgs] = useState<JarvisMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  async function send(overrideInput?: string) {
    const text = (overrideInput ?? input).trim();
    if (!text || streaming) return;
    setInput("");
    setStreaming(true);

    const userMsg: JarvisMsg = { role: "user", content: text, ts: Date.now() };
    const placeholder: JarvisMsg = { role: "assistant", content: "", ts: Date.now() };
    setMsgs((p) => [...p, userMsg, placeholder]);

    abortRef.current = new AbortController();

    try {
      const history: ApiMsg[] = [...msgs, userMsg].map((m) => ({ role: m.role, content: m.content }));
      const result = await streamAtlas(
        history,
        JARVIS_SYSTEM,
        (delta) => setMsgs((p) => {
          const copy = [...p];
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: copy[copy.length - 1].content + delta };
          return copy;
        }),
        abortRef.current.signal,
      );
      setLatency(result.latency_ms);
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-full">
      {/* Chat */}
      <div className="lg:col-span-2 flex flex-col gap-3">
        <GlassCard className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-blue-400" />
            <span className="text-xs font-mono text-blue-300 tracking-widest">JARVIS · ATLAS ENGINE</span>
          </div>
          {latency !== null && (
            <div className="flex items-center gap-1.5">
              <Activity className="w-3 h-3 text-emerald-400" />
              <span className="text-xs font-mono text-emerald-300">{latency} ms</span>
            </div>
          )}
        </GlassCard>

        <GlassCard className="flex-1 flex flex-col min-h-[420px]">
          <ScrollArea className="flex-1 p-4 font-mono text-sm">
            {msgs.length === 0 && (
              <p className="text-muted-foreground text-xs text-center mt-16">
                Jarvis is ready. Send a prompt or fire an automation trigger →
              </p>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`mb-3 ${m.role === "user" ? "text-right" : "text-left"}`}>
                <span
                  className={`inline-block max-w-[88%] px-3 py-2 rounded-lg text-xs leading-relaxed whitespace-pre-wrap text-left ${
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
              placeholder="Prompt Jarvis… (Enter to send)"
              rows={2}
              className="resize-none bg-white/5 border-white/10 text-sm font-mono"
              disabled={streaming}
            />
            <Button onClick={() => send()} disabled={streaming || !input.trim()} className="bg-blue-600 hover:bg-blue-500 shrink-0">
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </GlassCard>
      </div>

      {/* Right: triggers + stats */}
      <div className="flex flex-col gap-4">
        <GlassCard className="p-4 space-y-2">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-mono text-amber-300 tracking-widest">AUTOMATION TRIGGERS</span>
          </div>
          {TRIGGERS.map((t) => (
            <button
              key={t.label}
              onClick={() => send(t.prompt)}
              disabled={streaming}
              className="w-full flex items-center justify-between p-2.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-left group disabled:opacity-40"
            >
              <span className="text-xs font-semibold text-foreground">{t.label}</span>
              <ChevronRight className="w-3 h-3 text-muted-foreground group-hover:text-amber-400 transition-colors" />
            </button>
          ))}
        </GlassCard>

        <GlassCard className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-mono text-emerald-300 tracking-widest">SESSION STATS</span>
          </div>
          {[
            { label: "MESSAGES", value: String(msgs.length) },
            { label: "LAST LATENCY", value: latency != null ? `${latency} ms` : "—" },
            { label: "ENGINE", value: "atlas-core" },
            { label: "MODE", value: "streaming" },
          ].map((row) => (
            <div key={row.label} className="flex justify-between">
              <span className="text-xs text-muted-foreground font-mono">{row.label}</span>
              <span className="text-xs font-mono font-semibold text-foreground">{row.value}</span>
            </div>
          ))}
        </GlassCard>
      </div>
    </div>
  );
}

// ─── Tab 2: OpenClaw Desk ────────────────────────────────────────────────────

const OPENCLAW_SYSTEM = `You are the OpenClaw execution engine inside Skyforge Command Center.
When a skill is invoked, execute it thoroughly and return structured output.
Format responses as JSON when the skill requests data, or clear markdown prose for analysis tasks.
Be precise, complete, and action-oriented.`;

interface Skill { id: string; name: string; description: string; tags: string[]; prompt: string }
interface CanvasLog { id: string; ts: number; type: "text" | "error"; label: string; content: string }
interface ClawChannel { name: string; status: string; runtime?: string }
interface ClawAgent { id: string; name: string; status?: string }

type ConnStatus = "online" | "offline" | "checking" | "unknown";

function StatusDot({ status }: { status: ConnStatus }) {
  const map: Record<ConnStatus, string> = {
    online: "bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.6)]",
    offline: "bg-red-500",
    checking: "bg-amber-400 animate-pulse",
    unknown: "bg-zinc-500",
  };
  return <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${map[status]}`} />;
}

const FALLBACK_SKILLS: Skill[] = [
  { id: "sk-1", name: "market_scan", description: "Scan for high-conviction market setups", tags: ["markets"], prompt: "Run a market scan. Identify 3 high-conviction trade setups across equities, crypto, and forex. For each: ticker, thesis, entry zone, invalidation." },
  { id: "sk-2", name: "news_brief", description: "Summarise top macro/market news", tags: ["news"], prompt: "Provide a concise macro/market news brief for today. Cover Fed policy, risk sentiment, and any major geopolitical drivers. Under 200 words." },
  { id: "sk-3", name: "risk_audit", description: "Audit portfolio for concentration risk", tags: ["risk"], prompt: "Outline a 6-point portfolio risk audit framework covering: concentration, correlation, leverage, liquidity, drawdown exposure, and tail risk." },
  { id: "sk-4", name: "draft_outreach", description: "Draft a cold outreach message", tags: ["messaging"], prompt: "Write a professional cold outreach message for a fintech SaaS product targeting independent RIAs. 3 sentences max. High signal, no fluff." },
  { id: "sk-5", name: "weekly_review", description: "Generate a weekly review template", tags: ["ops"], prompt: "Generate a structured weekly performance review template for a solo operator: wins, misses, key metrics, top 3 priorities for next week." },
];

async function callOpenClaw(action: string, payload: Record<string, unknown> = {}) {
  const token = await getToken();
  const { data, error } = await supabase.functions.invoke("openclaw-proxy", {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) throw error;
  return data;
}

function OpenClawTab() {
  const [connStatus, setConnStatus] = useState<ConnStatus>("unknown");
  const [channels, setChannels] = useState<ClawChannel[]>([]);
  const [agents, setAgents] = useState<ClawAgent[]>([]);
  const [skills, setSkills] = useState<Skill[]>(FALLBACK_SKILLS);
  const [canvasLog, setCanvasLog] = useState<CanvasLog[]>([]);
  const [activeSkill, setActiveSkill] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const probe = useCallback(async () => {
    setChecking(true);
    setConnStatus("checking");
    try {
      // Try health first, then status
      const health = await callOpenClaw("health").catch(() => callOpenClaw("status"));

      if (health?.offline) {
        setConnStatus("offline");
        return;
      }

      setConnStatus("online");

      // Fetch channels
      const chanData = await callOpenClaw("channels").catch(() => null);
      if (Array.isArray(chanData?.channels)) {
        setChannels(chanData.channels);
      } else if (Array.isArray(chanData)) {
        setChannels(chanData);
      }

      // Fetch agents
      const agentData = await callOpenClaw("agents").catch(() => null);
      if (Array.isArray(agentData?.agents)) {
        setAgents(agentData.agents);
      } else if (Array.isArray(agentData)) {
        setAgents(agentData);
      }

      // Fetch skills from Railway if available
      const skillData = await callOpenClaw("skills").catch(() => null);
      if (Array.isArray(skillData?.skills) && skillData.skills.length > 0) {
        setSkills(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          skillData.skills.map((s: any, i: number) => ({
            id: s.id ?? `sk-live-${i}`,
            name: s.name ?? s.action ?? `skill_${i}`,
            description: s.description ?? s.desc ?? "",
            tags: s.tags ?? s.categories ?? [],
            prompt: s.prompt ?? s.description ?? s.name ?? "",
          })),
        );
      }

      setCanvasLog((p) => [...p, {
        id: crypto.randomUUID(), ts: Date.now(), type: "text",
        label: "✓ OpenClaw connected",
        content: `Railway service online.\nAgents: ${agents.length || agentData?.length || "?"} · Channels: ${channels.length || chanData?.length || "?"}`,
      }]);
    } catch (err) {
      setConnStatus("offline");
      const msg = err instanceof Error ? err.message : String(err);
      setCanvasLog((p) => [...p, {
        id: crypto.randomUUID(), ts: Date.now(), type: "error",
        label: "✗ OpenClaw unreachable", content: msg,
      }]);
    } finally {
      setChecking(false);
    }
  }, [agents.length, channels.length]);

  useEffect(() => { probe(); }, [probe]);

  async function executeSkill(skill: Skill) {
    if (activeSkill) return;
    setActiveSkill(skill.id);
    const logId = crypto.randomUUID();
    setCanvasLog((p) => [...p, { id: logId, ts: Date.now(), type: "text", label: `▶ ${skill.name}`, content: "" }]);

    try {
      // If online, try dispatching via OpenClaw first
      if (connStatus === "online") {
        const result = await callOpenClaw("execute", { skill_name: skill.name, prompt: skill.prompt }).catch(() => null);
        if (result && !result.error) {
          const out = typeof result.output === "string" ? result.output : JSON.stringify(result, null, 2);
          setCanvasLog((p) => p.map((e) => e.id === logId ? { ...e, label: `✓ ${skill.name} (openclaw)`, content: out } : e));
          return;
        }
      }

      // Fallback: stream through Atlas
      const ctrl = new AbortController();
      const atlasResult = await streamAtlas(
        [{ role: "user", content: skill.prompt }],
        OPENCLAW_SYSTEM,
        (delta) => setCanvasLog((p) => p.map((e) => e.id === logId ? { ...e, content: e.content + delta } : e)),
        ctrl.signal,
      );
      setCanvasLog((p) => p.map((e) => e.id === logId ? { ...e, label: `✓ ${skill.name} (${atlasResult.latency_ms}ms)` } : e));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCanvasLog((p) => p.map((e) => e.id === logId ? { ...e, type: "error", content: msg } : e));
    } finally {
      setActiveSkill(null);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Left column: status + skills */}
      <div className="lg:col-span-1 flex flex-col gap-3">
        {/* Railway status */}
        <GlassCard className="p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <StatusDot status={connStatus} />
              <span className="text-xs font-mono text-muted-foreground tracking-widest">OPENCLAW · RAILWAY</span>
            </div>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={probe} disabled={checking}>
              <RefreshCw className={`w-3 h-3 ${checking ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {/* Channels */}
          {channels.length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-[10px] text-muted-foreground font-mono mb-1.5">CHANNELS</p>
              {channels.map((ch, i) => (
                <div key={i} className="flex items-center justify-between text-[10px] px-2 py-1 rounded bg-white/5">
                  <span className="text-foreground font-mono">{ch.name}</span>
                  <div className="flex items-center gap-1">
                    <StatusDot status={(ch.status === "connected" || ch.status === "online") ? "online" : ch.status === "disconnected" ? "offline" : "unknown"} />
                    <span className="text-muted-foreground">{ch.runtime ?? ch.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Agents */}
          {agents.length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-[10px] text-muted-foreground font-mono mb-1.5">ACTIVE AGENTS</p>
              {agents.slice(0, 5).map((ag) => (
                <div key={ag.id} className="flex items-center gap-2 text-[10px] px-2 py-1 rounded bg-white/5">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0" />
                  <span className="text-foreground font-mono truncate">{ag.name}</span>
                </div>
              ))}
            </div>
          )}
        </GlassCard>

        {/* Skills library */}
        <GlassCard className="p-4 flex-1">
          <div className="flex items-center gap-2 mb-3">
            <Layers className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-mono text-violet-300 tracking-widest">WORKSPACE SKILLS</span>
          </div>
          <div className="space-y-2">
            {skills.map((sk) => (
              <div key={sk.id} className="flex items-center justify-between p-2.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/8 transition-colors">
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
                  className="h-7 w-7 shrink-0"
                  onClick={() => executeSkill(sk)}
                  disabled={activeSkill !== null}
                  title={`Run ${sk.name}`}
                >
                  {activeSkill === sk.id
                    ? <RefreshCw className="w-3 h-3 animate-spin text-violet-400" />
                    : <Play className="w-3 h-3 text-emerald-400" />}
                </Button>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>

      {/* Canvas log */}
      <div className="lg:col-span-2">
        <GlassCard className="flex flex-col min-h-[480px]">
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
              <p className="text-xs text-muted-foreground text-center mt-16">
                Click a skill to run it — output streams here.
              </p>
            )}
            {canvasLog.map((entry) => (
              <div
                key={entry.id}
                className={`mb-4 rounded-lg border overflow-hidden ${
                  entry.type === "error"
                    ? "border-red-500/30 bg-red-500/10"
                    : "border-white/10 bg-white/5"
                }`}
              >
                <div className={`px-3 py-1.5 border-b text-[10px] font-mono flex items-center gap-1.5 ${
                  entry.type === "error" ? "border-red-500/30 text-red-400" : "border-white/10 text-muted-foreground"
                }`}>
                  {entry.type === "error"
                    ? <AlertCircle className="w-3 h-3" />
                    : <Clock className="w-3 h-3" />}
                  {entry.label} · {new Date(entry.ts).toLocaleTimeString()}
                </div>
                <div className="p-3 text-xs leading-relaxed whitespace-pre-wrap font-mono text-foreground">
                  {entry.content || <span className="animate-pulse text-muted-foreground">▌</span>}
                </div>
              </div>
            ))}
          </ScrollArea>
        </GlassCard>
      </div>
    </div>
  );
}

// ─── Tab 3: Azaries Studio ───────────────────────────────────────────────────

const AZARIES_SYSTEM = `You are the Azaries SPARK compliance engine inside Skyforge Command Center.
You evaluate plain-English guardrails for an AI-powered financial operations platform.

For each guardrail provided, return a JSON array with this exact structure:
[
  {
    "action": "<first 80 chars of guardrail text>",
    "reasoning": "<2-3 sentence compliance evaluation>",
    "confidence": <0.0-1.0>,
    "passed": <true|false>,
    "risk_level": "low|medium|high"
  }
]

Be rigorous. Flag any guardrail that is ambiguous, unenforceable, or conflicts with common regulatory requirements.`;

interface Guardrail { id: string; text: string; active: boolean }
interface AuditEntry { id: string; ts: number; action: string; reasoning: string; confidence: number; passed: boolean; risk_level: string }

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

  async function validateAll() {
    const active = guardrails.filter((g) => g.active);
    if (!active.length) return;
    setValidating(true);

    const prompt = `Evaluate these ${active.length} guardrails:\n\n${active.map((g, i) => `${i + 1}. ${g.text}`).join("\n")}`;

    try {
      let fullText = "";
      const ctrl = new AbortController();
      await streamAtlas(
        [{ role: "user", content: prompt }],
        AZARIES_SYSTEM,
        (delta) => { fullText += delta; },
        ctrl.signal,
      );

      // Extract JSON from the response
      const jsonMatch = fullText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array found in response");

      const results: Array<{ action: string; reasoning: string; confidence: number; passed: boolean; risk_level: string }> = JSON.parse(jsonMatch[0]);

      const entries: AuditEntry[] = results.map((r) => ({
        ...r,
        id: crypto.randomUUID(),
        ts: Date.now(),
        risk_level: r.risk_level ?? "low",
      }));

      setAuditLog((p) => [...entries, ...p]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAuditLog((p) => [
        { id: crypto.randomUUID(), ts: Date.now(), action: "Validation error", reasoning: msg, confidence: 0, passed: false, risk_level: "high" },
        ...p,
      ]);
    } finally {
      setValidating(false);
    }
  }

  const riskColor: Record<string, string> = {
    low: "text-emerald-400",
    medium: "text-amber-400",
    high: "text-red-400",
  };

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
              <button onClick={() => setGuardrails((p) => p.map((r) => r.id === g.id ? { ...r, active: !r.active } : r))} className="mt-0.5 shrink-0">
                {g.active
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  : <XCircle className="w-4 h-4 text-muted-foreground" />}
              </button>
              <p className="text-xs text-foreground flex-1 leading-relaxed">{g.text}</p>
              <button
                onClick={() => setGuardrails((p) => p.filter((r) => r.id !== g.id))}
                className="text-muted-foreground hover:text-red-400 transition-colors shrink-0 mt-0.5"
              >
                <XCircle className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <Textarea
            value={newRule}
            onChange={(e) => setNewRule(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addRule(); } }}
            placeholder="Add a plain-English guardrail…"
            rows={2}
            className="resize-none bg-white/5 border-white/10 text-xs"
          />
          <Button size="icon" onClick={addRule} className="bg-emerald-700 hover:bg-emerald-600 shrink-0">
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        <Button
          onClick={validateAll}
          disabled={validating || guardrails.filter((g) => g.active).length === 0}
          className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 w-full"
        >
          {validating
            ? <><RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" /> Evaluating…</>
            : <><Shield className="w-3.5 h-3.5 mr-2" /> Run Compliance Evaluation</>}
        </Button>
      </GlassCard>

      {/* Audit trace */}
      <GlassCard className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-mono text-violet-300 tracking-widest">AUDIT TRACE LOG</span>
          </div>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setAuditLog([])}>Clear</Button>
        </div>

        <ScrollArea className="flex-1 min-h-[400px]">
          {auditLog.length === 0 && (
            <p className="text-xs text-muted-foreground text-center mt-16">
              Run compliance evaluation to populate audit traces.
            </p>
          )}
          {auditLog.map((entry) => (
            <div
              key={entry.id}
              className={`mb-3 p-3 rounded-lg border ${
                entry.passed ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/10"
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="flex items-center gap-1.5">
                  {entry.passed
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                  <span className="text-xs font-semibold text-foreground leading-snug">{entry.action}</span>
                </div>
                <span className={`text-[10px] font-mono shrink-0 ${riskColor[entry.risk_level] ?? "text-muted-foreground"}`}>
                  {entry.risk_level}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">{entry.reasoning}</p>
              <div className="flex items-center gap-2 mt-2">
                <div className="flex-1 bg-white/10 rounded-full h-1">
                  <div
                    className={`h-1 rounded-full ${entry.passed ? "bg-emerald-400" : "bg-red-400"}`}
                    style={{ width: `${entry.confidence * 100}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-muted-foreground">{Math.round(entry.confidence * 100)}%</span>
                <span className="text-[9px] text-muted-foreground">{new Date(entry.ts).toLocaleTimeString()}</span>
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
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-blue-500/30">
          <Cpu className="w-5 h-5 text-blue-400" />
        </div>
        <div>
          <h1 className="font-display text-lg tracking-widest text-glow-blue">SOVEREIGN COMMAND CENTER</h1>
          <p className="text-xs text-muted-foreground">Unified agentic control plane — powered by Atlas engine</p>
        </div>
      </div>

      <Tabs defaultValue="jarvis" className="space-y-4">
        <TabsList className="bg-white/5 border border-white/10 gap-1 p-1">
          <TabsTrigger value="jarvis" className="data-[state=active]:bg-blue-500/20 data-[state=active]:text-blue-300 text-xs font-mono tracking-wider">
            <Terminal className="w-3.5 h-3.5 mr-1.5" /> JARVIS CORE
          </TabsTrigger>
          <TabsTrigger value="openclaw" className="data-[state=active]:bg-orange-500/20 data-[state=active]:text-orange-300 text-xs font-mono tracking-wider">
            <Layers className="w-3.5 h-3.5 mr-1.5" /> SKILLS DESK
          </TabsTrigger>
          <TabsTrigger value="azaries" className="data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-300 text-xs font-mono tracking-wider">
            <Shield className="w-3.5 h-3.5 mr-1.5" /> COMPLIANCE STUDIO
          </TabsTrigger>
        </TabsList>

        <TabsContent value="jarvis" className="mt-0"><JarvisTab /></TabsContent>
        <TabsContent value="openclaw" className="mt-0"><OpenClawTab /></TabsContent>
        <TabsContent value="azaries" className="mt-0"><AzariesTab /></TabsContent>
      </Tabs>
    </div>
  );
}
