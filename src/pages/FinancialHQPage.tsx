import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

type AccountType = "cash" | "credit" | "debit" | "asset" | "liability";
interface FinAccount {
  id: string;
  user_id: string;
  type: AccountType;
  name: string;
  balance: number | null;
  limit_amount: number | null;
  notes: string | null;
}

const SECTIONS: { key: AccountType[]; title: string }[] = [
  { key: ["cash"], title: "Cash" },
  { key: ["credit", "debit"], title: "Cards" },
  { key: ["asset"], title: "Assets" },
  { key: ["liability"], title: "Liabilities" },
];

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
  const { data: existing } = await supabase
    .from("shared_operator_memory")
    .select("id")
    .eq("user_id", userId)
    .eq("key", "financial_snapshot")
    .maybeSingle();
  if (existing) {
    await supabase.from("shared_operator_memory").update({ value, memory_type: "financial_snapshot", source_agent: "system", updated_at: new Date().toISOString() }).eq("id", existing.id);
  } else {
    await supabase.from("shared_operator_memory").insert({ user_id: userId, source_agent: "system", memory_type: "financial_snapshot", key: "financial_snapshot", value });
  }
}

export default function FinancialHQPage() {
  const [accounts, setAccounts] = useState<FinAccount[]>([]);
  const [userId, setUserId] = useState<string>("");
  const [adding, setAdding] = useState<AccountType | null>(null);

  async function load() {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    setUserId(u.user.id);
    const { data } = await supabase.from("financial_accounts").select("*").order("type").order("name");
    setAccounts((data as FinAccount[]) || []);
  }
  useEffect(() => { load(); }, []);

  async function saveAccount(acc: FinAccount) {
    const { error } = await supabase.from("financial_accounts").update({
      name: acc.name,
      balance: acc.balance,
      limit_amount: acc.limit_amount,
      notes: acc.notes,
      updated_at: new Date().toISOString(),
    }).eq("id", acc.id);
    if (error) { toast.error(error.message); return; }
    const updated = accounts.map(a => a.id === acc.id ? acc : a);
    setAccounts(updated);
    await writeSnapshot(userId, updated);
  }

  async function addAccount(type: AccountType, name: string) {
    if (!name.trim()) return;
    const { data, error } = await supabase.from("financial_accounts").insert({ user_id: userId, type, name, balance: 0 }).select().single();
    if (error) { toast.error(error.message); return; }
    const updated = [...accounts, data as FinAccount];
    setAccounts(updated);
    setAdding(null);
    await writeSnapshot(userId, updated);
  }

  async function removeAccount(id: string) {
    await supabase.from("financial_accounts").delete().eq("id", id);
    const updated = accounts.filter(a => a.id !== id);
    setAccounts(updated);
    await writeSnapshot(userId, updated);
  }

  const cash = accounts.filter(a => a.type === "cash").reduce((s, a) => s + Number(a.balance || 0), 0);
  const debit = accounts.filter(a => a.type === "debit").reduce((s, a) => s + Number(a.balance || 0), 0);
  const assets = accounts.filter(a => a.type === "asset").reduce((s, a) => s + Number(a.balance || 0), 0);
  const liabilities = accounts.filter(a => a.type === "liability").reduce((s, a) => s + Number(a.balance || 0), 0);
  const credit = accounts.filter(a => a.type === "credit").reduce((s, a) => s + Number(a.balance || 0), 0);
  const netWorth = cash + debit + assets - liabilities - credit;

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
            Cash ${cash.toFixed(0)} + Debit ${debit.toFixed(0)} + Assets ${assets.toFixed(0)} − Liabilities ${liabilities.toFixed(0)} − Credit ${credit.toFixed(0)}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AddRow({ type, onSave, onCancel }: { type: AccountType; onSave: (n: string) => void; onCancel: () => void }) {
  const [n, setN] = useState("");
  return (
    <div className="flex gap-2">
      <Input placeholder={`New ${type} account name`} value={n} onChange={e => setN(e.target.value)} autoFocus />
      <Button size="sm" onClick={() => onSave(n)}>Add</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

function AccountCard({ acc, onSave, onDelete }: { acc: FinAccount; onSave: (a: FinAccount) => void; onDelete: () => void }) {
  const [draft, setDraft] = useState(acc);
  useEffect(() => setDraft(acc), [acc]);
  const isCredit = acc.type === "credit";
  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center justify-between">
          <div className="font-medium">{acc.name}</div>
          <div className="flex gap-1">
            <Popover>
              <PopoverTrigger asChild>
                <Button size="icon" variant="ghost" className="h-7 w-7"><Pencil className="w-3 h-3" /></Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 space-y-2">
                <Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} onBlur={() => onSave(draft)} placeholder="Name" />
                <Input type="number" value={draft.balance ?? 0} onChange={e => setDraft({ ...draft, balance: parseFloat(e.target.value) })} onBlur={() => onSave(draft)} placeholder="Balance" />
                {isCredit && (
                  <Input type="number" value={draft.limit_amount ?? 0} onChange={e => setDraft({ ...draft, limit_amount: parseFloat(e.target.value) })} onBlur={() => onSave(draft)} placeholder="Credit limit" />
                )}
                <Input value={draft.notes ?? ""} onChange={e => setDraft({ ...draft, notes: e.target.value })} onBlur={() => onSave(draft)} placeholder="Notes" />
              </PopoverContent>
            </Popover>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={onDelete}><Trash2 className="w-3 h-3" /></Button>
          </div>
        </div>
        <div className="text-2xl font-display text-primary">${Number(acc.balance || 0).toLocaleString()}</div>
        {isCredit && acc.limit_amount && (
          <div className="text-xs text-muted-foreground">Limit ${Number(acc.limit_amount).toLocaleString()} · Available ${(Number(acc.limit_amount) - Number(acc.balance || 0)).toLocaleString()}</div>
        )}
        {acc.notes && <div className="text-xs text-muted-foreground">{acc.notes}</div>}
      </CardContent>
    </Card>
  );
}
