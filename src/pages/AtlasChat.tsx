import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Send, Paperclip, X, Plus, ChevronDown, ChevronRight,
  MessageSquare, FolderOpen, Trash2, Edit2, Check, MoreHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { detectDomain, detectEmotionalValence, detectImportanceScore, storeMemory } from "@/lib/atlas-memory";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

interface Conversation {
  id: string;
  project_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const PAGE_SIZE = 30;
// forge_chat is the primary endpoint (deployed, proven working).
// atlas-core is the upgraded replacement — used as fallback while it propagates.
const PRIMARY_URL  = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/forge_chat`;
const FALLBACK_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/atlas-core`;

// ── Helpers ────────────────────────────────────────────────────────────────────

function dateGroup(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays <= 7) return "Last 7 days";
  if (diffDays <= 30) return "Last 30 days";
  return d.toLocaleString("default", { month: "long", year: "numeric" });
}

function truncate(s: string, n = 40): string {
  return s.length <= n ? s : s.slice(0, n).trimEnd() + "…";
}

const PROJECT_COLORS: Record<string, string> = {
  orange: "bg-accent/20 text-accent",
  blue:   "bg-blue-400/20 text-blue-400",
  green:  "bg-green-400/20 text-green-400",
  purple: "bg-purple-400/20 text-purple-400",
  red:    "bg-red-400/20 text-red-400",
};

// ── Component ──────────────────────────────────────────────────────────────────

const AtlasChat = () => {
  const { user } = useAuth();

  // ── Sidebar state ────────────────────────────────────────
  const [projects,      setProjects]      = useState<Project[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [expandedProj,  setExpandedProj]  = useState<Record<string, boolean>>({});
  const [sidebarOpen,   setSidebarOpen]   = useState(true);

  // New project form
  const [showNewProject,  setShowNewProject]  = useState(false);
  const [newProjectName,  setNewProjectName]  = useState("");
  const [newProjectColor, setNewProjectColor] = useState("orange");

  // Rename conversation
  const [renamingId,    setRenamingId]    = useState<string | null>(null);
  const [renameValue,   setRenameValue]   = useState("");

  // ── Chat state ───────────────────────────────────────────
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [messages,      setMessages]      = useState<ChatMessage[]>([]);
  const [hasMore,       setHasMore]       = useState(false);
  const [loadingMore,   setLoadingMore]   = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [streaming,     setStreaming]     = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [input,         setInput]         = useState("");
  const [attachment,    setAttachment]    = useState<{ name: string; media_type: string; data: string } | null>(null);

  // ── Refs ─────────────────────────────────────────────────
  const bottomRef        = useRef<HTMLDivElement>(null);
  const sentinelRef      = useRef<HTMLDivElement>(null);
  const scrollRef        = useRef<HTMLDivElement>(null);
  const textareaRef      = useRef<HTMLTextAreaElement>(null);
  const fileInputRef     = useRef<HTMLInputElement>(null);
  const abortRef         = useRef<AbortController | null>(null);
  const oldestMsgDate    = useRef<string | null>(null);
  const isInitialLoad    = useRef(true);

  // ── Load sidebar data ────────────────────────────────────
  const loadSidebar = useCallback(async () => {
    if (!user) return;
    try {
      const [projRes, convRes] = await Promise.all([
        supabase.from("atlas_projects").select("id, name, color, created_at").eq("user_id", user.id).order("created_at", { ascending: false }),
        supabase.from("atlas_conversations").select("id, project_id, title, created_at, updated_at").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(100),
      ]);
      setProjects((projRes.data ?? []) as Project[]);
      setConversations((convRes.data ?? []) as Conversation[]);
    } catch { /* tables not yet migrated — sidebar stays empty, chat still works */ }
  }, [user]);

  useEffect(() => { void loadSidebar(); }, [loadSidebar]);

  // ── Load messages for a conversation ─────────────────────
  const loadMessages = useCallback(async (convId: string, reset = true) => {
    if (reset) {
      setMessages([]);
      setHasMore(false);
      oldestMsgDate.current = null;
      isInitialLoad.current = true;
    }
    setHistoryLoaded(false);

    const { data } = await supabase
      .from("atlas_messages")
      .select("id, conversation_id, role, content, created_at")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);

    if (!data) { setHistoryLoaded(true); return; }

    const ordered = [...data].reverse() as ChatMessage[];
    setMessages(ordered);
    setHasMore(data.length === PAGE_SIZE);
    oldestMsgDate.current = ordered[0]?.created_at ?? null;
    setHistoryLoaded(true);
  }, []);

  // ── Infinite scroll — load older messages ─────────────────
  const loadMoreMessages = useCallback(async () => {
    if (!currentConvId || !hasMore || loadingMore || !oldestMsgDate.current) return;
    setLoadingMore(true);

    const scrollEl = scrollRef.current;
    const prevHeight = scrollEl?.scrollHeight ?? 0;

    const { data } = await supabase
      .from("atlas_messages")
      .select("id, conversation_id, role, content, created_at")
      .eq("conversation_id", currentConvId)
      .lt("created_at", oldestMsgDate.current)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);

    if (!data || data.length === 0) {
      setHasMore(false);
      setLoadingMore(false);
      return;
    }

    const older = [...data].reverse() as ChatMessage[];
    oldestMsgDate.current = older[0].created_at;
    setHasMore(data.length === PAGE_SIZE);

    setMessages((prev) => [...older, ...prev]);
    setLoadingMore(false);

    // Restore scroll position so the view doesn't jump
    requestAnimationFrame(() => {
      if (scrollEl) {
        scrollEl.scrollTop = scrollEl.scrollHeight - prevHeight;
      }
    });
  }, [currentConvId, hasMore, loadingMore]);

  // ── IntersectionObserver for infinite scroll ──────────────
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) void loadMoreMessages(); },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMoreMessages]);

  // ── Auto-scroll to bottom on new messages ────────────────
  useEffect(() => {
    if (isInitialLoad.current && historyLoaded) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
      isInitialLoad.current = false;
    } else if (streaming || (!loadingMore && messages.length > 0)) {
      const el = scrollRef.current;
      if (el) {
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
        if (nearBottom || streaming) {
          bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        }
      }
    }
  }, [messages, streaming, historyLoaded, loadingMore]);

  // ── Select / open a conversation ──────────────────────────
  const openConversation = useCallback(async (convId: string) => {
    abortRef.current?.abort();
    setCurrentConvId(convId);
    setStreamContent("");
    setStreaming(false);
    await loadMessages(convId);
  }, [loadMessages]);

  // ── Create a new conversation ─────────────────────────────
  const startNewChat = useCallback(async (projectId?: string) => {
    if (!user) return;
    abortRef.current?.abort();
    setMessages([]);
    setStreamContent("");
    setStreaming(false);
    setHasMore(false);
    setHistoryLoaded(true);
    isInitialLoad.current = false;

    const localId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      const { data, error } = await supabase
        .from("atlas_conversations")
        .insert({ user_id: user.id, project_id: projectId ?? null, title: "New conversation" })
        .select("id, project_id, title, created_at, updated_at")
        .single();
      if (!error && data) {
        setCurrentConvId(data.id);
        setConversations((prev) => [data as Conversation, ...prev]);
        return;
      }
    } catch { /* table not yet migrated — fall through to local session */ }

    // Fallback: local session (no persistence)
    setCurrentConvId(localId);
    setConversations((prev) => [{ id: localId, project_id: projectId ?? null, title: "New conversation", created_at: now, updated_at: now }, ...prev]);
  }, [user]);

  // ── Create project ────────────────────────────────────────
  const createProject = async () => {
    if (!user || !newProjectName.trim()) return;
    try {
      const { data, error } = await supabase
        .from("atlas_projects")
        .insert({ user_id: user.id, name: newProjectName.trim(), color: newProjectColor })
        .select("id, name, color, created_at")
        .single();
      if (error || !data) throw new Error();
      setProjects((prev) => [data as Project, ...prev]);
      setExpandedProj((p) => ({ ...p, [data.id]: true }));
      setNewProjectName("");
      setShowNewProject(false);
      toast.success(`Project "${data.name}" created.`);
    } catch {
      toast.error("Projects require the migration to be applied. Ask Atlas to help.");
    }
  };

  // ── Delete conversation ───────────────────────────────────
  const deleteConversation = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await supabase.from("atlas_conversations").delete().eq("id", convId);
    setConversations((prev) => prev.filter((c) => c.id !== convId));
    if (currentConvId === convId) {
      setCurrentConvId(null);
      setMessages([]);
    }
  };

  // ── Rename conversation ───────────────────────────────────
  const commitRename = async (convId: string) => {
    if (!renameValue.trim()) { setRenamingId(null); return; }
    await supabase.from("atlas_conversations").update({ title: renameValue.trim() }).eq("id", convId);
    setConversations((prev) => prev.map((c) => c.id === convId ? { ...c, title: renameValue.trim() } : c));
    setRenamingId(null);
  };

  // ── File attachment ───────────────────────────────────────
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = (reader.result as string).split(",")[1];
      setAttachment({ name: file.name, media_type: file.type, data: b64 });
    };
    reader.readAsDataURL(file);
  };

  // ── Send message ──────────────────────────────────────────
  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || streaming) return;
    if (!user) return;

    setInput("");
    setAttachment(null);

    // Ensure a conversation exists (fall back to local UUID if tables not migrated yet)
    let convId = currentConvId;
    let isFirstMessage = false;
    if (!convId) {
      const localId = crypto.randomUUID();
      const now = new Date().toISOString();
      const title = truncate(text, 50);
      try {
        const { data, error } = await supabase
          .from("atlas_conversations")
          .insert({ user_id: user.id, title })
          .select("id, project_id, title, created_at, updated_at")
          .single();
        if (!error && data) {
          convId = data.id;
          setCurrentConvId(convId);
          setConversations((prev) => [data as Conversation, ...prev]);
        } else throw new Error();
      } catch {
        convId = localId;
        setCurrentConvId(localId);
        setConversations((prev) => [{ id: localId, project_id: null, title, created_at: now, updated_at: now }, ...prev]);
      }
      isFirstMessage = true;
    }

    // Save user message — silent fail if table not yet migrated
    const { data: userMsg } = await supabase
      .from("atlas_messages")
      .insert({ conversation_id: convId, role: "user", content: text })
      .select("id, conversation_id, role, content, created_at")
      .single()
      .catch(() => ({ data: null })) as { data: ChatMessage | null };

    const userMsgRow: ChatMessage = userMsg ?? {
      id: crypto.randomUUID(),
      conversation_id: convId,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsgRow]);

    // Stream from atlas-core
    setStreaming(true);
    setStreamContent("");
    abortRef.current = new AbortController();

    try {
      const { data: { session } } = await supabase.auth.getSession();

      // Build messages array: recent history + current user message
      const historyMsgs = messages.slice(-12).map((m) => ({ role: m.role, content: m.content }));
      const allMessages = [...historyMsgs, { role: "user", content: text }];

      const chatBody = JSON.stringify({
        action: "chat",
        messages: allMessages,
        ...(attachment ? { attachments: [attachment] } : {}),
      });
      const authHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session?.access_token}`,
      };

      // Try primary (forge_chat) first; fall back to atlas-core on failure.
      // Auth errors (401) and credits exhausted (402) won't be fixed by retrying.
      const shouldFallback = (status: number) => status !== 401 && status !== 402;

      let res = await fetch(PRIMARY_URL, {
        method: "POST",
        headers: authHeaders,
        body: chatBody,
        signal: abortRef.current.signal,
      });

      if (!res.ok && shouldFallback(res.status)) {
        console.warn(`[AtlasChat] ${PRIMARY_URL} returned ${res.status}, trying fallback`);
        res = await fetch(FALLBACK_URL, {
          method: "POST",
          headers: authHeaders,
          body: chatBody,
          signal: abortRef.current!.signal,
        });
      }

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Stream failed (${res.status}): ${errText.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") break;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed?.delta?.text ?? parsed?.choices?.[0]?.delta?.content ?? "";
            if (delta) { full += delta; setStreamContent(full); }
          } catch { /* non-JSON SSE line */ }
        }
      }

      if (!full) full = "I'm here.";

      // Save assistant message — silent fail if table not yet migrated
      const { data: assistantMsg } = await supabase
        .from("atlas_messages")
        .insert({ conversation_id: convId, role: "assistant", content: full })
        .select("id, conversation_id, role, content, created_at")
        .single()
        .catch(() => ({ data: null })) as { data: ChatMessage | null };

      const assistantMsgRow: ChatMessage = assistantMsg ?? {
        id: crypto.randomUUID(),
        conversation_id: convId,
        role: "assistant",
        content: full,
        created_at: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMsgRow]);
      setStreamContent("");

      // Update conversation metadata — silent fail if table not yet migrated
      const now = new Date().toISOString();
      if (isFirstMessage) {
        const newTitle = truncate(text, 50);
        supabase.from("atlas_conversations").update({ title: newTitle, updated_at: now }).eq("id", convId).then(() => {});
        setConversations((prev) => prev.map((c) => c.id === convId ? { ...c, title: newTitle, updated_at: now } : c));
      } else {
        supabase.from("atlas_conversations").update({ updated_at: now }).eq("id", convId).then(() => {});
        setConversations((prev) => {
          const updated = prev.map((c) => c.id === convId ? { ...c, updated_at: now } : c);
          return [...updated].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
        });
      }

      // Store in atlas_memory for semantic recall
      const domain = detectDomain(text);
      const importance = detectImportanceScore(text, domain);
      const valence = detectEmotionalValence(text);
      if (importance > 0.4) {
        void storeMemory({ content: `User: ${text}\nAtlas: ${full.slice(0, 500)}`, domain, sessionId: convId, emotionalValence: valence, importanceScore: importance });
      }

    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[AtlasChat] sendMessage error:", msg);
      toast.error(`Atlas error: ${msg.slice(0, 120)}`);
      setStreamContent("");
    } finally {
      setStreaming(false);
    }
  }, [input, streaming, user, currentConvId, messages, attachment]);

  // ── Keyboard submit ───────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); }
  };

  // ── Derived: group conversations by project + date ────────
  const projectConvs = (projId: string) => conversations.filter((c) => c.project_id === projId);
  const standaloneConvs = conversations.filter((c) => c.project_id === null);

  const grouped: Record<string, Conversation[]> = {};
  for (const c of standaloneConvs) {
    const g = dateGroup(c.updated_at);
    (grouped[g] ??= []).push(c);
  }
  const groupOrder = ["Today", "Yesterday", "Last 7 days", "Last 30 days"];
  const allGroups = [
    ...groupOrder.filter((g) => grouped[g]),
    ...Object.keys(grouped).filter((g) => !groupOrder.includes(g)),
  ];

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Conversation sidebar ─────────────────────────── */}
      <div className={`${sidebarOpen ? "w-64" : "w-0"} shrink-0 flex flex-col border-r border-border/40 bg-sidebar transition-all duration-200 overflow-hidden`}>

        {/* New chat */}
        <div className="p-3 border-b border-border/30">
          <Button
            onClick={() => void startNewChat()}
            className="w-full justify-start gap-2 bg-accent/10 text-accent hover:bg-accent/20 border border-accent/30 font-display tracking-wider text-xs"
            size="sm"
          >
            <Plus className="h-3.5 w-3.5" />
            New Chat
          </Button>
        </div>

        {/* Scrollable list */}
        <div className="flex-1 overflow-y-auto py-2 space-y-0.5 min-h-0">

          {/* Projects section */}
          <div className="px-3 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-display tracking-widest text-muted-foreground/50 uppercase">Projects</span>
              <button
                onClick={() => setShowNewProject((v) => !v)}
                className="text-muted-foreground/40 hover:text-accent transition-colors"
                title="New project"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>

            {showNewProject && (
              <div className="mt-2 space-y-2">
                <Input
                  autoFocus
                  placeholder="Project name"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void createProject(); if (e.key === "Escape") setShowNewProject(false); }}
                  className="h-7 text-xs bg-secondary/30 border-border/30"
                />
                <div className="flex gap-1">
                  {Object.keys(PROJECT_COLORS).map((c) => (
                    <button
                      key={c}
                      onClick={() => setNewProjectColor(c)}
                      className={`w-5 h-5 rounded-full border-2 transition-all ${PROJECT_COLORS[c].split(" ")[0]} ${newProjectColor === c ? "border-white scale-110" : "border-transparent"}`}
                    />
                  ))}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" onClick={createProject} disabled={!newProjectName.trim()} className="h-6 text-[10px] flex-1 bg-accent text-accent-foreground">Create</Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowNewProject(false)} className="h-6 text-[10px]">Cancel</Button>
                </div>
              </div>
            )}
          </div>

          {projects.map((proj) => {
            const convs = projectConvs(proj.id);
            const isOpen = expandedProj[proj.id] ?? false;
            return (
              <div key={proj.id}>
                <button
                  onClick={() => setExpandedProj((p) => ({ ...p, [proj.id]: !isOpen }))}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-primary/5 transition-colors group"
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${PROJECT_COLORS[proj.color]?.split(" ")[0] ?? "bg-accent/20"}`} />
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  <span className="flex-1 text-left text-foreground/80 truncate font-medium">{proj.name}</span>
                  <span className="text-[10px] text-muted-foreground/30 shrink-0">{convs.length}</span>
                  {isOpen ? <ChevronDown className="h-3 w-3 text-muted-foreground/40" /> : <ChevronRight className="h-3 w-3 text-muted-foreground/40" />}
                </button>
                {isOpen && (
                  <div className="ml-5">
                    <button
                      onClick={() => void startNewChat(proj.id)}
                      className="w-full flex items-center gap-2 px-3 py-1 text-[10px] text-muted-foreground/50 hover:text-accent transition-colors"
                    >
                      <Plus className="h-3 w-3" /> New chat in {proj.name}
                    </button>
                    {convs.map((c) => (
                      <ConvItem
                        key={c.id}
                        conv={c}
                        active={c.id === currentConvId}
                        renamingId={renamingId}
                        renameValue={renameValue}
                        onSelect={() => void openConversation(c.id)}
                        onDelete={(e) => void deleteConversation(c.id, e)}
                        onRenameStart={() => { setRenamingId(c.id); setRenameValue(c.title); }}
                        onRenameChange={setRenameValue}
                        onRenameCommit={() => void commitRename(c.id)}
                      />
                    ))}
                    {convs.length === 0 && (
                      <p className="px-3 py-1 text-[10px] text-muted-foreground/30">No chats yet</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Standalone conversations grouped by date */}
          {allGroups.map((group) => (
            <div key={group}>
              <div className="px-3 pt-3 pb-1">
                <span className="text-[10px] font-display tracking-widest text-muted-foreground/40 uppercase">{group}</span>
              </div>
              {(grouped[group] ?? []).map((c) => (
                <ConvItem
                  key={c.id}
                  conv={c}
                  active={c.id === currentConvId}
                  renamingId={renamingId}
                  renameValue={renameValue}
                  onSelect={() => void openConversation(c.id)}
                  onDelete={(e) => void deleteConversation(c.id, e)}
                  onRenameStart={() => { setRenamingId(c.id); setRenameValue(c.title); }}
                  onRenameChange={setRenameValue}
                  onRenameCommit={() => void commitRename(c.id)}
                />
              ))}
            </div>
          ))}

          {conversations.length === 0 && (
            <div className="px-4 py-6 text-center">
              <MessageSquare className="h-6 w-6 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-[10px] text-muted-foreground/40">No conversations yet.</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Chat area ────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Chat header */}
        <div className="h-10 flex items-center px-4 border-b border-border/30 gap-3 shrink-0">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="text-muted-foreground/50 hover:text-primary transition-colors"
            title="Toggle conversation list"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          <span className="text-xs font-display tracking-widest text-primary truncate">
            {currentConvId
              ? (conversations.find((c) => c.id === currentConvId)?.title ?? "Atlas")
              : "Atlas"}
          </span>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-4 py-6 space-y-6">

          {/* Infinite scroll sentinel — at the very top */}
          <div ref={sentinelRef} className="h-1" />

          {loadingMore && (
            <div className="text-center py-2">
              <span className="text-[10px] text-muted-foreground/40 animate-pulse">Loading earlier messages…</span>
            </div>
          )}

          {/* Empty state */}
          {!currentConvId && historyLoaded && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-6 text-center py-20">
              <div className="space-y-2">
                <p className="text-2xl font-display text-primary tracking-widest">ATLAS</p>
                <p className="text-sm text-muted-foreground/60 max-w-sm">
                  Your autonomous intelligence partner. What's on your mind?
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2 max-w-md">
                {[
                  "What's worth paying attention to today?",
                  "Run the morning brief.",
                  "Check my positions.",
                  "Scan the forex pairs.",
                ].map((chip) => (
                  <button
                    key={chip}
                    onClick={() => void sendMessage(chip)}
                    className="px-3 py-1.5 rounded-full text-xs border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          )}

          {currentConvId && historyLoaded && messages.length === 0 && !streaming && (
            <div className="flex flex-col items-center justify-center h-full gap-3 py-20 text-center">
              <MessageSquare className="h-8 w-8 text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground/50">Start the conversation.</p>
            </div>
          )}

          {/* Message list */}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}

          {/* Streaming bubble */}
          {streaming && streamContent && (
            <div className="flex gap-3 max-w-3xl">
              <div className="w-7 h-7 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-[9px] font-display text-accent">A</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{streamContent}</p>
                <span className="inline-block w-1.5 h-4 bg-accent animate-pulse ml-0.5 align-text-bottom" />
              </div>
            </div>
          )}

          {streaming && !streamContent && (
            <div className="flex gap-3 max-w-3xl">
              <div className="w-7 h-7 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center shrink-0">
                <span className="text-[9px] font-display text-accent">A</span>
              </div>
              <div className="flex gap-1 items-center h-7">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="w-1.5 h-1.5 rounded-full bg-accent/60 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        <div className="border-t border-border/30 p-4 shrink-0">
          {attachment && (
            <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-secondary/30 border border-border/30 text-xs text-muted-foreground w-fit">
              <Paperclip className="h-3 w-3" />
              {attachment.name}
              <button onClick={() => setAttachment(null)} className="hover:text-destructive transition-colors ml-1">
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <div className="flex gap-2 items-end max-w-3xl mx-auto">
            <input ref={fileInputRef} type="file" accept="image/*,.pdf" className="hidden" onChange={handleFile} />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 p-2 rounded-xl border border-border/40 text-muted-foreground hover:text-foreground hover:border-border/70 transition-colors mb-0.5"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message Atlas…"
              className="flex-1 resize-none min-h-[44px] max-h-[200px] rounded-xl border-border/50 bg-secondary/20 focus:bg-secondary/30 transition-colors text-sm"
              rows={1}
            />
            <Button
              onClick={() => void sendMessage()}
              disabled={!input.trim() || streaming}
              size="icon"
              className="shrink-0 rounded-xl bg-accent hover:bg-accent/90 text-accent-foreground disabled:opacity-30 mb-0.5"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-center text-[10px] text-muted-foreground/30 mt-2">Enter to send · Shift+Enter for new line</p>
        </div>
      </div>
    </div>
  );
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex gap-3 max-w-3xl ${isUser ? "ml-auto flex-row-reverse" : ""}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-[9px] font-display text-accent">A</span>
        </div>
      )}
      <div className={`flex-1 min-w-0 ${isUser ? "flex flex-col items-end" : ""}`}>
        <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-accent/15 border border-accent/25 text-foreground max-w-[85%]"
            : "text-foreground/90"
        }`}>
          {msg.content}
        </div>
        <span className="text-[9px] text-muted-foreground/30 mt-1 px-1">
          {new Date(msg.created_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
    </div>
  );
}

interface ConvItemProps {
  conv: Conversation;
  active: boolean;
  renamingId: string | null;
  renameValue: string;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onRenameStart: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
}

function ConvItem({ conv, active, renamingId, renameValue, onSelect, onDelete, onRenameStart, onRenameChange, onRenameCommit }: ConvItemProps) {
  const isRenaming = renamingId === conv.id;
  return (
    <div
      onClick={!isRenaming ? onSelect : undefined}
      className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-md mx-1 cursor-pointer transition-colors ${
        active ? "bg-accent/10 text-accent" : "text-foreground/70 hover:bg-primary/5 hover:text-foreground"
      }`}
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-50" />
      {isRenaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onRenameCommit(); if (e.key === "Escape") onRenameChange(""); }}
          onBlur={onRenameCommit}
          className="flex-1 text-xs bg-transparent border-b border-accent outline-none"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 text-xs truncate">{conv.title}</span>
      )}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {isRenaming ? (
          <button onClick={(e) => { e.stopPropagation(); onRenameCommit(); }} className="p-0.5 hover:text-green-400">
            <Check className="h-3 w-3" />
          </button>
        ) : (
          <>
            <button onClick={(e) => { e.stopPropagation(); onRenameStart(); }} className="p-0.5 hover:text-primary">
              <Edit2 className="h-3 w-3" />
            </button>
            <button onClick={onDelete} className="p-0.5 hover:text-destructive">
              <Trash2 className="h-3 w-3" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default AtlasChat;
