import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { TrendingUp, DollarSign, CheckCircle, XCircle, Briefcase, FileText, BookOpen, Loader2, RefreshCw } from "lucide-react";

type AtlasBusiness = {
  id: string;
  name: string;
  stage: string;
  category: string | null;
  description: string | null;
  initial_capital_usd: number | null;
  monthly_revenue_target_usd: number | null;
  current_monthly_revenue_usd: number | null;
  months_underperforming: number;
  atlas_score: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type AtlasDecision = {
  id: string;
  action_type: string;
  payload: Record<string, unknown>;
  priority: string;
  created_at: string;
};

type LedgerRow = {
  id: string;
  entry_type: string;
  category: string;
  description: string;
  amount_usd: number;
  status: string;
  due_at: string | null;
  recurring: boolean;
};

type BriefRow = {
  id: string;
  title: string;
  content: string;
  created_at: string;
};

const STAGE_COLORS: Record<string, string> = {
  scouting:    "text-blue-400 border-blue-400/30 bg-blue-400/5",
  evaluating:  "text-yellow-400 border-yellow-400/30 bg-yellow-400/5",
  initializing:"text-purple-400 border-purple-400/30 bg-purple-400/5",
  operating:   "text-green-400 border-green-400/30 bg-green-400/5",
  monitoring:  "text-amber-400 border-amber-400/30 bg-amber-400/5",
  completed:   "text-muted-foreground border-border/40",
  rejected:    "text-red-400/50 border-red-400/20",
};

const fmt = (n: number) => `$${n >= 1000 ? (n / 1000).toFixed(1) + "k" : n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const BusinessPage = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<"pipeline" | "decisions" | "ledger" | "brief">("pipeline");

  const [businesses,   setBusinesses]   = useState<AtlasBusiness[]>([]);
  const [decisions,    setDecisions]    = useState<AtlasDecision[]>([]);
  const [ledger,       setLedger]       = useState<LedgerRow[]>([]);
  const [brief,        setBrief]        = useState<BriefRow | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [runningBrief, setRunningBrief] = useState(false);
  const [sendingId,    setSendingId]    = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!user) return;
    try {
      const [bizRes, decRes, ledRes, briefRes] = await Promise.all([
        supabase.from("atlas_business_pipeline").select("*").not("stage", "in", "(completed,rejected)").order("updated_at", { ascending: false }),
        supabase.from("atlas_decision_queue").select("id, action_type, payload, priority, created_at").eq("status", "PENDING_APPROVAL").in("priority", ["ORANGE", "YELLOW"]).order("created_at", { ascending: false }).limit(20),
        supabase.from("business_ledger").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50),
        supabase.from("research_notes").select("id, title, content, created_at").eq("user_id", user.id).like("title", "Business Brief%").order("created_at", { ascending: false }).limit(1),
      ]);
      setBusinesses((bizRes.data ?? []) as AtlasBusiness[]);
      setDecisions((decRes.data ?? []) as AtlasDecision[]);
      setLedger((ledRes.data ?? []) as LedgerRow[]);
      setBrief(((briefRes.data ?? []) as BriefRow[])[0] ?? null);
    } catch (e) {
      console.error("Business data load failed:", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void loadData(); }, [loadData]);

  const runBrief = async () => {
    setRunningBrief(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${"https://hycpzeskartlkybsfkbh.supabase.co"}/functions/v1/atlas-business`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: "brief" }),
        },
      );
      if (!res.ok) throw new Error("brief failed");
      toast.success("Business brief generated.");
      void loadData();
    } catch {
      toast.error("Brief failed. Try again.");
    } finally {
      setRunningBrief(false);
    }
  };

  const approveDecision = async (id: string) => {
    setSendingId(id);
    try {
      await supabase.from("atlas_decision_queue").update({ status: "APPROVED", resolved_at: new Date().toISOString() }).eq("id", id);
      setDecisions((prev) => prev.filter((d) => d.id !== id));
      toast.success("Decision approved.");
    } catch {
      toast.error("Failed to approve.");
    } finally {
      setSendingId(null);
    }
  };

  const rejectDecision = async (id: string) => {
    await supabase.from("atlas_decision_queue").update({ status: "REJECTED", resolved_at: new Date().toISOString() }).eq("id", id);
    setDecisions((prev) => prev.filter((d) => d.id !== id));
    toast.success("Decision rejected.");
  };

  const mtdRevenue  = ledger.filter(e => e.entry_type === "revenue" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
  const mtdExpenses = ledger.filter(e => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount_usd), 0);

  const activeDecisions = decisions.length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-primary font-display animate-pulse-glow tracking-widest text-sm">LOADING</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-sm font-display tracking-widest text-primary uppercase">Business</h1>
          <p className="text-xs text-muted-foreground/60 mt-0.5">Atlas autonomous pipeline · Decisions · Ledger</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={runBrief}
          disabled={runningBrief}
          className="text-xs gap-1.5 border-primary/30 text-primary/70 hover:text-primary hover:border-primary/60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${runningBrief ? "animate-spin" : ""}`} />
          {runningBrief ? "Running…" : "Run Brief"}
        </Button>
      </div>

      {/* Tab nav */}
      <div className="flex gap-1">
        {(["pipeline", "decisions", "ledger", "brief"] as const).map((t) => (
          <button key={t} onClick={() => setActiveTab(t)} className={`text-xs px-4 py-1.5 rounded-full border capitalize transition-colors ${activeTab === t ? "border-accent/60 bg-accent/10 text-accent" : "border-border/40 text-muted-foreground hover:border-border/70"}`}>
            {t}{t === "decisions" && activeDecisions > 0 ? ` (${activeDecisions})` : ""}
          </button>
        ))}
      </div>

      {/* ── Atlas Pipeline ─────────────────────────────────────────────────── */}
      {activeTab === "pipeline" && (
        <div className="space-y-3">
          {businesses.length === 0 ? (
            <div className="glass-card p-8 text-center space-y-3">
              <Briefcase className="h-8 w-8 text-muted-foreground/30 mx-auto" />
              <p className="text-sm text-muted-foreground/50">No businesses in pipeline. Atlas scouts automatically every 2 days.</p>
              <Button size="sm" variant="outline" onClick={async () => {
                const { data: { session } } = await supabase.auth.getSession();
                const res = await fetch(`${"https://hycpzeskartlkybsfkbh.supabase.co"}/functions/v1/atlas-business`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
                  body: JSON.stringify({ action: "scout" }),
                });
                if (res.ok) { toast.success("Scouting cycle launched."); void loadData(); }
                else toast.error("Scout failed.");
              }} className="text-xs border-primary/30 text-primary/70">
                Run Scout Now
              </Button>
            </div>
          ) : (
            businesses.map((b) => {
              const revenueRatio = b.monthly_revenue_target_usd && b.current_monthly_revenue_usd
                ? b.current_monthly_revenue_usd / b.monthly_revenue_target_usd
                : null;
              return (
                <div key={b.id} className="glass-card p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-display text-foreground">{b.name}</span>
                        {b.category && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-border/30 text-muted-foreground capitalize">{b.category}</span>
                        )}
                      </div>
                      {b.description && <p className="text-xs text-muted-foreground/60 mt-0.5 leading-snug">{b.description}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {b.atlas_score != null && (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-display ${b.atlas_score >= 8 ? "border-green-400/30 text-green-400" : b.atlas_score >= 6 ? "border-accent/30 text-accent" : "border-border/40 text-muted-foreground"}`}>
                          {b.atlas_score}/10
                        </span>
                      )}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border font-display uppercase ${STAGE_COLORS[b.stage] ?? "border-border/40 text-muted-foreground"}`}>
                        {b.stage}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t border-border/10">
                    <div>
                      <div className="text-xs font-display text-foreground/80">{b.initial_capital_usd ? fmt(b.initial_capital_usd) : "—"}</div>
                      <div className="text-[10px] text-muted-foreground/50">Capital Required</div>
                    </div>
                    <div>
                      <div className="text-xs font-display text-foreground/80">{b.monthly_revenue_target_usd ? fmt(b.monthly_revenue_target_usd) : "—"}</div>
                      <div className="text-[10px] text-muted-foreground/50">Revenue Target/Mo</div>
                    </div>
                    <div>
                      <div className={`text-xs font-display ${revenueRatio == null ? "text-foreground/80" : revenueRatio >= 1 ? "text-green-400" : revenueRatio >= 0.7 ? "text-amber-400" : "text-red-400"}`}>
                        {b.current_monthly_revenue_usd != null ? fmt(b.current_monthly_revenue_usd) : "—"}
                      </div>
                      <div className="text-[10px] text-muted-foreground/50">Current Revenue/Mo</div>
                    </div>
                    <div>
                      <div className={`text-xs font-display ${b.months_underperforming >= 3 ? "text-red-400" : b.months_underperforming > 0 ? "text-amber-400" : "text-foreground/80"}`}>
                        {b.months_underperforming > 0 ? `${b.months_underperforming}mo` : "On track"}
                      </div>
                      <div className="text-[10px] text-muted-foreground/50">Underperforming</div>
                    </div>
                  </div>

                  {b.notes && (
                    <p className="text-[10px] text-muted-foreground/50 border-t border-border/10 pt-2">{b.notes}</p>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── Decisions ─────────────────────────────────────────────────────── */}
      {activeTab === "decisions" && (
        <div className="space-y-3">
          {decisions.length === 0 ? (
            <div className="glass-card p-8 text-center">
              <TrendingUp className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground/50">No decisions pending approval.</p>
            </div>
          ) : (
            decisions.map((d) => {
              const payload = d.payload as Record<string, unknown>;
              const isPriority = d.priority === "ORANGE";
              return (
                <div key={d.id} className={`glass-card p-4 space-y-2 ${isPriority ? "border-amber-400/20 bg-amber-400/5" : "border-yellow-400/10"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-display tracking-widest uppercase ${isPriority ? "text-amber-400" : "text-yellow-400/70"}`}>{d.priority}</span>
                        <span className="text-sm text-foreground font-medium">{d.action_type}</span>
                      </div>
                      {payload?.rationale && (
                        <p className="text-xs text-muted-foreground/70 mt-1 leading-snug">{payload.rationale as string}</p>
                      )}
                      <p className="text-[10px] text-muted-foreground/40 mt-1">
                        {new Date(d.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => approveDecision(d.id)} disabled={sendingId === d.id} className="h-7 text-xs gap-1.5 bg-green-500/15 text-green-400 hover:bg-green-500/25 border border-green-500/30" variant="outline">
                      {sendingId === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                      Approve
                    </Button>
                    <Button size="sm" onClick={() => rejectDecision(d.id)} className="h-7 text-xs gap-1.5 bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30" variant="outline">
                      <XCircle className="h-3 w-3" />Reject
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── Ledger ────────────────────────────────────────────────────────── */}
      {activeTab === "ledger" && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="glass-card p-4 text-center space-y-1">
              <div className="text-xl font-display text-green-400">{fmt(mtdRevenue)}</div>
              <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">MTD Revenue</div>
            </div>
            <div className="glass-card p-4 text-center space-y-1">
              <div className="text-xl font-display text-red-400">{fmt(mtdExpenses)}</div>
              <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">MTD Expenses</div>
            </div>
            <div className="glass-card p-4 text-center space-y-1">
              <div className={`text-xl font-display ${mtdRevenue - mtdExpenses >= 0 ? "text-primary" : "text-red-400"}`}>{fmt(mtdRevenue - mtdExpenses)}</div>
              <div className="text-[10px] text-muted-foreground font-display tracking-widest uppercase">Net</div>
            </div>
          </div>

          {ledger.length === 0 ? (
            <div className="glass-card p-8 text-center">
              <DollarSign className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground/50">No entries yet.</p>
            </div>
          ) : (
            <div className="glass-card divide-y divide-border/10">
              {ledger.map(e => (
                <div key={e.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-foreground">{e.description}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-border/30 text-muted-foreground capitalize">{e.category}</span>
                    </div>
                    {e.recurring && <span className="text-[10px] text-muted-foreground/50">recurring</span>}
                  </div>
                  <div className={`text-sm font-display shrink-0 ${e.entry_type === "revenue" ? "text-green-400" : "text-red-400"}`}>
                    {e.entry_type === "revenue" ? "+" : "-"}{fmt(Number(e.amount_usd))}
                  </div>
                  <div className="text-[10px] text-muted-foreground/40 shrink-0 capitalize">{e.status}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Brief ─────────────────────────────────────────────────────────── */}
      {activeTab === "brief" && (
        <div>
          {brief ? (
            <div className="glass-card p-6 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-display tracking-widest text-primary uppercase">{brief.title}</h2>
                <span className="text-[10px] text-muted-foreground/50">
                  {new Date(brief.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
              </div>
              <div className="prose prose-sm prose-invert max-w-none text-foreground/80 leading-relaxed text-sm">
                <pre className="whitespace-pre-wrap font-sans">{brief.content}</pre>
              </div>
            </div>
          ) : (
            <div className="glass-card p-8 text-center space-y-3">
              <BookOpen className="h-8 w-8 text-muted-foreground/30 mx-auto" />
              <p className="text-sm text-muted-foreground/50">No business brief yet. Atlas generates one every Monday at 09:00 UTC.</p>
              <Button size="sm" variant="outline" onClick={runBrief} disabled={runningBrief} className="text-xs border-primary/30 text-primary/70">
                <FileText className="h-3.5 w-3.5 mr-1.5" />Run Now
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BusinessPage;
