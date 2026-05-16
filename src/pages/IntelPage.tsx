import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell,
} from "recharts";

type DailyPnl    = { date: string; pnl: number };
type AssetBar    = { asset_class: string; count: number; pnl: number };
type TradeStatus = { status: string; count: number };
type EquityPoint = { date: string; cumPnl: number };
type MonthlyBar  = { month: string; pnl: number };
type CommitmentStats = { kept: number; missed: number; open: number; total: number };
type GoalRow = { label: string; period: string; current_amount: number; target_amount: number };

const fmt    = (n: number) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n}`;
const fmtPnl = (n: number) => `${n >= 0 ? "+" : ""}${fmt(Math.abs(n))}`;
const GREEN = "hsl(142,76%,36%)";
const RED   = "hsl(0,72%,51%)";

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card px-3 py-2 text-xs border border-border/40">
      <p className="text-muted-foreground mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>
          {typeof p.value === "number" && p.value !== 0 ? fmtPnl(p.value) : fmt(p.value)}
        </p>
      ))}
    </div>
  );
};

const WinRateLabel = ({ cx, cy, wins, losses }: { cx: number; cy: number; wins: number; losses: number }) => {
  const total = wins + losses;
  const pct   = total > 0 ? Math.round((wins / total) * 100) : 0;
  return (
    <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
      <tspan x={cx} dy="-0.3em" fill="hsl(142,76%,36%)" fontSize={18} fontFamily="var(--font-display)">{pct}%</tspan>
      <tspan x={cx} dy="1.4em" fill="hsl(215,20%,45%)" fontSize={10}>win rate</tspan>
    </text>
  );
};

const IntelPage = () => {
  const { user } = useAuth();
  const [dailyPnl,     setDailyPnl]     = useState<DailyPnl[]>([]);
  const [equityCurve,  setEquityCurve]  = useState<EquityPoint[]>([]);
  const [winRate,      setWinRate]      = useState<{ wins: number; losses: number }>({ wins: 0, losses: 0 });
  const [monthlyPnl,   setMonthlyPnl]   = useState<MonthlyBar[]>([]);
  const [byAsset,      setByAsset]      = useState<AssetBar[]>([]);
  const [tradeStatus,  setTradeStatus]  = useState<TradeStatus[]>([]);
  const [commitStats,  setCommitStats]  = useState<CommitmentStats>({ kept: 0, missed: 0, open: 0, total: 0 });
  const [goals,        setGoals]        = useState<GoalRow[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [range,        setRange]        = useState<30 | 90>(30);

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

    // Equity curve — cumulative P&L sorted chronologically
    const closedSorted = trades
      .filter((t) => t.status === "closed" && t.closed_at && t.pnl_usd != null)
      .sort((a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime());
    let cum = 0;
    setEquityCurve(
      closedSorted.map((t) => {
        cum += Number(t.pnl_usd);
        return {
          date: new Date(t.closed_at!).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          cumPnl: Math.round(cum * 100) / 100,
        };
      }),
    );

    // Win rate
    const closed = trades.filter((t) => t.status === "closed");
    setWinRate({
      wins:   closed.filter((t) => Number(t.pnl_usd ?? 0) > 0).length,
      losses: closed.filter((t) => Number(t.pnl_usd ?? 0) <= 0).length,
    });

    // Monthly P&L — group by month
    const monthMap: Map<string, { ts: number; pnl: number }> = new Map();
    for (const t of trades) {
      if (t.status !== "closed" || !t.closed_at || t.pnl_usd == null) continue;
      const d = new Date(t.closed_at);
      const key = d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
      const entry = monthMap.get(key) ?? { ts: d.getTime(), pnl: 0 };
      entry.pnl += Number(t.pnl_usd);
      monthMap.set(key, entry);
    }
    setMonthlyPnl(
      [...monthMap.entries()]
        .sort((a, b) => a[1].ts - b[1].ts)
        .map(([month, v]) => ({ month: month.split(" ")[0], pnl: Math.round(v.pnl * 100) / 100 })),
    );

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
        .sort((a, b) => b.count - a.count),
    );

    // Trade status
    const statusMap: Record<string, number> = {};
    for (const t of trades) statusMap[t.status] = (statusMap[t.status] ?? 0) + 1;
    setTradeStatus(Object.entries(statusMap).map(([status, count]) => ({ status, count })));

    // Commitment stats
    const rows = commitRes.data ?? [];
    const stats = { kept: 0, missed: 0, open: 0, total: rows.length };
    for (const r of rows) {
      if      (r.resolution_status === "kept")   stats.kept++;
      else if (r.resolution_status === "missed") stats.missed++;
      else if (r.resolution_status === "open")   stats.open++;
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
          target_amount:  Number(g.target_amount  ?? 0),
        })),
      );
    }

    setLoading(false);
  }, [user, range]);

  useEffect(() => { void loadData(); }, [loadData]);

  const totalPnl   = dailyPnl.reduce((s, d) => s + d.pnl, 0);
  const finalCum   = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].cumPnl : 0;
  const followRate = commitStats.total > 0
    ? Math.round((commitStats.kept / (commitStats.kept + commitStats.missed || 1)) * 100)
    : null;
  const hasTrades  = dailyPnl.some((d) => d.pnl !== 0);
  const hasClosed  = equityCurve.length > 0;
  const equityColor = finalCum >= 0 ? GREEN : RED;

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

      {/* Equity Curve */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">Equity Curve</p>
          {hasClosed && (
            <span className={`text-xs font-display ${finalCum >= 0 ? "text-green-400" : "text-red-400"}`}>
              {fmtPnl(finalCum)} cumulative
            </span>
          )}
        </div>
        {!hasClosed ? (
          <p className="text-xs text-muted-foreground/50 py-4 text-center">No closed trades. Close a position to see your equity curve.</p>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={equityCurve} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={equityColor} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={equityColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220,30%,16%)" />
              <XAxis dataKey="date"   tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
              <YAxis dataKey="cumPnl" tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} tickFormatter={(v) => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="cumPnl" stroke={equityColor} strokeWidth={2} fill="url(#eqGrad)" name="Equity" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Win Rate + Monthly P&L */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Win Rate Donut */}
        <div className="glass-card p-4 space-y-3">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">Win Rate</p>
          {winRate.wins + winRate.losses === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-2">No closed trades yet.</p>
          ) : (
            <div className="flex items-center gap-6">
              <ResponsiveContainer width={140} height={140}>
                <PieChart>
                  <Pie
                    data={[
                      { name: "Wins",   value: winRate.wins   || 0.001 },
                      { name: "Losses", value: winRate.losses || 0.001 },
                    ]}
                    cx="50%"
                    cy="50%"
                    innerRadius={44}
                    outerRadius={60}
                    dataKey="value"
                    strokeWidth={0}
                  >
                    <Cell fill={GREEN} />
                    <Cell fill={RED} />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              {/* Manual center label overlay */}
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: GREEN }} />
                  <span className="text-muted-foreground">Wins</span>
                  <span className="ml-auto font-display text-green-400">{winRate.wins}</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: RED }} />
                  <span className="text-muted-foreground">Losses</span>
                  <span className="ml-auto font-display text-red-400">{winRate.losses}</span>
                </div>
                <div className="pt-1 border-t border-border/20">
                  <span className="text-[10px] text-muted-foreground">Win rate: </span>
                  <span className="text-sm font-display text-green-400">
                    {Math.round((winRate.wins / (winRate.wins + winRate.losses)) * 100)}%
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Monthly P&L */}
        <div className="glass-card p-4 space-y-3">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">Monthly P&L</p>
          {monthlyPnl.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-2">No closed trades in this period.</p>
          ) : (
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={monthlyPnl} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220,30%,16%)" />
                <XAxis dataKey="month" tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} />
                <YAxis tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} tickFormatter={(v) => fmt(v)} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                  {monthlyPnl.map((entry, i) => (
                    <Cell key={i} fill={entry.pnl >= 0 ? GREEN : RED} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* P&L trend (daily) */}
      <div className="glass-card p-4 space-y-3">
        <p className="text-[10px] font-display tracking-widest text-primary uppercase">Daily P&L Trend</p>
        {!hasTrades ? (
          <p className="text-xs text-muted-foreground/50 py-4 text-center">No closed trades in this period. Log trades in Positions.</p>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={dailyPnl} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={GREEN} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={GREEN} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220,30%,16%)" />
              <XAxis dataKey="date" tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} tickFormatter={(v) => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="pnl" stroke={GREEN} strokeWidth={2} fill="url(#pnlGrad)" />
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
                <Bar dataKey="count" name="Trades" fill="hsl(24,95%,54%)"  radius={[3, 3, 0, 0]} />
                <Bar dataKey="pnl"   name="P&L"    radius={[3, 3, 0, 0]}>
                  {byAsset.map((entry, i) => (
                    <Cell key={i} fill={entry.pnl >= 0 ? GREEN : RED} />
                  ))}
                </Bar>
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
                const color = s.status === "open" ? "hsl(217,91%,60%)" : s.status === "closed" ? GREEN : "hsl(215,20%,45%)";
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
                const pct   = g.target_amount > 0 ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100)) : 0;
                const color = pct >= 100 ? GREEN : pct >= 70 ? "hsl(24,95%,54%)" : "hsl(217,91%,60%)";
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
                  { label: "Kept",   value: commitStats.kept,   color: GREEN },
                  { label: "Open",   value: commitStats.open,   color: "hsl(217,91%,60%)" },
                  { label: "Missed", value: commitStats.missed, color: RED },
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
