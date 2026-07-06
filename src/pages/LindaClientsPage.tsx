import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Building2, Loader2, X } from "lucide-react";
import LindaNav from "@/components/LindaNav";

interface Client {
  id: string;
  business_name: string;
  owner_name: string | null;
  phone: string | null;
  email: string | null;
  city_region: string | null;
  website: string | null;
  service_type: string | null;
  monthly_recurring: number;
  one_time_revenue: number;
  contract_start: string | null;
  contract_end: string | null;
  status: string;
  site_url: string | null;
  network_tier: string | null;
  linda_notes: string | null;
  health_score: number;
  last_touchpoint: string | null;
  next_touchpoint: string | null;
  created_at: string;
}

const healthColor = (score: number) => {
  if (score >= 0.8) return "#22c55e";
  if (score >= 0.5) return "#f59e0b";
  return "#ef4444";
};

const serviceColor: Record<string, string> = {
  build: "#f97316",
  forge: "#3b82f6",
  network: "#22c55e",
  syndicate: "#a855f7",
  marine_site: "#14b8a6",
  bundle: "#f59e0b",
};

export default function LindaClientsPage() {
  const { user } = useAuth();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Client | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("active");

  const loadClients = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from("linda_clients")
      .select("*")
      .eq("user_id", user.id)
      .order("health_score", { ascending: true });
    setClients(data ?? []);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { loadClients(); }, [loadClients]);

  const filtered = clients.filter(c => filterStatus === "all" || c.status === filterStatus);
  const totalMRR = clients.filter(c => c.status === "active").reduce((s, c) => s + (c.monthly_recurring ?? 0), 0);

  return (
    <div className="min-h-screen bg-background p-6 md:p-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">PrymalAI Clients</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            {clients.filter(c => c.status === "active").length} active · ${totalMRR.toLocaleString()}/mo MRR
          </p>
        </div>
        <a href="/linda" className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-purple-400"
           style={{ background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.2)" }}>
          👁 Ask Linda
        </a>
      </div>

      <div className="mb-6"><LindaNav /></div>

      {/* MRR stat */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Active Clients", value: clients.filter(c => c.status === "active").length, color: "#22c55e" },
          { label: "Monthly Recurring", value: `$${totalMRR.toLocaleString()}`, color: "#f97316" },
          { label: "At Risk (health < 0.5)", value: clients.filter(c => (c.health_score ?? 0) < 0.5).length, color: "#ef4444" },
          { label: "Churned", value: clients.filter(c => c.status === "churned").length, color: "#71717a" },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl p-4 border border-border/20" style={{ background: "rgba(255,255,255,0.02)" }}>
            <div className="text-xs text-zinc-500 mb-1">{label}</div>
            <div className="text-xl font-bold" style={{ color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div className="flex gap-2 mb-6">
        {["all", "active", "paused", "churned", "prospect"].map(s => (
          <button key={s} onClick={() => setFilterStatus(s)}
            className="px-3 py-1.5 rounded-lg text-xs capitalize transition-all"
            style={filterStatus === s
              ? { background: "rgba(168,85,247,0.15)", color: "#a855f7", border: "1px solid rgba(168,85,247,0.25)" }
              : { background: "rgba(255,255,255,0.04)", color: "#71717a", border: "1px solid rgba(255,255,255,0.06)" }}>
            {s}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr,380px]">
        {/* Client list */}
        <div>
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 rounded-2xl border border-border/20 border-dashed">
              <Building2 className="w-8 h-8 text-zinc-700 mb-3" />
              <div className="text-sm text-zinc-500">No clients yet</div>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map(client => (
                <button key={client.id} onClick={() => setSelected(client)}
                  className="w-full text-left rounded-xl p-4 border transition-all"
                  style={{
                    background: selected?.id === client.id ? "rgba(168,85,247,0.06)" : "rgba(255,255,255,0.02)",
                    borderColor: selected?.id === client.id ? "rgba(168,85,247,0.25)" : "rgba(255,255,255,0.08)",
                  }}>
                  <div className="flex items-center gap-3">
                    {/* Health indicator */}
                    <div className="w-1 h-10 rounded-full shrink-0" style={{ background: healthColor(client.health_score ?? 0.8) }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-zinc-200">{client.business_name}</span>
                        {client.service_type && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full capitalize"
                                style={{ background: `${serviceColor[client.service_type] ?? "#71717a"}15`, color: serviceColor[client.service_type] ?? "#71717a" }}>
                            {client.service_type}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-500">
                        {client.city_region && <span>{client.city_region} · </span>}
                        {client.monthly_recurring > 0 && <span className="text-green-400">${client.monthly_recurring}/mo</span>}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs font-bold" style={{ color: healthColor(client.health_score ?? 0.8) }}>
                        {((client.health_score ?? 0.8) * 100).toFixed(0)}%
                      </div>
                      <div className="text-[10px] text-zinc-600">health</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="rounded-2xl border border-border/30 overflow-hidden" style={{ background: "rgba(255,255,255,0.02)" }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/20">
              <div className="text-sm font-semibold text-zinc-200">{selected.business_name}</div>
              <button onClick={() => setSelected(null)} className="text-zinc-500 hover:text-zinc-300">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {/* Health bar */}
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-zinc-500">Health Score</span>
                  <span style={{ color: healthColor(selected.health_score ?? 0.8) }}>
                    {((selected.health_score ?? 0.8) * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${((selected.health_score ?? 0.8) * 100)}%`, background: healthColor(selected.health_score ?? 0.8) }} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                {[
                  { label: "Owner", value: selected.owner_name },
                  { label: "Email", value: selected.email },
                  { label: "Phone", value: selected.phone },
                  { label: "Location", value: selected.city_region },
                  { label: "Service", value: selected.service_type },
                  { label: "MRR", value: selected.monthly_recurring > 0 ? `$${selected.monthly_recurring}` : null },
                  { label: "Contract Start", value: selected.contract_start },
                  { label: "Network Tier", value: selected.network_tier },
                ].filter(f => f.value).map(({ label, value }) => (
                  <div key={label} className="rounded-lg p-2 bg-white/3 border border-border/15">
                    <div className="text-zinc-600 mb-0.5">{label}</div>
                    <div className="text-zinc-300">{value}</div>
                  </div>
                ))}
              </div>

              {selected.site_url && (
                <a href={selected.site_url} target="_blank" rel="noreferrer"
                   className="block text-xs text-teal-400 hover:text-teal-300 truncate">{selected.site_url}</a>
              )}

              {selected.linda_notes && (
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Linda's Notes</div>
                  <div className="text-xs text-zinc-300 leading-relaxed bg-white/3 rounded-lg p-3 border border-border/15">
                    {selected.linda_notes}
                  </div>
                </div>
              )}

              {selected.next_touchpoint && (
                <div className="text-xs text-zinc-500">
                  Next touchpoint: <span className="text-zinc-300">{new Date(selected.next_touchpoint).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

