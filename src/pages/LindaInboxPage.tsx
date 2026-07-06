import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Inbox, CheckCircle2, X, Loader2, Mail, MessageSquare, FileText } from "lucide-react";
import { approveAndSendResponse } from "@/lib/linda";
import LindaNav from "@/components/LindaNav";

interface InboxItem {
  id: string;
  lead_id: string;
  channel: string;
  subject: string;
  body: string;
  status: string;
  approved_by: string | null;
  sent_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
  linda_confidence: number | null;
  created_at: string;
  lead: { full_name: string; email: string | null; business_name: string | null } | null;
}

const CHANNEL: Record<string, { color: string; Icon: typeof Mail; label: string }> = {
  email:      { color: "#3b82f6", Icon: Mail,          label: "Email" },
  sms:        { color: "#14b8a6", Icon: MessageSquare,  label: "SMS" },
  form_reply: { color: "#a855f7", Icon: FileText,       label: "Form Reply" },
};

const STATUS_TABS = [
  { key: "all",              label: "All" },
  { key: "pending_approval", label: "Pending" },
  { key: "sent",             label: "Sent" },
  { key: "failed",           label: "Failed" },
];

export default function LindaInboxPage() {
  const { user }     = useAuth();
  const [items, setItems]           = useState<InboxItem[]>([]);
  const [loading, setLoading]       = useState(true);
  const [selected, setSelected]     = useState<InboxItem | null>(null);
  const [filterStatus, setFilter]   = useState("all");
  const [sendingId, setSendingId]   = useState<string | null>(null);
  const [sendError, setSendError]   = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    const { data: responses } = await supabase
      .from("linda_responses")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    const rows = responses ?? [];
    const leadIds = [...new Set(rows.map((r: any) => r.lead_id).filter(Boolean))] as string[];

    let leadsMap: Record<string, any> = {};
    if (leadIds.length > 0) {
      const { data: leads } = await supabase
        .from("linda_leads")
        .select("id, full_name, email, business_name")
        .in("id", leadIds);
      leadsMap = Object.fromEntries((leads ?? []).map((l: any) => [l.id, l]));
    }

    setItems(rows.map((r: any) => ({ ...r, lead: leadsMap[r.lead_id] ?? null })));
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  const approveResponse = async (id: string) => {
    setSendError(null);
    setSendingId(id);
    try {
      await approveAndSendResponse(id);
      const now = new Date().toISOString();
      setItems(prev => prev.map(i => i.id === id ? { ...i, status: "sent", sent_at: now, approved_by: "bishop" } : i));
      setSelected(prev => prev?.id === id ? { ...prev, status: "sent", sent_at: now, approved_by: "bishop" } : prev);
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSendingId(null);
    }
  };

  const rejectResponse = async (id: string) => {
    await supabase.from("linda_responses").update({ status: "failed" }).eq("id", id);
    setItems(prev => prev.map(i => i.id === id ? { ...i, status: "failed" } : i));
    setSelected(prev => prev?.id === id ? { ...prev, status: "failed" } : prev);
  };

  const pendingCount = items.filter(i => i.status === "pending_approval").length;
  const filtered     = filterStatus === "all" ? items : items.filter(i => i.status === filterStatus);

  return (
    <div className="min-h-screen bg-background p-6 md:p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg"
               style={{ background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.2)" }}>
            👁
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white tracking-tight">Linda's Inbox</h1>
            <p className="text-sm text-zinc-500 mt-0.5">Drafted responses awaiting your review · {items.length} total</p>
          </div>
        </div>
        <a href="/linda"
           className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-purple-400 transition-all"
           style={{ background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.2)" }}>
          👁 Ask Linda
        </a>
      </div>

      {/* Linda sub-nav */}
      <div className="mb-6">
        <LindaNav />
      </div>

      {/* Pending banner */}
      {pendingCount > 0 && (
        <div className="mb-6 rounded-xl p-4 border border-blue-500/20 bg-blue-500/5 flex items-center gap-3">
          <CheckCircle2 className="w-4 h-4 text-blue-400 shrink-0" />
          <div>
            <div className="text-xs font-semibold text-blue-300">
              {pendingCount} response{pendingCount !== 1 ? "s" : ""} awaiting approval
            </div>
            <div className="text-xs text-zinc-500 mt-0.5">Linda drafted these — approve to send</div>
          </div>
        </div>
      )}

      {/* Status filter tabs */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {STATUS_TABS.map(tab => {
          const count = tab.key === "all" ? items.length : items.filter(i => i.status === tab.key).length;
          return (
            <button key={tab.key} onClick={() => setFilter(tab.key)}
              className="px-3 py-1.5 rounded-lg text-xs transition-all"
              style={filterStatus === tab.key
                ? { background: "rgba(168,85,247,0.15)", color: "#a855f7", border: "1px solid rgba(168,85,247,0.2)" }
                : { background: "rgba(255,255,255,0.04)", color: "#71717a", border: "1px solid rgba(255,255,255,0.06)" }}>
              {tab.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Main grid */}
      <div className="grid gap-4 lg:grid-cols-[1fr,420px]">

        {/* Left — message list */}
        <div>
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 rounded-2xl border border-border/20 border-dashed">
              <Inbox className="w-8 h-8 text-zinc-700 mb-3" />
              <div className="text-sm text-zinc-500">No messages</div>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map(item => {
                const ch = CHANNEL[item.channel] ?? CHANNEL.email;
                const { Icon } = ch;
                return (
                  <button key={item.id} onClick={() => setSelected(item)}
                    className="w-full text-left rounded-xl p-4 border transition-all"
                    style={{
                      background:   selected?.id === item.id ? "rgba(168,85,247,0.06)" : "rgba(255,255,255,0.02)",
                      borderColor:  selected?.id === item.id ? "rgba(168,85,247,0.25)" : "rgba(255,255,255,0.08)",
                    }}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                             style={{ background: `${ch.color}15`, border: `1px solid ${ch.color}25` }}>
                          <Icon className="w-3.5 h-3.5" style={{ color: ch.color }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                            <span className="text-sm font-medium text-zinc-200">
                              {item.lead?.full_name ?? "Unknown Lead"}
                            </span>
                            {item.lead?.business_name && (
                              <span className="text-xs text-zinc-500">{item.lead.business_name}</span>
                            )}
                          </div>
                          <div className="text-xs text-zinc-400 truncate mb-1">{item.subject}</div>
                          <div className="flex items-center gap-2 text-[10px] text-zinc-600 flex-wrap">
                            <span className="px-1.5 py-0.5 rounded-full font-medium"
                                  style={{ background: `${ch.color}12`, color: ch.color }}>
                              {ch.label}
                            </span>
                            {item.linda_confidence != null && (
                              <span>Linda {(item.linda_confidence * 100).toFixed(0)}% conf</span>
                            )}
                            <span>{new Date(item.created_at).toLocaleDateString()}</span>
                          </div>
                        </div>
                      </div>
                      <div className="shrink-0">
                        <span className="text-[10px] px-2 py-0.5 rounded-full capitalize"
                              style={item.status === "pending_approval"
                                ? { background: "rgba(59,130,246,0.12)",  color: "#93c5fd" }
                                : item.status === "sent"
                                ? { background: "rgba(34,197,94,0.12)",   color: "#86efac" }
                                : { background: "rgba(239,68,68,0.12)",   color: "#fca5a5" }}>
                          {item.status === "pending_approval" ? "Pending" : item.status}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right — detail panel */}
        {selected && (() => {
          const ch = CHANNEL[selected.channel] ?? CHANNEL.email;
          const { Icon } = ch;
          return (
            <div className="rounded-2xl border border-border/30 overflow-hidden"
                 style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-border/20">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" style={{ color: ch.color }} />
                  <span className="text-sm font-semibold text-zinc-200 truncate">{selected.subject}</span>
                </div>
                <button onClick={() => setSelected(null)} className="text-zinc-500 hover:text-zinc-300 shrink-0 ml-2">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-4 space-y-4">
                {/* Lead context */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {[
                    { label: "To",         value: selected.lead?.full_name },
                    { label: "Business",   value: selected.lead?.business_name },
                    { label: "Email",      value: selected.lead?.email },
                    { label: "Channel",    value: ch.label },
                    { label: "Confidence", value: selected.linda_confidence != null ? `${(selected.linda_confidence * 100).toFixed(0)}%` : null },
                    { label: "Created",    value: new Date(selected.created_at).toLocaleString() },
                  ].filter(f => f.value).map(({ label, value }) => (
                    <div key={label} className="rounded-lg p-2 bg-white/[0.03] border border-border/15">
                      <div className="text-zinc-600 mb-0.5">{label}</div>
                      <div className="text-zinc-300">{value}</div>
                    </div>
                  ))}
                </div>

                {/* Engagement timestamps */}
                {selected.status === "sent" && (
                  <div className="flex gap-2 flex-wrap">
                    {selected.sent_at && (
                      <span className="text-[10px] px-2 py-1 rounded-lg border"
                            style={{ background: "rgba(34,197,94,0.06)", color: "#86efac", borderColor: "rgba(34,197,94,0.15)" }}>
                        Sent {new Date(selected.sent_at).toLocaleString()}
                      </span>
                    )}
                    {selected.opened_at && (
                      <span className="text-[10px] px-2 py-1 rounded-lg border"
                            style={{ background: "rgba(59,130,246,0.06)", color: "#93c5fd", borderColor: "rgba(59,130,246,0.15)" }}>
                        Opened {new Date(selected.opened_at).toLocaleString()}
                      </span>
                    )}
                    {selected.replied_at && (
                      <span className="text-[10px] px-2 py-1 rounded-lg border"
                            style={{ background: "rgba(168,85,247,0.06)", color: "#d8b4fe", borderColor: "rgba(168,85,247,0.15)" }}>
                        Replied {new Date(selected.replied_at).toLocaleString()}
                      </span>
                    )}
                  </div>
                )}

                {/* Message body */}
                <div>
                  <div className="text-xs text-zinc-500 mb-2">Message</div>
                  <div className="text-xs text-zinc-300 leading-relaxed rounded-xl p-4 border border-border/15 max-h-64 overflow-y-auto whitespace-pre-wrap"
                       style={{ background: "rgba(255,255,255,0.02)" }}>
                    {selected.body}
                  </div>
                </div>

                {/* Actions */}
                {selected.status === "pending_approval" && (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <button onClick={() => approveResponse(selected.id)}
                        disabled={sendingId === selected.id}
                        className="flex-1 py-2 rounded-xl text-xs font-medium text-green-400 flex items-center justify-center gap-1.5 transition-all disabled:opacity-50"
                        style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.2)" }}>
                        {sendingId === selected.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        {sendingId === selected.id ? "Sending…" : "Approve & Send"}
                      </button>
                      <button onClick={() => rejectResponse(selected.id)}
                        disabled={sendingId === selected.id}
                        className="flex-1 py-2 rounded-xl text-xs font-medium text-red-400 flex items-center justify-center gap-1.5 transition-all disabled:opacity-50"
                        style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.15)" }}>
                        <X className="w-3.5 h-3.5" />
                        Reject
                      </button>
                    </div>
                    {sendError && selected.status === "pending_approval" && (
                      <div className="text-[10px] text-red-400 leading-relaxed">{sendError}</div>
                    )}
                  </div>
                )}

                {selected.status === "sent" && selected.approved_by && (
                  <div className="text-[10px] text-zinc-600 text-center">
                    Approved by {selected.approved_by}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
