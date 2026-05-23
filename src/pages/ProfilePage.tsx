import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Plus, Trash2, CheckCircle, AlertCircle, ExternalLink, Plug, Briefcase } from "lucide-react";
import skyforgeEagle from "@/assets/skyforge-eagle.jpeg";
import MCPConnectionsTab from "@/components/MCPConnectionsTab";


type AccountRow = {
  id: string;
  broker: string;
  account_id: string;
  account_type: string;
  currency: string;
  balance_usd: number | null;
  buying_power_usd: number | null;
  last_sync_at: string | null;
};

type TradeStats = {
  total: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  total_pnl: number;
};

const BROKER_INFO: Record<string, { label: string; url: string; description: string }> = {
  ibkr: {
    label: "Interactive Brokers",
    url: "https://www.ibkr.com",
    description: "Stocks · Options · Futures · Global markets",
  },
  oanda: {
    label: "OANDA",
    url: "https://www.oanda.com",
    description: "70+ forex pairs · Fractional lots · REST API",
  },
  alpaca: {
    label: "Alpaca Markets",
    url: "https://alpaca.markets",
    description: "Commission-free equities · Fractional shares · API-first",
  },
  manual: {
    label: "Manual",
    url: "",
    description: "Manually logged trades — no live sync",
  },
};

const BROKERS = ["ibkr", "oanda", "alpaca", "manual"];

const ProfilePage = () => {
  const { user } = useAuth();
  const name = user?.user_metadata?.full_name || "Operator";
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [stats, setStats] = useState<TradeStats>({ total: 0, open: 0, closed: 0, wins: 0, losses: 0, total_pnl: 0 });
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [broker, setBroker] = useState("oanda");
  const [accountId, setAccountId] = useState("");
  const [accountType, setAccountType] = useState<"live" | "paper">("paper");
  const [currency, setCurrency] = useState("USD");
  const [adding, setAdding] = useState(false);

  const loadData = useCallback(async () => {
    if (!user) return;
    const [acctRes, tradesRes] = await Promise.all([
      supabase
        .from("trading_accounts")
        .select("id, broker, account_id, account_type, currency, balance_usd, buying_power_usd, last_sync_at")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .order("created_at", { ascending: true }),
      supabase
        .from("trade_ledger")
        .select("status, pnl_usd")
        .eq("user_id", user.id),
    ]);
    setAccounts((acctRes.data ?? []) as AccountRow[]);

    const trades = tradesRes.data ?? [];
    const closed = trades.filter((t) => t.status === "closed");
    setStats({
      total: trades.length,
      open: trades.filter((t) => t.status === "open").length,
      closed: closed.length,
      wins: closed.filter((t) => (t.pnl_usd ?? 0) > 0).length,
      losses: closed.filter((t) => (t.pnl_usd ?? 0) < 0).length,
      total_pnl: closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0),
    });
    setLoading(false);
  }, [user]);

  useEffect(() => { void loadData(); }, [loadData]);

  const addAccount = async () => {
    if (!accountId.trim()) return;
    setAdding(true);
    try {
      await supabase.from("trading_accounts").insert({
        user_id: user!.id,
        broker,
        account_id: accountId.trim(),
        account_type: accountType,
        currency,
      });
      setAccountId(""); setShowForm(false);
      void loadData();
      toast.success(`${BROKER_INFO[broker]?.label ?? broker} account registered.`);
    } catch (e: any) {
      toast.error(e?.message?.includes("unique") ? "Account already registered." : "Failed to add account.");
    } finally {
      setAdding(false);
    }
  };

  const removeAccount = async (id: string, b: string) => {
    await supabase.from("trading_accounts").update({ is_active: false }).eq("id", id);
    void loadData();
    toast.success(`${BROKER_INFO[b]?.label ?? b} account removed.`);
  };

  const winRate = stats.closed > 0 ? Math.round((stats.wins / stats.closed) * 100) : null;
  const fmtPnl = (n: number) => `${n >= 0 ? "+" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary font-display animate-pulse-glow tracking-widest text-sm">LOADING</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl mx-auto">

      {/* Operator Card */}
      <div className="glass-card relative overflow-hidden">
        <div className="absolute inset-0">
          <img src={skyforgeEagle} alt="" className="w-full h-full object-cover opacity-20" loading="lazy" />
          <div className="absolute inset-0 bg-gradient-to-r from-background/90 to-background/70" />
        </div>
        <div className="relative p-6 md:p-10 flex flex-col md:flex-row items-start md:items-center gap-6">
          <div className="w-20 h-20 rounded-2xl overflow-hidden border-2 border-primary/30 glow-blue shrink-0">
            <img src={skyforgeEagle} alt={name} className="w-full h-full object-cover" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl md:text-2xl font-display tracking-wider text-primary text-glow-blue">{name}</h1>
            <p className="text-sm text-muted-foreground mt-1">{user?.email}</p>
            <p className="text-xs text-muted-foreground/60 mt-1 font-mono">ID: {user?.id?.slice(0, 12)}…</p>
          </div>
          <div className="flex gap-6">
            <div className="text-center">
              <div className="text-2xl font-display text-accent">{accounts.length}</div>
              <div className="text-xs text-muted-foreground">Brokers</div>
            </div>
            <div className="text-center">
              <div className={`text-2xl font-display ${stats.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                {stats.closed > 0 ? fmtPnl(stats.total_pnl) : "—"}
              </div>
              <div className="text-xs text-muted-foreground">Total P&L</div>
            </div>
          </div>
        </div>
      </div>

      {/* Trading stats */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Total Trades", value: stats.total },
          { label: "Open", value: stats.open },
          { label: "Win Rate", value: winRate != null ? `${winRate}%` : "—" },
          { label: "Wins / Losses", value: stats.closed > 0 ? `${stats.wins}W ${stats.losses}L` : "—" },
        ].map((s) => (
          <div key={s.label} className="glass-card p-4 text-center space-y-1">
            <div className="text-xl font-display text-primary">{s.value}</div>
            <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Broker accounts */}
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-display tracking-widest text-primary uppercase">Broker Accounts</h2>
          <Button
            size="sm"
            onClick={() => setShowForm((v) => !v)}
            className="bg-accent/10 text-accent hover:bg-accent/20 border border-accent/30 font-display tracking-wider"
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Connect
          </Button>
        </div>

        {showForm && (
          <div className="space-y-3 pt-2 border-t border-border/20">
            <p className="text-[10px] font-display tracking-widest text-accent uppercase">Register Account</p>
            <div className="grid grid-cols-2 gap-2">
              <select value={broker} onChange={(e) => setBroker(e.target.value)} className="bg-secondary/30 border border-border/30 rounded-md px-3 py-2 text-sm text-foreground">
                {BROKERS.map((b) => <option key={b} value={b} className="bg-background">{BROKER_INFO[b]?.label ?? b}</option>)}
              </select>
              <div className="flex rounded-md overflow-hidden border border-border/30">
                {(["paper", "live"] as const).map((t) => (
                  <button key={t} onClick={() => setAccountType(t)} className={`flex-1 py-2 text-sm font-display capitalize transition-colors ${accountType === t ? "bg-accent text-accent-foreground" : "bg-secondary/30 text-muted-foreground hover:bg-secondary/50"}`}>{t}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Account ID" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="bg-secondary/30 border-border/30" />
              <Input placeholder="Currency (USD)" value={currency} onChange={(e) => setCurrency(e.target.value)} className="bg-secondary/30 border-border/30" />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button size="sm" onClick={addAccount} disabled={adding || !accountId.trim()} className="bg-accent text-accent-foreground hover:bg-accent/90 font-display tracking-wider">
                {adding ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}

        {accounts.length === 0 && !showForm ? (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground/50">No broker accounts connected. Register them above to enable live P&L sync.</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {(["oanda", "alpaca", "ibkr"] as const).map((b) => (
                <div key={b} className="p-3 rounded-lg border border-border/20 bg-secondary/10 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-display uppercase text-foreground/80">{BROKER_INFO[b].label}</span>
                    {BROKER_INFO[b].url && (
                      <a href={BROKER_INFO[b].url} target="_blank" rel="noopener noreferrer" className="text-primary/40 hover:text-primary transition-colors">
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground/50">{BROKER_INFO[b].description}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center gap-4 p-3 rounded-lg bg-secondary/20 border border-border/20 group">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-display uppercase text-foreground">{BROKER_INFO[a.broker]?.label ?? a.broker}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border capitalize ${a.account_type === "live" ? "text-green-400 border-green-400/30 bg-green-400/5" : "text-blue-400 border-blue-400/30 bg-blue-400/5"}`}>
                      {a.account_type}
                    </span>
                    {a.account_type === "live" ? (
                      <CheckCircle className="h-3 w-3 text-green-400/60" />
                    ) : (
                      <AlertCircle className="h-3 w-3 text-blue-400/60" />
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground/50 mt-0.5 font-mono">
                    {a.account_id} · {a.currency}
                    {a.last_sync_at && ` · synced ${new Date(a.last_sync_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                  </div>
                </div>
                {a.balance_usd != null && (
                  <div className="text-right shrink-0">
                    <div className="text-sm font-display text-primary">${a.balance_usd.toLocaleString()}</div>
                    {a.buying_power_usd != null && (
                      <div className="text-[10px] text-muted-foreground/40">{a.buying_power_usd.toLocaleString()} bp</div>
                    )}
                  </div>
                )}
                <button
                  onClick={() => removeAccount(a.id, a.broker)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* API Setup Guide */}
      <div className="glass-card p-5 space-y-3">
        <h2 className="text-sm font-display tracking-widest text-primary uppercase">API Setup</h2>
        <div className="space-y-3">
          {[
            {
              broker: "OANDA",
              steps: ["Open practice account at oanda.com", "My Account → Manage API Access → Generate token", "Note your Account ID from the dashboard"],
              status: accounts.some((a) => a.broker === "oanda") ? "connected" : "pending",
            },
            {
              broker: "Alpaca",
              steps: ["Sign up at alpaca.markets", "Dashboard → API Keys → Generate", "Paper trading available instantly"],
              status: accounts.some((a) => a.broker === "alpaca") ? "connected" : "pending",
            },
            {
              broker: "IBKR",
              steps: ["Open account at ibkr.com (24-48hr verification)", "TWS → Edit → Global Config → API → Enable Socket Clients", "Port 7497 (paper) / 7496 (live)"],
              status: accounts.some((a) => a.broker === "ibkr") ? "connected" : "pending",
            },
          ].map((guide) => (
            <div key={guide.broker} className="p-3 rounded-lg border border-border/20 bg-secondary/5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-display uppercase text-foreground/80">{guide.broker}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${guide.status === "connected" ? "text-green-400 border-green-400/30 bg-green-400/5" : "text-muted-foreground/50 border-border/20"}`}>
                  {guide.status}
                </span>
              </div>
              <ol className="space-y-0.5">
                {guide.steps.map((step, i) => (
                  <li key={i} className="text-[10px] text-muted-foreground/60">
                    {i + 1}. {step}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground/30">
          MCP servers for live position sync build in Phase 2. Register accounts here now so Atlas knows your setup.
        </p>
      </div>

    </div>
  );
};

export default ProfilePage;
