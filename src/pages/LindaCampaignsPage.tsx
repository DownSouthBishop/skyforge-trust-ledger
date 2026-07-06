import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Megaphone, Plus, Loader2, X, TrendingUp } from "lucide-react";
import LindaNav from "@/components/LindaNav";

interface Campaign {
  id: string;
  title: string;
  content_type: string;
  vertical: string;
  target_audience: string | null;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  impressions: number;
  clicks: number;
  form_submissions: number;
  leads_generated: number;
  revenue_attributed: number;
  linda_prediction: string | null;
  linda_confidence: number | null;
  performance_rating: string | null;
  created_at: string;
}

const verticalColor: Record<string, string> = {
  prymalai: "#14b8a6",
  marine: "#3b82f6",
  book: "#f97316",
  wig_general: "#a855f7",
};

const statusColor: Record<string, string> = {
  draft: "#71717a",
  scheduled: "#f59e0b",
  published: "#22c55e",
  paused: "#f97316",
  archived: "#3f3f46",
};

export default function LindaCampaignsPage() {
  const { user } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterVertical, setFilterVertical] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const loadCampaigns = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from("linda_campaigns")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    setCampaigns(data ?? []);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  const filtered = campaigns.filter(c =>
    (filterVertical === "all" || c.vertical === filterVertical) &&
    (filterStatus === "all" || c.status === filterStatus),
  );

  const totalLeads = campaigns.reduce((s, c) => s + (c.leads_generated ?? 0), 0);
  const totalRevenue = campaigns.reduce((s, c) => s + (c.revenue_attributed ?? 0), 0);

  return (
    <div className="min-h-screen bg-background p-6 md:p-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Campaigns</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Content across all WIG verticals</p>
        </div>
        <a href="/linda" className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-purple-400"
           style={{ background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.2)" }}>
          👁 Ask Linda
        </a>
      </div>

      <div className="mb-6"><LindaNav /></div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        {[
          { label: "Total Campaigns", value: campaigns.length, color: "#a855f7" },
          { label: "Published", value: campaigns.filter(c => c.status === "published").length, color: "#22c55e" },
          { label: "Leads Generated", value: totalLeads, color: "#f97316" },
          { label: "Revenue Attributed", value: `$${totalRevenue.toLocaleString()}`, color: "#14b8a6" },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl p-4 border border-border/20" style={{ background: "rgba(255,255,255,0.02)" }}>
            <div className="text-xs text-zinc-500 mb-1">{label}</div>
            <div className="text-xl font-bold" style={{ color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-6">
        <div className="flex flex-wrap gap-2">
          {["all", "prymalai", "marine", "book", "wig_general"].map(v => (
            <button key={v} onClick={() => setFilterVertical(v)}
              className="px-3 py-1.5 rounded-lg text-xs capitalize transition-all"
              style={filterVertical === v
                ? { background: `${verticalColor[v] ?? "#a855f7"}20`, color: verticalColor[v] ?? "#a855f7", border: `1px solid ${verticalColor[v] ?? "#a855f7"}30` }
                : { background: "rgba(255,255,255,0.04)", color: "#71717a", border: "1px solid rgba(255,255,255,0.06)" }}>
              {v === "all" ? "All" : v === "wig_general" ? "WIG" : v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {["all", "draft", "scheduled", "published", "paused"].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className="px-3 py-1.5 rounded-lg text-xs capitalize transition-all"
              style={filterStatus === s
                ? { background: `${statusColor[s] ?? "#71717a"}20`, color: statusColor[s] ?? "#71717a", border: `1px solid ${statusColor[s] ?? "#71717a"}30` }
                : { background: "rgba(255,255,255,0.04)", color: "#71717a", border: "1px solid rgba(255,255,255,0.06)" }}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 rounded-2xl border border-border/20 border-dashed">
          <Megaphone className="w-8 h-8 text-zinc-700 mb-3" />
          <div className="text-sm text-zinc-500">No campaigns yet</div>
          <div className="text-xs text-zinc-600 mt-1">Ask Linda to brief a campaign</div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map(c => (
            <div key={c.id} className="rounded-xl p-4 border border-border/20 hover:border-border/40 transition-colors"
                 style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0 pr-2">
                  <div className="text-sm font-medium text-zinc-200 mb-1 truncate">{c.title}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize"
                          style={{ background: `${verticalColor[c.vertical] ?? "#71717a"}15`, color: verticalColor[c.vertical] ?? "#71717a" }}>
                      {c.vertical === "wig_general" ? "WIG" : c.vertical}
                    </span>
                    <span className="text-[10px] text-zinc-600">{c.content_type?.replace("_", " ")}</span>
                  </div>
                </div>
                <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full capitalize"
                      style={{ background: `${statusColor[c.status] ?? "#71717a"}15`, color: statusColor[c.status] ?? "#71717a" }}>
                  {c.status}
                </span>
              </div>

              {/* Metrics */}
              <div className="grid grid-cols-4 gap-1.5 mb-3">
                {[
                  { label: "Imp", value: c.impressions ?? 0 },
                  { label: "Clicks", value: c.clicks ?? 0 },
                  { label: "Forms", value: c.form_submissions ?? 0 },
                  { label: "Leads", value: c.leads_generated ?? 0 },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-lg p-2 bg-white/3 text-center">
                    <div className="text-[10px] text-zinc-600">{label}</div>
                    <div className="text-xs font-bold text-zinc-200">{value.toLocaleString()}</div>
                  </div>
                ))}
              </div>

              {c.linda_prediction && (
                <div className="text-[10px] text-zinc-500 leading-relaxed italic border-t border-border/10 pt-2">
                  "{c.linda_prediction}"
                  {c.linda_confidence != null && (
                    <span className="ml-1 text-purple-400">{(c.linda_confidence * 100).toFixed(0)}%</span>
                  )}
                </div>
              )}

              {c.performance_rating && (
                <div className="mt-2 flex items-center gap-1">
                  <TrendingUp className="w-3 h-3 text-zinc-500" />
                  <span className="text-[10px] capitalize" style={{ color: { excellent: "#22c55e", good: "#86efac", average: "#f59e0b", poor: "#ef4444" }[c.performance_rating] ?? "#71717a" }}>
                    {c.performance_rating}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

