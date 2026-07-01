import { useEffect, useRef, useState } from "react";
import { getAgentVoice, speakChunkedForce, speakChunkedQueue } from "@/lib/agent-voice";
import { useConversationMode, ConversationModeButton } from "@/lib/voice-input";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Mic, MicOff, Send, Plus, MessageSquare, Trash2, Volume2, VolumeX } from "lucide-react";
import { toast } from "sonner";

type Entry = { id: string; title: string | null; content: string; entry_type: string; created_at: string };
type Agent = { id: string; name: string; slug: string; avatar_emoji: string };
type Msg = { id: string; role: string; agent_slug: string | null; content: string; created_at: string };
type Session = { id: string; title: string | null; agent_slugs: string[]; entry_id: string | null; created_at: string };

const ENTRY_TYPES = ["thought", "idea", "mental_model", "concept"];

function colorFor(slug: string) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 60%)`;
}

export default function ClosedChamberPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeEntry, setActiveEntry] = useState<Entry | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftType, setDraftType] = useState("thought");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [globalVoice, setGlobalVoice] = useState<boolean>(() => {
    try { return JSON.parse(localStorage.getItem("chamber_global_voice") ?? "true"); } catch { return true; }
  });
  const [leftTab, setLeftTab] = useState<"threads" | "entries">("threads");

  const toggleGlobalVoice = () => {
    setGlobalVoice(prev => {
      const next = !prev;
      localStorage.setItem("chamber_global_voice", JSON.stringify(next));
      if (!next && window.speechSynthesis) window.speechSynthesis.cancel();
      return next;
    });
  };
  const recRef = useRef<any>(null);
  const recTargetRef = useRef<"draft" | "input">("input");
  const recBaseRef = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const recordingRef = useRef(false);

  const loadSessions = async () => {
    const { data } = await supabase.from("chamber_sessions").select("*").order("created_at", { ascending: false });
    setSessions((data as Session[]) ?? []);
  };

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const [e, a, s] = await Promise.all([
        supabase.from("chamber_entries").select("*").order("created_at", { ascending: false }),
        supabase.from("skyforge_agents").select("id,name,slug,avatar_emoji").eq("is_active", true),
        supabase.from("chamber_sessions").select("*").order("created_at", { ascending: false }),
      ]);
      setEntries((e.data as Entry[]) ?? []);
      const agentList = (a.data as Agent[]) ?? [];
      setAgents(agentList);
      setSessions((s.data as Session[]) ?? []);
      const defaults = agentList.filter(x => ["atlas", "janus"].includes(x.slug)).map(x => x.slug);
      setSelectedAgents(defaults.length ? defaults : agentList.slice(0, 2).map(x => x.slug));
    })();
  }, []);

  useEffect(() => { recordingRef.current = recording; }, [recording]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages, streaming]);

  const newEntry = () => {
    setActiveEntry(null);
    setDraftTitle(""); setDraftContent(""); setDraftType("thought");
  };

  const newThread = () => {
    setSessionId(null);
    setMessages([]);
    setStreaming({});
    setActiveEntry(null);
  };

  const openSession = async (s: Session) => {
    setSessionId(s.id);
    setSelectedAgents(s.agent_slugs ?? []);
    setStreaming({});
    if (s.entry_id) {
      const { data: e } = await supabase.from("chamber_entries").select("*").eq("id", s.entry_id).maybeSingle();
      setActiveEntry((e as Entry) ?? null);
    } else {
      setActiveEntry(null);
    }
    const { data: m } = await supabase.from("chamber_messages").select("*").eq("session_id", s.id).order("created_at", { ascending: true });
    setMessages((m as Msg[]) ?? []);
  };

  const deleteSession = async (id: string) => {
    if (!confirm("Delete this conversation?")) return;
    await supabase.from("chamber_messages").delete().eq("session_id", id);
    await supabase.from("chamber_sessions").delete().eq("id", id);
    if (sessionId === id) newThread();
    loadSessions();
  };

  const saveEntry = async () => {
    if (!draftContent.trim()) return;
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    const { data, error } = await supabase.from("chamber_entries").insert({
      user_id: u.user.id, title: draftTitle || null, content: draftContent, entry_type: draftType,
    }).select().single();
    if (error) return toast.error(error.message);
    setEntries(prev => [data as Entry, ...prev]);
    setActiveEntry(data as Entry);
    toast.success("Saved");
  };

  const openDiscussion = async () => {
    if (selectedAgents.length === 0) return toast.error("Select at least one agent");
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    const { data, error } = await supabase.from("chamber_sessions").insert({
      user_id: u.user.id,
      entry_id: activeEntry?.id ?? null,
      agent_slugs: selectedAgents,
      title: activeEntry?.title ?? activeEntry?.content?.slice(0, 60) ?? `Chamber ${new Date().toLocaleString()}`,
    }).select().single();
    if (error) return toast.error(error.message);
    setSessionId(data.id);
    setMessages([]);
    loadSessions();
  };

  const toggleAgent = async (slug: string) => {
    const next = selectedAgents.includes(slug) ? selectedAgents.filter(s => s !== slug) : [...selectedAgents, slug];
    setSelectedAgents(next);
    if (sessionId) {
      await supabase.from("chamber_sessions").update({ agent_slugs: next }).eq("id", sessionId);
      loadSessions();
    }
  };

  const toggleVoice = (target: "draft" | "input") => {
    if (recording) { try { recRef.current?.stop(); } catch {} setRecording(false); return; }
    // Cancel any ongoing TTS when mic turns on so it doesn't bleed into recording
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return toast.error("Voice not supported");
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.lang = "en-US";
    recTargetRef.current = target;
    recBaseRef.current = target === "draft" ? (draftContent ? draftContent + " " : "") : (input ? input + " " : "");
    r.onresult = (e: any) => {
      let finalT = ""; let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalT += res[0].transcript + " ";
        else interim += res[0].transcript;
      }
      if (finalT) recBaseRef.current += finalT;
      const text = recBaseRef.current + interim;
      if (recTargetRef.current === "draft") setDraftContent(text);
      else setInput(text);
    };
    r.onerror = (ev: any) => { if (ev.error !== "no-speech") { setRecording(false); toast.error(ev.error || "Voice error"); } };
    r.onend = () => { if (recording) { try { r.start(); } catch { setRecording(false); } } };
    recRef.current = r; setRecording(true);
    try { r.start(); } catch { setRecording(false); }
  };

  const speak = (agentSlug: string, text: string) => {
    if (!globalVoice) return;
    // Use ref so async send() always reads the live recording state, not the stale closure value.
    // Mic ON → cancel before each agent so only the last one is heard.
    // Mic OFF → queue so all agents speak in sequence.
    if (recordingRef.current) speakChunkedForce(agentSlug, text);
    else speakChunkedQueue(agentSlug, text);
  };

  const send = async (overrideText?: string) => {
    const text = overrideText ?? input;
    if (!text.trim() || selectedAgents.length === 0) return;
    // Stop mic before sending so agents always speak in queue mode after delivery
    if (recordingRef.current) { try { recRef.current?.stop(); } catch {} setRecording(false); recordingRef.current = false; }
    setSending(true);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) { setSending(false); return; }

    // Auto-create session if none
    let sid = sessionId;
    if (!sid) {
      const { data, error } = await supabase.from("chamber_sessions").insert({
        user_id: u.user.id,
        entry_id: activeEntry?.id ?? null,
        agent_slugs: selectedAgents,
        title: activeEntry?.title ?? text.trim().slice(0, 60),
      }).select().single();
      if (error) { toast.error(error.message); setSending(false); return; }
      sid = data.id;
      setSessionId(sid);
      loadSessions();
    }

    const userMsgContent = text.trim();
    setInput("");

    const { data: userMsg, error: uErr } = await supabase.from("chamber_messages").insert({
      session_id: sid, user_id: u.user.id, role: "user", agent_slug: null, content: userMsgContent,
    }).select().single();
    if (uErr) { toast.error(uErr.message); setSending(false); return; }
    setMessages(prev => [...prev, userMsg as Msg]);

    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const url = `https://hycpzeskartlkybsfkbh.supabase.co/functions/v1/chamber-chat`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: sid, entry_id: activeEntry?.id, agent_slugs: selectedAgents, user_id: u.user.id }),
      });
      if (!resp.ok || !resp.body) { toast.error("Chamber failed"); setSending(false); return; }

      const reader = resp.body.getReader(); const dec = new TextDecoder();
      let buf = ""; const accum: Record<string, string> = {};
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.type === "delta") {
              accum[d.agent_slug] = (accum[d.agent_slug] ?? "") + d.text;
              setStreaming(prev => ({ ...prev, [d.agent_slug]: accum[d.agent_slug] }));
            } else if (d.type === "agent_end") {
              const final = accum[d.agent_slug] ?? "";
              setMessages(prev => [...prev, { id: crypto.randomUUID(), role: d.agent_slug, agent_slug: d.agent_slug, content: final, created_at: new Date().toISOString() }]);
              setStreaming(prev => { const c = { ...prev }; delete c[d.agent_slug]; return c; });
              speak(d.agent_slug, final);
            }
          } catch {}
        }
      }
    } catch (e: any) {
      toast.error(e.message);
    }
    setSending(false);
  };

  const { active: convoActive, listening: convoListening, toggle: toggleConvo } = useConversationMode((text) => { void send(text); });

  return (
    <div className="h-screen bg-background text-foreground">
      <ResizablePanelGroup direction="horizontal" className="h-full">
        {/* Left: threads / entries */}
        <ResizablePanel defaultSize={18} minSize={12} maxSize={30}>
          <div className="h-full flex flex-col border-r border-border/50">
            <div className="p-3 border-b border-border/50">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-display text-sm tracking-widest text-primary">CHAMBER</h2>
                <Button size="sm" variant="ghost" onClick={leftTab === "threads" ? newThread : newEntry}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex gap-1">
                <button onClick={() => setLeftTab("threads")}
                  className={`flex-1 text-xs px-2 py-1 rounded ${leftTab === "threads" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                  Threads
                </button>
                <button onClick={() => setLeftTab("entries")}
                  className={`flex-1 text-xs px-2 py-1 rounded ${leftTab === "entries" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                  Entries
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {leftTab === "threads" && sessions.map(s => (
                <div key={s.id}
                  className={`group relative w-full border-b border-border/30 hover:bg-primary/5 ${sessionId === s.id ? "bg-primary/10" : ""}`}>

                  <button onClick={() => openSession(s)} className="w-full text-left p-3 pr-8">
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      {new Date(s.created_at).toLocaleDateString()}
                    </div>
                    <div className="text-sm font-medium truncate">{s.title || "Untitled"}</div>
                    <div className="text-[10px] text-accent truncate">{(s.agent_slugs ?? []).join(", ")}</div>
                  </button>
                  <button onClick={() => deleteSession(s.id)}
                    className="absolute opacity-0 group-hover:opacity-100 right-2 top-3 p-1 hover:text-destructive">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {leftTab === "threads" && sessions.length === 0 && (
                <div className="p-3 text-xs text-muted-foreground">No conversations yet.</div>
              )}
              {leftTab === "entries" && entries.map(e => (
                <button key={e.id} onClick={() => { setActiveEntry(e); }}
                  className={`w-full text-left p-3 border-b border-border/30 hover:bg-primary/5 ${activeEntry?.id === e.id ? "bg-primary/10" : ""}`}>
                  <div className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleDateString()}</div>
                  <div className="text-sm font-medium truncate">{e.title || e.content.slice(0, 60)}</div>
                  <span className="text-[10px] uppercase tracking-wider text-accent">{e.entry_type}</span>
                </button>
              ))}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Center: entry editor / view */}
        <ResizablePanel defaultSize={32} minSize={15}>
          <div className="h-full flex flex-col border-r border-border/50">
            <div className="p-4 border-b border-border/50">
              <Input placeholder="Title (optional)" value={activeEntry?.title ?? draftTitle}
                onChange={e => { if (!activeEntry) setDraftTitle(e.target.value); }} disabled={!!activeEntry} />
              <div className="flex gap-2 mt-2">
                {ENTRY_TYPES.map(t => (
                  <button key={t} onClick={() => !activeEntry && setDraftType(t)}
                    className={`text-xs px-2 py-1 rounded ${(activeEntry?.entry_type ?? draftType) === t ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 p-4 flex flex-col gap-3 min-h-0">
              <Textarea
                value={activeEntry?.content ?? draftContent}
                onChange={e => !activeEntry && setDraftContent(e.target.value)}
                disabled={!!activeEntry}
                placeholder="Speak freely. This is your chamber."
                className="flex-1 resize-none text-base"
              />
              <div className="flex gap-2">
                {!activeEntry && (
                  <>
                    <Button variant={recording ? "default" : "outline"} onClick={() => toggleVoice("draft")} className={recording ? "relative" : ""}>
                      <Mic className={`h-4 w-4 ${recording ? "text-accent-foreground" : ""}`} />
                      {recording && <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500 animate-ping" />}
                      {recording && <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500" />}
                    </Button>
                    <Button onClick={saveEntry} disabled={!draftContent.trim()}>Save</Button>
                  </>
                )}
                {activeEntry && (
                  <Button variant="outline" onClick={() => setActiveEntry(null)}>Clear</Button>
                )}
              </div>
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right: discussion */}
        <ResizablePanel defaultSize={50} minSize={25}>
          <div className="h-full flex flex-col">
            <div className="p-3 border-b border-border/50">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-muted-foreground">Agents in the chamber {sessionId ? "(live)" : ""}</div>
                {sessionId && (
                  <Button size="sm" variant="ghost" onClick={newThread} className="h-6 text-xs">+ New thread</Button>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {agents.map(a => {
                  const on = selectedAgents.includes(a.slug);
                  return (
                    <button key={a.slug} onClick={() => toggleAgent(a.slug)}
                      className={`text-xs px-2 py-1 rounded-full border flex items-center gap-1 transition-all ${on ? "border-primary bg-primary/10" : "border-border"}`}>
                      <span>{a.avatar_emoji}</span><span>{a.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
              {!sessionId && messages.length === 0 && (
                <div className="space-y-3 max-w-md">
                  <p className="text-sm text-muted-foreground">
                    Select agents above, attach an entry from the left (optional), then type below. A new persistent thread is created automatically.
                  </p>
                </div>
              )}

              {messages.map(m => {
                const agent = agents.find(a => a.slug === m.agent_slug);
                const isUser = m.role === "user";
                return (
                  <div key={m.id} className="space-y-1">
                    <div className="flex items-center gap-2 text-xs" style={{ color: isUser ? undefined : colorFor(m.agent_slug ?? "") }}>
                      <span>{isUser ? "🧭" : agent?.avatar_emoji ?? "🤖"}</span>
                      <span className="font-medium">{isUser ? "Operator" : agent?.name ?? m.agent_slug}</span>
                    </div>
                    <div className="text-sm whitespace-pre-wrap pl-6 leading-relaxed">{m.content}</div>
                  </div>
                );
              })}
              {Object.entries(streaming).map(([slug, text]) => {
                const agent = agents.find(a => a.slug === slug);
                return (
                  <div key={`s-${slug}`} className="space-y-1">
                    <div className="flex items-center gap-2 text-xs" style={{ color: colorFor(slug) }}>
                      <span>{agent?.avatar_emoji ?? "🤖"}</span>
                      <span className="font-medium">{agent?.name ?? slug}</span>
                      <span className="animate-pulse">▌</span>
                    </div>
                    <div className="text-sm whitespace-pre-wrap pl-6 leading-relaxed">{text}</div>
                  </div>
                );
              })}
            </div>

            <div className="p-3 border-t border-border/50 flex gap-2 items-center">
              <Button variant={recording ? "default" : "outline"} size="icon" onClick={() => toggleVoice("input")} className="relative">
                {recording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                {recording && <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500 animate-ping" />}
                {recording && <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500" />}
              </Button>
              <ConversationModeButton active={convoActive} listening={convoListening} onToggle={toggleConvo} />
              <Button variant="outline" size="icon" onClick={toggleGlobalVoice}
                title={globalVoice ? "Agents speaking — click to mute" : "Agents muted — click to unmute"}>
                {globalVoice ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </Button>
              <Input value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={sessionId ? "Continue the conversation..." : "Start a new conversation..."}
                disabled={sending || selectedAgents.length === 0} />
              <Button onClick={() => void send()} disabled={sending || !input.trim() || selectedAgents.length === 0}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
