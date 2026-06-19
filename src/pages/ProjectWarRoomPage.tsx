import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _supabase } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = _supabase as any;
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send, Plus, Check, Pencil } from "lucide-react";
import { buildProjectContextBlock } from "@/lib/project-context";
import { streamFunctionToText } from "@/lib/stream-fn";

type Agent = "atlas" | "linda" | "janus" | "izzy";

const AGENTS: { slug: Agent; label: string; role: string; accent: string }[] = [
  { slug: "atlas",  label: "Atlas", role: "Strategy & Execution",   accent: "text-blue-400"    },
  { slug: "linda",  label: "Linda", role: "Sales & Client Relations", accent: "text-rose-400"  },
  { slug: "janus",  label: "Janus", role: "Planning & Operations",   accent: "text-amber-400"  },
  { slug: "izzy",   label: "Izzy",  role: "Tech & Automation",       accent: "text-emerald-400" },
];

type Msg    = { role: "user" | "assistant"; content: string };
type Thread = Msg[];
type Threads = Record<Agent, Thread>;

const emptyThreads = (): Threads => ({ atlas: [], linda: [], janus: [], izzy: [] });

export default function ProjectWarRoomPage() {
  const { id }   = useParams<{ id: string }>();
  const { user } = useAuth();

  const [project,     setProject]     = useState<any>(null);
  const [clients,     setClients]     = useState<any[]>([]);
  const [leads,       setLeads]       = useState<any[]>([]);
  const [financials,  setFinancials]  = useState<any[]>([]);
  const [bottlenecks, setBottlenecks] = useState<any[]>([]);
  const [memory,      setMemory]      = useState<any[]>([]);
  const [pipeline,    setPipeline]    = useState<any[]>([]);

  const [agent,       setAgent]       = useState<Agent>("atlas");
  const [threads,     setThreads]     = useState<Threads>(emptyThreads());
  const [msg,         setMsg]         = useState("");
  const [sending,     setSending]     = useState(false);
  const [editGoal,    setEditGoal]    = useState(false);
  const [goalDraft,   setGoalDraft]   = useState("");

  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── data loading ────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!id || !user) return;
    const [p, c, l, f, b, m, pi] = await Promise.all([
      supabase.from("business_projects").select("*").eq("id", id).maybeSingle(),
      supabase.from("project_clients").select("*").eq("project_id", id).order("created_at", { ascending: false }),
      supabase.from("project_leads").select("*").eq("project_id", id).order("created_at", { ascending: false }),
      supabase.from("project_financials").select("*").eq("project_id", id).order("date", { ascending: false }),
      supabase.from("project_bottlenecks").select("*").eq("project_id", id).order("created_at", { ascending: false }),
      supabase.from("project_memory").select("*").eq("project_id", id).order("created_at", { ascending: false }).limit(50),
      supabase.from("income_pipeline").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20),
    ]);
    setProject(p.data);
    setGoalDraft(String(p.data?.goal_revenue_usd ?? ""));
    setClients(c.data ?? []);
    setLeads(l.data ?? []);
    setFinancials(f.data ?? []);
    setBottlenecks(b.data ?? []);
    setMemory(m.data ?? []);
    setPipeline(pi.data ?? []);
  }, [id, user]);

  useEffect(() => { load(); }, [load]);

  // realtime project memory
  useEffect(() => {
    if (!id) return;
    const ch = supabase.channel(`pmem-${id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "project_memory", filter: `project_id=eq.${id}` },
        (payload: any) => setMemory(cur => [payload.new, ...cur].slice(0, 50)))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id]);

  // scroll chat to bottom on new messages
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [threads, agent]);

  // ── derived values ─────────────────────────────────────────────────────────
  const revenue  = financials.filter(r => r.entry_type === "revenue").reduce((s, r) => s + Number(r.amount_usd || 0), 0);
  const expenses = financials.filter(r => r.entry_type !== "revenue").reduce((s, r) => s + Number(r.amount_usd || 0), 0);
  const target   = Number(project?.goal_revenue_usd || 0);
  const gap      = target - revenue;

  const hotLeads  = leads.filter(l => l.temperature === "hot");
  const warmLeads = leads.filter(l => l.temperature === "warm");
  const coldLeads = leads.filter(l => l.temperature !== "hot" && l.temperature !== "warm");
  const sortedLeads = [...hotLeads, ...warmLeads, ...coldLeads];

  const filteredPipeline = pipeline.filter((p: any) => p.project_id === id);
  const izzyCognition    = memory.filter(m => m.agent === "izzy").slice(0, 6);

  // ── agent command ──────────────────────────────────────────────────────────
  const sendToAgent = async () => {
    if (!msg.trim() || !user || !id || sending) return;
    const userText  = msg.trim();
    const userEntry: Msg = { role: "user", content: userText };
    setMsg("");
    setSending(true);
    setThreads(prev => ({ ...prev, [agent]: [...prev[agent], userEntry] }));

    try {
      const ctxBlock   = await buildProjectContextBlock(id);
      const sess       = await supabase.auth.getSession();
      const token      = sess.data.session?.access_token;
      if (!token) throw new Error("no session");

      // Always inject fresh project context, then the accumulated thread, then the new message.
      // Threads store only real messages — context is re-injected per request.
      const apiMessages: Msg[] = [
        { role: "user",      content: `[PROJECT CONTEXT — read silently]\n${ctxBlock}` },
        { role: "assistant", content: "Understood. I am operating inside this project." },
        ...threads[agent],
        userEntry,
      ];

      // All four agents route through agent-chat (built-in tools, Gemini fallback)
      const reply = await streamFunctionToText("agent-chat", { agent_slug: agent, messages: apiMessages }, token);

      const assistantEntry: Msg = { role: "assistant", content: reply || "(no response)" };
      setThreads(prev => ({ ...prev, [agent]: [...prev[agent], assistantEntry] }));

      await supabase.from("project_memory").insert([
        { project_id: id, user_id: user.id, agent: "operator", content: userText,                memory_type: "conversation" },
        { project_id: id, user_id: user.id, agent,             content: reply || "(no response)", memory_type: "conversation" },
      ]);

      supabase.functions.invoke("agent_remember", {
        body: { user_id: user.id, source_agent: agent, user_message: userText, assistant_message: reply, context: `project:${project?.name ?? id}`, project_id: id },
      }).catch(() => {});
    } catch (e) {
      setThreads(prev => ({ ...prev, [agent]: [...prev[agent], { role: "assistant", content: `Error: ${(e as Error).message}` }] }));
    } finally {
      setSending(false);
    }
  };

  // ── revenue goal ──────────────────────────────────────────────────────────
  const saveGoal = async () => {
    const val = parseFloat(goalDraft) || 0;
    await supabase.from("business_projects").update({ goal_revenue_usd: val }).eq("id", id);
    setProject((p: any) => ({ ...p, goal_revenue_usd: val }));
    setEditGoal(false);
  };

  // ── crud helpers ──────────────────────────────────────────────────────────
  const addClient      = async () => { if (!user || !id) return; await supabase.from("project_clients").insert({ project_id: id, user_id: user.id, name: "New client" }); load(); };
  const addLead        = async () => { if (!user || !id) return; await supabase.from("project_leads").insert({ project_id: id, user_id: user.id, name: "New lead", temperature: "cold" }); load(); };
  const addFinancial   = async () => { if (!user || !id) return; await supabase.from("project_financials").insert({ project_id: id, user_id: user.id, entry_type: "revenue", amount_usd: 0, description: "" }); load(); };
  const addBottleneck  = async () => { if (!user || !id) return; await supabase.from("project_bottlenecks").insert({ project_id: id, user_id: user.id, description: "New bottleneck", severity: "medium" }); load(); };
  const resolveBottleneck = async (bid: string) => { await supabase.from("project_bottlenecks").update({ resolved: true }).eq("id", bid); load(); };
  const updateClient     = async (cid: string, patch: any) => { await supabase.from("project_clients").update(patch).eq("id", cid); };
  const updateLead       = async (lid: string, patch: any) => { await supabase.from("project_leads").update(patch).eq("id", lid); };
  const updateFinancial  = async (fid: string, patch: any) => { await supabase.from("project_financials").update(patch).eq("id", fid); };
  const updateBottleneck = async (bid: string, patch: any) => { await supabase.from("project_bottlenecks").update(patch).eq("id", bid); };

  // ── agent pulse ────────────────────────────────────────────────────────────
  const agentPulse = (slug: Agent) => {
    const last = memory.find(m => m.agent === slug);
    if (!last) return { color: "bg-zinc-500", text: "no activity yet" };
    const ageH = (Date.now() - new Date(last.created_at).getTime()) / 3.6e6;
    return {
      color: ageH < 48 ? "bg-emerald-500" : ageH < 72 ? "bg-amber-500" : "bg-red-500",
      text:  last.content.slice(0, 160),
    };
  };

  const currentAgent  = AGENTS.find(a => a.slug === agent)!;
  const currentThread = threads[agent];
  const openBN        = bottlenecks.filter(b => !b.resolved);

  if (!project) return <div className="p-6 text-muted-foreground">Loading project…</div>;

  return (
    <div className="p-6 space-y-6">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-primary tracking-widest">{project.name}</h1>
          {(project.mission || project.description) && (
            <p className="text-sm text-muted-foreground mt-1">{project.mission || project.description}</p>
          )}
        </div>
        <Badge variant="outline">{project.status ?? "active"}</Badge>
      </div>

      {/* ── The Gap ── */}
      <Card className="glass-card border-primary/30">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap gap-6 text-sm">
              <div>
                <div className="text-[10px] text-muted-foreground tracking-widest mb-0.5">TARGET</div>
                <div className="flex items-center gap-1">
                  {editGoal ? (
                    <Input autoFocus type="number" value={goalDraft}
                      onChange={e => setGoalDraft(e.target.value)}
                      onBlur={saveGoal}
                      onKeyDown={e => e.key === "Enter" && saveGoal()}
                      className="h-7 w-32 text-sm" />
                  ) : (
                    <span className="text-primary font-display text-xl">${target.toLocaleString()}</span>
                  )}
                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setEditGoal(true)}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground tracking-widest mb-0.5">REVENUE</div>
                <div className="text-emerald-400 font-display text-xl">${revenue.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground tracking-widest mb-0.5">EXPENSES</div>
                <div className="text-red-400 font-display text-xl">${expenses.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground tracking-widest mb-0.5">GAP</div>
                <div className={`font-display text-xl ${gap > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                  ${Math.abs(gap).toLocaleString()} {gap > 0 ? "to close" : "surplus"}
                </div>
              </div>
            </div>
            {target > 0 && (
              <div className="w-40">
                <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full"
                    style={{ width: `${Math.min(100, (revenue / target) * 100)}%` }} />
                </div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  {Math.round((revenue / target) * 100)}% to goal
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Command Center ── */}
      <Card className="glass-card">
        <CardHeader className="pb-2">
          <CardTitle className="font-display tracking-widest text-sm">COMMAND CENTER</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* agent tabs */}
          <div className="flex gap-2 flex-wrap">
            {AGENTS.map(a => {
              const threadLen = threads[a.slug].length;
              const turns     = Math.floor(threadLen / 2);
              return (
                <button key={a.slug} onClick={() => setAgent(a.slug)}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition border ${
                    agent === a.slug
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/40 text-muted-foreground hover:border-primary/30"
                  }`}>
                  <span className={a.accent}>{a.label}</span>
                  <span className="ml-1 text-muted-foreground hidden sm:inline">— {a.role}</span>
                  {turns > 0 && (
                    <span className="ml-1.5 bg-primary/20 text-primary rounded px-1 text-[10px]">{turns}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* thread */}
          <div className="h-64 overflow-auto rounded border border-border/30 bg-background/40 p-3 space-y-2">
            {currentThread.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
                {currentAgent.label} is ready. What does this project need?
              </div>
            ) : (
              currentThread.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-primary/20 text-primary"
                      : "bg-muted/60 text-foreground"
                  }`}>
                    {m.role === "assistant" && (
                      <span className={`block text-[10px] font-semibold mb-1 ${currentAgent.accent}`}>{currentAgent.label}</span>
                    )}
                    {m.content}
                  </div>
                </div>
              ))
            )}
            {sending && (
              <div className="flex justify-start">
                <div className="bg-muted/60 rounded-lg px-3 py-2 text-xs text-muted-foreground animate-pulse">
                  {currentAgent.label} is thinking…
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* input */}
          <div className="flex gap-2">
            <Input
              placeholder={`Tell ${currentAgent.label} something about this project…`}
              value={msg}
              onChange={e => setMsg(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendToAgent(); } }}
              disabled={sending}
            />
            <Button onClick={sendToAgent} disabled={sending || !msg.trim()} className="gap-2">
              <Send className="h-4 w-4" />{sending ? "…" : "Send"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Bottlenecks (always visible, front-and-center) ── */}
      <Card className={`glass-card ${openBN.length > 0 ? "border-red-900/40" : "border-border/20"}`}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="font-display tracking-widest text-sm">
            BOTTLENECKS
            {openBN.length > 0 && (
              <span className="ml-2 text-xs bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">{openBN.length} open</span>
            )}
          </CardTitle>
          <Button size="sm" variant="ghost" onClick={addBottleneck}><Plus className="h-4 w-4" /></Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {openBN.length === 0 && <div className="text-xs text-muted-foreground">Nothing in the way.</div>}
          {openBN.map(b => (
            <div key={b.id} className="flex gap-2 items-center">
              <span className={`h-2 w-2 shrink-0 rounded-full ${b.severity === "high" ? "bg-red-500" : "bg-amber-500"}`} />
              <Input defaultValue={b.description}
                onBlur={e => updateBottleneck(b.id, { description: e.target.value })}
                className="h-8 text-xs flex-1" />
              <Select defaultValue={b.severity} onValueChange={v => updateBottleneck(b.id, { severity: v })}>
                <SelectTrigger className="h-8 text-xs w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="ghost" onClick={() => resolveBottleneck(b.id)}>
                <Check className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ── Clients + Leads ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="glass-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Clients</CardTitle>
            <Button size="sm" variant="ghost" onClick={addClient}><Plus className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="space-y-2 max-h-64 overflow-auto">
            {clients.length === 0 && <div className="text-xs text-muted-foreground">No clients yet.</div>}
            {clients.map(c => (
              <div key={c.id} className="flex gap-2 items-center">
                <Input defaultValue={c.name ?? ""}     onBlur={e => updateClient(c.id, { name: e.target.value })}    className="h-8 text-xs" placeholder="Name" />
                <Input defaultValue={c.company ?? ""}  onBlur={e => updateClient(c.id, { company: e.target.value })} className="h-8 text-xs" placeholder="Company" />
                <Input type="number" defaultValue={c.revenue_usd ?? 0}
                  onBlur={e => updateClient(c.id, { revenue_usd: Number(e.target.value) })}
                  className="h-8 text-xs w-24" placeholder="$" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">
              Leads
              {hotLeads.length > 0 && (
                <span className="ml-2 text-xs bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">{hotLeads.length} hot</span>
              )}
            </CardTitle>
            <Button size="sm" variant="ghost" onClick={addLead}><Plus className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="space-y-2 max-h-64 overflow-auto">
            {sortedLeads.length === 0 && <div className="text-xs text-muted-foreground">No leads yet.</div>}
            {sortedLeads.map(l => (
              <div key={l.id} className="flex gap-2 items-center">
                <span className={`h-2 w-2 shrink-0 rounded-full ${
                  l.temperature === "hot" ? "bg-red-500" : l.temperature === "warm" ? "bg-amber-500" : "bg-zinc-500"}`} />
                <Input defaultValue={l.name ?? ""}    onBlur={e => updateLead(l.id, { name: e.target.value })}    className="h-8 text-xs" placeholder="Name" />
                <Input defaultValue={l.company ?? ""} onBlur={e => updateLead(l.id, { company: e.target.value })} className="h-8 text-xs" placeholder="Company" />
                <Select defaultValue={l.temperature ?? "cold"} onValueChange={v => updateLead(l.id, { temperature: v })}>
                  <SelectTrigger className="h-8 text-xs w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hot">Hot</SelectItem>
                    <SelectItem value="warm">Warm</SelectItem>
                    <SelectItem value="cold">Cold</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* ── Financials + Pipeline ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="glass-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Financials</CardTitle>
            <Button size="sm" variant="ghost" onClick={addFinancial}><Plus className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="space-y-2 max-h-64 overflow-auto">
            {financials.length === 0 && <div className="text-xs text-muted-foreground">No entries yet.</div>}
            {financials.map(f => {
              const col = f.entry_type === "revenue" ? "text-emerald-400"
                : f.entry_type === "receivable" ? "text-amber-400" : "text-red-400";
              return (
                <div key={f.id} className="flex gap-2 items-center text-xs">
                  <Select defaultValue={f.entry_type} onValueChange={v => updateFinancial(f.id, { entry_type: v })}>
                    <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="revenue">Revenue</SelectItem>
                      <SelectItem value="expense">Expense</SelectItem>
                      <SelectItem value="payroll">Payroll</SelectItem>
                      <SelectItem value="receivable">Receivable</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input defaultValue={f.description ?? ""}
                    onBlur={e => updateFinancial(f.id, { description: e.target.value })}
                    className="h-8 text-xs" placeholder="Description" />
                  <Input type="number" defaultValue={f.amount_usd}
                    onBlur={e => updateFinancial(f.id, { amount_usd: Number(e.target.value) })}
                    className={`h-8 text-xs w-28 ${col}`} />
                </div>
              );
            })}
            <div className="pt-2 border-t border-border/30 text-sm flex justify-between">
              <span>Net</span>
              <span className={revenue - expenses >= 0 ? "text-emerald-400" : "text-red-400"}>
                ${(revenue - expenses).toLocaleString()}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardHeader className="pb-2"><CardTitle className="text-base">Pipeline</CardTitle></CardHeader>
          <CardContent className="space-y-1 max-h-64 overflow-auto text-sm">
            {filteredPipeline.length === 0 && (
              <div className="text-xs text-muted-foreground">No pipeline items tagged to this project.</div>
            )}
            {filteredPipeline.map((p: any) => (
              <div key={p.id} className="flex justify-between border-b border-border/30 py-1">
                <span>{p.description ?? p.source ?? "Deal"}</span>
                <span className="text-primary">${Number(p.amount_usd ?? p.amount ?? 0).toLocaleString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* ── Izzy — Tech Intelligence ── */}
      <Card className="glass-card border-emerald-900/30">
        <CardHeader className="pb-2">
          <CardTitle className="font-display tracking-widest text-sm text-emerald-400">IZZY — TECH INTELLIGENCE</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Izzy owns all technical architecture, automation, and tooling for this project.
            Talk to him in the Command Center above — he will document findings here.
          </p>
          {izzyCognition.length > 0 ? (
            <div className="space-y-2">
              {izzyCognition.map(m => (
                <div key={m.id} className="text-xs border-l-2 border-emerald-500/40 pl-3 py-1">
                  <div className="text-[10px] text-muted-foreground mb-0.5">
                    {new Date(m.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </div>
                  <div className="text-foreground/80 whitespace-pre-wrap">
                    {m.content.slice(0, 220)}{m.content.length > 220 ? "…" : ""}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground italic">
              No tech notes yet. Ask Izzy to map the stack, find automation gaps, or review the build.
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Agent Pulse ── */}
      <Card className="glass-card">
        <CardHeader className="pb-2">
          <CardTitle className="font-display tracking-widest text-sm">AGENT PULSE</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {AGENTS.map(a => {
            const p = agentPulse(a.slug);
            return (
              <div key={a.slug} className="flex items-start gap-3">
                <span className={`h-2 w-2 mt-1.5 shrink-0 rounded-full ${p.color} animate-pulse`} />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className={`text-sm font-medium ${a.accent}`}>{a.label}</span>
                    <span className="text-[10px] text-muted-foreground">{a.role}</span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{p.text}</div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ── Activity ── */}
      <Card className="glass-card">
        <CardHeader className="pb-2">
          <CardTitle className="font-display tracking-widest text-sm">ACTIVITY LOG</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 max-h-96 overflow-auto">
          {memory.length === 0 && <div className="text-xs text-muted-foreground">No activity yet.</div>}
          {memory.map(m => (
            <div key={m.id} className="text-xs border-b border-border/30 pb-2">
              <div className="flex justify-between text-muted-foreground mb-0.5">
                <span className="capitalize text-primary font-medium">{m.agent}</span>
                <span>{new Date(m.created_at).toLocaleString()}</span>
              </div>
              <div className="whitespace-pre-wrap text-foreground/80">{m.content}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
