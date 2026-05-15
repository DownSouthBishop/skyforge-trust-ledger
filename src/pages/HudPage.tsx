import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { TrendingUp, Target, ChevronRight, Flame, Bell, X, Plus, Zap } from "lucide-react";

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

type HudData = {
  full_name: string;
  active_goals: GoalRow[];
  pipeline: PipelineRow[];
  crm_opportunities: CrmRow[];
  trajectory_sentence: string | null;
  alerts: AlertRow[];
};

const STAGES: Record<string, string> = {
  quoted: "Quoted",
  in_progress: "In Progress",
  closing: "Closing",
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

const HudPage = () => {
  const { user } = useAuth();
  const [hud, setHud] = useState<HudData | null>(null);
  const [accounts, setAccounts] = useState<TradeAccount[]>([]);
  const [openTrades, setOpenTrades] = useState<OpenTrade[]>([]);
  const [loading, setLoading] = useState(true);

  const [showPipelineForm, setShowPipelineForm] = useState(false);
  const [pDesc, setPDesc] = useState("");
  const [pClient, setPClient] = useState("");
  const [pValue, setPValue] = useState("");
  const [pVertical, setPVertical] = useState("");
  const [addingPipeline, setAddingPipeline] = useState(false);

  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  const loadHud = useCallback(async () => {
    if (!user) return;
    try {
      const [ctxRes, acctRes, tradesRes] = await Promise.all([
        supabase.rpc("get_forge_context", { _user_id: user.id }),
        supabase
          .from("trading_accounts")
          .select("broker, balance_usd")
          .eq("user_id", user.id)
          .eq("is_active", true),
        supabase
          .from("trade_ledger")
          .select("symbol, direction, pnl_usd")
          .eq("user_id", user.id)
          .eq("status", "open"),
      ]);
      if (ctxRes.data) setHud(ctxRes.data as unknown as HudData);
      setAccounts((acctRes.data ?? []) as TradeAccount[]);
      setOpenTrades((tradesRes.data ?? []) as OpenTrade[]);
    } catch (e) {
      console.error("hud load failed", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void loadHud(); }, [loadHud]);

  const addPipeline = async () => {
    if (!pDesc.trim()) return;
    setAddingPipeline(true);
    try {
      await supabase.from("income_pipeline").insert({
        user_id: user!.id,
        description: pDesc.trim(),
        client_name: pClient.trim() || null,
        estimated_value: parseFloat(pValue) || null,
        business_vertical: pVertical.trim() || null,
        stage: "quoted",
      });
      setPDesc(""); setPClient(""); setPValue(""); setPVertical("");
      setShowPipelineForm(false);
      void loadHud();
    } catch (e) {
      console.error("add pipeline failed", e);
      toast.error("Failed to add pipeline item.");
    } finally {
      setAddingPipeline(false);
    }
  };

  const advancePipeline = async (id: string, currentStage: string) => {
    const order = ["quoted", "in_progress", "closing", "won"];
    const next = order[order.indexOf(currentStage) + 1];
    if (!next) return;
    await supabase.from("income_pipeline").update({ stage: next }).eq("id", id);
    if (next === "won") toast.success("Closed. Log the trade when ready.");
    void loadHud();
  };

  const dismissAlert = async (id: string) => {
    setDismissedAlerts((prev) => new Set([...prev, id]));
    await supabase.from("forge_alerts").update({ read_at: new Date().toISOString() }).eq("id", id);
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
  const crm = hud?.crm_opportunities ?? [];
  const visibleAlerts = (hud?.alerts ?? []).filter((a) => !dismissedAlerts.has(a.id));
  const pipelineTotal = pipeline.reduce((s, p) => s + (p.estimated_value ?? 0), 0);
  const totalBalance = accounts.reduce((s, a) => s + (a.balance_usd ?? 0), 0);
  const openPnl = openTrades.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      {/* Header */}
      <div>
        <p className="text-xs text-muted-foreground font-display tracking-widest uppercase">{today}</p>
        {hud?.trajectory_sentence && (
          <p className="text-sm text-foreground/70 mt-1 max-w-lg">{hud.trajectory_sentence}</p>
        )}
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

      {/* Pipeline + Follow-ups */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Pipeline */}
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-display tracking-widest text-primary uppercase">Pipeline</span>
            </div>
            <div className="flex items-center gap-2">
              {pipelineTotal > 0 && (
                <span className="text-xs text-muted-foreground">{fmt(pipelineTotal)} in motion</span>
              )}
              <button onClick={() => setShowPipelineForm((v) => !v)} className="text-muted-foreground hover:text-accent transition-colors">
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {showPipelineForm && (
            <div className="space-y-2 pt-1 border-t border-border/20">
              <Input placeholder="What's the opportunity?" value={pDesc} onChange={(e) => setPDesc(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Client / counterparty" value={pClient} onChange={(e) => setPClient(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
                <Input placeholder="Est. value ($)" type="number" value={pValue} onChange={(e) => setPValue(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
              </div>
              <Input placeholder="Category" value={pVertical} onChange={(e) => setPVertical(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowPipelineForm(false)}>Cancel</Button>
                <Button size="sm" onClick={addPipeline} disabled={addingPipeline || !pDesc.trim()} className="bg-primary/20 text-primary hover:bg-primary/30">Add</Button>
              </div>
            </div>
          )}

          {pipeline.length === 0 && !showPipelineForm ? (
            <p className="text-xs text-muted-foreground/50 py-2">No open pipeline. Add an opportunity above.</p>
          ) : (
            <div className="space-y-2">
              {pipeline.map((p) => (
                <div key={p.id} className="flex items-center gap-3 py-1.5 border-t border-border/10 first:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{p.description}</div>
                    <div className="text-[10px] text-muted-foreground/60">
                      {[p.client_name, p.business_vertical].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {p.estimated_value && (
                      <span className="text-xs text-primary font-display">{fmt(p.estimated_value)}</span>
                    )}
                    <button
                      onClick={() => advancePipeline(p.id, p.stage)}
                      className="text-[10px] px-2 py-0.5 rounded-full border border-border/40 text-muted-foreground hover:border-accent/40 hover:text-accent transition-colors flex items-center gap-1"
                    >
                      {STAGES[p.stage] ?? p.stage}
                      <ChevronRight className="h-2.5 w-2.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Follow-ups due */}
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Flame className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-display tracking-widest text-primary uppercase">Follow Up</span>
          </div>
          {crm.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-2">No follow-ups due. CRM is clean.</p>
          ) : (
            <div className="space-y-2">
              {crm.map((c, i) => (
                <div key={i} className="flex items-center gap-3 py-1.5 border-t border-border/10 first:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">{c.client_name}</div>
                    {c.days_since_contact != null && (
                      <div className="text-[10px] text-muted-foreground/60">{c.days_since_contact}d since last contact</div>
                    )}
                  </div>
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
