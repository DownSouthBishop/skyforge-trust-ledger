import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Users, Plus, ChevronRight, Loader2, CheckCircle2, X } from "lucide-react";

interface Lead {
  id: string;
  full_name: string;
  business_name: string | null;
  phone: string | null;
  email: string | null;
  city_region: string | null;
  service_requested: string | null;
  status: string;
  priority: string;
  source: string;
  linda_notes: string | null;
  linda_confidence: number | null;
  last_contacted_at: string | null;
  created_at: string;
}

interface PendingResponse {
  id: string;
  lead_id: string;
  subject: string;
  body: string;
  channel: string;
  linda_confidence: number | null;
  created_at: string;
}

const STATUS_ORDER = ["new", "responded", "qualified", "proposal_sent", "negotiating", "won", "lost", "nurturing", "cold"];

const statusColor: Record<string, string> = {
  new: "#f97316",
  responded: "#3b82f6",
  qualified: "#22c55e",
  proposal_sent: "#a855f7",
  negotiating: "#f59e0b",
  won: "#22c55e",
  lost: "#71717a",
  nurturing: "#14b8a6",
  cold: "#3f3f46",
};

const priorityColor: Record<string, string> = {
  hot: "#ef4444",
  normal: "#f97316",
  cold: "#71717a",
};

export default function LindaLeadsPage() {
  const { user } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [pendingResponses, setPendingResponses] = useState<PendingResponse[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const loadLeads = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [leadsRes, responsesRes] = await Promise.all([
      supabase.from("linda_leads").select("*").eq("user_id", user.id)
        .order("created_at", { ascending: false }),
      supabase.from("linda_responses").select("*").eq("user_id", user.id)
        .eq("status", "pending_approval").order("created_at", { ascending: false }),
    ]);
    setLeads(leadsRes.data ?? []);
    setPendingResponses(responsesRes.data ?? []);
    setLoading(false);
  }, [user]);

  useEffect(() => { loadLeads(); }, [loadLeads]);

  const updateLeadStatus = async (id: string, status: string) => {
    await supabase.from("linda_leads").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    loadLeads();
    if (selectedLead?.id === id) setSelectedLead(prev => prev ? { ...prev, status } : null);
  };

  const approveResponse = async (id: string) => {
    await supabase.from("linda_responses").update({ status: "sent", sent_at: new Date().toISOString(), approved_by: "bishop" }).eq("id", id);
    loadLeads();
  };

  const filteredLeads = filterStatus === "all" ? leads : leads.filter(l => l.status === filterStatus);

  return (
    <div className="min-h-screen bg-background p-6 md:p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">PrymalAI Leads</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Linda's inbound pipeline · {leads.length} total</p>
        </div>
        <a href="/linda" className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-purple-400 transition-all"
           style={{ background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.2)" }}>
          👁 Ask Linda
        </a>
      </div>

      {/* Pending responses banner */}
      {pendingResponses.length > 0 && (
        <div className="mb-6 rounded-xl p-4 border border-blue-500/20 bg-blue-500/5 flex items-center gap-3">
          <CheckCircle2 className="w-4 h-4 text-blue-400 shrink-0" />
          <div className="flex-1">
            <div className="text-xs font-semibold text-blue-300">{pendingResponses.length} response{pendingResponses.length !== 1 ? "s" : ""} awaiting approval</div>
            <div className="text-xs text-zinc-500 mt-0.5">Linda drafted these — approve to send</div>
          </div>
        </div>
      )}

      {/* Status filter */}
      <div className="flex flex-wrap gap-2 mb-6">
        <button onClick={() => setFilterStatus("all")}
          className="px-3 py-1.5 rounded-lg text-xs transition-all"
          style={filterStatus === "all" ? { background: "rgba(249,115,22,0.15)", color: "#f97316", border: "1px solid rgba(249,115,22,0.2)" } : { background: "rgba(255,255,255,0.04)", color: "#71717a", border: "1px solid rgba(255,255,255,0.06)" }}>
          All ({leads.length})
        </button>
        {STATUS_ORDER.filter(s => leads.some(l => l.status === s)).map(s => (
          <button key={s} onClick={() => setFilterStatus(s)}
            className="px-3 py-1.5 rounded-lg text-xs transition-all capitalize"
            style={filterStatus === s
              ? { background: `${statusColor[s]}20`, color: statusColor[s], border: `1px solid ${statusColor[s]}30` }
              : { background: "rgba(255,255,255,0.04)", color: "#71717a", border: "1px solid rgba(255,255,255,0.06)" }}>
            {s.replace("_", " ")} ({leads.filter(l => l.status === s).length})
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr,400px]">
        {/* Lead list */}
        <div>
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
            </div>
          ) : filteredLeads.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 rounded-2xl border border-border/20 border-dashed">
              <Users className="w-8 h-8 text-zinc-700 mb-3" />
              <div className="text-sm text-zinc-500">No leads yet</div>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredLeads.map(lead => (
                <button key={lead.id} onClick={() => setSelectedLead(lead)}
                  className="w-full text-left rounded-xl p-4 border transition-all"
                  style={{
                    background: selectedLead?.id === lead.id ? "rgba(168,85,247,0.06)" : "rgba(255,255,255,0.02)",
                    borderColor: selectedLead?.id === lead.id ? "rgba(168,85,247,0.25)" : "rgba(255,255,255,0.08)",
                  }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-sm font-medium text-zinc-200">{lead.full_name}</span>
                        {lead.business_name && <span className="text-xs text-zinc-500">{lead.business_name}</span>}
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize"
                              style={{ background: `${priorityColor[lead.priority] ?? "#71717a"}15`, color: priorityColor[lead.priority] ?? "#71717a" }}>
                          {lead.priority}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-zinc-500 flex-wrap">
                        {lead.service_requested && <span className="font-mono text-teal-400">{lead.service_requested}</span>}
                        <span>{lead.city_region}</span>
                        <span>{lead.source}</span>
                        {lead.linda_confidence != null && <span>Linda {(lead.linda_confidence * 100).toFixed(0)}% conf</span>}
                      </div>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <span className="text-[10px] px-2 py-0.5 rounded-full capitalize"
                            style={{ background: `${statusColor[lead.status] ?? "#71717a"}15`, color: statusColor[lead.status] ?? "#71717a" }}>
                        {lead.status.replace("_", " ")}
                      </span>
                      <span className="text-[10px] text-zinc-600">{new Date(lead.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Lead detail panel */}
        {selectedLead && (
          <div className="rounded-2xl border border-border/30 overflow-hidden"
               style={{ background: "rgba(255,255,255,0.02)" }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/20">
              <div className="text-sm font-semibold text-zinc-200">{selectedLead.full_name}</div>
              <button onClick={() => setSelectedLead(null)} className="text-zinc-500 hover:text-zinc-300">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-2 text-xs">
                {[
                  { label: "Service", value: selectedLead.service_requested },
                  { label: "Source", value: selectedLead.source },
                  { label: "Email", value: selectedLead.email },
                  { label: "Phone", value: selectedLead.phone },
                  { label: "Location", value: selectedLead.city_region },
                  { label: "Priority", value: selectedLead.priority },
                ].filter(f => f.value).map(({ label, value }) => (
                  <div key={label} className="rounded-lg p-2 bg-white/3 border border-border/15">
                    <div className="text-zinc-600 mb-0.5">{label}</div>
                    <div className="text-zinc-300 capitalize">{value}</div>
                  </div>
                ))}
              </div>

              {selectedLead.linda_notes && (
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Linda's Assessment</div>
                  <div className="text-xs text-zinc-300 leading-relaxed bg-white/3 rounded-lg p-3 border border-border/15">
                    {selectedLead.linda_notes}
                  </div>
                </div>
              )}

              {/* Status progression */}
              <div>
                <div className="text-xs text-zinc-500 mb-2">Move to</div>
                <div className="flex flex-wrap gap-1.5">
                  {["responded", "qualified", "proposal_sent", "won", "lost"].map(s => (
                    <button key={s} onClick={() => updateLeadStatus(selectedLead.id, s)}
                      disabled={selectedLead.status === s}
                      className="px-2 py-1 rounded-lg text-xs capitalize transition-all disabled:opacity-40"
                      style={{ background: `${statusColor[s] ?? "#71717a"}12`, color: statusColor[s] ?? "#71717a", border: `1px solid ${statusColor[s] ?? "#71717a"}20` }}>
                      {s.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </div>

              {/* Pending responses for this lead */}
              {pendingResponses.filter(r => r.lead_id === selectedLead.id).map(r => (
                <div key={r.id} className="rounded-xl p-3 border border-blue-500/20 bg-blue-500/5">
                  <div className="text-xs font-semibold text-blue-300 mb-1">{r.subject}</div>
                  <div className="text-xs text-zinc-400 leading-relaxed max-h-32 overflow-y-auto mb-3">{r.body}</div>
                  <button onClick={() => approveResponse(r.id)}
                    className="w-full py-1.5 rounded-lg text-xs font-medium text-blue-300"
                    style={{ background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.2)" }}>
                    <CheckCircle2 className="w-3 h-3 inline mr-1" />
                    Approve & Send
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
