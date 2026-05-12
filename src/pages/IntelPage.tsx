import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from "recharts";

type DailyIncome = { date: string; amount: number };
type VerticalBar = { vertical: string; total: number; jobs: number };
type PipelineStage = { stage: string; count: number; value: number };
type CommitmentStats = { kept: number; missed: number; open: number; total: number };
type GoalRow = { label: string; period: string; current_amount: number; target_amount: number };

const fmt = (n: number) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n}`;

const STAGE_ORDER = ["quoted", "in_progress", "closing"];
const STAGE_LABELS: Record<string, string> = { quoted: "Quoted", in_progress: "In Progress", closing: "Closing" };

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card px-3 py-2 text-xs border border-border/40">
      <p className="text-muted-foreground mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>{fmt(p.value)}</p>
      ))}
    </div>
  );
};

const IntelPage = () => {
  const { user } = useAuth();
  const [dailyIncome, setDailyIncome] = useState<DailyIncome[]>([]);
  const [verticals, setVerticals] = useState<VerticalBar[]>([]);
  const [pipeline, setPipeline] = useState<PipelineStage[]>([]);
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

    const [receiptsRes, pipelineRes, commitRes, ctxRes] = await Promise.all([
      supabase
        .from("receipts_ledger")
        .select("created_at, action_value_usd, business_vertical")
        .eq("provider_id", user.id)
        .gte("created_at", sinceStr)
        .order("created_at", { ascending: true }),
      supabase
        .from("income_pipeline")
        .select("stage, estimated_value")
        .eq("user_id", user.id)
        .not("stage", "in", "(won,lost)"),
      supabase
        .from("forge_commitments")
        .select("resolution_status")
        .eq("user_id", user.id),
      supabase.rpc("get_forge_context", { _user_id: user.id }),
    ]);

    // Daily income — aggregate by date
    const byDate: Record<string, number> = {};
    for (const r of (receiptsRes.data ?? [])) {
      const d = new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      byDate[d] = (byDate[d] ?? 0) + Number(r.action_value_usd ?? 0);
    }
    // Fill gaps with zero for the range
    const filled: DailyIncome[] = [];
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      filled.push({ date: label, amount: byDate[label] ?? 0 });
    }
    // Thin to every Nth day if range is large to avoid crowded x-axis
    const step = range === 90 ? 3 : 1;
    setDailyIncome(filled.filter((_, i) => i % step === 0 || i === filled.length - 1));

    // Vertical breakdown
    const byVertical: Record<string, { total: number; jobs: number }> = {};
    for (const r of (receiptsRes.data ?? [])) {
      const v = r.business_vertical ?? "Untagged";
      if (!byVertical[v]) byVertical[v] = { total: 0, jobs: 0 };
      byVertical[v].total += Number(r.action_value_usd ?? 0);
      byVertical[v].jobs += 1;
    }
    setVerticals(
      Object.entries(byVertical)
        .map(([vertical, d]) => ({ vertical, total: Math.round(d.total), jobs: d.jobs }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 8)
    );

    // Pipeline by stage
    const byStage: Record<string, { count: number; value: number }> = {};
    for (const p of (pipelineRes.data ?? [])) {
      if (!byStage[p.stage]) byStage[p.stage] = { count: 0, value: 0 };
      byStage[p.stage].count += 1;
      byStage[p.stage].value += Number(p.estimated_value ?? 0);
    }
    setPipeline(
      STAGE_ORDER.map((s) => ({
        stage: STAGE_LABELS[s] ?? s,
        count: byStage[s]?.count ?? 0,
        value: Math.round(byStage[s]?.value ?? 0),
      }))
    );

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

  const totalIncome = dailyIncome.reduce((s, d) => s + d.amount, 0);
  const followRate = commitStats.total > 0
    ? Math.round((commitStats.kept / (commitStats.kept + commitStats.missed || 1)) * 100)
    : null;

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
          <div className="text-xl font-display text-primary">{fmt(totalIncome)}</div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">{range}d Income</div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className="text-xl font-display text-primary">
            {followRate !== null ? `${followRate}%` : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Follow-Through</div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className="text-xl font-display text-accent">
            {pipeline.reduce((s, p) => s + p.value, 0) > 0 ? fmt(pipeline.reduce((s, p) => s + p.value, 0)) : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Pipeline</div>
        </div>
      </div>

      {/* Income trend */}
      <div className="glass-card p-4 space-y-3">
        <p className="text-[10px] font-display tracking-widest text-primary uppercase">Income Trend</p>
        {dailyIncome.every((d) => d.amount === 0) ? (
          <p className="text-xs text-muted-foreground/50 py-4 text-center">No income logged in this period.</p>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={dailyIncome} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="incomeGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(217,91%,60%)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(217,91%,60%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220,30%,16%)" />
              <XAxis dataKey="date" tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} tickFormatter={(v) => fmt(v)} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="amount" stroke="hsl(217,91%,60%)" strokeWidth={2} fill="url(#incomeGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Vertical breakdown + pipeline */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Vertical breakdown */}
        <div className="glass-card p-4 space-y-3">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">By Business</p>
          {verticals.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-2">No verticals tracked yet. Tag your income entries.</p>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={verticals} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220,30%,16%)" />
                <XAxis dataKey="vertical" tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} />
                <YAxis tick={{ fill: "hsl(215,20%,45%)", fontSize: 10 }} tickLine={false} tickFormatter={(v) => fmt(v)} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="total" fill="hsl(24,95%,54%)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Pipeline funnel */}
        <div className="glass-card p-4 space-y-3">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">Pipeline Stages</p>
          {pipeline.every((p) => p.count === 0) ? (
            <p className="text-xs text-muted-foreground/50 py-2">No open pipeline items.</p>
          ) : (
            <div className="space-y-3 pt-1">
              {pipeline.map((p) => (
                <div key={p.stage} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground/80">{p.stage}</span>
                    <span className="text-primary font-display">
                      {p.count > 0 ? `${p.count} · ${fmt(p.value)}` : "—"}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-secondary/40 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary/60"
                      style={{ width: `${Math.min(100, (p.count / Math.max(...pipeline.map((x) => x.count), 1)) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Goals + Commitment follow-through */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Goals attainment */}
        <div className="glass-card p-4 space-y-3">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">Goal Attainment</p>
          {goals.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-2">No active goals. Set them in the Income tab.</p>
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

        {/* Commitment follow-through */}
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
                      <div
                        className="w-full rounded-t-md transition-all"
                        style={{ height: `${(s.value / max) * 60}px`, background: s.color, opacity: 0.8 }}
                      />
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
