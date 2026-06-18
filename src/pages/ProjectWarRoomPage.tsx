import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _supabase } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = _supabase as any;
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send, Plus, Check } from "lucide-react";
import { buildProjectContextBlock } from "@/lib/project-context";
import { streamFunctionToText } from "@/lib/stream-fn";

type Agent = "atlas" | "linda" | "janus" | "izzy";

export default function ProjectWarRoomPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [project, setProject] = useState<any>(null);
  const [onboarding, setOnboarding] = useState<any>(null);
  const [clients, setClients] = useState<any[]>([]);
  const [leads, setLeads] = useState<any[]>([]);
  const [financials, setFinancials] = useState<any[]>([]);
  const [bottlenecks, setBottlenecks] = useState<any[]>([]);
  const [memory, setMemory] = useState<any[]>([]);
  const [pipeline, setPipeline] = useState<any[]>([]);

  const [agent, setAgent] = useState<Agent>("atlas");
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [lastReply, setLastReply] = useState<string>("");

  const load = useCallback(async () => {
    if (!id || !user) return;
    const [p, o, c, l, f, b, m, pi] = await Promise.all([
      supabase.from("business_projects").select("*").eq("id", id).maybeSingle(),
      supabase.from("project_onboarding").select("*").eq("project_id", id).maybeSingle(),
      supabase.from("project_clients").select("*").eq("project_id", id).order("created_at", { ascending: false }),
      supabase.from("project_leads").select("*").eq("project_id", id).order("created_at", { ascending: false }),
      supabase.from("project_financials").select("*").eq("project_id", id).order("date", { ascending: false }),
      supabase.from("project_bottlenecks").select("*").eq("project_id", id).order("created_at", { ascending: false }),
      supabase.from("project_memory").select("*").eq("project_id", id).order("created_at", { ascending: false }).limit(50),
      supabase.from("income_pipeline").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20),
    ]);
    setProject(p.data); setOnboarding(o.data);
    setClients(c.data ?? []); setLeads(l.data ?? []);
    setFinancials(f.data ?? []); setBottlenecks(b.data ?? []);
    setMemory(m.data ?? []); setPipeline(pi.data ?? []);
  }, [id, user]);

  useEffect(() => { load(); }, [load]);

  // Realtime memory
  useEffect(() => {
    if (!id) return;
    const ch = supabase.channel(`pmem-${id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "project_memory", filter: `project_id=eq.${id}` },
        (payload: any) => setMemory((cur) => [payload.new, ...cur].slice(0, 50)))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id]);

  const revenue = financials.filter((r) => r.entry_type === "revenue").reduce((s, r) => s + Number(r.amount_usd || 0), 0);
  const expenses = financials.filter((r) => r.entry_type !== "revenue").reduce((s, r) => s + Number(r.amount_usd || 0), 0);
  const target = Number(project?.goal_revenue_usd || 0);
  const gap = target - revenue;
  const hotLeads = leads.filter((l) => l.temperature === "hot");
  const warmLeads = leads.filter((l) => l.temperature === "warm");
  const coldLeads = leads.filter((l) => l.temperature !== "hot" && l.temperature !== "warm");

  const sortedLeads = [...hotLeads, ...warmLeads, ...coldLeads];
  const filteredPipeline = pipeline.filter((p: any) => p.project_id === id);

  const sendToAgent = async () => {
    if (!prompt.trim() || !user || !id) return;
    setSending(true);
    const userMsg = prompt.trim();
    setPrompt("");
    setLastReply("");
    try {
      const ctxBlock = await buildProjectContextBlock(id);
      const sess = await supabase.auth.getSession();
      const accessToken = sess.data.session?.access_token;
      if (!accessToken) throw new Error("no session");

      let reply = "";
      if (agent === "atlas") {
        reply = await streamFunctionToText("forge_chat", {
          mode: "chat",
          messages: [
            { role: "user", content: `[PROJECT CONTEXT — read silently]\n${ctxBlock}` },
            { role: "assistant", content: "Understood. Operating inside this project." },
            { role: "user", content: userMsg },
          ],
        }, accessToken);
      } else {
        reply = await streamFunctionToText("agent-chat", {
          agent_slug: agent,
          messages: [
            { role: "user", content: `[PROJECT CONTEXT — read silently]\n${ctxBlock}` },
            { role: "assistant", content: "Understood. Operating inside this project." },
            { role: "user", content: userMsg },
          ],
        }, accessToken);
      }
      setLastReply(reply);

      // Persist exchange to project_memory (server-side via agent_remember also writes,
      // but we insert directly here to guarantee capture even if remember fails).
      await supabase.from("project_memory").insert([
        { project_id: id, user_id: user.id, agent: "operator", content: userMsg, memory_type: "conversation" },
        { project_id: id, user_id: user.id, agent, content: reply || "(no response)", memory_type: "conversation" },
      ]);

      // Background memory extraction tied to the project
      supabase.functions.invoke("agent_remember", {
        body: {
          user_id: user.id,
          source_agent: agent,
          user_message: userMsg,
          assistant_message: reply,
          context: `project:${project?.name ?? id}`,
          project_id: id,
        },
      }).catch(() => { /* fire-and-forget */ });
    } catch (e) {
      setLastReply(`Error: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  // Inline add/edit helpers
  const addClient = async () => {
    if (!user || !id) return;
    await supabase.from("project_clients").insert({ project_id: id, user_id: user.id, name: "New client" });
    load();
  };
  const addLead = async () => {
    if (!user || !id) return;
    await supabase.from("project_leads").insert({ project_id: id, user_id: user.id, name: "New lead", temperature: "cold" });
    load();
  };
  const addFinancial = async () => {
    if (!user || !id) return;
    const amount = Number(prompt && /^\d+(\.\d+)?$/.test(prompt) ? prompt : 0);
    await supabase.from("project_financials").insert({ project_id: id, user_id: user.id, entry_type: "revenue", amount_usd: amount || 0, description: "" });
    load();
  };
  const addBottleneck = async () => {
    if (!user || !id) return;
    await supabase.from("project_bottlenecks").insert({ project_id: id, user_id: user.id, description: "New bottleneck", severity: "medium" });
    load();
  };
  const resolveBottleneck = async (bid: string) => {
    await supabase.from("project_bottlenecks").update({ resolved: true }).eq("id", bid);
    load();
  };
  const updateClient = async (cid: string, patch: any) => { await supabase.from("project_clients").update(patch).eq("id", cid); };
  const updateLead = async (lid: string, patch: any) => { await supabase.from("project_leads").update(patch).eq("id", lid); };
  const updateFinancial = async (fid: string, patch: any) => { await supabase.from("project_financials").update(patch).eq("id", fid); };
  const updateBottleneck = async (bid: string, patch: any) => { await supabase.from("project_bottlenecks").update(patch).eq("id", bid); };

  // Agent pulse — last memory per agent
  const agentPulse = (slug: Agent) => {
    const last = memory.find((m) => m.agent === slug);
    if (!last) return { color: "bg-zinc-500", text: "no activity yet" };
    const ageH = (Date.now() - new Date(last.created_at).getTime()) / 3.6e6;
    const color = ageH < 48 ? "bg-emerald-500" : ageH < 72 ? "bg-amber-500" : "bg-red-500";
    return { color, text: last.content.slice(0, 140) };
  };

  if (!project) return <div className="p-6 text-muted-foreground">Loading project…</div>;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <Card className="glass-card">
        <CardContent className="p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="font-display text-2xl text-primary tracking-widest">{project.name}</h1>
              <p className="text-sm text-muted-foreground mt-1">{project.mission || project.description}</p>
              {project.website && <a href={project.website} target="_blank" rel="noreferrer" className="text-xs text-accent">{project.website}</a>}
            </div>
            <Badge variant="outline">{project.status}</Badge>
          </div>

          <div className="flex gap-2 items-center pt-2 border-t border-border/40">
            <Select value={agent} onValueChange={(v) => setAgent(v as Agent)}>
              <SelectTrigger className="w-[120px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="atlas">Atlas</SelectItem>
                <SelectItem value="linda">Linda</SelectItem>
                <SelectItem value="janus">Janus</SelectItem>
                <SelectItem value="izzy">Izzy</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder={`Tell ${agent} what to do…`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendToAgent(); } }}
              disabled={sending}
            />
            <Button onClick={sendToAgent} disabled={sending || !prompt.trim()} className="gap-2">
              <Send className="h-4 w-4" /> {sending ? "…" : "Send"}
            </Button>
          </div>
          {lastReply && (
            <div className="text-sm whitespace-pre-wrap p-3 rounded-lg bg-primary/5 border border-primary/20">
              <strong className="capitalize">{agent}:</strong> {lastReply}
            </div>
          )}
        </CardContent>
      </Card>

      {/* The Gap */}
      <Card className="glass-card">
        <CardHeader><CardTitle className="text-base">The Gap</CardTitle></CardHeader>
        <CardContent>
          <div className="text-lg">
            Target <span className="text-primary">${target.toLocaleString()}</span> · Current <span className="text-emerald-400">${revenue.toLocaleString()}</span> · Gap{" "}
            <span className={gap > 0 ? "text-amber-400" : "text-emerald-400"}>${Math.abs(gap).toLocaleString()}{gap > 0 ? " to close" : " surplus"}</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Clients */}
        <Card className="glass-card">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Clients</CardTitle>
            <Button size="sm" variant="ghost" onClick={addClient}><Plus className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="space-y-2 max-h-72 overflow-auto">
            {clients.length === 0 && <div className="text-xs text-muted-foreground">No clients yet.</div>}
            {clients.map((c) => (
              <div key={c.id} className="flex gap-2 items-center">
                <Input defaultValue={c.name ?? ""} onBlur={(e) => updateClient(c.id, { name: e.target.value })} className="h-8 text-xs" placeholder="Name" />
                <Input defaultValue={c.company ?? ""} onBlur={(e) => updateClient(c.id, { company: e.target.value })} className="h-8 text-xs" placeholder="Company" />
                <Input type="number" defaultValue={c.revenue_usd ?? 0} onBlur={(e) => updateClient(c.id, { revenue_usd: Number(e.target.value) })} className="h-8 text-xs w-24" />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Leads */}
        <Card className="glass-card">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Leads</CardTitle>
            <Button size="sm" variant="ghost" onClick={addLead}><Plus className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="space-y-2 max-h-72 overflow-auto">
            {sortedLeads.length === 0 && <div className="text-xs text-muted-foreground">No leads yet.</div>}
            {sortedLeads.map((l) => (
              <div key={l.id} className="flex gap-2 items-center">
                <span className={`h-2 w-2 rounded-full ${l.temperature === "hot" ? "bg-red-500" : l.temperature === "warm" ? "bg-amber-500" : "bg-zinc-500"}`} />
                <Input defaultValue={l.name ?? ""} onBlur={(e) => updateLead(l.id, { name: e.target.value })} className="h-8 text-xs" placeholder="Name" />
                <Input defaultValue={l.company ?? ""} onBlur={(e) => updateLead(l.id, { company: e.target.value })} className="h-8 text-xs" placeholder="Company" />
                <Select defaultValue={l.temperature ?? "cold"} onValueChange={(v) => updateLead(l.id, { temperature: v })}>
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

        {/* Pipeline (reused) */}
        <Card className="glass-card">
          <CardHeader><CardTitle className="text-base">Pipeline</CardTitle></CardHeader>
          <CardContent className="space-y-1 max-h-72 overflow-auto text-sm">
            {filteredPipeline.length === 0 && <div className="text-xs text-muted-foreground">No pipeline items tagged to this project.</div>}
            {filteredPipeline.map((p: any) => (
              <div key={p.id} className="flex justify-between border-b border-border/30 py-1">
                <span>{p.description ?? p.source ?? "Deal"}</span>
                <span className="text-primary">${Number(p.amount_usd ?? p.amount ?? 0).toLocaleString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Financials */}
        <Card className="glass-card">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Financials</CardTitle>
            <Button size="sm" variant="ghost" onClick={addFinancial}><Plus className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="space-y-2 max-h-72 overflow-auto">
            {financials.map((f) => {
              const color = f.entry_type === "revenue" ? "text-emerald-400"
                : f.entry_type === "receivable" ? "text-amber-400" : "text-red-400";
              return (
                <div key={f.id} className="flex gap-2 items-center text-xs">
                  <Select defaultValue={f.entry_type} onValueChange={(v) => updateFinancial(f.id, { entry_type: v })}>
                    <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="revenue">Revenue</SelectItem>
                      <SelectItem value="expense">Expense</SelectItem>
                      <SelectItem value="payroll">Payroll</SelectItem>
                      <SelectItem value="receivable">Receivable</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input defaultValue={f.description ?? ""} onBlur={(e) => updateFinancial(f.id, { description: e.target.value })} className="h-8 text-xs" placeholder="Description" />
                  <Input type="number" defaultValue={f.amount_usd} onBlur={(e) => updateFinancial(f.id, { amount_usd: Number(e.target.value) })} className={`h-8 text-xs w-28 ${color}`} />
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
      </div>

      {/* Bottlenecks */}
      <Card className="glass-card">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Bottlenecks</CardTitle>
          <Button size="sm" variant="ghost" onClick={addBottleneck}><Plus className="h-4 w-4" /></Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {bottlenecks.filter((b) => !b.resolved).map((b) => (
            <div key={b.id} className="flex gap-2 items-center">
              <span className={`h-2 w-2 rounded-full ${b.severity === "high" ? "bg-red-500" : "bg-amber-500"}`} />
              <Input defaultValue={b.description} onBlur={(e) => updateBottleneck(b.id, { description: e.target.value })} className="h-8 text-xs flex-1" />
              <Select defaultValue={b.severity} onValueChange={(v) => updateBottleneck(b.id, { severity: v })}>
                <SelectTrigger className="h-8 text-xs w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="ghost" onClick={() => resolveBottleneck(b.id)}><Check className="h-4 w-4" /></Button>
            </div>
          ))}
          {bottlenecks.filter((b) => !b.resolved).length === 0 && <div className="text-xs text-muted-foreground">Nothing in the way.</div>}
        </CardContent>
      </Card>

      {/* Agent pulse */}
      <Card className="glass-card">
        <CardHeader><CardTitle className="text-base">Agent Pulse</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {(["atlas", "linda", "janus", "izzy"] as Agent[]).map((a) => {
            const p = agentPulse(a);
            return (
              <div key={a} className="flex items-center gap-2 text-sm">
                <span className={`h-2 w-2 rounded-full ${p.color}`} />
                <span className="capitalize w-16">{a}</span>
                <span className="text-muted-foreground truncate">{p.text}</span>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Activity log */}
      <Card className="glass-card">
        <CardHeader><CardTitle className="text-base">Activity</CardTitle></CardHeader>
        <CardContent className="space-y-2 max-h-96 overflow-auto">
          {memory.map((m) => (
            <div key={m.id} className="text-xs border-b border-border/30 pb-1">
              <div className="flex justify-between text-muted-foreground">
                <span className="capitalize text-primary">{m.agent}</span>
                <span>{new Date(m.created_at).toLocaleString()}</span>
              </div>
              <div className="whitespace-pre-wrap">{m.content}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
