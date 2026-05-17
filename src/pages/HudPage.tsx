import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { TrendingUp, Target, Flame, Bell, X, Zap, Newspaper, BarChart3, DollarSign } from "lucide-react";

type GoalRow = {
  id: string;
  period: string;
  target_amount: number;
  current_amount: number;
  label: string;
  business_vertical: string | null;
};

type PipelineRow = {
  id: string;
  description: string;
  client_name: string | null;
  estimated_value: number | null;
  stage: string;
  business_vertical: string | null;
};

type CrmRow = {
  client_name: string;
  days_since_contact: number | null;
};

type AlertRow = {
  id: string;
  signal_type: string;
  message: string;
  created_at: string;
  capital_at_stake?: number | null;
};

type TradeAccount = {
  broker: string;
  balance_usd: number | null;
};

type OpenTrade = {
  symbol: string;
  direction: string;
  pnl_usd: number | null;
};

type BalanceSnapshot = {
  snapshot_date: string;
  net_worth_usd: number | null;
  total_assets_usd: number | null;
  total_liabilities_usd: number | null;
  paper_assets_pct: number | null;
  business_pct: number | null;
  re_pct: number | null;
  cash_pct: number | null;
  atlas_summary: string | null;
};

type HudData = {
  full_name: string;
  active_goals: GoalRow[];
  pipeline: PipelineRow[];
  crm_opportunities: CrmRow[];
  trajectory_sentence: string | null;
  alerts: AlertRow[];
};

const SIGNAL_LABELS: Record<string, string> = {
  velocity_drop: "Velocity",
  aging_pipeline: "Pipeline",
  goal_behind: "Goal",
  missed_pattern: "Pattern",
  crm_overdue: "CRM",
  week_zero: "Signal",
  on_pace: "On Track",
  streak_risk: "Risk",
};

const fmt = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toLocaleString()}`;
const fmtPnl = (n: number) =>
  `${n >= 0 ? "+" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

type IncomeVelocity = {
  realised_total: number;
  daily_target: number;
  gap: number;
  pct_to_target: number;
  velocity_status: "ahead" | "on_track" | "behind" | "critical";
  trading_hours_left: number;
  rate_needed_per_hour: number;
  breakdown: { trading_realised_pnl: number; business_revenue: number; re_rent: number; legacy_income: number };
};

const HudPage = () => {
  const { user } = useAuth();
  const [hud, setHud] = useState<HudData | null>(null);
  const [accounts, setAccounts] = useState<TradeAccount[]>([]);
  const [openTrades, setOpenTrades] = useState<OpenTrade[]>([]);
  const [balanceSheet, setBalanceSheet] = useState<BalanceSnapshot | null>(null);
  const [velocity, setVelocity] = useState<IncomeVelocity | null>(null);
  const [loading, setLoading] = useState(true);

  const [bizOverdue, setBizOverdue] = useState<any[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const [runningBrief, setRunningBrief] = useState(false);

  const loadHud = useCallback(async () => {
    if (!user) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const [ctxRes, acctRes, tradesRes, bsRes, velRes, bizOverdueRes, alertsRes] = await Promise.all([
        supabase.rpc("get_forge_context", { _user_id: user.id }).catch(() => ({ data: null })),
        supabase
          .from("trading_accounts")
          .select("broker, balance_usd")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .catch(() => ({ data: [] })),
        supabase
          .from("trade_ledger")
          .select("symbol, direction, pnl_usd")
          .eq("user_id", user.id)
          .eq("status", "open")
          .catch(() => ({ data: [] })),
        supabase
          .from("balance_sheet_snapshots")
          .select("snapshot_date,net_worth_usd,total_assets_usd,total_liabilities_usd,paper_assets_pct,business_pct,re_pct,cash_pct,atlas_summary")
          .eq("user_id", user.id)
          .order("snapshot_date", { ascending: false })
          .limit(1)
          .maybeSingle()
          .catch(() => ({ data: null })),
        fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/atlas_income_velocity`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
            body: JSON.stringify({ user_id: user.id }),
          },
        ).then(r => r.ok ? r.json() : null).catch(() => null),
        supabase
          .from("atlas_business_pipeline")
          .select("id, name, stage, current_mrr, next_milestone")
          .eq("user_id", user.id)
          .not("stage", "in", '("operating","monitoring")')
          .order("updated_at", { ascending: true })
          .limit(5)
          .catch(() => ({ data: [] })),
        supabase
          .from("atlas_decision_queue")
          .select("id, decision_type, business_context, recommendation, capital_at_stake, created_at")
          .eq("user_id", user.id)
          .eq("status", "PENDING")
          .in("decision_type", ["ORANGE", "RED"])
          .order("created_at", { ascending: false })
          .limit(5)
          .catch(() => ({ data: [] })),
      ]);

      if (ctxRes.data) {
        const ctx = ctxRes.data as unknown as HudData;
        // Only pull trajectory and goals from legacy context — alerts come from atlas_decision_queue
        setHud({ ...ctx, alerts: [] });
      }
      setAccounts(((acctRes as any).data ?? []) as TradeAccount[]);
      setOpenTrades(((tradesRes as any).data ?? []) as OpenTrade[]);
      setBalanceSheet((bsRes as any).data as BalanceSnapshot | null);
      if (velRes) setVelocity(velRes as IncomeVelocity);
      setBizOverdue((bizOverdueRes as any).data ?? []);

      // Map decision queue entries to alert rows
      const decisionAlerts: AlertRow[] = ((alertsRes as any).data ?? []).map((d: any) => ({
        id: d.id,
        signal_type: (d.decision_type as string).toLowerCase(),
        message: d.business_context + (d.recommendation ? ` — ${d.recommendation}` : ""),
        created_at: d.created_at,
        capital_at_stake: d.capital_at_stake,
      }));
      setHud((prev) => prev ? { ...prev, alerts: decisionAlerts } : ({ alerts: decisionAlerts } as unknown as HudData));
    } catch (e) {
      console.error("hud load failed", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void loadHud(); }, [loadHud]);

  const handleRunBrief = async () => {
    setRunningBrief(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/atlas-trade`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: "market_brief", user_id: user!.id }),
        },
      );
      if (!res.ok) throw new Error("brief failed");
      toast.success("Market brief generated — check the Vault.");
    } catch {
      toast.error("Brief failed. Try again.");
    } finally {
      setRunningBrief(false);
    }
  };

  const dismissAlert = async (id: string) => {
    setDismissedAlerts((prev) => new Set([...prev, id]));
    // Mark decision as expired so it won't reappear
    await supabase.from("atlas_decision_queue").update({ status: "EXPIRED" }).eq("id", id).catch(() => {});
  };

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary font-display animate-pulse-glow tracking-widest text-sm">LOADING</div>
      </div>
    );
  }

  const goals = hud?.active_goals ?? [];
  const pipeline = hud?.pipeline ?? [];
  const visibleAlerts = (hud?.alerts ?? []).filter((a) => !dismissedAlerts.has(a.id));
  const totalBalance = accounts.reduce((s, a) => s + (a.balance_usd ?? 0), 0);
  const openPnl = openTrades.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground font-display tracking-widest uppercase">{today}</p>
          {hud?.trajectory_sentence && (
            <p className="text-sm text-foreground/70 mt-1 max-w-lg">{hud.trajectory_sentence}</p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRunBrief}
          disabled={runningBrief}
          className="shrink-0 text-xs gap-1.5 border-primary/30 text-primary/70 hover:text-primary hover:border-primary/60"
        >
          <Newspaper className={`h-3.5 w-3.5 ${runningBrief ? "animate-pulse" : ""}`} />
          {runningBrief ? "Briefing…" : "Run Brief"}
        </Button>
      </div>

      {/* Alerts strip */}
      {visibleAlerts.length > 0 && (
        <div className="space-y-2">
          {visibleAlerts.map((a) => (
            <div
              key={a.id}
              className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border text-xs ${
                a.signal_type === "on_pace"
                  ? "border-green-500/30 bg-green-500/5 text-green-400"
                  : "border-accent/30 bg-accent/5 text-accent"
              }`}
            >
              <Bell className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="font-display tracking-wider uppercase text-[10px] opacity-60 mr-2">
                  {SIGNAL_LABELS[a.signal_type] ?? a.signal_type}
                </span>
                {a.message}
              </div>
              <button onClick={() => dismissAlert(a.id)} className="opacity-50 hover:opacity-100 transition-opacity shrink-0">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Market Pulse — portfolio stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="glass-card p-4 text-center space-y-1">
          <div className="text-xl md:text-2xl font-display text-primary">
            {accounts.length > 0 ? fmt(totalBalance) : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Capital</div>
          <div className="text-[10px] text-muted-foreground/40">
            {accounts.length > 0 ? `${accounts.length} account${accounts.length !== 1 ? "s" : ""}` : "no accounts"}
          </div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className={`text-xl md:text-2xl font-display ${openTrades.length > 0 ? (openPnl >= 0 ? "text-green-400" : "text-red-400") : "text-primary"}`}>
            {openTrades.length > 0 ? fmtPnl(openPnl) : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Open P&L</div>
          <div className="text-[10px] text-muted-foreground/40">
            {openTrades.length} position{openTrades.length !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className="text-xl md:text-2xl font-display text-primary">
            {openTrades.length > 0 ? openTrades.length : "0"}
          </div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Open Trades</div>
          <div className="text-[10px] text-muted-foreground/40">
            {accounts.length === 0 ? "connect brokers" : "live"}
          </div>
        </div>
      </div>

      {/* Income Velocity — $100/day target tracker */}
      {velocity && (
        <div className={`glass-card p-4 space-y-3 border ${
          velocity.velocity_status === "ahead"    ? "border-green-500/30" :
          velocity.velocity_status === "on_track" ? "border-accent/20" :
          velocity.velocity_status === "behind"   ? "border-accent/40" :
          "border-red-500/40"
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <DollarSign className={`h-3.5 w-3.5 ${
                velocity.velocity_status === "ahead" ? "text-green-400" :
                velocity.velocity_status === "critical" ? "text-red-400" : "text-accent"
              }`} />
              <span className="text-xs font-display tracking-widest uppercase text-accent">
                Daily Target — ${velocity.daily_target}
              </span>
            </div>
            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-display uppercase ${
              velocity.velocity_status === "ahead"    ? "border-green-500/40 text-green-400" :
              velocity.velocity_status === "on_track" ? "border-accent/40 text-accent" :
              velocity.velocity_status === "behind"   ? "border-orange-500/40 text-orange-400" :
              "border-red-500/40 text-red-400"
            }`}>
              {velocity.velocity_status.replace("_", " ")}
            </span>
          </div>

          {/* Progress bar */}
          <div className="space-y-1">
            <div className="flex justify-between items-baseline">
              <span className="text-xl font-display text-foreground">${velocity.realised_total.toFixed(0)}</span>
              <span className="text-xs text-muted-foreground/60">
                {velocity.velocity_status !== "ahead"
                  ? `$${velocity.gap.toFixed(0)} gap · $${velocity.rate_needed_per_hour.toFixed(0)}/hr needed`
                  : `+$${(velocity.realised_total - velocity.daily_target).toFixed(0)} over target`
                }
              </span>
            </div>
            <div className="h-2 rounded-full bg-secondary/40 overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, velocity.pct_to_target)}%`,
                  background:
                    velocity.velocity_status === "ahead"    ? "hsl(142,76%,36%)" :
                    velocity.velocity_status === "on_track" ? "hsl(24,95%,54%)" :
                    velocity.velocity_status === "behind"   ? "hsl(38,95%,54%)" :
                    "hsl(0,84%,60%)",
                }}
              />
            </div>
          </div>

          {/* Vertical breakdown */}
          <div className="grid grid-cols-4 gap-2 pt-1 border-t border-border/10">
            {[
              { label: "Trading", value: velocity.breakdown.trading_realised_pnl },
              { label: "Business", value: velocity.breakdown.business_revenue },
              { label: "RE", value: velocity.breakdown.re_rent },
              { label: "Other", value: velocity.breakdown.legacy_income },
            ].map(({ label, value }) => (
              <div key={label} className="text-center">
                <div className={`text-xs font-display ${value > 0 ? "text-foreground/90" : "text-muted-foreground/40"}`}>
                  ${value > 0 ? value.toFixed(0) : "0"}
                </div>
                <div className="text-[9px] text-muted-foreground/50 uppercase tracking-wider">{label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Open positions quick view */}
      {openTrades.length > 0 && (
        <div className="glass-card p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Zap className="h-3.5 w-3.5 text-accent" />
            <span className="text-xs font-display tracking-widest text-accent uppercase">Open Positions</span>
          </div>
          <div className="space-y-1">
            {openTrades.slice(0, 5).map((t, i) => (
              <div key={i} className="flex items-center gap-3 py-1.5 border-t border-border/10 first:border-0">
                <span className="text-sm font-display text-foreground/90">{t.symbol}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full border uppercase font-display ${t.direction === "long" ? "text-green-400 border-green-400/30" : "text-red-400 border-red-400/30"}`}>
                  {t.direction}
                </span>
                <div className="flex-1" />
                {t.pnl_usd != null && (
                  <span className={`text-xs font-display ${t.pnl_usd >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {fmtPnl(t.pnl_usd)}
                  </span>
                )}
              </div>
            ))}
            {openTrades.length > 5 && (
              <p className="text-[10px] text-muted-foreground/40 pt-1">+{openTrades.length - 5} more → Positions</p>
            )}
          </div>
        </div>
      )}

      {/* Goals */}
      {goals.length > 0 && (
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Target className="h-3.5 w-3.5 text-accent" />
            <span className="text-xs font-display tracking-widest text-accent uppercase">Goals</span>
          </div>
          <div className="space-y-3">
            {goals.map((g) => {
              const pct = Math.min(100, Math.round((g.current_amount / g.target_amount) * 100));
              return (
                <div key={g.id} className="space-y-1">
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-foreground/80 capitalize">{g.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {fmt(g.current_amount)} <span className="text-muted-foreground/50">/ {fmt(g.target_amount)}</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-secondary/40 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${pct}%`,
                        background: pct >= 100 ? "hsl(142,76%,36%)" : pct >= 70 ? "hsl(24,95%,54%)" : "hsl(217,91%,60%)",
                      }}
                    />
                  </div>
                  <div className="text-[10px] text-muted-foreground/50 text-right">{pct}%</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Balance Sheet */}
      {balanceSheet && (
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-3.5 w-3.5 text-accent" />
              <span className="text-xs font-display tracking-widest text-accent uppercase">Balance Sheet</span>
            </div>
            <span className="text-[10px] text-muted-foreground/50">{balanceSheet.snapshot_date}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="text-center">
              <div className="text-sm font-display text-primary">{balanceSheet.net_worth_usd != null ? fmt(Number(balanceSheet.net_worth_usd)) : "—"}</div>
              <div className="text-[10px] text-muted-foreground/50 font-display tracking-widest uppercase">Net Worth</div>
            </div>
            <div className="text-center">
              <div className="text-sm font-display text-foreground/80">{balanceSheet.paper_assets_pct != null ? `${Number(balanceSheet.paper_assets_pct).toFixed(0)}%` : "—"}</div>
              <div className="text-[10px] text-muted-foreground/50 font-display tracking-widest uppercase">Paper</div>
            </div>
            <div className="text-center">
              <div className="text-sm font-display text-foreground/80">{balanceSheet.business_pct != null ? `${Number(balanceSheet.business_pct).toFixed(0)}%` : "—"}</div>
              <div className="text-[10px] text-muted-foreground/50 font-display tracking-widest uppercase">Business</div>
            </div>
            <div className="text-center">
              <div className="text-sm font-display text-foreground/80">{balanceSheet.re_pct != null ? `${Number(balanceSheet.re_pct).toFixed(0)}%` : "—"}</div>
              <div className="text-[10px] text-muted-foreground/50 font-display tracking-widest uppercase">Real Estate</div>
            </div>
          </div>
          {balanceSheet.atlas_summary && (
            <p className="text-xs text-muted-foreground/70 border-t border-border/20 pt-2 leading-relaxed">
              {balanceSheet.atlas_summary.slice(0, 200)}{balanceSheet.atlas_summary.length > 200 ? "…" : ""}
            </p>
          )}
        </div>
      )}

      {/* Pipeline + Follow-ups */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Pipeline — read-only summary from atlas_business_pipeline */}
        {bizOverdue.length > 0 && (
          <div className="glass-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-display tracking-widest text-primary uppercase">Pipeline</span>
              </div>
              <a href="/business" className="text-[10px] text-muted-foreground/50 hover:text-accent transition-colors">
                Manage →
              </a>
            </div>
            <div className="space-y-1.5">
              {bizOverdue.slice(0, 4).map((p: any) => (
                <div key={p.id} className="flex items-center gap-3 py-1.5 border-t border-border/10 first:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{p.name ?? p.contact_name ?? "—"}</div>
                    <div className="text-[10px] text-muted-foreground/60 capitalize">{p.stage?.replace(/_/g, " ")}</div>
                  </div>
                  {(p.current_mrr ?? p.estimated_value) != null && (
                    <span className="text-xs text-primary font-display shrink-0">{fmt(p.current_mrr ?? p.estimated_value)}</span>
                  )}
                </div>
              ))}
              {bizOverdue.length > 4 && (
                <p className="text-[10px] text-muted-foreground/40 pt-1">+{bizOverdue.length - 4} more</p>
              )}
            </div>
          </div>
        )}

        {/* Pending decisions requiring attention */}
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Flame className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-display tracking-widest text-primary uppercase">Decisions</span>
          </div>
          {(hud?.alerts ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-2">No pending decisions. Atlas is watching.</p>
          ) : (
            <div className="space-y-2">
              {(hud?.alerts ?? []).slice(0, 4).map((a) => (
                <div key={a.id} className="flex items-start gap-3 py-1.5 border-t border-border/10 first:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs leading-relaxed text-foreground/80 line-clamp-2">{a.message}</div>
                    {a.capital_at_stake != null && (
                      <div className="text-[10px] text-accent/70 mt-0.5">{fmt(a.capital_at_stake)} at stake</div>
                    )}
                  </div>
                  <span className={`text-[10px] font-display uppercase shrink-0 px-1.5 py-0.5 rounded border ${
                    a.signal_type === "red"    ? "text-red-400 border-red-400/30" :
                    a.signal_type === "orange" ? "text-orange-400 border-orange-400/30" : "text-accent border-accent/30"
                  }`}>
                    {a.signal_type}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

export default HudPage;
