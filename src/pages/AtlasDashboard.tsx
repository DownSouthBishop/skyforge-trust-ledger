import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  DollarSign,
  BarChart3,
  Newspaper,
  Brain,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// ─── Types ───────────────────────────────────────────────────────────────────

type DecisionItem = {
  id: string;
  priority: "RED" | "ORANGE" | "YELLOW" | "GREEN";
  title: string;
  business_context: string | null;
  capital_at_stake: number | null;
  status: string;
  created_at: string;
};

type PortfolioState = {
  id: string;
  snapshot_date: string;
  total_value: number | null;
  monthly_cashflow: number | null;
  annual_return_rate: number | null;
  rebalancing_needed: boolean | null;
  liquid_trading_pct: number | null;
  real_assets_pct: number | null;
  venture_allocation_pct: number | null;
  operating_reserve_pct: number | null;
  monthly_income: number | null;
  monthly_operating_cost: number | null;
  is_self_funding: boolean | null;
};

type BusinessPipeline = {
  id: string;
  name: string;
  stage: string;
  thesis: string | null;
  capital_required: number | null;
  projected_monthly_revenue: number | null;
};

type TradeAudit = {
  id: string;
  instrument: string | null;
  action: string | null;
  price: number | null;
  outcome: string | null;
  closed_at: string | null;
  pnl: number | null;
};

type AtlasState = {
  regime: string | null;
};

type Subscriber = {
  tier: string;
  monthly_amount: number;
  status: string;
};

type ReportArchive = {
  id: string;
  report_date: string;
  published_at: string | null;
  verified_predictions: Record<string, unknown> | null;
};

type DossierEntry = {
  id: string;
  entry_type: string;
  content: string | null;
  pattern_strength: number | null;
  created_at: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmt = (n: number | null | undefined): string => {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};

const fmtPct = (n: number | null | undefined): string =>
  n == null ? "—" : `${Number(n).toFixed(1)}%`;

const STAGE_COLORS: Record<string, string> = {
  SCOUTING: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  EVALUATION: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  APPROVED: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  BUILDING: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  OPERATING: "bg-green-500/20 text-green-400 border-green-500/30",
  MONITORING: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  EXITING: "bg-orange-500/20 text-orange-400 border-orange-500/30",
};

function AllocationBar({
  label,
  actual,
  target,
}: {
  label: string;
  actual: number | null;
  target: number;
}) {
  const pct = actual ?? 0;
  const diff = pct - target;
  const isOver = diff > 2;
  const isUnder = diff < -2;
  const barColor = isOver
    ? "bg-orange-500"
    : isUnder
      ? "bg-blue-500"
      : "bg-green-500";

  return (
    <div className="space-y-1">
      <div className="flex justify-between items-baseline text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span
          className={
            isOver
              ? "text-orange-400"
              : isUnder
                ? "text-blue-400"
                : "text-green-400"
          }
        >
          {fmtPct(pct)}{" "}
          <span className="text-muted-foreground/50">/ {target}% target</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary/40 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const AtlasDashboard = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Data state
  const [decisions, setDecisions] = useState<DecisionItem[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioState | null>(null);
  const [businesses, setBusinesses] = useState<BusinessPipeline[]>([]);
  const [trades, setTrades] = useState<TradeAudit[]>([]);
  const [tradeStats, setTradeStats] = useState<{
    count: number;
    pnl30: number;
  }>({ count: 0, pnl30: 0 });
  const [regime, setRegime] = useState<string | null>(null);
  const [subscribers, setSubscribers] = useState<
    Record<string, number>
  >({});
  const [monthlyRevenue, setMonthlyRevenue] = useState<number>(0);
  const [latestReport, setLatestReport] = useState<ReportArchive | null>(null);
  const [verificationRate, setVerificationRate] = useState<number | null>(null);
  const [dossierEntries, setDossierEntries] = useState<DossierEntry[]>([]);
  const [selfFunding, setSelfFunding] = useState<{
    isSelfFunding: boolean;
    monthlyIncome: number;
    monthlyOperatingCost: number;
  } | null>(null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [yellowExpanded, setYellowExpanded] = useState(false);
  const [memoryExpanded, setMemoryExpanded] = useState(false);
  const [updatingDecision, setUpdatingDecision] = useState<string | null>(null);

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // ── Data loading ──────────────────────────────────────────────────────────

  const loadDashboard = useCallback(async () => {
    if (!user) return;

    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const [
        decisionsRes,
        portfolioRes,
        businessRes,
        tradesRes,
        atlasStateRes,
        subscribersRes,
        reportRes,
        dossierRes,
      ] = await Promise.all([
        supabase
          .from("atlas_decision_queue")
          .select("*")
          .order("created_at", { ascending: false }),

        supabase
          .from("atlas_portfolio_state")
          .select("*")
          .order("snapshot_date", { ascending: false })
          .limit(1)
          .maybeSingle(),

        supabase
          .from("atlas_business_pipeline")
          .select(
            "id, name, stage, thesis, capital_required, projected_monthly_revenue",
          )
          .order("created_at", { ascending: false }),

        supabase
          .from("atlas_trade_audit")
          .select("id, instrument, action, price, outcome, closed_at, pnl")
          .gte("closed_at", thirtyDaysAgo)
          .order("closed_at", { ascending: false }),

        supabase
          .from("atlas_state")
          .select("regime")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),

        supabase.from("atlas_subscribers").select("tier, monthly_amount, status"),

        supabase
          .from("atlas_report_archive")
          .select("id, report_date, published_at, verified_predictions")
          .order("report_date", { ascending: false })
          .limit(1)
          .maybeSingle(),

        supabase
          .from("atlas_dossier_full")
          .select("id, entry_type, content, pattern_strength, created_at")
          .order("pattern_strength", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

      // Decisions
      setDecisions((decisionsRes.data ?? []) as DecisionItem[]);

      // Portfolio
      setPortfolio(portfolioRes.data as PortfolioState | null);

      // Self-funding check
      if (portfolioRes.data) {
        const ps = portfolioRes.data as PortfolioState;
        setSelfFunding({
          isSelfFunding: ps.is_self_funding ?? false,
          monthlyIncome: ps.monthly_income ?? 0,
          monthlyOperatingCost: ps.monthly_operating_cost ?? 0,
        });
      }

      // Businesses
      setBusinesses((businessRes.data ?? []) as BusinessPipeline[]);

      // Trades
      const tradeData = (tradesRes.data ?? []) as TradeAudit[];
      const pnl30 = tradeData.reduce((s, t) => s + (t.pnl ?? 0), 0);
      setTradeStats({ count: tradeData.length, pnl30 });
      setTrades(tradeData.slice(0, 5));

      // Regime
      setRegime((atlasStateRes.data as AtlasState | null)?.regime ?? null);

      // Subscribers
      const subData = (subscribersRes.data ?? []) as Subscriber[];
      const counts: Record<string, number> = {};
      let rev = 0;
      for (const s of subData) {
        counts[s.tier] = (counts[s.tier] ?? 0) + 1;
        if (s.status === "active") rev += s.monthly_amount ?? 0;
      }
      setSubscribers(counts);
      setMonthlyRevenue(rev);

      // Report
      setLatestReport(reportRes.data as ReportArchive | null);

      // Compute verification rate
      if (reportRes.data) {
        const vp = (reportRes.data as ReportArchive).verified_predictions;
        if (vp && typeof vp === "object") {
          let total = 0;
          let correct = 0;
          for (const val of Object.values(vp)) {
            if (val && typeof val === "object") {
              const entry = val as Record<string, unknown>;
              total++;
              if (
                entry.correct === true ||
                entry.outcome === "correct" ||
                entry.result === "correct"
              )
                correct++;
            }
          }
          setVerificationRate(total > 0 ? Math.round((correct / total) * 100) : null);
        }
      }

      // Dossier
      setDossierEntries((dossierRes.data ?? []) as DossierEntry[]);
    } catch (e) {
      console.error("[AtlasDashboard] load failed", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  // ── Decision actions ──────────────────────────────────────────────────────

  const handleDecision = async (
    id: string,
    action: "approved" | "rejected",
  ) => {
    setUpdatingDecision(id);
    try {
      await supabase
        .from("atlas_decision_queue")
        .update({ status: action, updated_at: new Date().toISOString() })
        .eq("id", id);
      setDecisions((prev) =>
        prev.map((d) => (d.id === id ? { ...d, status: action } : d)),
      );
    } catch (e) {
      console.error("[AtlasDashboard] decision update failed", e);
    } finally {
      setUpdatingDecision(null);
    }
  };

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary font-display animate-pulse tracking-widest text-sm uppercase">
          Loading Atlas…
        </div>
      </div>
    );
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  const pendingDecisions = decisions.filter(
    (d) => d.status === "pending" || !d.status,
  );
  const redItems = pendingDecisions.filter((d) => d.priority === "RED");
  const orangeItems = pendingDecisions.filter((d) => d.priority === "ORANGE");
  const yellowItems = pendingDecisions.filter((d) => d.priority === "YELLOW");
  const greenItems = pendingDecisions.filter((d) => d.priority === "GREEN");

  const scoutingCount = businesses.filter(
    (b) => b.stage === "SCOUTING",
  ).length;

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-4xl mx-auto">
      {/* ── Header ── */}
      <div>
        <p className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">
          {today}
        </p>
        <h1 className="text-lg font-display tracking-widest text-primary mt-0.5 uppercase">
          Atlas Command
        </h1>
      </div>

      {/* ── SECTION 1: DECISION QUEUE ── */}
      <Card className="border-border/40 bg-card/80">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-xs font-display tracking-widest uppercase text-foreground/70 flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-accent" />
            Decision Queue
            {pendingDecisions.length > 0 && (
              <span className="ml-auto text-[10px] text-muted-foreground/50">
                {pendingDecisions.length} pending
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          {/* System warning */}
          {redItems.length > 3 && (
            <div className="px-3 py-2 rounded-lg border border-red-500/50 bg-red-500/10 text-red-400 text-xs font-display tracking-wide">
              ATLAS FLAGGED A SYSTEM-LEVEL PROBLEM — {redItems.length} critical
              items require immediate review
            </div>
          )}

          {/* RED items */}
          {redItems.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[10px] font-display tracking-widest text-red-400 uppercase">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                </span>
                Immediate Action Required
              </div>
              {redItems.map((item) => (
                <DecisionCard
                  key={item.id}
                  item={item}
                  colorClass="border-red-500/40 bg-red-500/5"
                  badgeClass="bg-red-500/20 text-red-400 border-red-500/30"
                  onApprove={() => handleDecision(item.id, "approved")}
                  onReject={() => handleDecision(item.id, "rejected")}
                  loading={updatingDecision === item.id}
                />
              ))}
            </div>
          )}

          {/* ORANGE items */}
          {orangeItems.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[10px] font-display tracking-widest text-orange-400 uppercase">
                <span className="h-2 w-2 rounded-full bg-orange-500 inline-block" />
                High Priority
                <Badge className="ml-1 bg-orange-500/20 text-orange-400 border border-orange-500/30 text-[10px] px-1.5 py-0">
                  {orangeItems.length}
                </Badge>
              </div>
              {orangeItems.map((item) => (
                <DecisionCard
                  key={item.id}
                  item={item}
                  colorClass="border-orange-500/30 bg-orange-500/5"
                  badgeClass="bg-orange-500/20 text-orange-400 border-orange-500/30"
                  onApprove={() => handleDecision(item.id, "approved")}
                  onReject={() => handleDecision(item.id, "rejected")}
                  loading={updatingDecision === item.id}
                />
              ))}
            </div>
          )}

          {/* YELLOW items — collapsible */}
          {yellowItems.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setYellowExpanded((v) => !v)}
                className="flex items-center gap-2 text-[10px] font-display tracking-widest text-yellow-400 uppercase w-full"
              >
                <span className="h-2 w-2 rounded-full bg-yellow-400 inline-block" />
                Review Needed
                <Badge className="ml-1 bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 text-[10px] px-1.5 py-0">
                  {yellowItems.length}
                </Badge>
                <span className="ml-auto">
                  {yellowExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </span>
              </button>
              {yellowExpanded &&
                yellowItems.map((item) => (
                  <DecisionCard
                    key={item.id}
                    item={item}
                    colorClass="border-yellow-500/20 bg-yellow-500/5"
                    badgeClass="bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
                    onApprove={() => handleDecision(item.id, "approved")}
                    onReject={() => handleDecision(item.id, "rejected")}
                    loading={updatingDecision === item.id}
                  />
                ))}
            </div>
          )}

          {/* GREEN items — count only */}
          {greenItems.length > 0 && (
            <div className="flex items-center gap-2 text-[10px] text-green-400/70 font-display tracking-widest uppercase">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {greenItems.length} item{greenItems.length !== 1 ? "s" : ""} on
              track — no action needed
            </div>
          )}

          {pendingDecisions.length === 0 && (
            <p className="text-xs text-muted-foreground/50 py-1">
              No pending decisions. Atlas queue is clear.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── SECTION 2: PORTFOLIO SNAPSHOT ── */}
      <Card className="border-border/40 bg-card/80">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-xs font-display tracking-widest uppercase text-foreground/70 flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5 text-accent" />
            Portfolio Snapshot
            {portfolio?.snapshot_date && (
              <span className="ml-auto text-[10px] text-muted-foreground/50">
                {portfolio.snapshot_date}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          {portfolio ? (
            <>
              {/* Key metrics */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricBlock
                  label="Total Value"
                  value={fmt(portfolio.total_value)}
                  highlight
                />
                <MetricBlock
                  label="Monthly Cashflow"
                  value={fmt(portfolio.monthly_cashflow)}
                  positive={
                    portfolio.monthly_cashflow != null
                      ? portfolio.monthly_cashflow >= 0
                      : undefined
                  }
                />
                <MetricBlock
                  label="Annual Return"
                  value={fmtPct(portfolio.annual_return_rate)}
                />
                <MetricBlock
                  label="Rebalancing"
                  value={
                    portfolio.rebalancing_needed == null
                      ? "—"
                      : portfolio.rebalancing_needed
                        ? "Needed"
                        : "OK"
                  }
                  positive={
                    portfolio.rebalancing_needed == null
                      ? undefined
                      : !portfolio.rebalancing_needed
                  }
                />
              </div>

              {/* Allocation bars */}
              <div className="space-y-2 pt-1">
                <AllocationBar
                  label="Liquid / Trading"
                  actual={portfolio.liquid_trading_pct}
                  target={40}
                />
                <AllocationBar
                  label="Real Assets"
                  actual={portfolio.real_assets_pct}
                  target={25}
                />
                <AllocationBar
                  label="Venture / Equity"
                  actual={portfolio.venture_allocation_pct}
                  target={30}
                />
                <AllocationBar
                  label="Operating Reserve"
                  actual={portfolio.operating_reserve_pct}
                  target={5}
                />
              </div>

              {/* Self-funding status */}
              {selfFunding && (
                <div
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-xs ${
                    selfFunding.isSelfFunding
                      ? "border-green-500/30 bg-green-500/5 text-green-400"
                      : "border-orange-500/30 bg-orange-500/5 text-orange-400"
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${selfFunding.isSelfFunding ? "bg-green-400" : "bg-orange-400"}`}
                  />
                  <span className="flex-1">
                    {selfFunding.isSelfFunding
                      ? "Self-Funding — income covers operating costs"
                      : "Not Yet Self-Funding"}
                  </span>
                  <span className="text-muted-foreground/60 font-display">
                    {fmt(selfFunding.monthlyIncome)} in /{" "}
                    {fmt(selfFunding.monthlyOperatingCost)} out
                  </span>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground/50 py-1">
              No portfolio snapshot available.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── SECTION 3: BUSINESS PIPELINE ── */}
      <Card className="border-border/40 bg-card/80">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-xs font-display tracking-widest uppercase text-foreground/70 flex items-center gap-2">
            <TrendingUp className="h-3.5 w-3.5 text-accent" />
            Business Pipeline
            {scoutingCount > 0 && (
              <button
                onClick={() => navigate("/business")}
                className="ml-auto flex items-center gap-1 text-[10px] text-accent/70 hover:text-accent transition-colors"
              >
                {scoutingCount} new scouting{" "}
                <ExternalLink className="h-2.5 w-2.5" />
              </button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-2">
          {businesses.length > 0 ? (
            businesses.map((biz) => {
              const stageColor =
                STAGE_COLORS[biz.stage] ??
                "bg-gray-500/20 text-gray-400 border-gray-500/30";
              return (
                <div
                  key={biz.id}
                  className="flex items-start gap-3 py-2.5 border-t border-border/10 first:border-0"
                >
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-foreground/90 font-medium truncate">
                        {biz.name}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-display uppercase shrink-0 ${stageColor}`}
                      >
                        {biz.stage}
                      </span>
                    </div>
                    {biz.thesis && (
                      <p className="text-[11px] text-muted-foreground/60 truncate">
                        {biz.thesis}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0 space-y-0.5">
                    {biz.capital_required != null && (
                      <div className="text-xs font-display text-foreground/70">
                        {fmt(biz.capital_required)}
                      </div>
                    )}
                    {biz.projected_monthly_revenue != null && (
                      <div className="text-[10px] text-muted-foreground/50">
                        {fmt(biz.projected_monthly_revenue)}/mo
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <p className="text-xs text-muted-foreground/50 py-1">
              No businesses in pipeline.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── SECTION 4: TRADING PERFORMANCE ── */}
      <Card className="border-border/40 bg-card/80">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-xs font-display tracking-widest uppercase text-foreground/70 flex items-center gap-2">
            <DollarSign className="h-3.5 w-3.5 text-accent" />
            Trading Performance
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-3 gap-3">
            <MetricBlock label="Positions (30d)" value={String(tradeStats.count)} />
            <MetricBlock
              label="30d P&L"
              value={fmt(tradeStats.pnl30)}
              positive={tradeStats.pnl30 >= 0}
            />
            <MetricBlock label="Regime" value={regime ?? "—"} />
          </div>

          {/* Last 5 closed trades */}
          {trades.length > 0 && (
            <div className="space-y-0">
              <div className="grid grid-cols-4 gap-2 text-[10px] font-display tracking-widest text-muted-foreground/40 uppercase pb-1 border-b border-border/10">
                <span>Instrument</span>
                <span>Action</span>
                <span>Price</span>
                <span className="text-right">Outcome</span>
              </div>
              {trades.map((t) => (
                <div
                  key={t.id}
                  className="grid grid-cols-4 gap-2 py-1.5 text-xs border-b border-border/5 last:border-0"
                >
                  <span className="font-display text-foreground/80 truncate">
                    {t.instrument ?? "—"}
                  </span>
                  <span className="text-muted-foreground/70 capitalize">
                    {t.action ?? "—"}
                  </span>
                  <span className="text-muted-foreground/70">
                    {t.price != null ? `$${t.price.toFixed(2)}` : "—"}
                  </span>
                  <span
                    className={`text-right ${
                      t.pnl != null && t.pnl >= 0
                        ? "text-green-400"
                        : "text-red-400"
                    }`}
                  >
                    {t.pnl != null ? fmt(t.pnl) : t.outcome ?? "—"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {trades.length === 0 && (
            <p className="text-xs text-muted-foreground/50 py-1">
              No closed trades in the last 30 days.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── SECTION 5: REPORT PERFORMANCE ── */}
      <Card className="border-border/40 bg-card/80">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-xs font-display tracking-widest uppercase text-foreground/70 flex items-center gap-2">
            <Newspaper className="h-3.5 w-3.5 text-accent" />
            Report Performance
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          {/* Subscriber counts */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(["FREE", "SIGNAL", "COPYTRADE", "INSTITUTIONAL"] as const).map(
              (tier) => (
                <MetricBlock
                  key={tier}
                  label={tier}
                  value={String(subscribers[tier] ?? 0)}
                />
              ),
            )}
          </div>

          {/* Revenue + last report */}
          <div className="grid grid-cols-2 gap-3">
            <MetricBlock
              label="Monthly Revenue"
              value={fmt(monthlyRevenue)}
              positive={monthlyRevenue > 0}
            />
            <MetricBlock
              label="Last Report"
              value={latestReport?.report_date ?? "—"}
            />
          </div>

          {/* Verification rate */}
          {verificationRate != null && (
            <div
              className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-xs ${
                verificationRate >= 60
                  ? "border-green-500/30 bg-green-500/5 text-green-400"
                  : "border-orange-500/30 bg-orange-500/5 text-orange-400"
              }`}
            >
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>Prediction Verification Rate</span>
              <span className="ml-auto font-display">
                {verificationRate}%
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── SECTION 6: ATLAS MEMORY INSIGHTS ── */}
      <Card className="border-border/40 bg-card/80">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-xs font-display tracking-widest uppercase text-foreground/70 flex items-center gap-2">
            <Brain className="h-3.5 w-3.5 text-accent" />
            Atlas Memory Insights
            <button
              onClick={() => setMemoryExpanded((v) => !v)}
              className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-foreground/70 transition-colors"
            >
              {memoryExpanded ? "Collapse" : "Expand"}{" "}
              {memoryExpanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </button>
          </CardTitle>
        </CardHeader>
        {memoryExpanded && (
          <CardContent className="px-4 pb-4 space-y-3">
            {dossierEntries.length > 0 ? (
              dossierEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="p-3 rounded-lg border border-border/20 bg-secondary/10 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-display uppercase text-accent/80">
                      {entry.entry_type}
                    </span>
                    {entry.pattern_strength != null && (
                      <span className="text-[10px] text-muted-foreground/50">
                        strength: {entry.pattern_strength}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground/40">
                      {new Date(entry.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  {entry.content && (
                    <p className="text-xs text-muted-foreground/70 leading-relaxed line-clamp-2">
                      {entry.content}
                    </p>
                  )}
                  <button
                    onClick={() =>
                      navigate(
                        `/atlas?message=${encodeURIComponent(
                          `Tell me more about this pattern: ${entry.content?.slice(0, 100) ?? entry.entry_type}`,
                        )}`,
                      )
                    }
                    className="text-[10px] text-accent/60 hover:text-accent transition-colors font-display tracking-wide flex items-center gap-1"
                  >
                    Talk to Atlas about this{" "}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground/50 py-1">
                No high-strength memory entries found.
              </p>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricBlock({
  label,
  value,
  highlight,
  positive,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  positive?: boolean;
}) {
  const valueColor =
    positive === true
      ? "text-green-400"
      : positive === false
        ? "text-red-400"
        : highlight
          ? "text-primary"
          : "text-foreground/80";

  return (
    <div className="text-center space-y-0.5">
      <div className={`${highlight ? "text-xl" : "text-sm"} font-display ${valueColor}`}>
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground/50 font-display tracking-widest uppercase">
        {label}
      </div>
    </div>
  );
}

function DecisionCard({
  item,
  colorClass,
  badgeClass,
  onApprove,
  onReject,
  loading,
}: {
  item: DecisionItem;
  colorClass: string;
  badgeClass: string;
  onApprove: () => void;
  onReject: () => void;
  loading: boolean;
}) {
  const isPending = item.status === "pending" || !item.status;

  return (
    <div className={`p-3 rounded-lg border space-y-2 ${colorClass}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-display uppercase ${badgeClass}`}
            >
              {item.priority}
            </span>
            <span className="text-xs text-foreground/90 font-medium truncate">
              {item.title}
            </span>
          </div>
          {item.business_context && (
            <p className="text-[11px] text-muted-foreground/60">
              {item.business_context}
            </p>
          )}
          {item.capital_at_stake != null && (
            <p className="text-[11px] text-muted-foreground/50">
              Capital at stake:{" "}
              <span className="text-foreground/60">
                {item.capital_at_stake >= 1_000
                  ? `$${(item.capital_at_stake / 1_000).toFixed(1)}k`
                  : `$${item.capital_at_stake.toLocaleString()}`}
              </span>
            </p>
          )}
        </div>
      </div>
      {isPending && (
        <div className="flex gap-2 pt-0.5">
          <Button
            size="sm"
            variant="outline"
            onClick={onApprove}
            disabled={loading}
            className="h-6 text-[10px] font-display tracking-wide uppercase border-green-500/40 text-green-400 hover:bg-green-500/10 hover:border-green-500/60 px-3"
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onReject}
            disabled={loading}
            className="h-6 text-[10px] font-display tracking-wide uppercase border-red-500/40 text-red-400 hover:bg-red-500/10 hover:border-red-500/60 px-3"
          >
            Reject
          </Button>
        </div>
      )}
      {!isPending && (
        <span
          className={`text-[10px] font-display uppercase tracking-wide ${
            item.status === "approved" ? "text-green-400/60" : "text-red-400/60"
          }`}
        >
          {item.status}
        </span>
      )}
    </div>
  );
}

export default AtlasDashboard;
