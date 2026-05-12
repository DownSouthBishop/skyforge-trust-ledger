import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Plus, TrendingUp, Target, Users, ChevronRight, Flame, Bell, X } from "lucide-react";

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

type BreakdownRow = {
  vertical: string;
  job_count: number;
  total: number;
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

type Trajectory = {
  monthly_goal: number;
  projected_end: number;
  gap: number;
  days_remaining: number;
  per_day_needed: number;
  on_pace: boolean;
};

type HudData = {
  full_name: string;
  income_today: number;
  income_week: number;
  income_month: number;
  current_streak: number;
  active_goals: GoalRow[];
  pipeline: PipelineRow[];
  business_breakdown: BreakdownRow[];
  crm_opportunities: CrmRow[];
  trajectory_sentence: string | null;
  trajectory: Trajectory | null;
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
  week_zero: "Income",
  on_pace: "On Track",
  streak_risk: "Streak",
};

const fmt = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toLocaleString()}`;

const HudPage = () => {
  const { user } = useAuth();
  const [hud, setHud] = useState<HudData | null>(null);
  const [loading, setLoading] = useState(true);

  // Quick income log — always visible, pre-filled from last
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [client, setClient] = useState("");
  const [vertical, setVertical] = useState("");
  const [logging, setLogging] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  // Quick pipeline add state
  const [showPipelineForm, setShowPipelineForm] = useState(false);
  const [pDesc, setPDesc] = useState("");
  const [pClient, setPClient] = useState("");
  const [pValue, setPValue] = useState("");
  const [pVertical, setPVertical] = useState("");
  const [addingPipeline, setAddingPipeline] = useState(false);

  // Dismissed alerts (local session)
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  const loadHud = useCallback(async () => {
    if (!user) return;
    try {
      const { data } = await supabase.rpc("get_forge_context", { _user_id: user.id });
      if (data) setHud(data as unknown as HudData);
    } catch (e) {
      console.error("hud load failed", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Pre-fill vertical from last income entry
  const loadLastEntry = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("receipts_ledger")
      .select("business_vertical")
      .eq("provider_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.business_vertical) setVertical(data.business_vertical);
  }, [user]);

  useEffect(() => {
    void loadHud();
    void loadLastEntry();
  }, [loadHud, loadLastEntry]);

  const logIncome = async () => {
    const val = parseFloat(amount);
    if (!val || val <= 0 || !description.trim()) return;
    setLogging(true);
    try {
      await supabase.from("receipts_ledger").insert({
        provider_id: user!.id,
        action_id: crypto.randomUUID(),
        action_description: description.trim(),
        action_value_usd: val,
        client_name: client.trim() || null,
        verification_state: "VERIFIED",
        business_vertical: vertical.trim() || null,
      });
      setAmount("");
      setDescription("");
      setClient("");
      void loadHud();
      setTimeout(() => amountRef.current?.focus(), 50);
    } catch (e) {
      console.error("log income failed", e);
      toast.error("Failed to log income.");
    } finally {
      setLogging(false);
    }
  };

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
    if (next === "won") toast.success("Closed. Log the income when ready.");
    void loadHud();
  };

  const dismissAlert = async (id: string) => {
    setDismissedAlerts((prev) => new Set([...prev, id]));
    await supabase
      .from("forge_alerts")
      .update({ read_at: new Date().toISOString() })
      .eq("id", id);
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
  const breakdown = hud?.business_breakdown ?? [];
  const crm = hud?.crm_opportunities ?? [];
  const trajectory = hud?.trajectory ?? null;
  const visibleAlerts = (hud?.alerts ?? []).filter((a) => !dismissedAlerts.has(a.id));
  const pipelineTotal = pipeline.reduce((s, p) => s + (p.estimated_value ?? 0), 0);

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

      {/* Always-visible income log */}
      <div className="glass-card p-4 space-y-3">
        <p className="text-[10px] font-display tracking-widest text-accent uppercase">Log Income</p>
        <div className="grid grid-cols-2 gap-2">
          <Input
            ref={amountRef}
            placeholder="Amount ($)"
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void logIncome()}
            className="bg-secondary/30 border-border/30"
          />
          <Input
            placeholder="Business / vertical"
            value={vertical}
            onChange={(e) => setVertical(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void logIncome()}
            className="bg-secondary/30 border-border/30"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input
            placeholder="What was it for?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void logIncome()}
            className="bg-secondary/30 border-border/30"
          />
          <Input
            placeholder="Client (optional)"
            value={client}
            onChange={(e) => setClient(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void logIncome()}
            className="bg-secondary/30 border-border/30"
          />
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={logIncome}
            disabled={logging || !amount || !description.trim()}
            className="bg-accent text-accent-foreground hover:bg-accent/90 font-display tracking-wider"
          >
            {logging ? "Logging…" : "Log"}
          </Button>
        </div>
      </div>

      {/* Income Row — today / week / month */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Today", value: hud?.income_today ?? 0 },
          { label: "This Week", value: hud?.income_week ?? 0 },
          { label: "This Month", value: hud?.income_month ?? 0 },
        ].map((s) => (
          <div key={s.label} className="glass-card p-4 text-center space-y-1">
            <div className="text-xl md:text-2xl font-display text-primary">{fmt(s.value)}</div>
            <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Trajectory projection strip */}
      {trajectory && trajectory.monthly_goal > 0 && (
        <div className={`glass-card p-4 border ${trajectory.on_pace ? "border-green-500/20" : "border-primary/20"}`}>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-display tracking-widest uppercase text-muted-foreground">
              Monthly Trajectory
            </span>
            <span className={`text-[10px] font-display tracking-widest uppercase px-2 py-0.5 rounded-full ${
              trajectory.on_pace
                ? "bg-green-500/10 text-green-400 border border-green-500/20"
                : "bg-primary/10 text-primary border border-primary/20"
            }`}>
              {trajectory.on_pace ? "On Pace" : "Behind"}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div>
              <div className="text-base font-display text-primary">{fmt(trajectory.monthly_goal)}</div>
              <div className="text-[10px] text-muted-foreground/60 mt-0.5">Goal</div>
            </div>
            <div>
              <div className="text-base font-display text-foreground/80">{fmt(trajectory.projected_end)}</div>
              <div className="text-[10px] text-muted-foreground/60 mt-0.5">Projected</div>
            </div>
            <div>
              <div className={`text-base font-display ${trajectory.gap > 0 ? "text-accent" : "text-green-400"}`}>
                {trajectory.gap > 0 ? fmt(trajectory.gap) : "✓"}
              </div>
              <div className="text-[10px] text-muted-foreground/60 mt-0.5">Gap</div>
            </div>
            <div>
              <div className={`text-base font-display ${trajectory.gap > 0 ? "text-accent" : "text-green-400"}`}>
                {trajectory.gap > 0 && trajectory.per_day_needed > 0 ? `${fmt(trajectory.per_day_needed)}/d` : "—"}
              </div>
              <div className="text-[10px] text-muted-foreground/60 mt-0.5">{trajectory.days_remaining}d left</div>
            </div>
          </div>
          {/* Progress bar */}
          <div className="mt-3 h-1 rounded-full bg-secondary/40 overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(100, Math.round(((hud?.income_month ?? 0) / trajectory.monthly_goal) * 100))}%`,
                background: trajectory.on_pace ? "hsl(142,76%,36%)" : "hsl(217,91%,60%)",
              }}
            />
          </div>
          <div className="text-[10px] text-muted-foreground/40 text-right mt-1">
            {Math.min(100, Math.round(((hud?.income_month ?? 0) / trajectory.monthly_goal) * 100))}% of goal
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
              <button
                onClick={() => setShowPipelineForm((v) => !v)}
                className="text-muted-foreground hover:text-accent transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {showPipelineForm && (
            <div className="space-y-2 pt-1 border-t border-border/20">
              <Input placeholder="What's the opportunity?" value={pDesc} onChange={(e) => setPDesc(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Client" value={pClient} onChange={(e) => setPClient(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
                <Input placeholder="Est. value ($)" type="number" value={pValue} onChange={(e) => setPValue(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
              </div>
              <Input placeholder="Business / vertical" value={pVertical} onChange={(e) => setPVertical(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
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
            <Users className="h-3.5 w-3.5 text-primary" />
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

      {/* Business Breakdown */}
      {breakdown.length > 0 && (
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Flame className="h-3.5 w-3.5 text-accent" />
            <span className="text-xs font-display tracking-widest text-accent uppercase">30-Day Breakdown</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {breakdown.map((b) => {
              const monthTotal = hud?.income_month ?? 0;
              const pct = monthTotal > 0 ? Math.round((b.total / monthTotal) * 100) : 0;
              return (
                <div key={b.vertical} className="space-y-1.5 p-3 rounded-lg bg-secondary/20 border border-border/20">
                  <div className="text-xs text-muted-foreground/70 truncate">{b.vertical}</div>
                  <div className="text-base font-display text-primary">{fmt(b.total)}</div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground/50">{b.job_count} job{b.job_count !== 1 ? "s" : ""}</span>
                    <span className="text-[10px] text-muted-foreground/50">{pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
};

export default HudPage;
