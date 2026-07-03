import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { SUPABASE_URL } from "@/lib/supabase-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import {
  NotebookText, Plus, Trash2, FileText, Link as LinkIcon, Loader2, X, Upload,
  Folder, FolderOpen, User as UserIcon, Save, BookOpen, Calendar, Brain, Users,
} from "lucide-react";
import { toast } from "sonner";

interface Notebook { id: string; title: string; created_at: string }
interface Source { id: string; title: string; source_type: string; media_type: string | null; created_at: string }
interface Agent {
  id: string; slug: string; name: string; avatar_emoji: string | null;
  system_prompt: string; user_notes: string | null; identity_notes: string | null;
}
interface JournalEntry { id: string; date: string; title: string; context: string | null; importance: string | null }
interface DecisionEvent {
  id: string; agent_id: string; event_summary: string; belief_before: string | null;
  belief_after: string | null; character_implication: string | null; domain: string | null;
  impact_score: number; created_at: string;
}
interface MeetingLog { id: string; meeting_date: string; title: string | null; notes: string | null; outcome: string | null }

type AgentFileKind = "soul" | "user" | "identity";
interface AgentFileSel { agentId: string; kind: AgentFileKind }

const FILE_META: Record<AgentFileKind, { label: string; column: keyof Agent }> = {
  soul: { label: "soul.md", column: "system_prompt" },
  user: { label: "user.md", column: "user_notes" },
  identity: { label: "identity.md", column: "identity_notes" },
};

type FixedSection = "journal" | "daily" | "decisions" | "meetings";
const todayStr = () => new Date().toISOString().slice(0, 10);
const tomorrowStr = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };

export default function NotebookPage() {
  const { user } = useAuth();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [openAgents, setOpenAgents] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeAgentFile, setActiveAgentFile] = useState<AgentFileSel | null>(null);
  const [activeSection, setActiveSection] = useState<FixedSection | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [ingesting, setIngesting] = useState(false);

  // Agent-file editor state
  const [editorText, setEditorText] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const contextTokenRef = useRef<string>(""); // preserved [CONTEXT_INJECTION] literal

  // Journal / Daily
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [journalTitle, setJournalTitle] = useState("");
  const [journalContext, setJournalContext] = useState("");
  const [journalImportance, setJournalImportance] = useState("medium");

  // Decisions
  const [decisions, setDecisions] = useState<DecisionEvent[]>([]);
  const [decisionAgentId, setDecisionAgentId] = useState("");
  const [decisionSummary, setDecisionSummary] = useState("");
  const [decisionBefore, setDecisionBefore] = useState("");
  const [decisionAfter, setDecisionAfter] = useState("");
  const [decisionDomain, setDecisionDomain] = useState("");

  // Meetings
  const [meetings, setMeetings] = useState<MeetingLog[]>([]);
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingNotes, setMeetingNotes] = useState("");
  const [meetingOutcome, setMeetingOutcome] = useState("");
  const [meetingDate, setMeetingDate] = useState(todayStr());

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadNotebooks = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from("notebooks").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    setNotebooks(data ?? []);
  }, [user?.id]);

  const loadAgents = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("skyforge_agents")
      .select("id,slug,name,avatar_emoji,system_prompt,user_notes,identity_notes")
      .eq("user_id", user.id)
      .order("name", { ascending: true });
    setAgents(data ?? []);
    if (data?.length && !decisionAgentId) setDecisionAgentId(data[0].id);
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadJournal = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from("journal_entries").select("id,date,title,context,importance").eq("user_id", user.id).order("date", { ascending: false });
    setJournalEntries(data ?? []);
  }, [user?.id]);

  const loadDecisions = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from("agent_formative_events")
      .select("id,agent_id,event_summary,belief_before,belief_after,character_implication,domain,impact_score,created_at")
      .eq("user_id", user.id).order("created_at", { ascending: false }).limit(100);
    setDecisions(data ?? []);
  }, [user?.id]);

  const loadMeetings = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from("meeting_logs").select("id,meeting_date,title,notes,outcome").eq("user_id", user.id).order("meeting_date", { ascending: false });
    setMeetings(data ?? []);
  }, [user?.id]);

  useEffect(() => { loadNotebooks(); loadAgents(); loadJournal(); loadDecisions(); loadMeetings(); }, [loadNotebooks, loadAgents, loadJournal, loadDecisions, loadMeetings]);

  const loadNotebookDetail = useCallback(async (id: string) => {
    const { data } = await supabase.from("notebook_sources").select("id,title,source_type,media_type,created_at").eq("notebook_id", id).order("created_at", { ascending: true });
    setSources(data ?? []);
  }, []);

  useEffect(() => {
    if (activeId) loadNotebookDetail(activeId);
    else setSources([]);
  }, [activeId, loadNotebookDetail]);

  // Load agent file into editor when selection changes
  useEffect(() => {
    if (!activeAgentFile) { setEditorText(""); setEditorDirty(false); contextTokenRef.current = ""; return; }
    const agent = agents.find((a) => a.id === activeAgentFile.agentId);
    if (!agent) return;
    const col = FILE_META[activeAgentFile.kind].column;
    const raw = ((agent as any)[col] as string | null) ?? "";
    contextTokenRef.current = activeAgentFile.kind === "soul" && raw.includes("[CONTEXT_INJECTION]") ? "[CONTEXT_INJECTION]" : "";
    setEditorText(raw);
    setEditorDirty(false);
  }, [activeAgentFile, agents]);

  const selectNotebook = (id: string) => { setActiveAgentFile(null); setActiveSection(null); setActiveId(id); };
  const selectSection = (s: FixedSection) => {
    if (editorDirty && !confirm("Discard unsaved changes?")) return;
    setActiveId(null); setActiveAgentFile(null); setActiveSection(s);
  };

  const openAgentFile = (agentId: string, kind: AgentFileKind) => {
    if (editorDirty && !confirm("Discard unsaved changes?")) return;
    setActiveId(null); setActiveSection(null);
    setActiveAgentFile({ agentId, kind });
  };

  const saveAgentFile = async () => {
    if (!activeAgentFile) return;
    const col = FILE_META[activeAgentFile.kind].column as string;
    const value = editorText;
    // Preserve [CONTEXT_INJECTION] literal for soul.md — must remain byte-for-byte.
    if (activeAgentFile.kind === "soul" && contextTokenRef.current === "[CONTEXT_INJECTION]") {
      if (!value.includes("[CONTEXT_INJECTION]")) {
        toast.error("[CONTEXT_INJECTION] must be preserved in soul.md — save cancelled.");
        return;
      }
    }
    setEditorSaving(true);
    const { error } = await supabase
      .from("skyforge_agents")
      .update({ [col]: value, updated_at: new Date().toISOString() })
      .eq("id", activeAgentFile.agentId);
    setEditorSaving(false);
    if (error) return toast.error(error.message);
    setEditorDirty(false);
    setAgents((prev) => prev.map((a) => a.id === activeAgentFile.agentId ? { ...a, [col]: value } as Agent : a));
    toast.success("Saved");
  };

  const createNotebook = async () => {
    if (!user) return;
    const { data, error } = await supabase.from("notebooks").insert({ user_id: user.id, title: `Notebook ${new Date().toLocaleString()}` }).select().single();
    if (error) return toast.error(error.message);
    setNotebooks((prev) => [data as Notebook, ...prev]);
    selectNotebook((data as Notebook).id);
  };

  const deleteNotebook = async (id: string) => {
    if (!confirm("Delete this notebook and all its sources?")) return;
    await supabase.from("notebooks").delete().eq("id", id);
    if (activeId === id) setActiveId(null);
    loadNotebooks();
  };

  const addUrlSource = async () => {
    if (!activeId || !urlInput.trim()) return;
    setIngesting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/notebook-ingest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({ notebook_id: activeId, url: urlInput.trim() }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? "Failed to add URL");
      setUrlInput("");
      loadNotebookDetail(activeId);
      toast.success("Source added");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setIngesting(false);
    }
  };

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !activeId || !user) return;
    setIngesting(true);
    try {
      const path = `${user.id}/${activeId}/${Date.now()}_${file.name}`;
      const { error: uploadError } = await supabase.storage.from("notebook-sources").upload(path, file);
      if (uploadError) throw uploadError;
      const { error: insertError } = await supabase.from("notebook_sources").insert({
        notebook_id: activeId, user_id: user.id, title: file.name,
        source_type: "file", storage_path: path, media_type: file.type || "application/octet-stream",
      });
      if (insertError) throw insertError;
      loadNotebookDetail(activeId);
      toast.success(`${file.name} added`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setIngesting(false);
    }
  };

  const removeSource = async (id: string) => {
    await supabase.from("notebook_sources").delete().eq("id", id);
    if (activeId) loadNotebookDetail(activeId);
  };

  const toggleAgent = (id: string) => {
    setOpenAgents((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const activeAgent = activeAgentFile ? agents.find((a) => a.id === activeAgentFile.agentId) : null;

  // ── Journal / Daily ──────────────────────────────────────────────────────
  const addJournalEntry = async (date: string) => {
    if (!user || !journalTitle.trim()) return toast.error("Title required");
    const { error } = await supabase.from("journal_entries").insert({
      user_id: user.id, date, title: journalTitle.trim(), context: journalContext.trim() || null, importance: journalImportance,
    });
    if (error) return toast.error(error.message);
    setJournalTitle(""); setJournalContext("");
    loadJournal();
    toast.success("Saved");
  };
  const deleteJournalEntry = async (id: string) => {
    await supabase.from("journal_entries").delete().eq("id", id);
    loadJournal();
  };
  const entryForDate = (date: string) => journalEntries.find((e) => e.date === date);

  // ── Decisions ────────────────────────────────────────────────────────────
  const addDecision = async () => {
    if (!user || !decisionAgentId || !decisionSummary.trim()) return toast.error("Agent and summary required");
    const { error } = await supabase.from("agent_formative_events").insert({
      user_id: user.id, agent_id: decisionAgentId, event_summary: decisionSummary.trim(),
      belief_before: decisionBefore.trim() || null, belief_after: decisionAfter.trim() || null,
      domain: decisionDomain.trim() || null,
    });
    if (error) return toast.error(error.message);
    setDecisionSummary(""); setDecisionBefore(""); setDecisionAfter(""); setDecisionDomain("");
    loadDecisions();
    toast.success("Decision logged");
  };

  // ── Meetings ─────────────────────────────────────────────────────────────
  const addMeeting = async () => {
    if (!user || !meetingTitle.trim()) return toast.error("Title required");
    const { error } = await supabase.from("meeting_logs").insert({
      user_id: user.id, meeting_date: meetingDate, title: meetingTitle.trim(),
      notes: meetingNotes.trim() || null, outcome: meetingOutcome.trim() || null,
    });
    if (error) return toast.error(error.message);
    setMeetingTitle(""); setMeetingNotes(""); setMeetingOutcome("");
    loadMeetings();
    toast.success("Meeting logged");
  };
  const deleteMeeting = async (id: string) => {
    await supabase.from("meeting_logs").delete().eq("id", id);
    loadMeetings();
  };

  const FIXED_SECTIONS: Array<{ key: FixedSection; label: string; icon: typeof BookOpen }> = [
    { key: "journal", label: "Journal", icon: BookOpen },
    { key: "daily", label: "Daily", icon: Calendar },
    { key: "decisions", label: "Decisions", icon: Brain },
    { key: "meetings", label: "Meetings", icon: Users },
  ];

  return (
    <div className="h-screen bg-background text-foreground">
      <ResizablePanelGroup direction="horizontal" className="h-full">
        <ResizablePanel defaultSize={20} minSize={14} maxSize={32}>
          <div className="h-full flex flex-col border-r border-border/50">
            <div className="p-3 border-b border-border/50 flex items-center justify-between">
              <h2 className="font-display text-sm tracking-widest text-primary flex items-center gap-2">
                <NotebookText className="h-4 w-4" /> NOTEBOOK
              </h2>
              <Button size="sm" variant="ghost" onClick={createNotebook}><Plus className="h-4 w-4" /></Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {/* Fixed sections */}
              {FIXED_SECTIONS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => selectSection(key)}
                  className={`w-full text-left flex items-center gap-2 px-3 py-2 border-b border-border/20 hover:bg-primary/5 ${activeSection === key ? "bg-primary/10 text-primary" : ""}`}
                >
                  <Icon className="h-3.5 w-3.5" /><span className="text-sm">{label}</span>
                </button>
              ))}

              <div className="mt-2 px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground border-t border-border/40">
                Notebooks
              </div>
              {notebooks.length === 0 && <div className="p-3 text-xs text-muted-foreground">No notebooks yet.</div>}
              {notebooks.map((nb) => (
                <div key={nb.id} className={`group relative w-full border-b border-border/30 hover:bg-primary/5 ${activeId === nb.id ? "bg-primary/10" : ""}`}>
                  <button onClick={() => selectNotebook(nb.id)} className="w-full text-left p-3 pr-8">
                    <div className="text-sm font-medium truncate">{nb.title}</div>
                    <div className="text-[10px] text-muted-foreground">{new Date(nb.created_at).toLocaleDateString()}</div>
                  </button>
                  <button onClick={() => deleteNotebook(nb.id)} className="absolute opacity-0 group-hover:opacity-100 right-2 top-3 p-1 hover:text-destructive">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}

              {/* Agents section */}
              <div className="mt-2 px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground border-t border-border/40">
                Agents
              </div>
              {agents.map((agent) => {
                const isOpen = openAgents.has(agent.id);
                return (
                  <div key={agent.id} className="border-b border-border/20">
                    <button
                      onClick={() => toggleAgent(agent.id)}
                      className="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-primary/5"
                    >
                      {isOpen ? <FolderOpen className="h-3.5 w-3.5 text-primary" /> : <Folder className="h-3.5 w-3.5 text-muted-foreground" />}
                      <span className="text-sm truncate">{agent.avatar_emoji ?? "🤖"} {agent.name}</span>
                    </button>
                    {isOpen && (
                      <div className="pl-8 pb-2">
                        {(["soul", "user", "identity"] as AgentFileKind[]).map((kind) => {
                          const isActive = activeAgentFile?.agentId === agent.id && activeAgentFile.kind === kind;
                          return (
                            <button
                              key={kind}
                              onClick={() => openAgentFile(agent.id, kind)}
                              className={`w-full text-left flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-primary/5 ${isActive ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
                            >
                              <FileText className="h-3 w-3" /> {FILE_META[kind].label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {activeAgentFile ? (
          <ResizablePanel defaultSize={80}>
            <div className="h-full flex flex-col">
              <div className="p-3 border-b border-border/50 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <UserIcon className="h-4 w-4 text-primary" />
                  <span className="font-medium">{activeAgent?.name ?? "Agent"}</span>
                  <span className="text-muted-foreground">/</span>
                  <span className="text-muted-foreground">{FILE_META[activeAgentFile.kind].label}</span>
                  {editorDirty && <span className="text-[10px] text-amber-400 ml-1">● unsaved</span>}
                  {activeAgentFile.kind === "soul" && contextTokenRef.current && (
                    <span className="text-[10px] text-muted-foreground ml-2">[CONTEXT_INJECTION] required</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setActiveAgentFile(null)}><X className="h-4 w-4" /></Button>
                  <Button size="sm" onClick={saveAgentFile} disabled={editorSaving || !editorDirty}>
                    {editorSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                    Save
                  </Button>
                </div>
              </div>
              <Textarea
                value={editorText}
                onChange={(e) => { setEditorText(e.target.value); setEditorDirty(true); }}
                className="flex-1 rounded-none border-0 font-mono text-xs resize-none focus-visible:ring-0"
                placeholder={activeAgentFile.kind === "soul" ? "System prompt…" : "Notes…"}
              />
            </div>
          </ResizablePanel>
        ) : activeSection === "journal" ? (
          <ResizablePanel defaultSize={80}>
            <div className="h-full flex flex-col overflow-hidden">
              <div className="p-4 border-b border-border/50 space-y-2">
                <div className="text-sm font-medium flex items-center gap-2"><BookOpen className="h-4 w-4 text-primary" /> Journal — dated entries</div>
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <Input value={journalTitle} onChange={(e) => setJournalTitle(e.target.value)} placeholder="Entry title…" />
                  <select value={journalImportance} onChange={(e) => setJournalImportance(e.target.value)} className="bg-background border border-border rounded-md px-2 text-sm">
                    <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                  </select>
                </div>
                <Textarea value={journalContext} onChange={(e) => setJournalContext(e.target.value)} placeholder="What happened, what you're thinking…" className="min-h-[70px]" />
                <Button size="sm" onClick={() => addJournalEntry(todayStr())}><Plus className="h-3.5 w-3.5 mr-1.5" />Add entry (today)</Button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {journalEntries.length === 0 && <div className="text-xs text-muted-foreground">No journal entries yet.</div>}
                {journalEntries.map((e) => (
                  <div key={e.id} className="rounded-lg border border-border/15 p-3 text-sm group relative">
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-1">
                      <span>{e.date}</span>
                      {e.importance && <span className="uppercase">{e.importance}</span>}
                    </div>
                    <div className="font-medium">{e.title}</div>
                    {e.context && <div className="text-muted-foreground whitespace-pre-wrap mt-1">{e.context}</div>}
                    <button onClick={() => deleteJournalEntry(e.id)} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </ResizablePanel>
        ) : activeSection === "daily" ? (
          <ResizablePanel defaultSize={80}>
            <div className="h-full flex flex-col overflow-y-auto p-4 space-y-4">
              <div className="text-sm font-medium flex items-center gap-2"><Calendar className="h-4 w-4 text-primary" /> Daily agenda</div>
              {[{ label: "Today", date: todayStr() }, { label: "Tomorrow", date: tomorrowStr() }].map(({ label, date }) => {
                const existing = entryForDate(date);
                return (
                  <div key={date} className="rounded-lg border border-border/20 p-3 space-y-2">
                    <div className="text-xs uppercase tracking-widest text-muted-foreground">{label} — {date}</div>
                    {existing ? (
                      <div className="text-sm">
                        <div className="font-medium">{existing.title}</div>
                        {existing.context && <div className="text-muted-foreground whitespace-pre-wrap mt-1">{existing.context}</div>}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Input value={journalTitle} onChange={(e) => setJournalTitle(e.target.value)} placeholder={`Set the agenda for ${label.toLowerCase()}…`} />
                        <Textarea value={journalContext} onChange={(e) => setJournalContext(e.target.value)} placeholder="Details…" className="min-h-[60px]" />
                        <Button size="sm" onClick={() => addJournalEntry(date)}>Save {label.toLowerCase()}'s agenda</Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ResizablePanel>
        ) : activeSection === "decisions" ? (
          <ResizablePanel defaultSize={80}>
            <div className="h-full flex flex-col overflow-hidden">
              <div className="p-4 border-b border-border/50 space-y-2">
                <div className="text-sm font-medium flex items-center gap-2"><Brain className="h-4 w-4 text-primary" /> Decisions — what you chose, so agents learn from it</div>
                <div className="grid grid-cols-2 gap-2">
                  <select value={decisionAgentId} onChange={(e) => setDecisionAgentId(e.target.value)} className="bg-background border border-border rounded-md px-2 text-sm">
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <Input value={decisionDomain} onChange={(e) => setDecisionDomain(e.target.value)} placeholder="Domain (optional)" />
                </div>
                <Textarea value={decisionSummary} onChange={(e) => setDecisionSummary(e.target.value)} placeholder="What did you decide?" className="min-h-[60px]" />
                <div className="grid grid-cols-2 gap-2">
                  <Textarea value={decisionBefore} onChange={(e) => setDecisionBefore(e.target.value)} placeholder="What you believed before (optional)" className="min-h-[50px]" />
                  <Textarea value={decisionAfter} onChange={(e) => setDecisionAfter(e.target.value)} placeholder="What you believe now (optional)" className="min-h-[50px]" />
                </div>
                <Button size="sm" onClick={addDecision}><Plus className="h-3.5 w-3.5 mr-1.5" />Log decision</Button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {decisions.length === 0 && <div className="text-xs text-muted-foreground">No decisions logged yet.</div>}
                {decisions.map((d) => {
                  const agent = agents.find((a) => a.id === d.agent_id);
                  return (
                    <div key={d.id} className="rounded-lg border border-border/15 p-3 text-sm">
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-1">
                        <span>{new Date(d.created_at).toLocaleDateString()}</span>
                        <span>{agent?.name ?? "Unknown agent"}</span>
                        {d.domain && <span>· {d.domain}</span>}
                      </div>
                      <div className="font-medium">{d.event_summary}</div>
                      {(d.belief_before || d.belief_after) && (
                        <div className="text-muted-foreground mt-1 text-xs">
                          {d.belief_before && <div>Before: {d.belief_before}</div>}
                          {d.belief_after && <div>After: {d.belief_after}</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </ResizablePanel>
        ) : activeSection === "meetings" ? (
          <ResizablePanel defaultSize={80}>
            <div className="h-full flex flex-col overflow-hidden">
              <div className="p-4 border-b border-border/50 space-y-2">
                <div className="text-sm font-medium flex items-center gap-2"><Users className="h-4 w-4 text-primary" /> Meetings — log interactions and how they went</div>
                <div className="grid grid-cols-[auto_1fr] gap-2">
                  <Input type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} className="w-40" />
                  <Input value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} placeholder="Who/what was this meeting?" />
                </div>
                <Textarea value={meetingNotes} onChange={(e) => setMeetingNotes(e.target.value)} placeholder="Notes…" className="min-h-[60px]" />
                <Textarea value={meetingOutcome} onChange={(e) => setMeetingOutcome(e.target.value)} placeholder="Outcome / next steps…" className="min-h-[50px]" />
                <Button size="sm" onClick={addMeeting}><Plus className="h-3.5 w-3.5 mr-1.5" />Log meeting</Button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {meetings.length === 0 && <div className="text-xs text-muted-foreground">No meetings logged yet.</div>}
                {meetings.map((m) => (
                  <div key={m.id} className="rounded-lg border border-border/15 p-3 text-sm group relative">
                    <div className="text-[10px] text-muted-foreground mb-1">{m.meeting_date}</div>
                    <div className="font-medium">{m.title}</div>
                    {m.notes && <div className="text-muted-foreground whitespace-pre-wrap mt-1">{m.notes}</div>}
                    {m.outcome && <div className="text-muted-foreground mt-1 text-xs">Outcome: {m.outcome}</div>}
                    <button onClick={() => deleteMeeting(m.id)} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </ResizablePanel>
        ) : (
          <ResizablePanel defaultSize={80}>
            <div className="h-full flex flex-col border-r border-border/50">
              <div className="p-4 border-b border-border/50">
                <div className="text-xs text-muted-foreground mb-2">Sources</div>
                {!activeId && <div className="text-xs text-zinc-500">Select or create a notebook first.</div>}
                {activeId && (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <Input value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="Paste a URL…"
                        onKeyDown={(e) => { if (e.key === "Enter") addUrlSource(); }} disabled={ingesting} />
                      <Button size="icon" variant="outline" onClick={addUrlSource} disabled={ingesting || !urlInput.trim()}><LinkIcon className="h-4 w-4" /></Button>
                    </div>
                    <input ref={fileInputRef} type="file" className="hidden" onChange={onFileChosen} />
                    <Button variant="outline" className="w-full" onClick={() => fileInputRef.current?.click()} disabled={ingesting}>
                      {ingesting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                      Upload file
                    </Button>
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
                {!activeId && <p className="text-sm text-muted-foreground p-1">Select or create a notebook, then add sources — files, URLs, or text. Agents can reference this material directly.</p>}
                {sources.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg p-2 border border-border/15 bg-white/3 text-xs">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {s.source_type === "url" ? <LinkIcon className="h-3 w-3 shrink-0 text-muted-foreground" /> : <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />}
                      <span className="truncate">{s.title}</span>
                    </div>
                    <button onClick={() => removeSource(s.id)} className="shrink-0 text-muted-foreground hover:text-destructive"><X className="h-3 w-3" /></button>
                  </div>
                ))}
              </div>
            </div>
          </ResizablePanel>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
