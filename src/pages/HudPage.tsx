import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Plus, TrendingUp, Target, Users, ChevronRight, Flame } from "lucide-react";

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
  last_job: string | null;
  days_since_contact: number | null;
  estimated_value: number | null;
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
};

const STAGES: Record<string, string> = {
  quoted: "Quoted",
  in_progress: "In Progress",
  closing: "Closing",
};

const fmt = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toLocaleString()}`;

const HudPage = () => {
  const { user } = useAuth();
  const [hud, setHud] = useState<HudData | null>(null);
  const [loading, setLoading] = useState(true);

  // Quick income log state
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [client, setClient] = useState("");
  const [vertical, setVertical] = useState("");
  const [logging, setLogging] = useState(false);
  const [showLogForm, setShowLogForm] = useState(false);

  // Quick pipeline add state
  const [showPipelineForm, setShowPipelineForm] = useState(false);
  const [pDesc, setPDesc] = useState("");
  const [pClient, setPClient] = useState("");
  const [pValue, setPValue] = useState("");
  const [pVertical, setPVertical] = useState("");
  const [addingPipeline, setAddingPipeline] = useState(false);

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

  useEffect(() => {
    void loadHud();
  }, [loadHud]);

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
      setVertical("");
      setShowLogForm(false);
      void loadHud();
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
      setPDesc("");
      setPClient("");
      setPValue("");
      setPVertical("");
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
    if (next === "won") {
      toast.success("Closed. Log the income when ready.");
    }
    void loadHud();
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

  const pipelineTotal = pipeline.reduce((s, p) => s + (p.estimated_value ?? 0), 0);

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-muted-foreground font-display tracking-widest uppercase">{today}</p>
          {hud?.trajectory_sentence && (
            <p className="text-sm text-foreground/70 mt-1 max-w-lg">{hud.trajectory_sentence}</p>
          )}
        </div>
        <Button
          onClick={() => setShowLogForm((v) => !v)}
          size="sm"
          className="bg-accent text-accent-foreground hover:bg-accent/90 gap-1.5 font-display tracking-wider shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          Log Income
        </Button>
      </div>

      {/* Quick Income Log Form */}
      {showLogForm && (
        <div className="glass-card p-4 space-y-3">
          <p className="text-xs font-display tracking-widest text-accent uppercase">Income Entry</p>
          <div className="grid grid-cols-2 gap-2">
            <Input
              placeholder="Amount ($)"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="bg-secondary/30 border-border/30"
            />
            <Input
              placeholder="Business / vertical"
              value={vertical}
              onChange={(e) => setVertical(e.target.value)}
              className="bg-secondary/30 border-border/30"
            />
          </div>
          <Input
            placeholder="What was it for?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="bg-secondary/30 border-border/30"
          />
          <Input
            placeholder="Client (optional)"
            value={client}
            onChange={(e) => setClient(e.target.value)}
            className="bg-secondary/30 border-border/30"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowLogForm(false)}>Cancel</Button>
            <Button
              size="sm"
              onClick={logIncome}
              disabled={logging || !amount || !description.trim()}
              className="bg-accent text-accent-foreground hover:bg-accent/90"
            >
              {logging ? "Logging…" : "Log"}
            </Button>
          </div>
        </div>
      )}

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
                    <div className="text-[10px] text-muted-foreground/60">
                      {c.last_job ?? "No job on record"}
                      {c.days_since_contact != null ? ` · ${c.days_since_contact}d ago` : ""}
                    </div>
                  </div>
                  {c.estimated_value != null && c.estimated_value > 0 && (
                    <span className="text-xs text-muted-foreground shrink-0">{fmt(c.estimated_value)}/job</span>
                  )}
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
