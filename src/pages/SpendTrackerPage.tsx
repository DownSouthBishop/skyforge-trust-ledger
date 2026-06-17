import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from "recharts";

const CATEGORIES = ["Food", "Transport", "Business", "Housing", "Health", "Entertainment", "Other"];

interface FinAccount { id: string; type: string; name: string; balance: number | null; }
interface Tx { id: string; account_id: string | null; amount: number; category: string; note: string | null; date: string; }

async function writeSnapshot(userId: string) {
  const { data: accs } = await (supabase as any).from("financial_accounts").select("*");
  const accounts = (accs as FinAccount[]) || [];
  const cash = accounts.filter(a => a.type === "cash").reduce((s, a) => s + Number(a.balance || 0), 0);
  const debit = accounts.filter(a => a.type === "debit").reduce((s, a) => s + Number(a.balance || 0), 0);
  const assets = accounts.filter(a => a.type === "asset").reduce((s, a) => s + Number(a.balance || 0), 0);
  const liabilities = accounts.filter(a => a.type === "liability").reduce((s, a) => s + Number(a.balance || 0), 0);
  const credit = accounts.filter(a => a.type === "credit").reduce((s, a) => s + Number(a.balance || 0), 0);
  const creditAvail = accounts.filter(a => a.type === "credit").reduce((s, a) => s + Math.max(0, Number((a as any).limit_amount || 0) - Number(a.balance || 0)), 0);
  const netWorth = cash + debit + assets - liabilities - credit;
  const topLiab = [...accounts.filter(a => a.type === "liability")].sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0))[0];
  const value = `Net worth: $${netWorth.toFixed(2)}. Cash: $${cash.toFixed(2)}. Credit available: $${creditAvail.toFixed(2)}. Top liability: ${topLiab ? `${topLiab.name} $${Number(topLiab.balance || 0).toFixed(2)}` : "none"}.`;
  const { data: existing } = await (supabase as any).from("shared_operator_memory").select("id").eq("user_id", userId).eq("key", "financial_snapshot").maybeSingle();
  if (existing) await (supabase as any).from("shared_operator_memory").update({ value, memory_type: "financial_snapshot", source_agent: "system", updated_at: new Date().toISOString() }).eq("id", existing.id);
  else await (supabase as any).from("shared_operator_memory").insert({ user_id: userId, source_agent: "system", memory_type: "financial_snapshot", key: "financial_snapshot", value });
}

export default function SpendTrackerPage() {
  const [userId, setUserId] = useState("");
  const [accounts, setAccounts] = useState<FinAccount[]>([]);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("Food");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  async function load() {
    const { data: u } = await (supabase as any).auth.getUser();
    if (!u.user) return;
    setUserId(u.user.id);
    const { data: a } = await (supabase as any).from("financial_accounts").select("*").in("type", ["cash", "debit"]).order("name");
    setAccounts((a as FinAccount[]) || []);
    const { data: t } = await (supabase as any).from("spend_transactions").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }).limit(200);
    setTxs((t as Tx[]) || []);
  }
  useEffect(() => { load(); }, []);

  const available = accounts.reduce((s, a) => s + Number(a.balance || 0), 0);

  async function submit() {
    const amt = parseFloat(amount);
    if (!accountId || !amt || amt <= 0) { toast.error("Account and positive amount required"); return; }
    const { error } = await (supabase as any).from("spend_transactions").insert({ user_id: userId, account_id: accountId, amount: amt, category, note: note || null, date });
    if (error) { toast.error(error.message); return; }
    const acc = accounts.find(a => a.id === accountId);
    if (acc) await (supabase as any).from("financial_accounts").update({ balance: Number(acc.balance || 0) - amt, updated_at: new Date().toISOString() }).eq("id", accountId);
    setAmount(""); setNote("");
    await load();
    await writeSnapshot(userId);
  }

  async function deleteTx(tx: Tx) {
    await (supabase as any).from("spend_transactions").delete().eq("id", tx.id);
    if (tx.account_id) {
      const { data: acc } = await (supabase as any).from("financial_accounts").select("balance").eq("id", tx.account_id).maybeSingle();
      if (acc) await (supabase as any).from("financial_accounts").update({ balance: Number(acc.balance || 0) + Number(tx.amount), updated_at: new Date().toISOString() }).eq("id", tx.account_id);
    }
    await load();
    await writeSnapshot(userId);
  }

  // Chart data
  const monthStart = new Date(); monthStart.setDate(1);
  const byCat: Record<string, number> = {};
  for (const t of txs) {
    if (new Date(t.date) >= monthStart) byCat[t.category] = (byCat[t.category] || 0) + Number(t.amount);
  }
  const barData = CATEGORIES.map(c => ({ category: c, amount: byCat[c] || 0 }));

  const days: Record<string, number> = {};
  const today = new Date();
  for (let i = 29; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); days[d.toISOString().slice(0, 10)] = 0; }
  for (const t of txs) if (days[t.date] !== undefined) days[t.date] += Number(t.amount);
  const lineData = Object.entries(days).map(([date, amount]) => ({ date: date.slice(5), amount }));

  return (
    <div className="p-6 space-y-6">
      <Card className="border-accent/30">
        <CardHeader><CardTitle className="font-display tracking-widest text-accent">AVAILABLE BALANCE</CardTitle></CardHeader>
        <CardContent>
          <div className="text-4xl font-display text-primary">${available.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
          <div className="text-xs text-muted-foreground mt-1">Cash + debit accounts</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Log Spend</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-6 gap-2">
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger><SelectValue placeholder="Account" /></SelectTrigger>
            <SelectContent>{accounts.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
          </Select>
          <Input type="number" placeholder="Amount" value={amount} onChange={e => setAmount(e.target.value)} />
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
          <Input placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} />
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          <Button onClick={submit}>Log</Button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">This Month by Category</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="category" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="amount" fill="hsl(var(--accent))" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Last 30 Days</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={lineData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Line type="monotone" dataKey="amount" stroke="hsl(var(--primary))" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Transactions</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-1">
            {txs.map(t => {
              const acc = accounts.find(a => a.id === t.account_id);
              return (
                <div key={t.id} className="flex items-center justify-between text-sm border-b border-border/30 py-1.5">
                  <div className="flex-1 grid grid-cols-5 gap-2">
                    <span className="text-muted-foreground">{t.date}</span>
                    <span>{t.category}</span>
                    <span className="text-muted-foreground">{acc?.name ?? "—"}</span>
                    <span className="font-medium">${Number(t.amount).toFixed(2)}</span>
                    <span className="text-muted-foreground truncate">{t.note}</span>
                  </div>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => deleteTx(t)}><Trash2 className="w-3 h-3" /></Button>
                </div>
              );
            })}
            {txs.length === 0 && <div className="text-xs text-muted-foreground">No transactions yet.</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
