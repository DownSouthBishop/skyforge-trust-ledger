import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { TrendingUp, TrendingDown, Plus, Trash2, AlertCircle, CheckCircle, XCircle, Bell } from "lucide-react";

type TradeRow = {
  id: string;
  symbol: string;
  asset_class: string;
  direction: string;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  broker: string;
  status: string;
  pnl_usd: number | null;
  pnl_pct: number | null;
  thesis: string | null;
  opened_at: string;
  closed_at: string | null;
};

type AccountRow = {
  id: string;
  broker: string;
  account_type: string;
  balance_usd: number | null;
  buying_power_usd: number | null;
  last_sync_at: string | null;
};

type ApprovalAlert = {
  id: string;
  message: string;
  created_at: string;
};

const BROKERS = ["ibkr", "oanda", "alpaca", "manual"];
const ASSET_CLASSES = ["forex", "equity", "crypto", "options", "futures"];

const fmt = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmtPnl = (n: number | null) =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const PositionsPage = () => {
  const { user } = useAuth();
  const [openTrades, setOpenTrades] = useState<TradeRow[]>([]);
  const [closedTrades, setClosedTrades] = useState<TradeRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"open" | "closed">("open");

  // Manual trade entry form
  const [showForm, setShowForm] = useState(false);
  const [tSymbol, setTSymbol] = useState("");
  const [tClass, setTClass] = useState("equity");
  const [tDir, setTDir] = useState<"long" | "short">("long");
  const [tEntry, setTEntry] = useState("");
  const [tQty, setTQty] = useState("");
  const [tBroker, setTBroker] = useState("manual");
  const [tThesis, setTThesis] = useState("");
  const [adding, setAdding] = useState(false);

  const loadData = useCallback(async () => {
    if (!user) return;
    const [openRes, closedRes, acctRes, alertsRes] = await Promise.all([
      supabase
        .from("trade_ledger")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "open")
        .order("opened_at", { ascending: false }),
      supabase
        .from("trade_ledger")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "closed")
        .order("closed_at", { ascending: false })
        .limit(50),
      supabase
        .from("trading_accounts")
        .select("id, broker, account_type, balance_usd, buying_power_usd, last_sync_at")
        .eq("user_id", user.id)
        .eq("is_active", true),
      supabase
        .from("forge_alerts")
        .select("id, message, created_at")
        .eq("user_id", user.id)
        .eq("signal_type", "trade_approval")
        .is("read_at", null)
        .order("created_at", { ascending: false }),
    ]);
    setOpenTrades((openRes.data ?? []) as TradeRow[]);
    setClosedTrades((closedRes.data ?? []) as TradeRow[]);
    setAccounts((acctRes.data ?? []) as AccountRow[]);
    setPendingApprovals((alertsRes.data ?? []) as ApprovalAlert[]);
    setLoading(false);
  }, [user]);

  useEffect(() => { void loadData(); }, [loadData]);

  const addTrade = async () => {
    const entry = parseFloat(tEntry);
    const qty = parseFloat(tQty);
    if (!tSymbol.trim() || !entry || !qty) return;
    setAdding(true);
    try {
      await supabase.from("trade_ledger").insert({
        user_id: user!.id,
        symbol: tSymbol.trim().toUpperCase(),
        asset_class: tClass,
        direction: tDir,
        entry_price: entry,
        quantity: qty,
        broker: tBroker,
        status: "open",
        thesis: tThesis.trim() || null,
      });
      setTSymbol(""); setTEntry(""); setTQty(""); setTThesis("");
      setShowForm(false);
      void loadData();
      toast.success("Trade logged.");
    } catch (e) {
      toast.error("Failed to log trade.");
    } finally {
      setAdding(false);
    }
  };

  const closeTrade = async (id: string, sym: string) => {
    const exitStr = prompt(`Exit price for ${sym}:`);
    if (!exitStr) return;
    const exit = parseFloat(exitStr);
    if (!exit) return;
    const trade = openTrades.find((t) => t.id === id);
    if (!trade) return;
    const pnl = trade.direction === "long"
      ? (exit - trade.entry_price) * trade.quantity
      : (trade.entry_price - exit) * trade.quantity;
    await supabase.from("trade_ledger").update({
      status: "closed",
      exit_price: exit,
      pnl_usd: Math.round(pnl * 100) / 100,
      pnl_pct: Math.round(((exit - trade.entry_price) / trade.entry_price) * 10000) / 100,
      closed_at: new Date().toISOString(),
    }).eq("id", id);
    toast.success(`${sym} closed. P&L: ${fmtPnl(Math.round(pnl * 100) / 100)}`);
    void loadData();
  };

  const approveAlert = async (alertId: string) => {
    await supabase.from("forge_alerts").update({ read_at: new Date().toISOString() }).eq("id", alertId);
    setPendingApprovals((prev) => prev.filter((a) => a.id !== alertId));
    toast.success("Trade approved.");
  };

  const declineAlert = async (alertId: string, message: string) => {
    await supabase.from("forge_alerts").update({ read_at: new Date().toISOString() }).eq("id", alertId);
    // Try to cancel the most recent open trade matching the symbol extracted from the message
    const symMatch = message.match(/\b([A-Z]{1,6}\/[A-Z]{1,6}|[A-Z]{2,6})\b/);
    if (symMatch) {
      const sym = symMatch[1];
      const { data: trades } = await supabase
        .from("trade_ledger")
        .select("id")
        .eq("user_id", user!.id)
        .eq("symbol", sym)
        .eq("status", "open")
        .order("opened_at", { ascending: false })
        .limit(1);
      if (trades && trades.length > 0) {
        await supabase.from("trade_ledger").update({ status: "cancelled" }).eq("id", trades[0].id);
      }
    }
    setPendingApprovals((prev) => prev.filter((a) => a.id !== alertId));
    toast.success("Trade declined and cancelled.");
    void loadData();
  };

  const deleteTrade = async (id: string) => {
    await supabase.from("trade_ledger").update({ status: "cancelled" }).eq("id", id);
    void loadData();
    toast.success("Trade cancelled.");
  };

  const totalBalance = accounts.reduce((s, a) => s + (a.balance_usd ?? 0), 0);
  const openPnl = openTrades.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const realizedToday = closedTrades
    .filter((t) => t.closed_at && new Date(t.closed_at) >= todayStart)
    .reduce((s, t) => s + (t.pnl_usd ?? 0), 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary font-display animate-pulse-glow tracking-widest text-sm">LOADING</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-sm font-display tracking-widest text-primary uppercase">Positions</h1>
          <p className="text-xs text-muted-foreground/60 mt-0.5">Open trades · P&L · Account balances</p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowForm((v) => !v)}
          className="bg-accent/10 text-accent hover:bg-accent/20 border border-accent/30 font-display tracking-wider"
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Log Trade
        </Button>
      </div>

      {/* Broker API notice */}
      {accounts.length === 0 && (
        <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-primary/20 bg-primary/5 text-xs text-primary/80">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Broker connections (IBKR · OANDA · Alpaca) wire up in Phase 2.
            Log manual trades now — live sync activates when MCP servers are running.
          </span>
        </div>
      )}

      {/* Pending trade approvals */}
      {pendingApprovals.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-xs font-display tracking-widest text-amber-400 uppercase">Pending Approval</span>
          </div>
          {pendingApprovals.map((a) => (
            <div key={a.id} className="glass-card px-4 py-3 border-amber-400/20 bg-amber-400/5 space-y-2">
              <p className="text-sm text-foreground/90 leading-snug">{a.message}</p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => approveAlert(a.id)}
                  className="h-7 text-xs gap-1.5 bg-green-500/15 text-green-400 hover:bg-green-500/25 border border-green-500/30"
                  variant="outline"
                >
                  <CheckCircle className="h-3 w-3" /> Approve
                </Button>
                <Button
                  size="sm"
                  onClick={() => declineAlert(a.id, a.message)}
                  className="h-7 text-xs gap-1.5 bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30"
                  variant="outline"
                >
                  <XCircle className="h-3 w-3" /> Decline
                </Button>
                <span className="text-[10px] text-muted-foreground/40 ml-auto">
                  {new Date(a.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Portfolio stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Capital", value: totalBalance > 0 ? fmt(totalBalance) : "—", sub: `${accounts.length} account${accounts.length !== 1 ? "s" : ""}` },
          { label: "Open P&L", value: openTrades.length > 0 ? fmtPnl(openPnl) : "—", pnl: openPnl, sub: `${openTrades.length} position${openTrades.length !== 1 ? "s" : ""}` },
          { label: "Today Realized", value: realizedToday !== 0 ? fmtPnl(realizedToday) : "—", pnl: realizedToday, sub: "closed today" },
        ].map((s) => (
          <div key={s.label} className="glass-card p-4 text-center space-y-1">
            <div className={`text-xl font-display ${s.pnl != null ? (s.pnl >= 0 ? "text-green-400" : "text-red-400") : "text-primary"}`}>
              {s.value}
            </div>
            <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">{s.label}</div>
            <div className="text-[10px] text-muted-foreground/40">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Account balances */}
      {accounts.length > 0 && (
        <div className="glass-card p-4 space-y-2">
          <p className="text-[10px] font-display tracking-widest text-primary uppercase">Accounts</p>
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between py-1.5 border-t border-border/10 first:border-0">
              <div>
                <span className="text-sm font-display uppercase text-foreground">{a.broker}</span>
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-border/30 text-muted-foreground capitalize">{a.account_type}</span>
              </div>
              <div className="text-right">
                <div className="text-sm font-display text-primary">{a.balance_usd != null ? fmt(a.balance_usd) : "—"}</div>
                {a.buying_power_usd != null && (
                  <div className="text-[10px] text-muted-foreground/40">{fmt(a.buying_power_usd)} buying power</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Manual trade form */}
      {showForm && (
        <div className="glass-card p-4 space-y-3">
          <p className="text-[10px] font-display tracking-widest text-accent uppercase">Log Trade</p>
          <div className="grid grid-cols-3 gap-2">
            <Input placeholder="Symbol" value={tSymbol} onChange={(e) => setTSymbol(e.target.value)} className="bg-secondary/30 border-border/30" />
            <select value={tClass} onChange={(e) => setTClass(e.target.value)} className="bg-secondary/30 border border-border/30 rounded-md px-3 py-2 text-sm text-foreground capitalize">
              {ASSET_CLASSES.map((c) => <option key={c} value={c} className="bg-background capitalize">{c}</option>)}
            </select>
            <select value={tBroker} onChange={(e) => setTBroker(e.target.value)} className="bg-secondary/30 border border-border/30 rounded-md px-3 py-2 text-sm text-foreground uppercase">
              {BROKERS.map((b) => <option key={b} value={b} className="bg-background uppercase">{b}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="flex rounded-md overflow-hidden border border-border/30">
              {(["long", "short"] as const).map((d) => (
                <button key={d} onClick={() => setTDir(d)} className={`flex-1 py-2 text-sm font-display capitalize transition-colors ${tDir === d ? "bg-accent text-accent-foreground" : "bg-secondary/30 text-muted-foreground hover:bg-secondary/50"}`}>{d}</button>
              ))}
            </div>
            <Input placeholder="Entry price" type="number" value={tEntry} onChange={(e) => setTEntry(e.target.value)} className="bg-secondary/30 border-border/30" />
            <Input placeholder="Quantity / lots" type="number" value={tQty} onChange={(e) => setTQty(e.target.value)} className="bg-secondary/30 border-border/30" />
          </div>
          <Input placeholder="Trade thesis (optional)" value={tThesis} onChange={(e) => setTThesis(e.target.value)} className="bg-secondary/30 border-border/30" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button size="sm" onClick={addTrade} disabled={adding || !tSymbol.trim() || !tEntry || !tQty} className="bg-accent text-accent-foreground hover:bg-accent/90 font-display tracking-wider">
              {adding ? "Logging…" : "Log"}
            </Button>
          </div>
        </div>
      )}

      {/* Open / Closed tabs */}
      <div className="flex gap-1">
        {(["open", "closed"] as const).map((t) => (
          <button key={t} onClick={() => setActiveTab(t)} className={`text-xs px-4 py-1.5 rounded-full border capitalize transition-colors ${activeTab === t ? "border-accent/60 bg-accent/10 text-accent" : "border-border/40 text-muted-foreground hover:border-border/70"}`}>
            {t} {t === "open" ? `(${openTrades.length})` : `(${closedTrades.length})`}
          </button>
        ))}
      </div>

      {/* Trade list */}
      {activeTab === "open" ? (
        openTrades.length === 0 ? (
          <div className="glass-card p-8 text-center space-y-2">
            <TrendingUp className="h-8 w-8 text-muted-foreground/30 mx-auto" />
            <p className="text-sm text-muted-foreground/50">No open positions. Log a trade or connect your broker accounts.</p>
          </div>
        ) : (
          <div className="glass-card divide-y divide-border/10">
            {openTrades.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-4 py-3 group">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-display text-foreground">{t.symbol}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-display uppercase ${t.direction === "long" ? "text-green-400 border-green-400/30 bg-green-400/5" : "text-red-400 border-red-400/30 bg-red-400/5"}`}>
                      {t.direction}
                    </span>
                    <span className="text-[10px] text-muted-foreground/40 uppercase">{t.broker}</span>
                  </div>
                  {t.thesis && <p className="text-[10px] text-muted-foreground/50 mt-0.5 truncate">{t.thesis}</p>}
                  <div className="text-[10px] text-muted-foreground/40 mt-0.5">
                    Entry {t.entry_price} · Qty {t.quantity} · {new Date(t.opened_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  {t.pnl_usd != null && (
                    <div className={`text-sm font-display ${t.pnl_usd >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {fmtPnl(t.pnl_usd)}
                    </div>
                  )}
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                  <button onClick={() => closeTrade(t.id, t.symbol)} className="text-xs px-2 py-0.5 rounded border border-green-500/30 text-green-400 hover:bg-green-400/10">Close</button>
                  <button onClick={() => deleteTrade(t.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        closedTrades.length === 0 ? (
          <div className="glass-card p-8 text-center">
            <TrendingDown className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground/50">No closed trades yet.</p>
          </div>
        ) : (
          <div className="glass-card divide-y divide-border/10">
            {closedTrades.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-display text-foreground/80">{t.symbol}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-display uppercase ${t.direction === "long" ? "text-green-400/50 border-green-400/20" : "text-red-400/50 border-red-400/20"}`}>
                      {t.direction}
                    </span>
                    <span className="text-[10px] text-muted-foreground/30 uppercase">{t.broker}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground/40 mt-0.5">
                    {t.entry_price} → {t.exit_price ?? "—"} · {t.closed_at ? new Date(t.closed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}
                  </div>
                </div>
                <div className={`text-sm font-display shrink-0 ${(t.pnl_usd ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {fmtPnl(t.pnl_usd)}
                </div>
              </div>
            ))}
          </div>
        )
      )}

    </div>
  );
};

export default PositionsPage;
