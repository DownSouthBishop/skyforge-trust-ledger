import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Trash2, TrendingUp, TrendingDown } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid, Legend, ReferenceLine } from "recharts";

const CATEGORIES = ["Food", "Transport", "Business", "Housing", "Health", "Entertainment", "Other"];

interface FinAccount { id: string; type: string; name: string; balance: number | null }
interface Tx { id: string; account_id: string | null; amount: number; category: string; note: string | null; date: string; flow: string }
interface Budget { category: string; monthly_limit: number }

async function writeSnapshot(userId: string) {
  const { data: accs } = await (supabase as any).from("financial_accounts").select("*").eq("user_id", userId);
  const accounts = (accs as any[]) || [];
  const cash = accounts.filter(a => a.type === "cash").reduce((s: number, a: any) => s + Number(a.balance || 0), 0);
  const debit = accounts.filter(a => a.type === "debit").reduce((s: number, a: any) => s + Number(a.balance || 0), 0);
  const assets = accounts.filter(a => a.type === "asset").reduce((s: number, a: any) => s + Number(a.balance || 0), 0);
  const liabilities = accounts.filter(a => a.type === "liability").reduce((s: number, a: any) => s + Number(a.balance || 0), 0);
  const credit = accounts.filter(a => a.type === "credit").reduce((s: number, a: any) => s + Number(a.balance || 0), 0);
  const creditAvail = accounts.filter(a => a.type === "credit").reduce((s: number, a: any) => s + Math.max(0, Number(a.limit_amount || 0) - Number(a.balance || 0)), 0);
  const netWorth = cash + debit + assets - liabilities - credit;
  const topLiab = [...accounts.filter((a: any) => a.type === "liability")].sort((a: any, b: any) => Number(b.balance || 0) - Number(a.balance || 0))[0];
  const value = `Net worth: $${netWorth.toFixed(2)}. Cash: $${cash.toFixed(2)}. Credit available: $${creditAvail.toFixed(2)}. Top liability: ${topLiab ? `${topLiab.name} $${Number(topLiab.balance || 0).toFixed(2)}` : "none"}.`;
  const { data: existing } = await (supabase as any).from("shared_operator_memory").select("id").eq("user_id", userId).eq("key", "financial_snapshot").maybeSingle();
  if (existing) await (supabase as any).from("shared_operator_memory").update({ value, memory_type: "financial_snapshot", source_agent: "system", updated_at: new Date().toISOString() }).eq("id", existing.id);
  else await (supabase as any).from("shared_operator_memory").insert({ user_id: userId, source_agent: "system", memory_type: "financial_snapshot", key: "financial_snapshot", value });
  await (supabase as any).from("net_worth_snapshots").insert({ user_id: userId, net_worth: netWorth, cash: cash + debit, credit_available: creditAvail, assets, liabilities });
}

export default function SpendTrackerPage() {
  const [userId, setUserId] = useState("");
  const [accounts, setAccounts] = useState<FinAccount[]>([]);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("Food");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [flow, setFlow] = useState<"out" | "in">("out");
  const [editBudgets, setEditBudgets] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({});

  async function load() {
    const { data: u } = await (supabase as any).auth.getUser();
    if (!u.user) return;
    setUserId(u.user.id);
    const { data: a } = await (supabase as any).from("financial_accounts").select("*").eq("user_id", u.user.id).in("type", ["cash", "debit", "credit"]).order("name");
    setAccounts((a as FinAccount[]) || []);
    const { data: t } = await (supabase as any).from("spend_transactions").select("*").eq("user_id", u.user.id).order("date", { ascending: false }).order("created_at", { ascending: false }).limit(200);
    setTxs((t as Tx[]) || []);
    const { data: b } = await (supabase as any).from("budget_targets").select("category,monthly_limit").eq("user_id", u.user.id);
    setBudgets((b as Budget[]) || []);
  }

  useEffect(() => { load(); }, []);

  const available = accounts.reduce((s, a) => s + Number(a.balance || 0), 0);

  async function submit() {
    const amt = parseFloat(amount);
    if (!accountId || !amt || amt <= 0) { toast.error("Account and positive amount required"); return; }
    const { error } = await (supabase as any).from("spend_transactions").insert({
      user_id: userId, account_id: accountId, amount: amt, category, note: note || null, date, flow,
    });
    if (error) { toast.error(error.message); return; }
    const acc = accounts.find(a => a.id === accountId);
    if (acc) {
      const newBalance = flow === "out"
        ? Number(acc.balance || 0) - amt
        : Number(acc.balance || 0) + amt;
      await (supabase as any).from("financial_accounts").update({ balance: newBalance, updated_at: new Date().toISOString() }).eq("id", accountId);
    }
    setAmount(""); setNote("");
    await load();
    await writeSnapshot(userId);
    toast.success(flow === "out" ? `Logged $${amt.toFixed(2)} spend` : `Logged $${amt.toFixed(2)} income`);
  }

  async function deleteTx(tx: Tx) {
    await (supabase as any).from("spend_transactions").delete().eq("id", tx.id);
    if (tx.account_id) {
      const { data: acc } = await (supabase as any).from("financial_accounts").select("balance").eq("id", tx.account_id).maybeSingle();
      if (acc) {
        const newBalance = tx.flow === "out"
          ? Number(acc.balance || 0) + Number(tx.amount)
          : Number(acc.balance || 0) - Number(tx.amount);
        await (supabase as any).from("financial_accounts").update({ balance: newBalance, updated_at: new Date().toISOString() }).eq("id", tx.account_id);
      }
    }
    await load();
    await writeSnapshot(userId);
  }

  async function saveBudgets() {
    for (const cat of CATEGORIES) {
      const val = parseFloat(budgetDraft[cat] || "0");
      if (isNaN(val)) continue;
      await (supabase as any).from("budget_targets").upsert({ user_id: userId, category: cat, monthly_limit: val, updated_at: new Date().toISOString() }, { onConflict: "user_id,category" });
    }
    setEditBudgets(false);
    await load();
    toast.success("Budgets saved");
  }

  // Chart data
  const monthStart = new Date(); monthStart.setDate(1);
  const byCat: Record<string, { spend: number; income: number }> = {};
  for (const t of txs) {
    if (new Date(t.date) >= monthStart) {
      if (!byCat[t.category]) byCat[t.category] = { spend: 0, income: 0 };
      if (t.flow === "in") byCat[t.category].income += Number(t.amount);
      else byCat[t.category].spend += Number(t.amount);
    }
  }
  const budgetMap: Record<string, number> = {};
  budgets.forEach(b => { budgetMap[b.category] = b.monthly_limit; });
  const barData = CATEGORIES.map(c => ({
    category: c,
    spend: byCat[c]?.spend || 0,
    income: byCat[c]?.income || 0,
    budget: budgetMap[c] || 0,
  }));

  const days: Record<string, { spend: number; income: number }> = {};
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    days[d.toISOString().slice(0, 10)] = { spend: 0, income: 0 };
  }
  for (const t of txs) {
    if (days[t.date] !== undefined) {
      if (t.flow === "in") days[t.date].income += Number(t.amount);
      else days[t.date].spend += Number(t.amount);
    }
  }
  const lineData = Object.entries(days).map(([d, v]) => ({ date: d.slice(5), spend: v.spend, income: v.income }));

  const monthSpend = txs.filter(t => new Date(t.date) >= monthStart && t.flow === "out").reduce((s, t) => s + Number(t.amount), 0);
  const monthIncome = txs.filter(t => new Date(t.date) >= monthStart && t.flow === "in").reduce((s, t) => s + Number(t.amount), 0);

  return (
    <div className="p-6 space-y-6">

      {/* Summary row */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="border-accent/30">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Available</div>
            <div className="text-3xl font-display text-primary">${available.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
            <div className="text-[10px] text-muted-foreground mt-1">Cash + debit + credit</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1"><TrendingDown className="w-3 h-3 text-red-400" /> Month Spend</div>
            <div className="text-3xl font-display text-red-400">${monthSpend.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1"><TrendingUp className="w-3 h-3 text-green-400" /> Month Income</div>
            <div className="text-3xl font-display text-green-400">${monthIncome.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
          </CardContent>
        </Card>
      </div>

      {/* Log transaction */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CardTitle className="text-base">Log Transaction</CardTitle>
            <div className="flex rounded overflow-hidden border border-border text-xs">
              <button onClick={() => setFlow("out")} className={`px-3 py-1 ${flow === "out" ? "bg-red-500/20 text-red-400" : "text-muted-foreground hover:bg-muted"}`}>
                Expense
              </button>
              <button onClick={() => setFlow("in")} className={`px-3 py-1 ${flow === "in" ? "bg-green-500/20 text-green-400" : "text-muted-foreground hover:bg-muted"}`}>
                Income
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-6 gap-2">
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger><SelectValue placeholder="Account" /></SelectTrigger>
            <SelectContent>{accounts.map(a => <SelectItem key={a.id} value={a.id}>{a.name} (${Number(a.balance || 0).toFixed(0)})</SelectItem>)}</SelectContent>
          </Select>
          <Input type="number" placeholder="Amount" value={amount} onChange={e => setAmount(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()} />
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
          <Input placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} />
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          <Button onClick={submit} className={flow === "in" ? "bg-green-600 hover:bg-green-700" : ""}>Log</Button>
        </CardContent>
      </Card>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">This Month by Category</CardTitle>
              <button onClick={() => { setEditBudgets(!editBudgets); setBudgetDraft(Object.fromEntries(CATEGORIES.map(c => [c, String(budgetMap[c] || "")])));  }} className="text-[10px] text-accent hover:underline">
                {editBudgets ? "Cancel" : "Set Budgets"}
              </button>
            </div>
          </CardHeader>
          {editBudgets ? (
            <CardContent className="space-y-2">
              {CATEGORIES.map(c => (
                <div key={c} className="flex items-center gap-2">
                  <span className="text-xs w-24 text-muted-foreground">{c}</span>
                  <Input type="number" placeholder="Monthly limit" value={budgetDraft[c] || ""} onChange={e => setBudgetDraft({ ...budgetDraft, [c]: e.target.value })} className="h-7 text-xs" />
                </div>
              ))}
              <Button size="sm" onClick={saveBudgets} className="mt-2">Save Budgets</Button>
            </CardContent>
          ) : (
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="category" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="spend" name="Spent" fill="hsl(var(--destructive))" opacity={0.8} />
                  <Bar dataKey="budget" name="Budget" fill="hsl(var(--accent))" opacity={0.3} />
                  <Bar dataKey="income" name="Income" fill="#4ade80" opacity={0.8} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Last 30 Days</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={lineData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="date" tick={{ fontSize: 9 }} interval={4} />
                <YAxis tick={{ fontSize: 9 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine y={0} stroke="hsl(var(--border))" />
                <Line type="monotone" dataKey="spend" name="Spend" stroke="hsl(var(--destructive))" dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="income" name="Income" stroke="#4ade80" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Transactions */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Transactions</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-0.5">
            {txs.map(t => {
              const acc = accounts.find(a => a.id === t.account_id);
              const isIncome = t.flow === "in";
              return (
                <div key={t.id} className="flex items-center justify-between text-sm border-b border-border/20 py-1.5 hover:bg-muted/20">
                  <div className="flex-1 grid grid-cols-5 gap-2 items-center">
                    <span className="text-muted-foreground text-xs">{t.date}</span>
                    <span className="text-xs">{t.category}</span>
                    <span className="text-muted-foreground text-xs truncate">{acc?.name ?? "—"}</span>
                    <span className={`font-medium text-xs ${isIncome ? "text-green-400" : "text-red-400"}`}>
                      {isIncome ? "+" : "-"}${Number(t.amount).toFixed(2)}
                    </span>
                    <span className="text-muted-foreground text-xs truncate">{t.note}</span>
                  </div>
                  <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive shrink-0" onClick={() => deleteTx(t)}><Trash2 className="w-3 h-3" /></Button>
                </div>
              );
            })}
            {txs.length === 0 && <div className="text-xs text-muted-foreground py-2">No transactions yet.</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
