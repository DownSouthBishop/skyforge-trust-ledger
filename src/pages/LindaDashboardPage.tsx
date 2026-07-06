import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Users, Mail, Trophy, ShieldAlert, Loader2 } from "lucide-react";
import LindaNav from "@/components/LindaNav";

const STATUS_ORDER = ["new", "responded", "qualified", "proposal_sent", "negotiating", "won", "lost", "nurturing", "cold"];
const statusColor: Record<string, string> = {
  new: "#f97316", responded: "#3b82f6", qualified: "#22c55e", proposal_sent: "#a855f7",
  negotiating: "#f59e0b", won: "#22c55e", lost: "#71717a", nurturing: "#14b8a6", cold: "#3f3f46",
};

function MetricBlock({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  const valueColor = positive === true ? "text-green-400" : positive === false ? "text-red-400" : "text-zinc-200";
  return (
    <div className="text-center space-y-0.5">
      <div className={`text-lg font-semibold ${valueColor}`}>{value}</div>
      <div className="text-[10px] text-zinc-600 uppercase tracking-wider">{label}</div>
    </div>
  );
}

export default function LindaDashboardPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [sentCount, setSentCount] = useState(0);
  const [openedCount, setOpenedCount] = useState(0);
  const [repliedCount, setRepliedCount] = useState(0);
  const [avgDealValue, setAvgDealValue] = useState<number | null>(null);
  const [objectionsByCategory, setObjectionsByCategory] = useState<Record<string, number>>({});
  const [topCompetitors, setTopCompetitors] = useState<{ name: string; count: number }[]>([]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    const [leadsRes, responsesRes, dealsRes, objectionsRes, competitorsRes] = await Promise.all([
      supabase.from("linda_leads").select("status").eq("user_id", user.id),
      supabase.from("linda_responses").select("status,opened_at,replied_at").eq("user_id", user.id).eq("channel", "email"),
      supabase.from("linda_deals").select("deal_value").eq("user_id", user.id).not("deal_value", "is", null),
      supabase.from("linda_objections").select("objection_category").eq("user_id", user.id),
      supabase.from("linda_competitors").select("name").eq("user_id", user.id),
    ]);

    const counts: Record<string, number> = {};
    for (const l of (leadsRes.data ?? [])) counts[l.status] = (counts[l.status] ?? 0) + 1;
    setStatusCounts(counts);

    const sent = (responsesRes.data ?? []).filter((r: any) => r.status === "sent");
    setSentCount(sent.length);
    setOpenedCount(sent.filter((r: any) => r.opened_at).length);
    setRepliedCount(sent.filter((r: any) => r.replied_at).length);

    const dealValues = (dealsRes.data ?? []).map((d: any) => Number(d.deal_value)).filter((v: number) => !isNaN(v));
    setAvgDealValue(dealValues.length ? dealValues.reduce((a: number, b: number) => a + b, 0) / dealValues.length : null);

    const objCounts: Record<string, number> = {};
    for (const o of (objectionsRes.data ?? [])) {
      const cat = o.objection_category ?? "other";
      objCounts[cat] = (objCounts[cat] ?? 0) + 1;
    }
    setObjectionsByCategory(objCounts);

    const compCounts: Record<string, number> = {};
    for (const c of (competitorsRes.data ?? [])) compCounts[c.name] = (compCounts[c.name] ?? 0) + 1;
    setTopCompetitors(
      Object.entries(compCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5)
    );

    setLoading(false);
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  const totalLeads = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const won = statusCounts.won ?? 0;
  const lost = statusCounts.lost ?? 0;
  const winRate = won + lost > 0 ? won / (won + lost) : null;
  const openRate = sentCount > 0 ? openedCount / sentCount : null;
  const replyRate = sentCount > 0 ? repliedCount / sentCount : null;
  const pct = (v: number | null) => v == null ? "—" : `${(v * 100).toFixed(0)}%`;

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 md:p-8 space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Pipeline Dashboard</h1>
          <p className="text-sm text-zinc-500 mt-0.5">{totalLeads} lead{totalLeads !== 1 ? "s" : ""} across the funnel</p>
        </div>
        <a href="/linda" className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-purple-400 transition-all"
           style={{ background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.2)" }}>
          👁 Ask Linda
        </a>
      </div>

      <div className="mb-2"><LindaNav /></div>

      <Card className="border-border/30 bg-white/[0.02]">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-xs uppercase tracking-widest text-zinc-400 flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-teal-400" />
            Funnel
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="flex flex-wrap gap-2">
            {STATUS_ORDER.map(s => (
              <div key={s} className="px-3 py-2 rounded-lg text-xs capitalize"
                   style={{ background: `${statusColor[s]}12`, color: statusColor[s], border: `1px solid ${statusColor[s]}25` }}>
                {s.replace("_", " ")}: <span className="font-semibold">{statusCounts[s] ?? 0}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/30 bg-white/[0.02]">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-xs uppercase tracking-widest text-zinc-400 flex items-center gap-2">
            <Mail className="h-3.5 w-3.5 text-blue-400" />
            Outreach Performance
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricBlock label="Sent" value={String(sentCount)} />
            <MetricBlock label="Open Rate" value={pct(openRate)} />
            <MetricBlock label="Reply Rate" value={pct(replyRate)} />
            <MetricBlock label="Win Rate" value={pct(winRate)} positive={winRate != null ? winRate >= 0.3 : undefined} />
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/30 bg-white/[0.02]">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-xs uppercase tracking-widest text-zinc-400 flex items-center gap-2">
            <Trophy className="h-3.5 w-3.5 text-amber-400" />
            Deals
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricBlock label="Won" value={String(won)} positive />
            <MetricBlock label="Lost" value={String(lost)} positive={lost === 0 ? undefined : false} />
            <MetricBlock label="Avg Deal Value" value={avgDealValue != null ? `$${avgDealValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="border-border/30 bg-white/[0.02]">
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-xs uppercase tracking-widest text-zinc-400 flex items-center gap-2">
              <ShieldAlert className="h-3.5 w-3.5 text-orange-400" />
              Objections Logged
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {Object.keys(objectionsByCategory).length === 0 ? (
              <div className="text-xs text-zinc-700">None logged yet</div>
            ) : (
              <div className="space-y-1.5">
                {Object.entries(objectionsByCategory).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
                  <div key={cat} className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400 capitalize">{cat.replace("_", " ")}</span>
                    <span className="text-zinc-200 font-medium">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/30 bg-white/[0.02]">
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-xs uppercase tracking-widest text-zinc-400 flex items-center gap-2">
              <BarChart3 className="h-3.5 w-3.5 text-purple-400" />
              Top Competitors Mentioned
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {topCompetitors.length === 0 ? (
              <div className="text-xs text-zinc-700">None logged yet</div>
            ) : (
              <div className="space-y-1.5">
                {topCompetitors.map(c => (
                  <div key={c.name} className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400">{c.name}</span>
                    <span className="text-zinc-200 font-medium">{c.count}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
