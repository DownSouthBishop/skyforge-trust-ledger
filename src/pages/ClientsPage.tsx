import { useEffect, useMemo, useState } from "react";
import { Search, Users, DollarSign, Bell, ChevronDown, ChevronUp, CheckCircle2, Link as LinkIcon } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface Client {
  id: string;
  client_name: string;
  client_email: string | null;
  client_phone: string | null;
  total_spend: number;
  job_count: number;
  last_job_date: string | null;
  last_job_type: string | null;
  next_followup_date: string | null;
  followup_status: string;
  notes: string | null;
}

interface Receipt {
  id: string;
  action_description: string;
  action_value_usd: number | null;
  created_at: string;
  verification_state: string;
}

const followupBadge = (status: string, nextDate: string | null) => {
  const today = new Date().toISOString().slice(0, 10);
  const due =
    status !== "completed" &&
    nextDate &&
    nextDate <= new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  if (status === "completed") {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full border border-primary/30 text-primary uppercase tracking-wider">
        Completed
      </span>
    );
  }
  if (due) {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full border border-accent/50 bg-accent/10 text-accent uppercase tracking-wider">
        Due
      </span>
    );
  }
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full border border-border/50 text-muted-foreground uppercase tracking-wider">
      Pending
    </span>
  );
};

const fmtUSD = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString() : "—");

const ClientsPage = () => {
  const { user } = useAuth();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, Receipt[]>>({});
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [savingNotes, setSavingNotes] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("skyforge_clients")
      .select("*")
      .eq("user_id", user!.id)
      .order("last_job_date", { ascending: false, nullsFirst: false });
    setClients((data ?? []) as Client[]);
    setLoading(false);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => c.client_name.toLowerCase().includes(q));
  }, [search, clients]);

  const totals = useMemo(() => {
    const totalClients = clients.length;
    const totalSpend = clients.reduce((s, c) => s + Number(c.total_spend || 0), 0);
    const today = new Date();
    const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const todayStr = today.toISOString().slice(0, 10);
    const opportunities = clients.filter(
      (c) =>
        c.followup_status !== "completed" &&
        c.next_followup_date &&
        c.next_followup_date >= todayStr &&
        c.next_followup_date <= in7,
    ).length;
    return { totalClients, totalSpend, opportunities };
  }, [clients]);

  const toggle = async (c: Client) => {
    if (openId === c.id) {
      setOpenId(null);
      return;
    }
    setOpenId(c.id);
    setNotesDraft((d) => ({ ...d, [c.id]: c.notes ?? "" }));
    if (!history[c.id]) {
      const { data } = await supabase
        .from("receipts_ledger")
        .select("id, action_description, action_value_usd, created_at, verification_state")
        .eq("provider_id", user!.id)
        .eq("client_name", c.client_name)
        .order("created_at", { ascending: false });
      setHistory((h) => ({ ...h, [c.id]: (data ?? []) as Receipt[] }));
    }
  };

  const saveNotes = async (c: Client) => {
    setSavingNotes(c.id);
    const newNotes = notesDraft[c.id] ?? "";
    const { error } = await supabase
      .from("skyforge_clients")
      .update({ notes: newNotes })
      .eq("id", c.id);
    setSavingNotes(null);
    if (error) {
      toast.error("Failed to save notes");
      return;
    }
    setClients((prev) => prev.map((x) => (x.id === c.id ? { ...x, notes: newNotes } : x)));
    toast.success("Notes saved");
  };

  const markComplete = async (c: Client) => {
    const { error } = await supabase
      .from("skyforge_clients")
      .update({ followup_status: "completed" })
      .eq("id", c.id);
    if (error) {
      toast.error("Failed to mark follow-up complete");
      return;
    }
    setClients((prev) => prev.map((x) => (x.id === c.id ? { ...x, followup_status: "completed" } : x)));
    // Generate verified-profile share link (existing HUD public record by user id)
    const link = `${window.location.origin}/?op=${user!.id}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Verified profile link copied — send it with your message.");
    } catch {
      toast("Verified profile link ready: " + link);
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <h1 className="text-xl md:text-2xl font-display tracking-wider text-primary text-glow-blue">
        CLIENTS
      </h1>

      {/* Top metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="glass-card p-4 text-center space-y-1">
          <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs uppercase tracking-widest">
            <Users className="h-3 w-3" /> Total Clients
          </div>
          <div className="text-2xl font-display text-primary">{totals.totalClients}</div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs uppercase tracking-widest">
            <DollarSign className="h-3 w-3" /> Verified Spend
          </div>
          <div className="text-2xl font-display text-primary">{fmtUSD(totals.totalSpend)}</div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs uppercase tracking-widest">
            <Bell className="h-3 w-3" /> Follow-ups This Week
          </div>
          <div className="text-2xl font-display text-accent">{totals.opportunities}</div>
        </div>
      </div>

      {/* Search */}
      <div className="glass-card p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-primary/50" />
          <Input
            placeholder="Search clients by name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 bg-secondary/30 border-border/30 placeholder:text-muted-foreground/40"
          />
        </div>
      </div>

      {/* List */}
      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!loading && filtered.length === 0 && (
        <div className="glass-card p-10 text-center space-y-3">
          <Users className="h-12 w-12 text-primary/30 mx-auto" />
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Clients appear here automatically when receipts are verified. Log a job to populate this list.
          </p>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map((c) => {
            const isOpen = openId === c.id;
            return (
              <div key={c.id} className="glass-card overflow-hidden">
                <button
                  onClick={() => toggle(c)}
                  className="w-full p-4 flex items-center justify-between gap-3 text-left hover:bg-primary/5 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-base font-display tracking-wide text-foreground truncate">
                        {c.client_name}
                      </h3>
                      {followupBadge(c.followup_status, c.next_followup_date)}
                    </div>
                    <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                      <span>Last: {c.last_job_type ?? "—"}</span>
                      <span>{fmtDate(c.last_job_date)}</span>
                      <span className="text-primary">{fmtUSD(Number(c.total_spend))}</span>
                      <span>{c.job_count} job{c.job_count === 1 ? "" : "s"}</span>
                    </div>
                  </div>
                  {isOpen ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                </button>

                {isOpen && (
                  <div className="border-t border-border/30 p-4 space-y-4 bg-secondary/20">
                    {/* Job history */}
                    <div>
                      <div className="text-xs font-display tracking-widest text-accent mb-2 uppercase">
                        Job History
                      </div>
                      {(history[c.id] ?? []).length === 0 ? (
                        <p className="text-xs text-muted-foreground">No receipts on file for this client.</p>
                      ) : (
                        <div className="space-y-1">
                          {(history[c.id] ?? []).map((r) => (
                            <div
                              key={r.id}
                              className="flex items-center justify-between gap-3 text-xs py-1.5 border-b border-border/20 last:border-0"
                            >
                              <span className="text-foreground/80 truncate">{r.action_description}</span>
                              <span className="text-muted-foreground shrink-0">{fmtDate(r.created_at)}</span>
                              <span className="text-primary shrink-0">{fmtUSD(Number(r.action_value_usd ?? 0))}</span>
                              <span
                                className={`text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wider shrink-0 ${
                                  r.verification_state === "VERIFIED"
                                    ? "border border-primary/30 text-primary"
                                    : r.verification_state === "DISPUTED"
                                    ? "border border-destructive/40 text-destructive"
                                    : "border border-border/40 text-muted-foreground"
                                }`}
                              >
                                {r.verification_state}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Notes */}
                    <div>
                      <div className="text-xs font-display tracking-widest text-accent mb-2 uppercase">
                        Notes
                      </div>
                      <Textarea
                        value={notesDraft[c.id] ?? ""}
                        onChange={(e) =>
                          setNotesDraft((d) => ({ ...d, [c.id]: e.target.value }))
                        }
                        placeholder="Anything worth remembering about this client…"
                        className="min-h-[80px] bg-background/50"
                      />
                      <div className="flex justify-end mt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => saveNotes(c)}
                          disabled={savingNotes === c.id}
                        >
                          {savingNotes === c.id ? "Saving…" : "Save Notes"}
                        </Button>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap gap-2 pt-2 border-t border-border/30">
                      <Button
                        size="sm"
                        onClick={() => markComplete(c)}
                        disabled={c.followup_status === "completed"}
                        className="gap-2"
                      >
                        {c.followup_status === "completed" ? (
                          <>
                            <CheckCircle2 className="h-4 w-4" /> Follow-up Complete
                          </>
                        ) : (
                          <>
                            <LinkIcon className="h-4 w-4" /> Mark Follow-up Initiated
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ClientsPage;
