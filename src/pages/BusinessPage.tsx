import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { TrendingUp, DollarSign, CheckCircle, XCircle, Plus, Briefcase, FileText, BookOpen, Loader2 } from "lucide-react";

type PipelineRow = {
  id: string;
  contact_name: string;
  company: string | null;
  opportunity: string;
  stage: string;
  estimated_value_usd: number | null;
  probability_pct: number | null;
  last_contact_at: string | null;
  next_action: string | null;
  next_action_due: string | null;
  notes: string | null;
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

type TaskRow = {
  id: string;
  task_type: string;
  subject: string;
  body: string | null;
  status: string;
  scheduled_for: string;
  requires_approval: boolean;
};

type BriefRow = {
  id: string;
  title: string;
  content: string;
  created_at: string;
};

const STAGES: Record<string, string> = {
  prospect: "Prospect",
  outreach: "Outreach",
  follow_up: "Follow-up",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Won",
  closed_lost: "Lost",
};

const STAGE_ORDER = ["prospect", "outreach", "follow_up", "proposal", "negotiation"];

const fmt = (n: number) => `$${n >= 1000 ? (n / 1000).toFixed(1) + "k" : n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const BusinessPage = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<"pipeline" | "ledger" | "tasks" | "brief">("pipeline");

  const [pipeline, setPipeline]   = useState<PipelineRow[]>([]);
  const [ledger, setLedger]       = useState<LedgerRow[]>([]);
  const [tasks, setTasks]         = useState<TaskRow[]>([]);
  const [brief, setBrief]         = useState<BriefRow | null>(null);
  const [loading, setLoading]     = useState(true);

  const [ledgerFilter, setLedgerFilter] = useState<"all" | "revenue" | "expense">("all");

  const [showProspectForm, setShowProspectForm] = useState(false);
  const [pContact, setPContact] = useState("");
  const [pCompany, setPCompany] = useState("");
  const [pOpportunity, setPOpportunity] = useState("");
  const [pValue, setPValue] = useState("");
  const [addingProspect, setAddingProspect] = useState(false);

  const [showLedgerForm, setShowLedgerForm] = useState(false);
  const [lType, setLType] = useState<"revenue" | "expense">("revenue");
  const [lCategory, setLCategory] = useState("");
  const [lDescription, setLDescription] = useState("");
  const [lAmount, setLAmount] = useState("");
  const [addingLedger, setAddingLedger] = useState(false);

  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [sendingTask, setSendingTask] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!user) return;
    try {
      const [pipeRes, ledRes, taskRes, briefRes] = await Promise.all([
        supabase.from("business_pipeline").select("*").eq("user_id", user.id).not("stage", "in", '("closed_won","closed_lost")').order("next_action_due", { ascending: true, nullsFirst: false }),
        supabase.from("business_ledger").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50),
        supabase.from("business_tasks").select("*").eq("user_id", user.id).eq("status", "queued").order("scheduled_for", { ascending: true }),
        supabase.from("research_notes").select("id,title,content,created_at").eq("user_id", user.id).like("title", "Business Brief%").order("created_at", { ascending: false }).limit(1),
      ]);
      setPipeline((pipeRes.data ?? []) as PipelineRow[]);
      setLedger((ledRes.data ?? []) as LedgerRow[]);
      setTasks((taskRes.data ?? []) as TaskRow[]);
      setBrief(((briefRes.data ?? []) as BriefRow[])[0] ?? null);
    } catch (e) {
      console.error("Business data load failed:", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void loadData(); }, [loadData]);

  const addProspect = async () => {
    if (!pContact.trim() || !pOpportunity.trim()) return;
    setAddingProspect(true);
    try {
      await supabase.from("business_pipeline").insert({
        user_id: user!.id,
        contact_name: pContact.trim(),
        company: pCompany.trim() || null,
        opportunity: pOpportunity.trim(),
        estimated_value_usd: parseFloat(pValue) || null,
        stage: "prospect",
      });
      setPContact(""); setPCompany(""); setPOpportunity(""); setPValue("");
      setShowProspectForm(false);
      void loadData();
      toast.success("Prospect added.");
    } catch {
      toast.error("Failed to add prospect.");
    } finally {
      setAddingProspect(false);
    }
  };

  const addLedgerEntry = async () => {
    if (!lCategory.trim() || !lDescription.trim() || !lAmount) return;
    setAddingLedger(true);
    try {
      await supabase.from("business_ledger").insert({
        user_id: user!.id,
        entry_type: lType,
        category: lCategory.trim(),
        description: lDescription.trim(),
        amount_usd: parseFloat(lAmount),
        status: "pending",
      });
      setLCategory(""); setLDescription(""); setLAmount("");
      setShowLedgerForm(false);
      void loadData();
      toast.success("Entry logged.");
    } catch {
      toast.error("Failed to log entry.");
    } finally {
      setAddingLedger(false);
    }
  };

  const approveTask = async (taskId: string) => {
    setSendingTask(taskId);
    try {
      await supabase.from("business_tasks").update({ status: "approved" }).eq("id", taskId);

      // Trigger send outreach
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/atlas_send_outreach`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ task_id: taskId, user_id: user!.id }),
        },
      );
      if (!res.ok) throw new Error("Send failed");
      toast.success("Outreach approved and sent.");
      void loadData();
    } catch {
      toast.error("Failed to send outreach.");
    } finally {
      setSendingTask(null);
    }
  };

  const cancelTask = async (taskId: string) => {
    await supabase.from("business_tasks").update({ status: "cancelled" }).eq("id", taskId);
    void loadData();
    toast.success("Task cancelled.");
  };

  const mtdRevenue  = ledger.filter(e => e.entry_type === "revenue" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
  const mtdExpenses = ledger.filter(e => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount_usd), 0);
  const pipelineByStage: Record<string, PipelineRow[]> = {};
  for (const stage of STAGE_ORDER) pipelineByStage[stage] = pipeline.filter(p => p.stage === stage);
  const filteredLedger = ledgerFilter === "all" ? ledger : ledger.filter(e => e.entry_type === ledgerFilter);

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
          <p className="text-xs text-muted-foreground/60 mt-0.5">Pipeline · Ledger · Tasks · Brief</p>
        </div>
      </div>

      {/* Tab nav */}
      <div className="flex gap-1">
        {(["pipeline", "ledger", "tasks", "brief"] as const).map((t) => (
          <button key={t} onClick={() => setActiveTab(t)} className={`text-xs px-4 py-1.5 rounded-full border capitalize transition-colors ${activeTab === t ? "border-accent/60 bg-accent/10 text-accent" : "border-border/40 text-muted-foreground hover:border-border/70"}`}>
            {t}{t === "tasks" && tasks.length > 0 ? ` (${tasks.length})` : ""}
          </button>
        ))}
      </div>

      {/* ── Pipeline tab ─────────────────────────────────────────────────────── */}
      {activeTab === "pipeline" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setShowProspectForm(v => !v)} className="bg-accent/10 text-accent hover:bg-accent/20 border border-accent/30 font-display tracking-wider">
              <Plus className="h-3.5 w-3.5 mr-1.5" />Add Prospect
            </Button>
          </div>

          {showProspectForm && (
            <div className="glass-card p-4 space-y-3">
              <p className="text-[10px] font-display tracking-widest text-accent uppercase">New Prospect</p>
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Contact name" value={pContact} onChange={e => setPContact(e.target.value)} className="bg-secondary/30 border-border/30" />
                <Input placeholder="Company" value={pCompany} onChange={e => setPCompany(e.target.value)} className="bg-secondary/30 border-border/30" />
              </div>
              <Input placeholder="Opportunity" value={pOpportunity} onChange={e => setPOpportunity(e.target.value)} className="bg-secondary/30 border-border/30" />
              <Input placeholder="Estimated value ($)" type="number" value={pValue} onChange={e => setPValue(e.target.value)} className="bg-secondary/30 border-border/30" />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowProspectForm(false)}>Cancel</Button>
                <Button size="sm" onClick={addProspect} disabled={addingProspect || !pContact.trim() || !pOpportunity.trim()} className="bg-accent text-accent-foreground hover:bg-accent/90">
                  {addingProspect ? "Adding…" : "Add"}
                </Button>
              </div>
            </div>
          )}

          {/* Kanban */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {STAGE_ORDER.map(stage => (
              <div key={stage} className="space-y-2">
                <p className="text-[10px] font-display tracking-widest text-muted-foreground uppercase">{STAGES[stage]}</p>
                {(pipelineByStage[stage] ?? []).map(p => {
                  const isOverdue = p.next_action_due && new Date(p.next_action_due) < new Date();
                  return (
                    <div key={p.id} className="glass-card p-3 space-y-1 cursor-pointer hover:border-accent/30 transition-all">
                      <p className="text-xs font-display text-foreground">{p.contact_name}</p>
                      {p.company && <p className="text-[10px] text-muted-foreground/60">{p.company}</p>}
                      {p.estimated_value_usd != null && (
                        <p className="text-xs text-primary font-display">{fmt(p.estimated_value_usd)}</p>
                      )}
                      {p.next_action_due && (
                        <p className={`text-[10px] ${isOverdue ? "text-red-400" : "text-muted-foreground/50"}`}>
                          Due {new Date(p.next_action_due).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </p>
                      )}
                    </div>
                  );
                })}
                {(pipelineByStage[stage] ?? []).length === 0 && (
                  <div className="glass-card p-3 border-dashed opacity-30">
                    <p className="text-[10px] text-muted-foreground text-center">—</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Ledger tab ────────────────────────────────────────────────────────── */}
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

          <div className="flex items-center justify-between">
            <div className="flex gap-1">
              {(["all", "revenue", "expense"] as const).map(f => (
                <button key={f} onClick={() => setLedgerFilter(f)} className={`text-[10px] px-3 py-1 rounded-full border capitalize transition-colors ${ledgerFilter === f ? "border-accent/60 bg-accent/10 text-accent" : "border-border/40 text-muted-foreground"}`}>
                  {f}
                </button>
              ))}
            </div>
            <Button size="sm" onClick={() => setShowLedgerForm(v => !v)} className="bg-accent/10 text-accent hover:bg-accent/20 border border-accent/30 font-display tracking-wider">
              <Plus className="h-3.5 w-3.5 mr-1.5" />Add Entry
            </Button>
          </div>

          {showLedgerForm && (
            <div className="glass-card p-4 space-y-3">
              <div className="flex gap-2">
                {(["revenue", "expense"] as const).map(t => (
                  <button key={t} onClick={() => setLType(t)} className={`text-xs px-3 py-1.5 rounded-md border capitalize ${lType === t ? "border-accent/60 bg-accent/10 text-accent" : "border-border/40 text-muted-foreground"}`}>
                    {t}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Category" value={lCategory} onChange={e => setLCategory(e.target.value)} className="bg-secondary/30 border-border/30" />
                <Input placeholder="Amount ($)" type="number" value={lAmount} onChange={e => setLAmount(e.target.value)} className="bg-secondary/30 border-border/30" />
              </div>
              <Input placeholder="Description" value={lDescription} onChange={e => setLDescription(e.target.value)} className="bg-secondary/30 border-border/30" />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowLedgerForm(false)}>Cancel</Button>
                <Button size="sm" onClick={addLedgerEntry} disabled={addingLedger} className="bg-accent text-accent-foreground hover:bg-accent/90">
                  {addingLedger ? "Adding…" : "Log"}
                </Button>
              </div>
            </div>
          )}

          {filteredLedger.length === 0 ? (
            <div className="glass-card p-8 text-center">
              <DollarSign className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground/50">No entries. Log revenue or expenses above.</p>
            </div>
          ) : (
            <div className="glass-card divide-y divide-border/10">
              {filteredLedger.map(e => (
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

      {/* ── Tasks tab ─────────────────────────────────────────────────────────── */}
      {activeTab === "tasks" && (
        <div className="space-y-3">
          {tasks.length === 0 ? (
            <div className="glass-card p-8 text-center">
              <Briefcase className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground/50">No tasks queued for approval.</p>
            </div>
          ) : (
            <>
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={async () => {
                  for (const t of tasks) await approveTask(t.id);
                }} className="text-xs border-green-500/30 text-green-400 hover:bg-green-500/10">
                  Bulk Approve All
                </Button>
              </div>
              {tasks.map(t => (
                <div key={t.id} className="glass-card p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-display tracking-widest text-muted-foreground uppercase">{t.task_type}</span>
                      </div>
                      <p className="text-sm text-foreground font-medium mt-0.5">{t.subject}</p>
                      <p className="text-[10px] text-muted-foreground/40 mt-0.5">
                        Scheduled {new Date(t.scheduled_for).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                  </div>

                  {t.body && (
                    <div>
                      <button onClick={() => setExpandedTask(expandedTask === t.id ? null : t.id)} className="text-[10px] text-muted-foreground/60 hover:text-primary">
                        {expandedTask === t.id ? "Hide preview" : "Show preview"}
                      </button>
                      {expandedTask === t.id && (
                        <pre className="text-xs text-foreground/70 bg-secondary/20 rounded p-3 mt-2 whitespace-pre-wrap leading-relaxed">{t.body}</pre>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => approveTask(t.id)} disabled={sendingTask === t.id} className="h-7 text-xs gap-1.5 bg-green-500/15 text-green-400 hover:bg-green-500/25 border border-green-500/30" variant="outline">
                      {sendingTask === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                      Approve & Send
                    </Button>
                    <Button size="sm" onClick={() => cancelTask(t.id)} className="h-7 text-xs gap-1.5 bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30" variant="outline">
                      <XCircle className="h-3 w-3" />Cancel
                    </Button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* ── Brief tab ─────────────────────────────────────────────────────────── */}
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
              <Button size="sm" variant="outline" onClick={async () => {
                const { data: { session } } = await supabase.auth.getSession();
                const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/atlas_business_brief`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
                  body: JSON.stringify({ user_id: user!.id }),
                });
                if (res.ok) { toast.success("Brief generated. Refreshing…"); void loadData(); }
                else toast.error("Brief failed.");
              }} className="text-xs border-primary/30 text-primary/70">
                <FileText className="h-3.5 w-3.5 mr-1.5" />Run Now
              </Button>
            </div>
          )}
        </div>
      )}

      {/* MTD summary always visible at bottom on pipeline/ledger */}
      {activeTab === "pipeline" && pipeline.length > 0 && (
        <div className="glass-card p-3 flex items-center gap-4 text-xs text-muted-foreground">
          <TrendingUp className="h-3.5 w-3.5 text-primary shrink-0" />
          <span>{pipeline.length} active deals</span>
          <span className="text-muted-foreground/40">·</span>
          <span>{fmt(pipeline.reduce((s, p) => s + Number(p.estimated_value_usd ?? 0), 0))} total pipeline</span>
        </div>
      )}
    </div>
  );
};

export default BusinessPage;
