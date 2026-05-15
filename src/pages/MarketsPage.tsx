import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Plus, Trash2, LineChart, AlertCircle } from "lucide-react";

type WatchlistRow = {
  id: string;
  symbol: string;
  asset_class: string;
  display_name: string | null;
  notes: string | null;
  alert_price_high: number | null;
  alert_price_low: number | null;
  created_at: string;
};

const ASSET_CLASSES = ["forex", "equity", "crypto", "options", "futures"];

const CLASS_COLORS: Record<string, string> = {
  forex: "text-blue-400 border-blue-400/30 bg-blue-400/5",
  equity: "text-green-400 border-green-400/30 bg-green-400/5",
  crypto: "text-purple-400 border-purple-400/30 bg-purple-400/5",
  options: "text-amber-400 border-amber-400/30 bg-amber-400/5",
  futures: "text-orange-400 border-orange-400/30 bg-orange-400/5",
};

const FOREX_MAJORS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD",
  "USD/CAD", "NZD/USD", "USD/CHF", "EUR/GBP",
];

const MarketsPage = () => {
  const { user } = useAuth();
  const [watchlist, setWatchlist] = useState<WatchlistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterClass, setFilterClass] = useState<string>("");

  const [showForm, setShowForm] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [assetClass, setAssetClass] = useState("equity");
  const [displayName, setDisplayName] = useState("");
  const [notes, setNotes] = useState("");
  const [alertHigh, setAlertHigh] = useState("");
  const [alertLow, setAlertLow] = useState("");
  const [adding, setAdding] = useState(false);

  const loadWatchlist = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("market_watchlist")
      .select("id, symbol, asset_class, display_name, notes, alert_price_high, alert_price_low, created_at")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    setWatchlist((data ?? []) as WatchlistRow[]);
    setLoading(false);
  }, [user]);

  useEffect(() => { void loadWatchlist(); }, [loadWatchlist]);

  const addToWatchlist = async () => {
    if (!symbol.trim() || !assetClass) return;
    setAdding(true);
    try {
      await supabase.from("market_watchlist").insert({
        user_id: user!.id,
        symbol: symbol.trim().toUpperCase(),
        asset_class: assetClass,
        display_name: displayName.trim() || null,
        notes: notes.trim() || null,
        alert_price_high: alertHigh ? parseFloat(alertHigh) : null,
        alert_price_low: alertLow ? parseFloat(alertLow) : null,
      });
      setSymbol(""); setDisplayName(""); setNotes(""); setAlertHigh(""); setAlertLow("");
      setShowForm(false);
      void loadWatchlist();
      toast.success(`${symbol.toUpperCase()} added to watchlist.`);
    } catch (e: any) {
      toast.error(e?.message?.includes("unique") ? "Already on watchlist." : "Failed to add symbol.");
    } finally {
      setAdding(false);
    }
  };

  const removeFromWatchlist = async (id: string, sym: string) => {
    await supabase.from("market_watchlist").update({ is_active: false }).eq("id", id);
    setWatchlist((prev) => prev.filter((w) => w.id !== id));
    toast.success(`${sym} removed.`);
  };

  const filtered = filterClass
    ? watchlist.filter((w) => w.asset_class === filterClass)
    : watchlist;

  const byClass = ASSET_CLASSES.reduce<Record<string, number>>((acc, c) => {
    acc[c] = watchlist.filter((w) => w.asset_class === c).length;
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary font-display animate-pulse-glow tracking-widest text-sm">LOADING</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-sm font-display tracking-widest text-primary uppercase">Markets</h1>
          <p className="text-xs text-muted-foreground/60 mt-0.5">Watchlist · Research Queue · Universe</p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowForm((v) => !v)}
          className="bg-accent/10 text-accent hover:bg-accent/20 border border-accent/30 font-display tracking-wider"
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Symbol
        </Button>
      </div>

      {/* Live data notice */}
      <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-primary/20 bg-primary/5 text-xs text-primary/80">
        <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Live prices connect in Phase 2 (OANDA · Alpha Vantage · CoinGecko).
          Add your watchlist now — Atlas will begin monitoring once APIs are wired.
        </span>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="glass-card p-4 space-y-3">
          <p className="text-[10px] font-display tracking-widest text-accent uppercase">Add to Watchlist</p>
          <div className="grid grid-cols-2 gap-2">
            <Input
              placeholder="Symbol (e.g. EUR/USD, NVDA, BTC)"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addToWatchlist()}
              className="bg-secondary/30 border-border/30"
            />
            <select
              value={assetClass}
              onChange={(e) => setAssetClass(e.target.value)}
              className="bg-secondary/30 border border-border/30 rounded-md px-3 py-2 text-sm text-foreground capitalize"
            >
              {ASSET_CLASSES.map((c) => (
                <option key={c} value={c} className="bg-background capitalize">{c}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              placeholder="Display name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="bg-secondary/30 border-border/30"
            />
            <Input
              placeholder="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="bg-secondary/30 border-border/30"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              placeholder="Alert above price"
              type="number"
              value={alertHigh}
              onChange={(e) => setAlertHigh(e.target.value)}
              className="bg-secondary/30 border-border/30"
            />
            <Input
              placeholder="Alert below price"
              type="number"
              value={alertLow}
              onChange={(e) => setAlertLow(e.target.value)}
              className="bg-secondary/30 border-border/30"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button
              size="sm"
              onClick={addToWatchlist}
              disabled={adding || !symbol.trim()}
              className="bg-accent text-accent-foreground hover:bg-accent/90 font-display tracking-wider"
            >
              {adding ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>
      )}

      {/* Asset class filter */}
      {watchlist.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setFilterClass("")}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${
              !filterClass
                ? "border-accent/60 bg-accent/10 text-accent"
                : "border-border/40 text-muted-foreground hover:border-border/70"
            }`}
          >
            All ({watchlist.length})
          </button>
          {ASSET_CLASSES.filter((c) => byClass[c] > 0).map((c) => (
            <button
              key={c}
              onClick={() => setFilterClass(filterClass === c ? "" : c)}
              className={`text-xs px-3 py-1 rounded-full border capitalize transition-colors ${
                filterClass === c
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-border/40 text-muted-foreground hover:border-border/70"
              }`}
            >
              {c} ({byClass[c]})
            </button>
          ))}
        </div>
      )}

      {/* Watchlist grid */}
      {filtered.length === 0 ? (
        <div className="glass-card p-8 text-center space-y-3">
          <LineChart className="h-8 w-8 text-muted-foreground/30 mx-auto" />
          <p className="text-sm text-muted-foreground/50">
            {filterClass ? `No ${filterClass} symbols on watchlist.` : "Watchlist is empty. Add your first symbol above."}
          </p>
          {!filterClass && (
            <div className="pt-2 space-y-1">
              <p className="text-[10px] text-muted-foreground/40 font-display tracking-widest uppercase">Approved Forex Pairs</p>
              <div className="flex flex-wrap gap-1.5 justify-center">
                {FOREX_MAJORS.map((pair) => (
                  <span key={pair} className="text-xs px-2 py-0.5 rounded border border-blue-400/20 text-blue-400/60">
                    {pair}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="glass-card divide-y divide-border/10">
          {filtered.map((w) => (
            <div key={w.id} className="flex items-center gap-3 px-4 py-3 group">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-display text-foreground">{w.symbol}</span>
                  {w.display_name && (
                    <span className="text-xs text-muted-foreground/60">{w.display_name}</span>
                  )}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border capitalize ${CLASS_COLORS[w.asset_class] ?? "text-muted-foreground border-border/30"}`}>
                    {w.asset_class}
                  </span>
                </div>
                {w.notes && (
                  <p className="text-[10px] text-muted-foreground/50 mt-0.5 truncate">{w.notes}</p>
                )}
                {(w.alert_price_high || w.alert_price_low) && (
                  <div className="text-[10px] text-muted-foreground/40 mt-0.5">
                    {w.alert_price_high && `↑ ${w.alert_price_high}`}
                    {w.alert_price_high && w.alert_price_low && " · "}
                    {w.alert_price_low && `↓ ${w.alert_price_low}`}
                  </div>
                )}
              </div>
              {/* Price placeholder — live data in Phase 2 */}
              <div className="text-right shrink-0">
                <div className="text-xs text-muted-foreground/30 font-display">—</div>
                <div className="text-[10px] text-muted-foreground/20">no feed</div>
              </div>
              <button
                onClick={() => removeFromWatchlist(w.id, w.symbol)}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Forex universe quick-reference */}
      <div className="glass-card p-4 space-y-3">
        <p className="text-[10px] font-display tracking-widest text-primary uppercase">Approved Forex Universe</p>
        <div className="grid grid-cols-4 gap-2">
          {FOREX_MAJORS.map((pair) => (
            <div key={pair} className="text-center py-2 rounded-lg border border-blue-400/10 bg-blue-400/3">
              <div className="text-xs font-display text-blue-400/80">{pair}</div>
              <div className="text-[10px] text-muted-foreground/30 mt-0.5">—</div>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground/30">
          Live streaming via OANDA · Phase 2
        </p>
      </div>

    </div>
  );
};

export default MarketsPage;
