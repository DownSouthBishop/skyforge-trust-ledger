import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { TrendingUp, TrendingDown, Plus, Trash2, CheckCircle, XCircle, Bell, Loader2 } from "lucide-react";

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

type PendingDecision = {
  id: string;
  decision_type: string;
  recommendation: Record<string, unknown>;
  business_context: string | null;
  created_at: string;
};

const BROKERS       = ["ibkr", "oanda", "alpaca", "manual"];
const ASSET_CLASSES = ["forex", "equity", "crypto", "options", "futures"];

const fmt     = (n: number) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmtPnl  = (n: number | null) => n == null ? "—" : `${n >= 0 ? "+" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmtPx   = (price: number | null | undefined, cls: string) => price == null ? "—" : cls === "forex" ? price.toFixed(5) : price.toFixed(2);

const PositionsPage = () => {
  const { user } = useAuth();
  const [openTrades,       setOpenTrades]      = useState<TradeRow[]>([]);
  const [closedTrades,     setClosedTrades]    = useState<TradeRow[]>([]);
  const [accounts,         setAccounts]        = useState<AccountRow[]>([]);
  const [pendingDecisions, setPendingDecisions] = useState<PendingDecision[]>([]);
  const [unrealizedPnl,    setUnrealizedPnl]   = useState<Record<string, number>>({});
  const [livePrices,       setLivePrices]      = useState<Record<string, number | null>>({});
  const [priceLoading,     setPriceLoading]    = useState(false);
  const [loading,          setLoading]         = useState(true);
  const [activeTab,        setActiveTab]       = useState<"open" | "closed">("open");

  const [showForm, setShowForm] = useState(false);
  const [tSymbol,  setTSymbol]  = useState("");
  const [tClass,   setTClass]   = useState("equity");
  const [tDir,     setTDir]     = useState<"long" | "short">("long");
  const [tEntry,   setTEntry]   = useState("");
  const [tQty,     setTQty]     = useState("");
  const [tBroker,  setTBroker]  = useState("manual");
  const [tThesis,  setTThesis]  = useState("");
  const [adding,   setAdding]   = useState(false);

  const fetchLivePrices = useCallback(async (trades: TradeRow[]) => {
    if (trades.length === 0) return;
    setPriceLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${"https://hycpzeskartlkybsfkbh.supabase.co"}/functions/v1/atlas-trade`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({
            action: "live_prices",
            symbols: trades.map((t) => ({ symbol: t.symbol, asset_class: t.asset_class })),
          }),
        },
      );
      if (!res.ok) return;
      const data = await res.json();
      const prices = (data?.prices ?? {}) as Record<string, number | null>;
      setLivePrices(prices);
      const unrealized: Record<string, number> = {};
      for (const t of trades) {
        const cur = prices[t.symbol];
        if (cur == null) continue;
        const mult = t.direction === "long" ? 1 : -1;
        unrealized[t.id] = (cur - t.entry_price) * t.quantity * mult;
      }
      setUnrealizedPnl(unrealized);
    } catch {
      // non-critical
    } finally {
      setPriceLoading(false);
    }
  }, []);

  const loadData = useCallback(async () => {
    if (!user) return;
    const [openRes, closedRes, acctRes, decisionsRes] = await Promise.all([
      supabase.from("trade_ledger").select("*").eq("user_id", user.id).eq("status", "open").order("opened_at", { ascending: false }),
      supabase.from("trade_ledger").select("*").eq("user_id", user.id).eq("status", "closed").order("closed_at", { ascending: false }).limit(50),
      supabase.from("trading_accounts").select("id, broker, account_type, balance_usd, buying_power_usd, last_sync_at").eq("user_id", user.id).eq("is_active", true),
      supabase.from("atlas_decision_queue").select("id, decision_type, recommendation, business_context, created_at").eq("status", "PENDING").in("decision_type", ["ORANGE"]).order("created_at", { ascending: false }).limit(10),
    ]);
    const open = (openRes.data ?? []) as TradeRow[];
    setOpenTrades(open);
    setClosedTrades((closedRes.data ?? []) as TradeRow[]);
    setAccounts((acctRes.data ?? []) as AccountRow[]);
    setPendingDecisions((decisionsRes.data ?? []) as PendingDecision[]);
    setLoading(false);
    void fetchLivePrices(open);
  }, [user, fetchLivePrices]);

  useEffect(() => { void loadData(); }, [loadData]);

  const addTrade = async () => {
    const entry = parseFloat(tEntry);
    const qty   = parseFloat(tQty);
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
    } catch {
      toast.error("Failed to log trade.");
    } finally {
      setAdding(false);
    }
  };

  const closeTrade = async (id: string, sym: string) => {
    const exitStr = prompt(`Exit price for ${sym}:`);
    if (!exitStr) return;
    const exit  = parseFloat(exitStr);
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

  const approveDecision = async (decisionId: string) => {
    await supabase.from("atlas_decision_queue").update({ status: "APPROVED", resolved_at: new Date().toISOString() }).eq("id", decisionId);
    setPendingDecisions((prev) => prev.filter((d) => d.id !== decisionId));
    toast.success("Decision approved.");
  };

  const rejectDecision = async (decisionId: string) => {
    await supabase.from("atlas_decision_queue").update({ status: "REJECTED", resolved_at: new Date().toISOString() }).eq("id", decisionId);
    setPendingDecisions((prev) => prev.filter((d) => d.id !== decisionId));
    toast.success("Decision rejected.");
  };

  const cancelTrade = async (id: string) => {
    await supabase.from("trade_ledger").update({ status: "cancelled" }).eq("id", id);
    void loadData();
    toast.success("Trade cancelled.");
  };

  const totalEquity   = accounts.reduce((s, a) => s + (a.balance_usd      ?? 0), 0);
  const totalBuyPow   = accounts.reduce((s, a) => s + (a.buying_power_usd ?? 0), 0);
  const openStoredPnl = openTrades.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
  const liveOpenPnl   = Object.values(unrealizedPnl).reduce((s, v) => s + v, 0);
  const displayPnl    = Object.keys(unrealizedPnl).length > 0 ? liveOpenPnl : openStoredPnl;

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

      {/* Account summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="glass-card p-4 text-center space-y-1">
          <div className="text-xl font-display text-primary">{totalEquity > 0 ? fmt(totalEquity) : "—"}</div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Total Equity</div>
          <div className="text-[10px] text-muted-foreground/40">{accounts.length} account{accounts.length !== 1 ? "s" : ""}</div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className="text-xl font-display text-accent">{totalBuyPow > 0 ? fmt(totalBuyPow) : "—"}</div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Buying Power</div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className={`text-xl font-display ${displayPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
            {openTrades.length > 0 ? fmtPnl(displayPnl) : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Open P&L</div>
          <div className="text-[10px] text-muted-foreground/40 flex items-center justify-center gap-1">
            {priceLoading && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            {openTrades.length} position{openTrades.length !== 1 ? "s" : ""}
          </div>
        </div>
      </div>

      {/* ORANGE decisions pending approval */}
      {pendingDecisions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Bell className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-xs font-display tracking-widest text-amber-400 uppercase">Atlas Awaiting Approval</span>
          </div>
          {pendingDecisions.map((d) => {
            const rec = d.recommendation as Record<string, unknown>;
            const label = rec?.symbol ? `${rec.symbol} — ${rec.action_type ?? d.business_context ?? ""}` : (d.business_context ?? "Decision pending");
            return (
              <div key={d.id} className="glass-card px-4 py-3 border-amber-400/20 bg-amber-400/5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-display tracking-widest text-amber-400 uppercase">{d.decision_type}</span>
                  <span className="text-sm text-foreground/90">{label}</span>
                </div>
                {rec?.rationale && (
                  <p className="text-xs text-muted-foreground/70 leading-snug">{rec.rationale as string}</p>
                )}
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => approveDecision(d.id)} className="h-7 text-xs gap-1.5 bg-green-500/15 text-green-400 hover:bg-green-500/25 border border-green-500/30" variant="outline">
                    <CheckCircle className="h-3 w-3" /> Approve
                  </Button>
                  <Button size="sm" onClick={() => rejectDecision(d.id)} className="h-7 text-xs gap-1.5 bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30" variant="outline">
                    <XCircle className="h-3 w-3" /> Reject
                  </Button>
                  <span className="text-[10px] text-muted-foreground/40 ml-auto">
                    {new Date(d.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
            <select value={tClass} onChange={(e) => setTClass(e.target.value)} className="bg-secondary/30 border border-border/30 rounded-md px-3 py-2 text-sm text-foreground">
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
            <Input placeholder="Entry price"     type="number" value={tEntry} onChange={(e) => setTEntry(e.target.value)} className="bg-secondary/30 border-border/30" />
            <Input placeholder="Quantity / lots" type="number" value={tQty}   onChange={(e) => setTQty(e.target.value)}   className="bg-secondary/30 border-border/30" />
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

      {activeTab === "open" ? (
        openTrades.length === 0 ? (
          <div className="glass-card p-8 text-center space-y-2">
            <TrendingUp className="h-8 w-8 text-muted-foreground/30 mx-auto" />
            <p className="text-sm text-muted-foreground/50">No open positions. Log a trade or connect your broker accounts.</p>
          </div>
        ) : (
          <div className="glass-card divide-y divide-border/10">
            {openTrades.map((t) => {
              const curPrice   = livePrices[t.symbol];
              const unrealized = unrealizedPnl[t.id];
              return (
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
                  <div className="text-right shrink-0 min-w-[72px]">
                    <div className="text-[10px] text-muted-foreground/40">Current</div>
                    <div className="text-sm font-display text-foreground/60">
                      {priceLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : fmtPx(curPrice, t.asset_class)}
                    </div>
                  </div>
                  <div className="text-right shrink-0 min-w-[72px]">
                    <div className="text-[10px] text-muted-foreground/40">Unrealized</div>
                    <div className={`text-sm font-display ${unrealized == null ? "text-muted-foreground/30" : unrealized >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {unrealized != null ? `${unrealized >= 0 ? "+" : ""}$${Math.abs(unrealized).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
                    </div>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                    <button onClick={() => closeTrade(t.id, t.symbol)} className="text-xs px-2 py-0.5 rounded border border-green-500/30 text-green-400 hover:bg-green-400/10">Close</button>
                    <button onClick={() => cancelTrade(t.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
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
