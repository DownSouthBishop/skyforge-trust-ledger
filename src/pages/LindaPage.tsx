import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Send, Eye, Users, Megaphone, AlertTriangle, CheckCircle2, X, Loader2, Plus } from "lucide-react";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

interface Msg {
  role: "user" | "assistant";
  content: string;
}

interface PendingLead {
  id: string;
  full_name: string;
  business_name: string | null;
  service_requested: string | null;
  source: string;
  created_at: string;
}

interface PendingResponse {
  id: string;
  lead_id: string;
  subject: string;
  created_at: string;
}

interface Escalation {
  id: string;
  action_type: string;
  known_facts: string | null;
  what_it_needs: string | null;
  created_at: string;
}

export default function LindaPage() {
  const { user } = useAuth();

  const [principal, setPrincipal] = useState<"bishop" | "calvin">("bishop");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loadingContext, setLoadingContext] = useState(true);

  const [pendingLeads, setPendingLeads] = useState<PendingLead[]>([]);
  const [pendingResponses, setPendingResponses] = useState<PendingResponse[]>([]);
  const [escalations, setEscalations] = useState<Escalation[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadContext = useCallback(async () => {
    if (!user) return;
    setLoadingContext(true);
    const [leadsRes, responsesRes, escalationsRes] = await Promise.all([
      supabase.from("linda_leads").select("id, full_name, business_name, service_requested, source, created_at")
        .eq("user_id", user.id).eq("status", "new").order("created_at", { ascending: false }).limit(10),
      supabase.from("linda_responses").select("id, lead_id, subject, created_at")
        .eq("user_id", user.id).eq("status", "pending_approval").order("created_at", { ascending: false }).limit(5),
      supabase.from("agent_escalations").select("id, action_type, known_facts, what_it_needs, created_at")
        .eq("user_id", user.id).eq("status", "pending").order("created_at", { ascending: false }).limit(5),
    ]);
    setPendingLeads(leadsRes.data ?? []);
    setPendingResponses(responsesRes.data ?? []);
    setEscalations(escalationsRes.data ?? []);
    setLoadingContext(false);
  }, [user]);

  useEffect(() => { loadContext(); }, [loadContext]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const newMsg: Msg = { role: "user", content: text };
    const history = [...messages, newMsg];
    setMessages(history);
    setInput("");
    setStreaming(true);

    const assistantMsg: Msg = { role: "assistant", content: "" };
    setMessages([...history, assistantMsg]);

    abortRef.current = new AbortController();

    // Log this exchange to cross-agent memory (fire-and-forget)
    supabase.from("agent_cross_memory").insert({
      user_id: user!.id,
      source_agent: "linda",
      summary: `Linda and Bishop discussed: ${text.slice(0, 100)}${text.length > 100 ? "…" : ""}`,
    }).then(() => {}).catch(() => {});

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";

      const res = await fetch(`${SUPABASE_URL}/functions/v1/linda-chat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          principal,
          messages: history.map(m => ({ role: m.role, content: m.content })),
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? `HTTP ${res.status}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let full = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          let line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") break;
          try {
            const p = JSON.parse(json);
            if (p.type === "content_block_delta" && p.delta?.type === "text_delta") {
              full += p.delta.text;
              setMessages([...history, { role: "assistant", content: full }]);
            }
          } catch { /* */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setMessages([...history, { role: "assistant", content: `Error: ${(e as Error).message}` }]);
      }
    } finally {
      setStreaming(false);
    }
  }, [input, messages, streaming, principal]);

  const approveResponse = async (id: string) => {
    await supabase.from("linda_responses").update({ status: "sent", sent_at: new Date().toISOString(), approved_by: "bishop" }).eq("id", id);
    loadContext();
  };

  const resolveEscalation = async (id: string, decision: "approved" | "rejected") => {
    await supabase.from("agent_escalations").update({ status: decision, resolved_by: principal, resolved_at: new Date().toISOString() }).eq("id", id);
    loadContext();
  };

  return (
    <div className="min-h-screen bg-background flex overflow-hidden" style={{ height: "100vh" }}>

      {/* ── Left: Chat ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/30 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg"
                 style={{ background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.2)" }}>
              👁
            </div>
            <div>
              <div className="text-sm font-semibold text-white">Linda</div>
              <div className="text-xs text-zinc-500">Chief of Staff · WIG</div>
            </div>
          </div>

          {/* Principal selector */}
          <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
            {(["bishop", "calvin"] as const).map(p => (
              <button key={p} onClick={() => setPrincipal(p)}
                className="px-3 py-1.5 rounded-md text-xs font-medium transition-all capitalize"
                style={principal === p
                  ? { background: "rgba(168,85,247,0.2)", color: "#a855f7" }
                  : { color: "#71717a" }}>
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center py-20">
              <div className="text-5xl mb-4">👁</div>
              <div className="text-sm text-zinc-400 mb-1">Linda is standing by.</div>
              <div className="text-xs text-zinc-600">Tell her what needs to happen.</div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-purple-500/15 border border-purple-500/25 text-purple-100"
                  : "bg-white/5 border border-white/10 text-zinc-200"
              }`}>
                {m.content}
                {m.role === "assistant" && streaming && i === messages.length - 1 && (
                  <span className="inline-block w-1 h-4 bg-purple-400 animate-pulse ml-0.5 align-text-bottom" />
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="px-6 pb-6 shrink-0">
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder="Tell Linda what needs to happen…"
              rows={2}
              disabled={streaming}
              className="flex-1 resize-none rounded-xl px-4 py-3 text-sm bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/40 transition-colors"
            />
            <button
              onClick={() => void send()}
              disabled={streaming || !input.trim()}
              className="shrink-0 p-3 rounded-xl transition-all disabled:opacity-40"
              style={{ background: "rgba(168,85,247,0.15)", color: "#a855f7", border: "1px solid rgba(168,85,247,0.2)" }}>
              {streaming ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* ── Right: Live Feed ── */}
      <div className="w-80 border-l border-border/30 flex flex-col overflow-hidden shrink-0">
        <div className="px-4 py-4 border-b border-border/20 shrink-0">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Live Feed</div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">

          {/* Escalations */}
          {escalations.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-3.5 h-3.5 text-orange-400" />
                <span className="text-xs font-semibold text-zinc-300">Escalations ({escalations.length})</span>
              </div>
              <div className="space-y-2">
                {escalations.map(e => (
                  <div key={e.id} className="rounded-xl p-3 border border-orange-500/20 bg-orange-500/5">
                    <div className="text-xs font-mono text-orange-300 mb-1">{e.action_type}</div>
                    {e.what_it_needs && <div className="text-xs text-zinc-400 mb-2 leading-relaxed">{e.what_it_needs}</div>}
                    <div className="flex gap-1.5">
                      <button onClick={() => resolveEscalation(e.id, "approved")}
                        className="flex-1 py-1 rounded-lg text-xs font-medium text-green-400" style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.2)" }}>
                        Approve
                      </button>
                      <button onClick={() => resolveEscalation(e.id, "rejected")}
                        className="flex-1 py-1 rounded-lg text-xs font-medium text-red-400" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Pending Responses */}
          {pendingResponses.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-xs font-semibold text-zinc-300">Awaiting Approval ({pendingResponses.length})</span>
              </div>
              <div className="space-y-2">
                {pendingResponses.map(r => (
                  <div key={r.id} className="rounded-xl p-3 border border-blue-500/20 bg-blue-500/5">
                    <div className="text-xs text-zinc-300 truncate mb-1">{r.subject}</div>
                    <div className="text-[10px] text-zinc-600 mb-2">{new Date(r.created_at).toLocaleString()}</div>
                    <button onClick={() => approveResponse(r.id)}
                      className="w-full py-1 rounded-lg text-xs font-medium text-blue-400" style={{ background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.2)" }}>
                      Approve & Send
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* New Leads */}
          {pendingLeads.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <Users className="w-3.5 h-3.5 text-teal-400" />
                <span className="text-xs font-semibold text-zinc-300">New Leads ({pendingLeads.length})</span>
              </div>
              <div className="space-y-2">
                {pendingLeads.map(l => (
                  <div key={l.id} className="rounded-xl p-3 border border-teal-500/15 bg-teal-500/4">
                    <div className="text-xs font-medium text-zinc-200">{l.full_name}</div>
                    {l.business_name && <div className="text-[10px] text-zinc-500">{l.business_name}</div>}
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-600">
                      {l.service_requested && <span className="font-mono text-teal-500">{l.service_requested}</span>}
                      <span>{l.source}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!loadingContext && !escalations.length && !pendingResponses.length && !pendingLeads.length && (
            <div className="text-center py-8 text-xs text-zinc-700">All clear — no pending items</div>
          )}
        </div>
      </div>
    </div>
  );
}
