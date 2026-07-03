import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { SUPABASE_URL } from "@/lib/supabase-url";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Pencil, Plus, Trash2, Target, Scale, Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";

type AccountType = "cash" | "credit" | "debit" | "asset" | "liability";
interface FinAccount {
  id: string; user_id: string; type: AccountType;
  name: string; balance: number | null; limit_amount: number | null; notes: string | null;
}
interface NWSnapshot { recorded_at: string; net_worth: number }
interface NetWorthGoal { id: string; target_amount: number; target_date: string | null }
interface PortfolioState {
  total_value: number; rebalancing_needed: boolean;
  operating_reserve: { value?: number } | null;
  liquid_trading: { value?: number } | null;
  real_assets: { value?: number } | null;
  venture_allocation: { value?: number } | null;
}

const SECTIONS: { key: AccountType[]; title: string }[] = [
  { key: ["cash"], title: "Cash" },
  { key: ["credit", "debit"], title: "Cards" },
  { key: ["asset"], title: "Assets" },
  { key: ["liability"], title: "Liabilities" },
];

// Matches the targets in check_portfolio_rebalancing() (20260517100002_atlas_core_tables.sql):
// trading 40%, real assets 25%, business/venture 30%, cash reserve 5%.
const ALLOCATION_TARGETS: Record<string, number> = {
  "Cash reserve": 5, "Trading": 40, "Real assets": 25, "Business/venture": 30,
};

async function writeSnapshot(userId: string, accounts: FinAccount[]) {
  const cash = accounts.filter(a => a.type === "cash").reduce((s, a) => s + Number(a.balance || 0), 0);
  const debit = accounts.filter(a => a.type === "debit").reduce((s, a) => s + Number(a.balance || 0), 0);
  const assets = accounts.filter(a => a.type === "asset").reduce((s, a) => s + Number(a.balance || 0), 0);
  const liabilities = accounts.filter(a => a.type === "liability").reduce((s, a) => s + Number(a.balance || 0), 0);
  const credit = accounts.filter(a => a.type === "credit").reduce((s, a) => s + Number(a.balance || 0), 0);
  const creditAvail = accounts.filter(a => a.type === "credit").reduce((s, a) => s + Math.max(0, Number(a.limit_amount || 0) - Number(a.balance || 0)), 0);
  const netWorth = cash + debit + assets - liabilities - credit;
  const topLiab = [...accounts.filter(a => a.type === "liability")].sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0))[0];
  const value = `Net worth: $${netWorth.toFixed(2)}. Cash: $${cash.toFixed(2)}. Credit available: $${creditAvail.toFixed(2)}. Top liability: ${topLiab ? `${topLiab.name} $${Number(topLiab.balance || 0).toFixed(2)}` : "none"}.`;

  const { data: existing } = await (supabase as any).from("shared_operator_memory").select("id").eq("user_id", userId).eq("key", "financial_snapshot").maybeSingle();
  if (existing) {
    await (supabase as any).from("shared_operator_memory").update({ value, memory_type: "financial_snapshot", source_agent: "system", updated_at: new Date().toISOString() }).eq("id", existing.id);
  } else {
    await (supabase as any).from("shared_operator_memory").insert({ user_id: userId, source_agent: "system", memory_type: "financial_snapshot", key: "financial_snapshot", value });
  }

  // Write to net worth history
  await (supabase as any).from("net_worth_snapshots").insert({
    user_id: userId, net_worth: netWorth, cash: cash + debit,
    credit_available: creditAvail, assets, liabilities,
  });
}

// Simple linear trend over recent snapshots -> projected date to hit target.
function projectGoalDate(history: NWSnapshot[], current: number, target: number): string | null {
  if (current >= target || history.length < 2) return null;
  const first = history[0], last = history[history.length - 1];
  const days = (new Date(last.recorded_at).getTime() - new Date(first.recorded_at).getTime()) / 86_400_000;
  if (days <= 0) return null;
  const perDay = (Number(last.net_worth) - Number(first.net_worth)) / days;
  if (perDay <= 0) return null;
  const daysNeeded = (target - current) / perDay;
  const d = new Date(); d.setDate(d.getDate() + Math.ceil(daysNeeded));
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export default function FinancialHQPage() {
  const [accounts, setAccounts] = useState<FinAccount[]>([]);
  const [userId, setUserId] = useState<string>("");
  const [adding, setAdding] = useState<AccountType | null>(null);
  const [history, setHistory] = useState<NWSnapshot[]>([]);
  const [goal, setGoal] = useState<NetWorthGoal | null>(null);
  const [editGoal, setEditGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  const [dateDraft, setDateDraft] = useState("");
  const [portfolio, setPortfolio] = useState<PortfolioState | null>(null);
  const [atlasTake, setAtlasTake] = useState("");
  const [askingAtlas, setAskingAtlas] = useState(false);

  async function load() {
    const { data: u } = await (supabase as any).auth.getUser();
    if (!u.user) return;
    setUserId(u.user.id);
    const { data } = await (supabase as any).from("financial_accounts").select("*").eq("user_id", u.user.id).order("type").order("name");
    setAccounts((data as FinAccount[]) || []);
    const { data: h } = await (supabase as any).from("net_worth_snapshots").select("recorded_at,net_worth").eq("user_id", u.user.id).order("recorded_at", { ascending: true }).limit(90);
    setHistory((h as NWSnapshot[]) || []);
    const { data: g } = await (supabase as any).from("net_worth_goals").select("id,target_amount,target_date").eq("user_id", u.user.id).maybeSingle();
    setGoal((g as NetWorthGoal) || null);
    const { data: p } = await (supabase as any).from("atlas_portfolio_state").select("total_value,rebalancing_needed,operating_reserve,liquid_trading,real_assets,venture_allocation").order("snapshot_at", { ascending: false }).limit(1).maybeSingle();
    setPortfolio((p as PortfolioState) || null);
  }

  useEffect(() => { load(); }, []);

  async function saveAccount(acc: FinAccount) {
    const { error } = await (supabase as any).from("financial_accounts").update({
      name: acc.name, balance: acc.balance, limit_amount: acc.limit_amount, notes: acc.notes, updated_at: new Date().toISOString(),
    }).eq("id", acc.id);
    if (error) { toast.error(error.message); return; }
    const updated = accounts.map(a => a.id === acc.id ? acc : a);
    setAccounts(updated);
    await writeSnapshot(userId, updated);
    await load();
  }

  async function addAccount(type: AccountType, name: string) {
    if (!name.trim()) return;
    const { data, error } = await (supabase as any).from("financial_accounts").insert({ user_id: userId, type, name, balance: 0 }).select().single();
    if (error) { toast.error(error.message); return; }
    const updated = [...accounts, data as FinAccount];
    setAccounts(updated);
    setAdding(null);
    await writeSnapshot(userId, updated);
    await load();
  }

  async function removeAccount(id: string) {
    await (supabase as any).from("financial_accounts").delete().eq("id", id);
    const updated = accounts.filter(a => a.id !== id);
    setAccounts(updated);
    await writeSnapshot(userId, updated);
    await load();
  }

  async function saveGoal() {
    const amt = parseFloat(goalDraft);
    if (!amt || amt <= 0) return toast.error("Enter a target amount");
    const { data, error } = await (supabase as any).from("net_worth_goals")
      .upsert({ user_id: userId, target_amount: amt, target_date: dateDraft || null, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
      .select().single();
    if (error) return toast.error(error.message);
    setGoal(data as NetWorthGoal);
    setEditGoal(false);
    toast.success("Goal saved");
  }

  async function askAtlas() {
    setAskingAtlas(true);
    setAtlasTake("");
    try {
      const { data: { session } } = await (supabase as any).auth.getSession();
      const prompt = `Here is my current financial snapshot:\n${snapshotText}\n\nGive me a short, direct take: is my allocation and spending on track to grow net worth, what's the single biggest lever I should pull right now, and anything concerning. 3-4 sentences, no fluff.`;
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/atlas-core`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
      });
      if (!resp.ok || !resp.body) throw new Error("Atlas request failed");
      const reader = resp.body.getReader(); const dec = new TextDecoder();
      let buf = ""; let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") continue;
          try {
            const p = JSON.parse(json);
            if (p.type === "content_block_delta" && p.delta?.type === "text_delta") full += p.delta.text;
          } catch { /* */ }
        }
      }
      setAtlasTake(full || "No response.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAskingAtlas(false);
    }
  }

  const cash = accounts.filter(a => a.type === "cash").reduce((s, a) => s + Number(a.balance || 0), 0);
  const debit = accounts.filter(a => a.type === "debit").reduce((s, a) => s + Number(a.balance || 0), 0);
  const assets = accounts.filter(a => a.type === "asset").reduce((s, a) => s + Number(a.balance || 0), 0);
  const liabilities = accounts.filter(a => a.type === "liability").reduce((s, a) => s + Number(a.balance || 0), 0);
  const credit = accounts.filter(a => a.type === "credit").reduce((s, a) => s + Number(a.balance || 0), 0);
  const netWorth = cash + debit + assets - liabilities - credit;

  const chartData = history.map(h => ({
    date: new Date(h.recorded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    value: Number(h.net_worth),
  }));

  const goalPct = goal ? Math.min(100, Math.max(0, (netWorth / goal.target_amount) * 100)) : 0;
  const projectedDate = goal ? projectGoalDate(history, netWorth, goal.target_amount) : null;

  const allocationRows = portfolio ? [
    { label: "Cash reserve", actual: Number(portfolio.operating_reserve?.value ?? 0) },
    { label: "Trading", actual: Number(portfolio.liquid_trading?.value ?? 0) },
    { label: "Real assets", actual: Number(portfolio.real_assets?.value ?? 0) },
    { label: "Business/venture", actual: Number(portfolio.venture_allocation?.value ?? 0) },
  ].map(r => ({ ...r, pct: portfolio.total_value > 0 ? (r.actual / portfolio.total_value) * 100 : 0, target: ALLOCATION_TARGETS[r.label] })) : [];

  const snapshotText = `Net worth: $${netWorth.toFixed(2)} (Cash $${cash.toFixed(0)}, Debit $${debit.toFixed(0)}, Assets $${assets.toFixed(0)}, Liabilities $${liabilities.toFixed(0)}, Credit owed $${credit.toFixed(0)}).`
    + (goal ? ` Goal: $${goal.target_amount.toFixed(0)}${goal.target_date ? ` by ${goal.target_date}` : ""} (${goalPct.toFixed(0)}% there).` : "")
    + (portfolio ? ` Allocation — ${allocationRows.map(r => `${r.label} ${r.pct.toFixed(0)}% (target ${r.target}%)`).join(", ")}.` : "");

  return (
    <div className="p-6 space-y-6">
      <h1 className="font-display text-2xl text-primary tracking-widest">FINANCIAL HQ</h1>

      {SECTIONS.map(section => {
        const items = accounts.filter(a => section.key.includes(a.type));
        const primaryType = section.key[0];
        return (
          <div key={section.title} className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm tracking-widest text-accent">{section.title.toUpperCase()}</h2>
              <div className="flex gap-2">
                {section.key.map(t => (
                  <Button key={t} size="sm" variant="outline" onClick={() => setAdding(t)}>
                    <Plus className="w-3 h-3 mr-1" />{t}
                  </Button>
                ))}
              </div>
            </div>
            {adding && section.key.includes(adding) && (
              <AddRow type={adding} onCancel={() => setAdding(null)} onSave={n => addAccount(adding, n)} />
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {items.map(acc => (
                <AccountCard key={acc.id} acc={acc} onSave={saveAccount} onDelete={() => removeAccount(acc.id)} />
              ))}
              {items.length === 0 && !adding && (
                <div className="text-xs text-muted-foreground col-span-3">No {primaryType} accounts yet.</div>
              )}
            </div>
          </div>
        );
      })}

      <Card className="border-accent/30">
        <CardHeader><CardTitle className="font-display tracking-widest text-accent">NET WORTH</CardTitle></CardHeader>
        <CardContent>
          <div className="text-4xl font-display text-primary">${netWorth.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
          <div className="text-xs text-muted-foreground mt-2">
            Cash ${cash.toFixed(0)} + Debit ${debit.toFixed(0)} + Assets ${assets.toFixed(0)} − Liabilities ${liabilities.toFixed(0)} − Credit owed ${credit.toFixed(0)}
          </div>
        </CardContent>
      </Card>

      {chartData.length > 1 && (
        <Card>
          <CardHeader><CardTitle className="text-sm font-display tracking-widest text-accent">NET WORTH OVER TIME</CardTitle></CardHeader>
          <CardContent className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="date" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v: number) => [`$${v.toLocaleString()}`, "Net Worth"]} />
                <Line type="monotone" dataKey="value" stroke="hsl(var(--accent))" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Net worth goal */}
      <Card className="border-accent/20">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-display tracking-widest text-accent flex items-center gap-2"><Target className="w-4 h-4" /> NET WORTH GOAL</CardTitle>
            <Button size="sm" variant="ghost" onClick={() => { setEditGoal(!editGoal); setGoalDraft(String(goal?.target_amount ?? "")); setDateDraft(goal?.target_date ?? ""); }}>
              {goal ? "Edit" : "Set goal"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {editGoal ? (
            <div className="flex gap-2">
              <Input type="number" placeholder="Target net worth" value={goalDraft} onChange={e => setGoalDraft(e.target.value)} />
              <Input type="date" value={dateDraft} onChange={e => setDateDraft(e.target.value)} />
              <Button size="sm" onClick={saveGoal}>Save</Button>
            </div>
          ) : goal ? (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">${netWorth.toLocaleString(undefined, { maximumFractionDigits: 0 })} of ${goal.target_amount.toLocaleString()}</span>
                <span className="text-accent font-medium">{goalPct.toFixed(1)}%</span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${goalPct}%` }} />
              </div>
              <div className="text-xs text-muted-foreground">
                {goal.target_date && <>Target date: {new Date(goal.target_date).toLocaleDateString()}. </>}
                {projectedDate ? `At your current savings trend, projected to hit this around ${projectedDate}.` : "Not enough trend data yet to project a date."}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No goal set yet — set a target net worth to track progress toward it.</p>
          )}
        </CardContent>
      </Card>

      {/* Capital allocation */}
      {portfolio && (
        <Card className="border-accent/20">
          <CardHeader>
            <CardTitle className="text-sm font-display tracking-widest text-accent flex items-center gap-2">
              <Scale className="w-4 h-4" /> CAPITAL ALLOCATION
              {portfolio.rebalancing_needed && <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 normal-case tracking-normal">Rebalancing suggested</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {allocationRows.map(r => (
              <div key={r.label} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-foreground/80">{r.label}</span>
                  <span className="text-muted-foreground">{r.pct.toFixed(0)}% actual · {r.target}% target</span>
                </div>
                <div className="relative w-full h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full" style={{ width: `${Math.min(100, r.pct)}%` }} />
                  <div className="absolute top-0 h-full w-0.5 bg-foreground/40" style={{ left: `${Math.min(100, r.target)}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Ask Atlas */}
      <Card className="border-accent/20">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-display tracking-widest text-accent flex items-center gap-2"><Sparkles className="w-4 h-4" /> ASK ATLAS</CardTitle>
            <Button size="sm" onClick={askAtlas} disabled={askingAtlas}>
              {askingAtlas ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
              {askingAtlas ? "Thinking…" : "Get a take"}
            </Button>
          </div>
        </CardHeader>
        {atlasTake && (
          <CardContent>
            <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">{atlasTake}</p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

function AddRow({ type, onSave, onCancel }: { type: AccountType; onSave: (n: string) => void; onCancel: () => void }) {
  const [n, setN] = useState("");
  return (
    <div className="flex gap-2">
      <Input placeholder={`New ${type} account name`} value={n} onChange={e => setN(e.target.value)}
        onKeyDown={e => e.key === "Enter" && onSave(n)} autoFocus />
      <Button size="sm" onClick={() => onSave(n)}>Add</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

function AccountCard({ acc, onSave, onDelete }: { acc: FinAccount; onSave: (a: FinAccount) => void; onDelete: () => void }) {
  const [draft, setDraft] = useState(acc);
  useEffect(() => setDraft(acc), [acc]);
  const isCredit = acc.type === "credit";
  const available = isCredit && acc.limit_amount ? Number(acc.limit_amount) - Number(acc.balance || 0) : null;
  const utilPct = isCredit && acc.limit_amount ? Math.round((Number(acc.balance || 0) / Number(acc.limit_amount)) * 100) : null;

  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center justify-between">
          <div className="font-medium text-sm">{acc.name}</div>
          <div className="flex gap-1">
            <Popover>
              <PopoverTrigger asChild>
                <Button size="icon" variant="ghost" className="h-7 w-7"><Pencil className="w-3 h-3" /></Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 space-y-2">
                <div className="text-xs text-muted-foreground font-medium mb-1">Edit {acc.name}</div>
                <Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} onBlur={() => onSave(draft)} placeholder="Name" />
                <Input type="number" value={draft.balance ?? 0} onChange={e => setDraft({ ...draft, balance: parseFloat(e.target.value) || 0 })} onBlur={() => onSave(draft)} placeholder={isCredit ? "Balance owed" : "Balance"} />
                {isCredit && (
                  <Input type="number" value={draft.limit_amount ?? 0} onChange={e => setDraft({ ...draft, limit_amount: parseFloat(e.target.value) || 0 })} onBlur={() => onSave(draft)} placeholder="Credit limit" />
                )}
                <Input value={draft.notes ?? ""} onChange={e => setDraft({ ...draft, notes: e.target.value })} onBlur={() => onSave(draft)} placeholder="Notes" />
              </PopoverContent>
            </Popover>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={onDelete}><Trash2 className="w-3 h-3" /></Button>
          </div>
        </div>
        <div className={`text-2xl font-display ${isCredit ? "text-orange-400" : "text-primary"}`}>
          ${Number(acc.balance || 0).toLocaleString()}
        </div>
        {isCredit && acc.limit_amount && (
          <>
            <div className="text-xs text-muted-foreground">
              Available ${available!.toLocaleString()} · Limit ${Number(acc.limit_amount).toLocaleString()}
            </div>
            <div className="w-full h-1 bg-muted rounded-full overflow-hidden mt-1">
              <div className={`h-full rounded-full ${utilPct! > 80 ? "bg-red-500" : utilPct! > 50 ? "bg-yellow-500" : "bg-green-500"}`}
                style={{ width: `${Math.min(utilPct!, 100)}%` }} />
            </div>
            <div className="text-[10px] text-muted-foreground">{utilPct}% utilized</div>
          </>
        )}
        {acc.notes && <div className="text-xs text-muted-foreground">{acc.notes}</div>}
      </CardContent>
    </Card>
  );
}
