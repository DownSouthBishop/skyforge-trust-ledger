import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import {
  Globe, TrendingUp, Building2, BookOpen, Home, Bot,
  AlertTriangle, CheckCircle2, RefreshCw, Loader2, Zap,
} from "lucide-react";

interface WigState {
  id: string;
  snapshot_at: string;
  capital_total: number;
  capital_deployed: number;
  capital_liquid: number;
  monthly_revenue: number;
  monthly_expenses: number;
  net_monthly: number;
  active_verticals: Record<string, VerticalState>;
  risk_exposure: Record<string, unknown>;
  agent_statuses: Record<string, AgentStatus>;
  flags: FlagItem[];
  updated_by: string;
}

interface VerticalState {
  status: string;
  revenue_mtd: number;
  active_jobs: number;
  notes: string;
}

interface AgentStatus {
  last_active: string | null;
  last_outcome: string | null;
  escalations_pending: number;
}

interface FlagItem {
  type: string;
  message: string;
  severity: string;
  created_at: string;
}

interface Escalation {
  id: string;
  action_type: string;
  known_facts: string | null;
  what_it_needs: string | null;
  confidence_score: number;
  created_at: string;
  skyforge_agents: { name: string; avatar_emoji: string } | null;
}

const verticalIcon: Record<string, typeof Globe> = {
  trading: TrendingUp,
  prymalai: Building2,
  book: BookOpen,
  realestate: Home,
  marine: Globe,
};

const verticalColor: Record<string, string> = {
  trading: "#22c55e",
  prymalai: "#14b8a6",
  book: "#f97316",
  realestate: "#3b82f6",
  marine: "#a855f7",
};

const flagSeverityColor: Record<string, string> = {
  high: "#ef4444",
  normal: "#f97316",
  low: "#71717a",
};

export default function WigPage() {
  const { user } = useAuth();
  const [state, setState] = useState<WigState | null>(null);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [agentActivity, setAgentActivity] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [stateRes, escalationsRes, sessionsRes] = await Promise.all([
      supabase.rpc("get_wig_state"),
      supabase.from("agent_escalations")
        .select("id, action_type, known_facts, what_it_needs, confidence_score, created_at, skyforge_agents(name, avatar_emoji)")
        .eq("user_id", user.id).eq("status", "pending")
        .order("created_at", { ascending: false }).limit(10),
      supabase.from("agent_sessions")
        .select("id, task_description, outcome, autonomy_score, started_at, skyforge_agents(name, avatar_emoji, slug)")
        .eq("user_id", user.id)
        .order("started_at", { ascending: false }).limit(10),
    ]);
    setState(stateRes.data as WigState | null);
    setEscalations(escalationsRes.data ?? []);
    setAgentActivity(sessionsRes.data ?? []);
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const resolveEscalation = async (id: string, decision: "approved" | "rejected") => {
    await supabase.from("agent_escalations").update({
      status: decision, resolved_by: user?.email, resolved_at: new Date().toISOString()
    }).eq("id", id);
    load();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-zinc-600 animate-spin" />
      </div>
    );
  }

  const verticals = state?.active_verticals ?? {};
  const agentStatuses = state?.agent_statuses ?? {};
  const flags = Array.isArray(state?.flags) ? state!.flags : [];

  return (
    <div className="min-h-screen bg-background p-6 md:p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">WIG World State</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            {state ? `Last updated ${new Date(state.snapshot_at).toLocaleString()}` : "No snapshot yet"}
          </p>
        </div>
        <button onClick={refresh} disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-zinc-400 transition-all disabled:opacity-50"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Capital overview */}
      {state && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
          {[
            { label: "Total Capital", value: `$${Number(state.capital_total ?? 0).toLocaleString()}`, color: "#f97316" },
            { label: "Deployed", value: `$${Number(state.capital_deployed ?? 0).toLocaleString()}`, color: "#3b82f6" },
            { label: "Liquid", value: `$${Number(state.capital_liquid ?? 0).toLocaleString()}`, color: "#22c55e" },
            { label: "Monthly Revenue", value: `$${Number(state.monthly_revenue ?? 0).toLocaleString()}`, color: "#14b8a6" },
            { label: "Net Monthly", value: `$${Number(state.net_monthly ?? 0).toLocaleString()}`, color: (state.net_monthly ?? 0) >= 0 ? "#22c55e" : "#ef4444" },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-xl p-4 border border-border/20" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="text-xs text-zinc-500 mb-1">{label}</div>
              <div className="text-lg font-bold" style={{ color }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">

        {/* Verticals */}
        <div className="lg:col-span-2 space-y-4">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Verticals</div>
          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(verticals).map(([key, v]) => {
              const Icon = verticalIcon[key] ?? Globe;
              const color = verticalColor[key] ?? "#71717a";
              return (
                <div key={key} className="rounded-xl p-4 border border-border/20" style={{ background: "rgba(255,255,255,0.02)" }}>
                  <div className="flex items-center gap-2 mb-3">
                    <Icon className="w-4 h-4" style={{ color }} />
                    <span className="text-xs font-semibold capitalize" style={{ color }}>{key}</span>
                    <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full capitalize"
                          style={{ background: v.status === "active" ? "rgba(34,197,94,0.1)" : "rgba(113,113,122,0.15)", color: v.status === "active" ? "#22c55e" : "#71717a" }}>
                      {v.status}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg p-2 bg-white/3">
                      <div className="text-zinc-600 mb-0.5">Revenue MTD</div>
                      <div className="text-zinc-200 font-bold">${Number(v.revenue_mtd ?? 0).toLocaleString()}</div>
                    </div>
                    <div className="rounded-lg p-2 bg-white/3">
                      <div className="text-zinc-600 mb-0.5">Active Jobs</div>
                      <div className="text-zinc-200 font-bold">{v.active_jobs ?? 0}</div>
                    </div>
                  </div>
                  {v.notes && <div className="text-[10px] text-zinc-500 mt-2 leading-relaxed">{v.notes}</div>}
                </div>
              );
            })}
          </div>

          {/* Agent Activity */}
          {agentActivity.length > 0 && (
            <div className="mt-6">
              <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Recent Agent Activity</div>
              <div className="space-y-2">
                {agentActivity.map((s: any) => (
                  <div key={s.id} className="rounded-xl px-3 py-2.5 border border-border/20 bg-white/2 flex items-center gap-3">
                    <div className="shrink-0 text-sm">{s.skyforge_agents?.avatar_emoji ?? "🤖"}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-zinc-300 truncate">{s.task_description}</div>
                      <div className="text-[10px] text-zinc-600">{s.skyforge_agents?.name} · {new Date(s.started_at).toLocaleString()}</div>
                    </div>
                    {s.outcome && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0" style={{
                        background: s.outcome === "success" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                        color: s.outcome === "success" ? "#22c55e" : "#ef4444",
                      }}>
                        {s.outcome}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column: agents + flags + escalations */}
        <div className="space-y-6">

          {/* Agent Statuses */}
          <div>
            <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Agents</div>
            <div className="space-y-2">
              {[
                { key: "atlas", emoji: "⚡", name: "Atlas" },
                { key: "linda", emoji: "👁", name: "Linda" },
                { key: "janus", emoji: "🔮", name: "Janus" },
                { key: "izzy", emoji: "⚙️", name: "Izzy" },
              ].map(({ key, emoji, name }) => {
                const status = agentStatuses[key] as AgentStatus | undefined;
                return (
                  <div key={key} className="rounded-xl p-3 border border-border/20 bg-white/2 flex items-center gap-3">
                    <div className="text-lg shrink-0">{emoji}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-zinc-200">{name}</div>
                      {status?.last_active ? (
                        <div className="text-[10px] text-zinc-600">Last active {new Date(status.last_active).toLocaleDateString()}</div>
                      ) : (
                        <div className="text-[10px] text-zinc-700">No recent activity</div>
                      )}
                    </div>
                    {(status?.escalations_pending ?? 0) > 0 && (
                      <div className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
                           style={{ background: "#ef4444", color: "white" }}>
                        {status!.escalations_pending}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Flags */}
          {flags.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                Flags ({flags.length})
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {flags.slice(-10).reverse().map((f, i) => (
                  <div key={i} className="rounded-xl px-3 py-2 border border-border/20 bg-white/2 flex items-start gap-2">
                    <div className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: flagSeverityColor[f.severity] ?? "#71717a" }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-zinc-300 leading-relaxed">{f.message}</div>
                      <div className="text-[10px] text-zinc-600 mt-0.5">{new Date(f.created_at).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pending Escalations */}
          {escalations.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-orange-400" />
                Escalations ({escalations.length})
              </div>
              <div className="space-y-3">
                {escalations.map(e => (
                  <div key={e.id} className="rounded-xl p-3 border border-orange-500/20 bg-orange-500/5">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm">{(e.skyforge_agents as any)?.avatar_emoji ?? "🤖"}</span>
                      <span className="text-xs font-mono text-orange-300">{e.action_type}</span>
                      <span className="ml-auto text-[10px] text-orange-400">{(e.confidence_score * 100).toFixed(0)}%</span>
                    </div>
                    {e.what_it_needs && (
                      <div className="text-xs text-zinc-400 mb-2 leading-relaxed">{e.what_it_needs}</div>
                    )}
                    <div className="flex gap-1.5">
                      <button onClick={() => resolveEscalation(e.id, "approved")}
                        className="flex-1 py-1 rounded-lg text-xs font-medium" style={{ background: "rgba(34,197,94,0.12)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.2)" }}>
                        Approve
                      </button>
                      <button onClick={() => resolveEscalation(e.id, "rejected")}
                        className="flex-1 py-1 rounded-lg text-xs font-medium" style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}>
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!flags.length && !escalations.length && (
            <div className="rounded-xl p-4 border border-border/20 border-dashed text-center">
              <CheckCircle2 className="w-5 h-5 text-green-500/50 mx-auto mb-2" />
              <div className="text-xs text-zinc-600">No flags or escalations pending</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
