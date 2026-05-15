import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from "recharts";

type DailyPnl = { date: string; pnl: number };
type AssetBar = { asset_class: string; count: number; pnl: number };
type TradeStatus = { status: string; count: number };
type CommitmentStats = { kept: number; missed: number; open: number; total: number };
type GoalRow = { label: string; period: string; current_amount: number; target_amount: number };

const fmt = (n: number) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n}`;
const fmtPnl = (n: number) => `${n >= 0 ? "+" : ""}${fmt(Math.abs(n))}`;

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card px-3 py-2 text-xs border border-border/40">
      <p className="text-muted-foreground mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>{typeof p.value === "number" && p.value !== 0 ? fmtPnl(p.value) : fmt(p.value)}</p>
      ))}
    </div>
  );
};

const IntelPage = () => {
  const { user } = useAuth();
  const [dailyPnl, setDailyPnl] = useState<DailyPnl[]>([]);
  const [byAsset, setByAsset] = useState<AssetBar[]>([]);
  const [tradeStatus, setTradeStatus] = useState<TradeStatus[]>([]);
  const [commitStats, setCommitStats] = useState<CommitmentStats>({ kept: 0, missed: 0, open: 0, total: 0 });
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<30 | 90>(30);

  const loadData = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    const since = new Date();
    since.setDate(since.getDate() - range);
    const sinceStr = since.toISOString();

    const [tradesRes, commitRes, ctxRes] = await Promise.all([
      supabase
        .from("trade_ledger")
        .select("closed_at, pnl_usd, asset_class, status")
        .eq("user_id", user.id)
        .gte("created_at", sinceStr),
      supabase
        .from("forge_commitments")
        .select("resolution_status")
        .eq("user_id", user.id),
      supabase.rpc("get_forge_context", { _user_id: user.id }),
    ]);

    const trades = tradesRes.data ?? [];

    // Daily P&L — closed trades by close date
    const byDate: Record<string, number> = {};
    for (const t of trades) {
      if (t.status !== "closed" || !t.closed_at || t.pnl_usd == null) continue;
      const d = new Date(t.closed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      byDate[d] = (byDate[d] ?? 0) + Number(t.pnl_usd);
    }
    const filled: DailyPnl[] = [];
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      filled.push({ date: label, pnl: byDate[label] ?? 0 });
    }
    const step = range === 90 ? 3 : 1;
    setDailyPnl(filled.filter((_, i) => i % step === 0 || i === filled.length - 1));

    // By asset class
    const byAssetMap: Record<string, { count: number; pnl: number }> = {};
    for (const t of trades) {
      const cls = t.asset_class ?? "unknown";
      if (!byAssetMap[cls]) byAssetMap[cls] = { count: 0, pnl: 0 };
      byAssetMap[cls].count += 1;
      byAssetMap[cls].pnl += Number(t.pnl_usd ?? 0);
    }
    setByAsset(
      Object.entries(byAssetMap)
        .map(([asset_class, d]) => ({ asset_class, count: d.count, pnl: Math.round(d.pnl * 100) / 100 }))
        .sort((a, b) => b.count - a.count)
    );

    // Trade status breakdown
    const statusMap: Record<string, number> = {};
    for (const t of trades) {
      statusMap[t.status] = (statusMap[t.status] ?? 0) + 1;
    }
    setTradeStatus(Object.entries(statusMap).map(([status, count]) => ({ status, count })));

    // Commitment stats
    const rows = commitRes.data ?? [];
    const stats = { kept: 0, missed: 0, open: 0, total: rows.length };
    for (const r of rows) {
      if (r.resolution_status === "kept") stats.kept++;
      else if (r.resolution_status === "missed") stats.missed++;
      else if (r.resolution_status === "open") stats.open++;
    }
    setCommitStats(stats);

    // Goals from context
    const ctx = ctxRes.data as any;
    if (ctx?.active_goals) {
      setGoals(
        (ctx.active_goals as any[]).map((g) => ({
          label: g.label ?? g.period,
          period: g.period,
          current_amount: Number(g.current_amount ?? 0),
          target_amount: Number(g.target_amount ?? 0),
        }))
      );
    }

    setLoading(false);
  }, [user, range]);

  useEffect(() => { void loadData(); }, [loadData]);

  const totalPnl = dailyPnl.reduce((s, d) => s + d.pnl, 0);
  const followRate = commitStats.total > 0
    ? Math.round((commitStats.kept / (commitStats.kept + commitStats.missed || 1)) * 100)
    : null;
  const hasTrades = dailyPnl.some((d) => d.pnl !== 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary font-display animate-pulse-glow tracking-widest text-sm">LOADING</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      {/* Header + range toggle */}
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-display tracking-widest text-primary uppercase">Intel</h1>
        <div className="flex gap-1">
          {([30, 90] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                range === r
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-border/40 text-muted-foreground hover:border-border/70"
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {/* Summary stat row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="glass-card p-4 text-center space-y-1">
          <div className={`text-xl font-display ${totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
            {hasTrades ? fmtPnl(totalPnl) : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">{range}d P&L</div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className="text-xl font-display text-primary">
            {followRate !== null ? `${followRate}%` : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Follow-Through</div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className="text-xl font-display text-accent">
            {tradeStatus.reduce((s, t) => s + t.count, 0) || "—"}
          </div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">{range}d Trades</div>
        </div>
      </div>

      {/* P&L trend */}
      <div className="glass-card p-4 space-y-3">
        <p className="text-[10px] font-display tracking-widest text-primary uppercase">P&L Trend</p>
        {!hasTrades ? (
          <p className="text-xs text-muted-foreground/50 py-4 text-center">No closed trades in this period. Log trades in Positions.</p>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={dailyPnl} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(142,76%,36%)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(142,76%,36%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220,30%,16%)" />
              <XAxis dataKey="date" tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} tickFormatter={(v) => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="pnl" stroke="hsl(142,76%,36%)" strokeWidth={2} fill="url(#pnlGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* By asset class + trade status */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        <div className="glass-card p-4 space-y-3">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">By Asset Class</p>
          {byAsset.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-2">No trades logged yet. Start in Positions.</p>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={byAsset} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220,30%,16%)" />
                <XAxis dataKey="asset_class" tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} />
                <YAxis tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} tickFormatter={(v) => String(v)} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="count" fill="hsl(24,95%,54%)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Trade status */}
        <div className="glass-card p-4 space-y-3">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">Trade Status</p>
          {tradeStatus.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-2">No trades in this period.</p>
          ) : (
            <div className="space-y-3 pt-1">
              {tradeStatus.map((s) => {
                const maxCount = Math.max(...tradeStatus.map((x) => x.count), 1);
                const color = s.status === "open" ? "hsl(217,91%,60%)" : s.status === "closed" ? "hsl(142,76%,36%)" : "hsl(215,20%,45%)";
                return (
                  <div key={s.status} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground/80 capitalize">{s.status}</span>
                      <span className="font-display" style={{ color }}>{s.count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-secondary/40 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(s.count / maxCount) * 100}%`, background: color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Goals + Commitment follow-through */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        <div className="glass-card p-4 space-y-3">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">Goal Attainment</p>
          {goals.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-2">No active goals. Set them in Dossier or Atlas.</p>
          ) : (
            <div className="space-y-3">
              {goals.map((g, i) => {
                const pct = g.target_amount > 0 ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100)) : 0;
                const color = pct >= 100 ? "hsl(142,76%,36%)" : pct >= 70 ? "hsl(24,95%,54%)" : "hsl(217,91%,60%)";
                return (
                  <div key={i} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground/80 capitalize">{g.label}</span>
                      <span className="font-display" style={{ color }}>{pct}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-secondary/40 overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <div className="text-[10px] text-muted-foreground/40 text-right">
                      {fmt(g.current_amount)} of {fmt(g.target_amount)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="glass-card p-4 space-y-3">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">Commitment Follow-Through</p>
          {commitStats.total === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-2">No commitments tracked yet. Atlas logs them during conversations.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-end gap-1 h-20">
                {[
                  { label: "Kept", value: commitStats.kept, color: "hsl(142,76%,36%)" },
                  { label: "Open", value: commitStats.open, color: "hsl(217,91%,60%)" },
                  { label: "Missed", value: commitStats.missed, color: "hsl(0,72%,51%)" },
                ].map((s) => {
                  const max = Math.max(commitStats.kept, commitStats.open, commitStats.missed, 1);
                  return (
                    <div key={s.label} className="flex-1 flex flex-col items-center gap-1">
                      <span className="text-xs font-display" style={{ color: s.color }}>{s.value}</span>
                      <div className="w-full rounded-t-md transition-all" style={{ height: `${(s.value / max) * 60}px`, background: s.color, opacity: 0.8 }} />
                      <span className="text-[10px] text-muted-foreground/60">{s.label}</span>
                    </div>
                  );
                })}
              </div>
              {followRate !== null && (
                <p className="text-xs text-muted-foreground/60 text-center">
                  {followRate}% follow-through rate ({commitStats.kept} kept / {commitStats.kept + commitStats.missed} resolved)
                </p>
              )}
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

export default IntelPage;
