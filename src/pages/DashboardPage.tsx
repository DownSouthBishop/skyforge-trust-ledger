import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

type IncomeEntry = {
  id: string;
  action_description: string;
  action_value_usd: number | null;
  client_name: string | null;
  business_vertical: string | null;
  created_at: string;
};

type GoalRow = {
  id: string;
  period: string;
  target_amount: number;
  label: string | null;
  business_vertical: string | null;
};

const fmt = (n: number) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const PERIODS = ["daily", "weekly", "monthly", "quarterly", "annual"];

const DashboardPage = () => {
  const { user } = useAuth();
  const [entries, setEntries] = useState<IncomeEntry[]>([]);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterVertical, setFilterVertical] = useState("");

  // New entry form
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [client, setClient] = useState("");
  const [vertical, setVertical] = useState("");
  const [logging, setLogging] = useState(false);

  // New goal form
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [goalPeriod, setGoalPeriod] = useState("monthly");
  const [goalAmount, setGoalAmount] = useState("");
  const [goalVertical, setGoalVertical] = useState("");
  const [goalLabel, setGoalLabel] = useState("");
  const [addingGoal, setAddingGoal] = useState(false);

  const loadData = useCallback(async () => {
    if (!user) return;
    const [entriesRes, goalsRes] = await Promise.all([
      supabase
        .from("receipts_ledger")
        .select("id, action_description, action_value_usd, client_name, business_vertical, created_at")
        .eq("provider_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("income_goals")
        .select("id, period, target_amount, label, business_vertical")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .order("created_at", { ascending: true }),
    ]);
    setEntries((entriesRes.data ?? []) as IncomeEntry[]);
    setGoals((goalsRes.data ?? []) as GoalRow[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

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
      void loadData();
    } catch (e) {
      console.error("log income failed", e);
      toast.error("Failed to log.");
    } finally {
      setLogging(false);
    }
  };

  const deleteEntry = async (id: string) => {
    await supabase.from("receipts_ledger").delete().eq("id", id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const addGoal = async () => {
    const val = parseFloat(goalAmount);
    if (!val || val <= 0) return;
    setAddingGoal(true);
    try {
      await supabase.from("income_goals").insert({
        user_id: user!.id,
        period: goalPeriod,
        target_amount: val,
        business_vertical: goalVertical.trim() || null,
        label: goalLabel.trim() || null,
      });
      setGoalAmount("");
      setGoalVertical("");
      setGoalLabel("");
      setShowGoalForm(false);
      void loadData();
    } catch (e) {
      console.error("add goal failed", e);
      toast.error("Failed to add goal.");
    } finally {
      setAddingGoal(false);
    }
  };

  const deleteGoal = async (id: string) => {
    await supabase.from("income_goals").update({ is_active: false }).eq("id", id);
    setGoals((prev) => prev.filter((g) => g.id !== id));
  };

  const filtered = filterVertical.trim()
    ? entries.filter((e) => e.business_vertical?.toLowerCase().includes(filterVertical.toLowerCase()))
    : entries;

  const verticals = [...new Set(entries.map((e) => e.business_vertical).filter(Boolean))] as string[];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary font-display animate-pulse-glow tracking-widest text-sm">LOADING</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-4xl mx-auto">

      <div className="flex items-center justify-between">
        <h1 className="text-sm font-display tracking-widest text-primary uppercase">Income Log</h1>
      </div>

      {/* Quick log form — always visible */}
      <div className="glass-card p-4 space-y-3">
        <p className="text-[10px] font-display tracking-widest text-accent uppercase">Log Income</p>
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

      {/* Goals */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">Revenue Goals</p>
          <button
            onClick={() => setShowGoalForm((v) => !v)}
            className="text-muted-foreground hover:text-accent transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {showGoalForm && (
          <div className="space-y-2 pt-2 border-t border-border/20">
            <div className="grid grid-cols-2 gap-2">
              <select
                value={goalPeriod}
                onChange={(e) => setGoalPeriod(e.target.value)}
                className="bg-secondary/30 border border-border/30 rounded-md px-3 py-2 text-sm text-foreground"
              >
                {PERIODS.map((p) => (
                  <option key={p} value={p} className="bg-background capitalize">{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                ))}
              </select>
              <Input
                placeholder="Target ($)"
                type="number"
                value={goalAmount}
                onChange={(e) => setGoalAmount(e.target.value)}
                className="bg-secondary/30 border-border/30"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="Business / vertical (optional)"
                value={goalVertical}
                onChange={(e) => setGoalVertical(e.target.value)}
                className="bg-secondary/30 border-border/30"
              />
              <Input
                placeholder="Label (optional)"
                value={goalLabel}
                onChange={(e) => setGoalLabel(e.target.value)}
                className="bg-secondary/30 border-border/30"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowGoalForm(false)}>Cancel</Button>
              <Button size="sm" onClick={addGoal} disabled={addingGoal || !goalAmount} className="bg-primary/20 text-primary hover:bg-primary/30">Save Goal</Button>
            </div>
          </div>
        )}

        {goals.length === 0 && !showGoalForm ? (
          <p className="text-xs text-muted-foreground/50">No active goals. Add one above.</p>
        ) : (
          <div className="space-y-1">
            {goals.map((g) => (
              <div key={g.id} className="flex items-center justify-between py-1.5 border-t border-border/10 first:border-0 group">
                <div>
                  <span className="text-sm capitalize">
                    {g.label ?? g.period}
                    {g.business_vertical ? <span className="text-muted-foreground/60"> · {g.business_vertical}</span> : null}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-display text-primary">{fmt(g.target_amount)}</span>
                  <button
                    onClick={() => deleteGoal(g.id)}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Income history */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">History</p>
          {verticals.length > 0 && (
            <Input
              placeholder="Filter by vertical…"
              value={filterVertical}
              onChange={(e) => setFilterVertical(e.target.value)}
              className="bg-secondary/30 border-border/30 text-sm h-7 w-40"
            />
          )}
        </div>

        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-2">No entries yet.</p>
        ) : (
          <div className="space-y-0">
            {filtered.map((e) => (
              <div key={e.id} className="flex items-center gap-3 py-2.5 border-t border-border/10 first:border-0 group">
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{e.action_description}</div>
                  <div className="text-[10px] text-muted-foreground/60">
                    {[
                      e.client_name,
                      e.business_vertical,
                      new Date(e.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
                    ].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <span className="text-sm font-display text-primary shrink-0">
                  {e.action_value_usd != null ? fmt(e.action_value_usd) : "—"}
                </span>
                <button
                  onClick={() => deleteEntry(e.id)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DashboardPage;
