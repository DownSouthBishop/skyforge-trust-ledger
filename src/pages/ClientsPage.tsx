import { useEffect, useMemo, useState } from "react";
import { Search, Users, ChevronDown, ChevronUp, Check, Send } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

type Client = {
  id: string;
  user_id: string;
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
  created_at: string;
};

type Receipt = {
  id: string;
  action_description: string;
  action_value_usd: number | null;
  verification_state: string;
  created_at: string;
};

const daysAgo = (d: string | null) => {
  if (!d) return null;
  return Math.floor(
    (Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24),
  );
};

const isWithin7Days = (d: string | null) => {
  if (!d) return false;
  const days = (new Date(d).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return days >= -1 && days <= 7;
};

const followupBadge = (c: Client) => {
  if (c.followup_status === "completed") {
    return { label: "Completed", classes: "border-primary/40 text-primary bg-primary/5" };
  }
  if (
    isWithin7Days(c.next_followup_date) ||
    (daysAgo(c.last_job_date) ?? 0) > 90
  ) {
    return { label: "Due", classes: "border-accent/50 text-accent bg-accent/10" };
  }
  return { label: "Pending", classes: "border-border/60 text-muted-foreground bg-secondary/40" };
};

const ClientsPage = () => {
  const { toast } = useToast();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, Receipt[]>>({});
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("skyforge_clients")
        .select("*")
        .order("last_job_date", { ascending: false, nullsFirst: false });
      if (error) console.error(error);
      else setClients((data as Client[]) ?? []);
      setLoading(false);
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) =>
      c.client_name.toLowerCase().includes(q) ||
      (c.last_job_type ?? "").toLowerCase().includes(q)
    );
  }, [clients, search]);

  const totalSpend = useMemo(
    () => clients.reduce((s, c) => s + Number(c.total_spend ?? 0), 0),
    [clients],
  );

  const followupsThisWeek = useMemo(
    () =>
      clients.filter((c) =>
        c.followup_status !== "completed" &&
        (isWithin7Days(c.next_followup_date) ||
          (daysAgo(c.last_job_date) ?? 0) > 90)
      ).length,
    [clients],
  );

  const toggleExpand = async (c: Client) => {
    if (expandedId === c.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(c.id);
    setNotesDraft((prev) => ({ ...prev, [c.id]: c.notes ?? "" }));
    if (!history[c.id]) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { data, error } = await supabase
        .from("receipts_ledger")
        .select("id, action_description, action_value_usd, verification_state, created_at")
        .eq("provider_id", session.user.id)
        .eq("client_name", c.client_name)
        .order("created_at", { ascending: false });
      if (!error && data) {
        setHistory((prev) => ({ ...prev, [c.id]: data as Receipt[] }));
      }
    }
  };

  const saveNotes = async (c: Client) => {
    setSavingId(c.id);
    const draft = notesDraft[c.id] ?? "";
    const { error } = await supabase
      .from("skyforge_clients")
      .update({ notes: draft })
      .eq("id", c.id);
    setSavingId(null);
    if (error) {
      toast({ title: "Couldn't save notes", description: error.message, variant: "destructive" });
      return;
    }
    setClients((prev) => prev.map((x) => x.id === c.id ? { ...x, notes: draft } : x));
    toast({ title: "Notes saved" });
  };

  const initiateFollowup = async (c: Client) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const link = `${window.location.origin}/?operator=${session.user.id}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // ignore — still mark as initiated
    }
    const { error } = await supabase
      .from("skyforge_clients")
      .update({ followup_status: "initiated" })
      .eq("id", c.id);
    if (error) {
      toast({ title: "Couldn't update", description: error.message, variant: "destructive" });
      return;
    }
    setClients((prev) => prev.map((x) => x.id === c.id ? { ...x, followup_status: "initiated" } : x));
    toast({ title: "Verified profile link copied — send it with your message." });
  };

  const markComplete = async (c: Client) => {
    const { error } = await supabase
      .from("skyforge_clients")
      .update({ followup_status: "completed" })
      .eq("id", c.id);
    if (error) {
      toast({ title: "Couldn't update", description: error.message, variant: "destructive" });
      return;
    }
    setClients((prev) => prev.map((x) => x.id === c.id ? { ...x, followup_status: "completed" } : x));
    toast({ title: "Follow-up marked complete" });
  };

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <h1 className="text-xl md:text-2xl font-display tracking-wider text-primary text-glow-blue">
        CLIENTS
      </h1>

      {/* Metric cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="glass-card p-4 text-center space-y-1">
          <div className="text-2xl font-display text-primary">{clients.length}</div>
          <div className="text-xs text-muted-foreground">Total Clients</div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className="text-2xl font-display text-primary">
            ${totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <div className="text-xs text-muted-foreground">Verified Spend</div>
        </div>
        <div className="glass-card p-4 text-center space-y-1">
          <div className="text-2xl font-display text-accent">{followupsThisWeek}</div>
          <div className="text-xs text-muted-foreground">Follow-ups This Week</div>
        </div>
      </div>

      {/* Search */}
      <div className="glass-card p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-primary/50" />
          <Input
            placeholder="Search by client name or job type..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 bg-secondary/30 border-border/30 placeholder:text-muted-foreground/40"
          />
        </div>
      </div>

      {/* Client list */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading clients…</div>
      ) : filtered.length === 0 ? (
        <div className="glass-card p-10 flex flex-col items-center justify-center text-center space-y-4 min-h-[260px]">
          <Users className="h-12 w-12 text-primary/30" />
          <h2 className="text-base font-display tracking-widest text-primary/60">
            NO CLIENTS YET
          </h2>
          <p className="text-sm text-muted-foreground max-w-md">
            Verified receipts automatically build your client roster. Issue your first verified job to populate this list.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((c) => {
            const badge = followupBadge(c);
            const open = expandedId === c.id;
            return (
              <div key={c.id} className="glass-card p-4 md:p-5">
                <button
                  type="button"
                  onClick={() => toggleExpand(c)}
                  className="w-full text-left flex items-center justify-between gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h3 className="font-display text-base text-foreground tracking-wide truncate">
                        {c.client_name}
                      </h3>
                      <span
                        className={`text-[10px] font-display tracking-widest px-2 py-0.5 rounded-full border ${badge.classes}`}
                      >
                        {badge.label.toUpperCase()}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      {c.last_job_type && <span>Last: {c.last_job_type}</span>}
                      {c.last_job_date && (
                        <span>{new Date(c.last_job_date).toLocaleDateString()}</span>
                      )}
                      <span className="text-primary/80">
                        ${Number(c.total_spend ?? 0).toLocaleString()}
                      </span>
                      <span>{c.job_count} {c.job_count === 1 ? "job" : "jobs"}</span>
                    </div>
                  </div>
                  {open
                    ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
                    : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
                </button>

                {open && (
                  <div className="mt-5 pt-5 border-t border-border/30 space-y-5">
                    <div>
                      <div className="text-[10px] tracking-widest font-display text-primary/70 mb-2">
                        JOB HISTORY
                      </div>
                      {history[c.id] === undefined ? (
                        <div className="text-xs text-muted-foreground">Loading history…</div>
                      ) : history[c.id].length === 0 ? (
                        <div className="text-xs text-muted-foreground">No receipts yet for this client.</div>
                      ) : (
                        <div className="space-y-2">
                          {history[c.id].map((r) => (
                            <div
                              key={r.id}
                              className="flex items-center justify-between text-xs bg-secondary/30 border border-border/30 rounded-lg px-3 py-2"
                            >
                              <span className="truncate text-foreground">{r.action_description}</span>
                              <span className="flex items-center gap-3 shrink-0 ml-3">
                                <span className="text-primary/80">
                                  ${Number(r.action_value_usd ?? 0).toLocaleString()}
                                </span>
                                <span className="text-muted-foreground">
                                  {new Date(r.created_at).toLocaleDateString()}
                                </span>
                                <span
                                  className={`text-[9px] tracking-widest font-display ${
                                    r.verification_state === "VERIFIED"
                                      ? "text-primary"
                                      : r.verification_state === "DISPUTED"
                                      ? "text-destructive"
                                      : "text-accent"
                                  }`}
                                >
                                  {r.verification_state}
                                </span>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-[10px] tracking-widest font-display text-primary/70 mb-2">
                        NOTES
                      </div>
                      <Textarea
                        rows={3}
                        value={notesDraft[c.id] ?? ""}
                        onChange={(e) =>
                          setNotesDraft((prev) => ({ ...prev, [c.id]: e.target.value }))}
                        placeholder="Private notes about this client…"
                        className="bg-secondary/30 border-border/30 resize-none"
                      />
                      <div className="flex justify-end mt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={savingId === c.id}
                          onClick={() => saveNotes(c)}
                          className="border-border/60 text-muted-foreground hover:text-primary"
                        >
                          {savingId === c.id ? "Saving…" : "Save notes"}
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => initiateFollowup(c)}
                        className="bg-accent hover:bg-accent/90 text-accent-foreground"
                      >
                        <Send className="h-3.5 w-3.5 mr-1.5" />
                        Initiate follow-up
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={c.followup_status === "completed"}
                        onClick={() => markComplete(c)}
                        className="border-primary/30 text-primary hover:bg-primary/10"
                      >
                        <Check className="h-3.5 w-3.5 mr-1.5" />
                        {c.followup_status === "completed" ? "Completed" : "Mark complete"}
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
