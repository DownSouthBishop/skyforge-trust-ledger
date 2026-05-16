import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Home, TrendingUp, FileText, Key, Plus, X, RefreshCw } from "lucide-react";

type Property = {
  id: string;
  address: string;
  city: string;
  state: string;
  property_type: string;
  current_value: number | null;
  mortgage_balance: number | null;
  mortgage_payment_monthly: number | null;
  gross_rent_monthly: number | null;
  status: string;
};

type PipelineDeal = {
  id: string;
  address: string;
  city: string;
  state: string;
  property_type: string;
  list_price: number | null;
  cap_rate: number | null;
  cash_on_cash_return: number | null;
  stage: string;
  notes: string | null;
  created_at: string;
};

type Lease = {
  id: string;
  property_id: string;
  tenant_name: string;
  tenant_email: string | null;
  lease_start: string;
  lease_end: string;
  monthly_rent: number;
  status: string;
  renewal_offered: boolean;
};

type Brief = {
  id: string;
  title: string;
  content: string;
  created_at: string;
};

const fmt = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1000
    ? `$${(n / 1000).toFixed(1)}k`
    : `$${n.toLocaleString()}`;

const PIPELINE_STAGES: Record<string, string> = {
  analyzing: "Analyzing",
  offer_pending: "Offer Pending",
  under_contract: "Under Contract",
  due_diligence: "Due Diligence",
  closed: "Closed",
  passed: "Passed",
};

const STAGE_ORDER = ["analyzing", "offer_pending", "under_contract", "due_diligence", "closed", "passed"];

const RealEstatePage = () => {
  const { user } = useAuth();
  const [tab, setTab] = useState<"portfolio" | "pipeline" | "leases" | "brief">("portfolio");

  const [portfolio, setPortfolio] = useState<Property[]>([]);
  const [pipeline, setPipeline] = useState<PipelineDeal[]>([]);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);

  // Add property form
  const [showAddProperty, setShowAddProperty] = useState(false);
  const [propAddress, setPropAddress] = useState("");
  const [propCity, setPropCity] = useState("");
  const [propState, setPropState] = useState("");
  const [propType, setPropType] = useState("sfr");
  const [propValue, setPropValue] = useState("");
  const [propMortgage, setPropMortgage] = useState("");
  const [propMortgagePmt, setPropMortgagePmt] = useState("");
  const [propRent, setPropRent] = useState("");
  const [addingProperty, setAddingProperty] = useState(false);

  // RE brief
  const [runningBrief, setRunningBrief] = useState(false);

  const loadData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [portRes, pipeRes, leaseRes, briefRes] = await Promise.all([
        supabase
          .from("property_portfolio")
          .select("id,address,city,state,property_type,current_value,mortgage_balance,mortgage_payment_monthly,gross_rent_monthly,status")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("property_pipeline")
          .select("id,address,city,state,property_type,list_price,cap_rate,cash_on_cash_return,stage,notes,created_at")
          .eq("user_id", user.id)
          .not("stage", "in", "(closed,passed)")
          .order("created_at", { ascending: false }),
        supabase
          .from("lease_tracker")
          .select("id,property_id,tenant_name,tenant_email,lease_start,lease_end,monthly_rent,status,renewal_offered")
          .eq("user_id", user.id)
          .eq("status", "active")
          .order("lease_end", { ascending: true }),
        supabase
          .from("research_notes")
          .select("id,title,content,created_at")
          .eq("user_id", user.id)
          .ilike("title", "%Real Estate Brief%")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      setPortfolio((portRes.data ?? []) as Property[]);
      setPipeline((pipeRes.data ?? []) as PipelineDeal[]);
      setLeases((leaseRes.data ?? []) as Lease[]);
      setBrief(briefRes.data as Brief | null);
    } catch (e) {
      console.error("RE load failed", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void loadData(); }, [loadData]);

  const addProperty = async () => {
    if (!propAddress.trim()) return;
    setAddingProperty(true);
    try {
      await supabase.from("property_portfolio").insert({
        user_id: user!.id,
        address: propAddress.trim(),
        city: propCity.trim() || null,
        state: propState.trim() || null,
        property_type: propType,
        current_value: parseFloat(propValue) || null,
        mortgage_balance: parseFloat(propMortgage) || null,
        mortgage_payment_monthly: parseFloat(propMortgagePmt) || null,
        gross_rent_monthly: parseFloat(propRent) || null,
        status: "active",
      });
      setPropAddress(""); setPropCity(""); setPropState(""); setPropType("sfr");
      setPropValue(""); setPropMortgage(""); setPropMortgagePmt(""); setPropRent("");
      setShowAddProperty(false);
      toast.success("Property added.");
      void loadData();
    } catch (e) {
      console.error("add property failed", e);
      toast.error("Failed to add property.");
    } finally {
      setAddingProperty(false);
    }
  };

  const advanceDeal = async (id: string, currentStage: string) => {
    const next = STAGE_ORDER[STAGE_ORDER.indexOf(currentStage) + 1];
    if (!next) return;
    await supabase.from("property_pipeline").update({ stage: next }).eq("id", id);
    void loadData();
  };

  const handleRunBrief = async () => {
    setRunningBrief(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/atlas_re_brief`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ user_id: user!.id }),
        },
      );
      if (!res.ok) throw new Error("brief failed");
      toast.success("RE brief generated — check the Brief tab.");
      void loadData();
    } catch {
      toast.error("Brief failed. Try again.");
    } finally {
      setRunningBrief(false);
    }
  };

  const totalValue = portfolio.reduce((s, p) => s + Number(p.current_value ?? 0), 0);
  const totalMortgage = portfolio.reduce((s, p) => s + Number(p.mortgage_balance ?? 0), 0);
  const totalEquity = totalValue - totalMortgage;
  const monthlyRent = portfolio.reduce((s, p) => s + Number(p.gross_rent_monthly ?? 0), 0);
  const monthlyDebt = portfolio.reduce((s, p) => s + Number(p.mortgage_payment_monthly ?? 0), 0);

  const expiringLeases = leases.filter((l) => {
    const daysLeft = Math.ceil((new Date(l.lease_end).getTime() - Date.now()) / 86400000);
    return daysLeft <= 90;
  });

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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-lg tracking-widest text-primary uppercase">Real Estate</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {portfolio.length} properties · {fmt(totalEquity)} equity
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRunBrief}
          disabled={runningBrief}
          className="shrink-0 text-xs gap-1.5 border-primary/30 text-primary/70 hover:text-primary hover:border-primary/60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${runningBrief ? "animate-spin" : ""}`} />
          {runningBrief ? "Running…" : "Run Brief"}
        </Button>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="glass-card p-3 text-center space-y-0.5">
          <div className="text-lg font-display text-primary">{portfolio.length > 0 ? fmt(totalValue) : "—"}</div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Portfolio Value</div>
        </div>
        <div className="glass-card p-3 text-center space-y-0.5">
          <div className="text-lg font-display text-green-400">{totalEquity > 0 ? fmt(totalEquity) : "—"}</div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Total Equity</div>
        </div>
        <div className="glass-card p-3 text-center space-y-0.5">
          <div className="text-lg font-display text-primary">{monthlyRent > 0 ? fmt(monthlyRent) : "—"}</div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Gross Rent/Mo</div>
        </div>
        <div className="glass-card p-3 text-center space-y-0.5">
          <div className={`text-lg font-display ${(monthlyRent - monthlyDebt) >= 0 ? "text-green-400" : "text-red-400"}`}>
            {monthlyRent > 0 || monthlyDebt > 0 ? fmt(monthlyRent - monthlyDebt) : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Net CF/Mo</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border/30">
        {(["portfolio", "pipeline", "leases", "brief"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-display tracking-widest uppercase transition-colors ${
              tab === t
                ? "text-accent border-b-2 border-accent"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
            {t === "leases" && expiringLeases.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-accent/20 text-accent text-[9px]">
                {expiringLeases.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Portfolio Tab */}
      {tab === "portfolio" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowAddProperty((v) => !v)}
              className="text-xs gap-1.5 border-primary/30 text-primary/70 hover:text-primary hover:border-primary/60"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Property
            </Button>
          </div>

          {showAddProperty && (
            <div className="glass-card p-4 space-y-3">
              <div className="text-xs font-display tracking-widest text-accent uppercase">New Property</div>
              <Input placeholder="Address" value={propAddress} onChange={(e) => setPropAddress(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="City" value={propCity} onChange={(e) => setPropCity(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
                <Input placeholder="State" value={propState} onChange={(e) => setPropState(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={propType}
                  onChange={(e) => setPropType(e.target.value)}
                  className="bg-secondary/30 border border-border/30 rounded-md text-sm px-3 py-2 text-foreground"
                >
                  <option value="sfr">SFR</option>
                  <option value="multi">Multi-Family</option>
                  <option value="commercial">Commercial</option>
                  <option value="land">Land</option>
                </select>
                <Input placeholder="Current value ($)" type="number" value={propValue} onChange={(e) => setPropValue(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Input placeholder="Mortgage balance ($)" type="number" value={propMortgage} onChange={(e) => setPropMortgage(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
                <Input placeholder="Monthly payment ($)" type="number" value={propMortgagePmt} onChange={(e) => setPropMortgagePmt(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
                <Input placeholder="Gross rent/mo ($)" type="number" value={propRent} onChange={(e) => setPropRent(e.target.value)} className="bg-secondary/30 border-border/30 text-sm" />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowAddProperty(false)}>Cancel</Button>
                <Button size="sm" onClick={addProperty} disabled={addingProperty || !propAddress.trim()} className="bg-primary/20 text-primary hover:bg-primary/30">Add</Button>
              </div>
            </div>
          )}

          {portfolio.length === 0 ? (
            <div className="glass-card p-8 text-center text-muted-foreground/50 text-sm">
              No properties yet. Add your first property above.
            </div>
          ) : (
            <div className="space-y-3">
              {portfolio.map((p) => {
                const equity = Number(p.current_value ?? 0) - Number(p.mortgage_balance ?? 0);
                const ltv = p.current_value ? ((Number(p.mortgage_balance ?? 0) / Number(p.current_value)) * 100).toFixed(0) : null;
                return (
                  <div key={p.id} className="glass-card p-4 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <Home className="h-3.5 w-3.5 text-accent shrink-0" />
                          <span className="text-sm font-medium">{p.address}</span>
                        </div>
                        {(p.city || p.state) && (
                          <div className="text-xs text-muted-foreground/60 mt-0.5 ml-5.5">
                            {[p.city, p.state].filter(Boolean).join(", ")} · {p.property_type?.toUpperCase()}
                          </div>
                        )}
                      </div>
                      <span className="text-[10px] px-2 py-0.5 rounded-full border border-green-400/30 text-green-400 font-display uppercase shrink-0">
                        {p.status}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1 border-t border-border/10">
                      <div>
                        <div className="text-xs font-display text-foreground/80">{p.current_value ? fmt(Number(p.current_value)) : "—"}</div>
                        <div className="text-[10px] text-muted-foreground/50">Value</div>
                      </div>
                      <div>
                        <div className={`text-xs font-display ${equity > 0 ? "text-green-400" : "text-red-400"}`}>{fmt(equity)}</div>
                        <div className="text-[10px] text-muted-foreground/50">Equity {ltv ? `(${ltv}% LTV)` : ""}</div>
                      </div>
                      <div>
                        <div className="text-xs font-display text-foreground/80">{p.gross_rent_monthly ? fmt(Number(p.gross_rent_monthly)) : "—"}</div>
                        <div className="text-[10px] text-muted-foreground/50">Gross Rent/Mo</div>
                      </div>
                      <div>
                        <div className="text-xs font-display text-foreground/80">{p.mortgage_payment_monthly ? fmt(Number(p.mortgage_payment_monthly)) : "—"}</div>
                        <div className="text-[10px] text-muted-foreground/50">Debt Service/Mo</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Pipeline Tab */}
      {tab === "pipeline" && (
        <div className="space-y-3">
          {pipeline.length === 0 ? (
            <div className="glass-card p-8 text-center text-muted-foreground/50 text-sm">
              No active deals in pipeline. Atlas deal scan runs daily.
            </div>
          ) : (
            pipeline.map((deal) => (
              <div key={deal.id} className="glass-card p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-3.5 w-3.5 text-accent shrink-0" />
                      <span className="text-sm font-medium">{deal.address}</span>
                    </div>
                    {(deal.city || deal.state) && (
                      <div className="text-xs text-muted-foreground/60 mt-0.5 ml-5.5">
                        {[deal.city, deal.state].filter(Boolean).join(", ")} · {deal.property_type?.toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(() => {
                      const match = deal.notes?.match(/Atlas score:\s*(\d+)/i);
                      const score = match ? parseInt(match[1]) : null;
                      return score != null ? (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-display ${
                          score >= 8 ? "border-green-400/30 text-green-400" :
                          score >= 6 ? "border-accent/30 text-accent" :
                          "border-border/40 text-muted-foreground"
                        }`}>
                          {score}/10
                        </span>
                      ) : null;
                    })()}
                    <span className="text-[10px] px-2 py-0.5 rounded-full border border-primary/30 text-primary font-display uppercase">
                      {PIPELINE_STAGES[deal.stage] ?? deal.stage}
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3 pt-1 border-t border-border/10">
                  <div>
                    <div className="text-xs font-display text-foreground/80">{deal.list_price ? fmt(Number(deal.list_price)) : "—"}</div>
                    <div className="text-[10px] text-muted-foreground/50">List</div>
                  </div>
                  <div>
                    <div className="text-xs font-display text-foreground/80">{deal.cap_rate != null ? `${Number(deal.cap_rate).toFixed(1)}%` : "—"}</div>
                    <div className="text-[10px] text-muted-foreground/50">Cap Rate</div>
                  </div>
                  <div>
                    <div className="text-xs font-display text-foreground/80">{deal.cash_on_cash_return != null ? `${Number(deal.cash_on_cash_return).toFixed(1)}%` : "—"}</div>
                    <div className="text-[10px] text-muted-foreground/50">CoC Return</div>
                  </div>
                </div>
                {!["closed", "passed"].includes(deal.stage) && (
                  <div className="flex justify-end">
                    <button
                      onClick={() => advanceDeal(deal.id, deal.stage)}
                      className="text-[10px] px-2 py-0.5 rounded-full border border-border/40 text-muted-foreground hover:border-accent/40 hover:text-accent transition-colors"
                    >
                      Advance →
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Leases Tab */}
      {tab === "leases" && (
        <div className="space-y-3">
          {expiringLeases.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-accent/30 bg-accent/5 text-accent text-xs">
              <Key className="h-3.5 w-3.5 shrink-0" />
              {expiringLeases.length} lease{expiringLeases.length > 1 ? "s" : ""} expiring within 90 days
            </div>
          )}
          {leases.length === 0 ? (
            <div className="glass-card p-8 text-center text-muted-foreground/50 text-sm">
              No active leases tracked. Add leases via Supabase or ask Atlas to monitor your portfolio.
            </div>
          ) : (
            leases.map((lease) => {
              const daysLeft = Math.ceil((new Date(lease.lease_end).getTime() - Date.now()) / 86400000);
              const isExpiring = daysLeft <= 90;
              return (
                <div key={lease.id} className={`glass-card p-4 space-y-2 ${isExpiring ? "border-accent/20" : ""}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">{lease.tenant_name}</div>
                      {lease.tenant_email && (
                        <div className="text-xs text-muted-foreground/60">{lease.tenant_email}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {isExpiring && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full border border-accent/30 text-accent font-display">
                          {daysLeft}d left
                        </span>
                      )}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border font-display ${
                        lease.renewal_offered ? "border-green-400/30 text-green-400" : "border-border/40 text-muted-foreground"
                      }`}>
                        {lease.renewal_offered ? "Renewal Offered" : "No Renewal Yet"}
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3 pt-1 border-t border-border/10">
                    <div>
                      <div className="text-xs font-display text-foreground/80">{fmt(Number(lease.monthly_rent))}/mo</div>
                      <div className="text-[10px] text-muted-foreground/50">Rent</div>
                    </div>
                    <div>
                      <div className="text-xs font-display text-foreground/80">{lease.lease_start}</div>
                      <div className="text-[10px] text-muted-foreground/50">Start</div>
                    </div>
                    <div>
                      <div className={`text-xs font-display ${isExpiring ? "text-accent" : "text-foreground/80"}`}>{lease.lease_end}</div>
                      <div className="text-[10px] text-muted-foreground/50">End</div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Brief Tab */}
      {tab === "brief" && (
        <div className="space-y-4">
          {brief ? (
            <div className="glass-card p-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <FileText className="h-3.5 w-3.5 text-accent" />
                  <span className="text-xs font-display tracking-widest text-accent uppercase">{brief.title}</span>
                </div>
                <span className="text-[10px] text-muted-foreground/50">
                  {new Date(brief.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                </span>
              </div>
              <div className="prose prose-invert prose-sm max-w-none text-foreground/80 text-sm leading-relaxed whitespace-pre-wrap border-t border-border/20 pt-3">
                {brief.content}
              </div>
            </div>
          ) : (
            <div className="glass-card p-8 text-center space-y-3">
              <FileText className="h-8 w-8 text-muted-foreground/30 mx-auto" />
              <p className="text-sm text-muted-foreground/50">No RE brief yet.</p>
              <Button
                size="sm"
                onClick={handleRunBrief}
                disabled={runningBrief}
                className="bg-primary/20 text-primary hover:bg-primary/30 text-xs"
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${runningBrief ? "animate-spin" : ""}`} />
                {runningBrief ? "Running…" : "Generate Brief"}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Dismiss icon for add form */}
      {showAddProperty && (
        <button
          onClick={() => setShowAddProperty(false)}
          className="fixed bottom-6 right-6 p-2 rounded-full bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
};

export default RealEstatePage;
