import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Mic, Send, Plus } from "lucide-react";
import { toast } from "sonner";

type Entry = { id: string; title: string | null; content: string; entry_type: string; created_at: string };
type Agent = { id: string; name: string; slug: string; avatar_emoji: string };
type Msg = { id: string; role: string; agent_slug: string | null; content: string; created_at: string };

const ENTRY_TYPES = ["thought", "idea", "mental_model", "concept"];

function colorFor(slug: string) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 60%)`;
}

export default function ClosedChamberPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
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
  const recRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const [e, a] = await Promise.all([
        supabase.from("chamber_entries").select("*").order("created_at", { ascending: false }),
        supabase.from("skyforge_agents").select("id,name,slug,avatar_emoji").eq("is_active", true),
      ]);
      setEntries((e.data as Entry[]) ?? []);
      const agentList = (a.data as Agent[]) ?? [];
      setAgents(agentList);
      // Auto-select Atlas + Janus if present, otherwise first 2
      const defaults = agentList.filter(x => ["atlas","janus"].includes(x.slug)).map(x => x.slug);
      setSelectedAgents(defaults.length ? defaults : agentList.slice(0, 2).map(x => x.slug));
    })();
  }, []);


  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages, streaming]);

  const newEntry = () => {
    setActiveEntry(null);
    setDraftTitle(""); setDraftContent(""); setDraftType("thought");
    setSessionId(null); setMessages([]); setStreaming({});
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
      title: activeEntry?.title ?? activeEntry?.content?.slice(0, 60) ?? "Open chamber",
    }).select().single();
    if (error) return toast.error(error.message);
    setSessionId(data.id);
    setSelectedAgents(data.agent_slugs as string[]);
    setMessages([]);
  };


  const toggleAgent = (slug: string) => {
    setSelectedAgents(prev => prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]);
  };

  const startVoice = (target: "draft" | "input") => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return toast.error("Voice not supported");
    const r = new SR(); r.continuous = false; r.interimResults = false; r.lang = "en-US";
    r.onresult = (e: any) => {
      const t = e.results[0][0].transcript;
      if (target === "draft") setDraftContent(prev => prev ? prev + " " + t : t);
      else setInput(prev => prev ? prev + " " + t : t);
    };
    r.onend = () => setRecording(false);
    r.onerror = () => setRecording(false);
    recRef.current = r; setRecording(true); r.start();
  };

  const speak = (agentSlug: string, text: string) => {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const idx = parseInt(localStorage.getItem(`voice_${agentSlug}`) ?? "-1", 10);
    if (voices[idx]) u.voice = voices[idx];
    window.speechSynthesis.speak(u);
  };

  const send = async () => {
    if (!input.trim() || !sessionId || selectedAgents.length === 0) return;
    setSending(true);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) { setSending(false); return; }

    const userMsgContent = input.trim();
    setInput("");

    const { data: userMsg, error: uErr } = await supabase.from("chamber_messages").insert({
      session_id: sessionId, user_id: u.user.id, role: "user", agent_slug: null, content: userMsgContent,
    }).select().single();
    if (uErr) { toast.error(uErr.message); setSending(false); return; }
    setMessages(prev => [...prev, userMsg as Msg]);

    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const url = `https://efpdhwqhitfccfccnlhm.supabase.co/functions/v1/chamber-chat`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: sessionId, entry_id: activeEntry?.id, agent_slugs: selectedAgents, user_id: u.user.id }),
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

  return (
    <div className="h-screen flex bg-background text-foreground">
      {/* Left: entries */}
      <div className="w-64 border-r border-border/50 flex flex-col">
        <div className="p-3 border-b border-border/50 flex items-center justify-between">
          <h2 className="font-display text-sm tracking-widest text-primary">CHAMBER</h2>
          <Button size="sm" variant="ghost" onClick={newEntry}><Plus className="h-4 w-4" /></Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {entries.map(e => (
            <button key={e.id} onClick={() => { setActiveEntry(e); setSessionId(null); setMessages([]); }}
              className={`w-full text-left p-3 border-b border-border/30 hover:bg-primary/5 ${activeEntry?.id === e.id ? "bg-primary/10" : ""}`}>
              <div className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</div>
              <div className="text-sm font-medium truncate">{e.title || e.content.slice(0, 60)}</div>
              <span className="text-[10px] uppercase tracking-wider text-accent">{e.entry_type}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Center: entry editor / view */}
      <div className="flex-1 flex flex-col border-r border-border/50">
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
        <div className="flex-1 p-4 flex flex-col gap-3">
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
                <Button variant="outline" onClick={() => startVoice("draft")} disabled={recording}>
                  <Mic className={`h-4 w-4 ${recording ? "text-accent animate-pulse" : ""}`} />
                </Button>
                <Button onClick={saveEntry} disabled={!draftContent.trim()}>Save</Button>
              </>
            )}
            {activeEntry && !sessionId && (
              <Button onClick={openDiscussion}>Open in Discussion</Button>
            )}
          </div>
        </div>
      </div>

      {/* Right: discussion */}
      <div className="w-[28rem] flex flex-col">
        <div className="p-3 border-b border-border/50">
          <div className="text-xs text-muted-foreground mb-2">Agents in the chamber</div>
          <div className="flex flex-wrap gap-1">
            {agents.map(a => (
              <button key={a.slug} onClick={() => toggleAgent(a.slug)}
                className={`text-xs px-2 py-1 rounded-full border flex items-center gap-1 ${selectedAgents.includes(a.slug) ? "border-primary bg-primary/10" : "border-border"}`}>
                <span>{a.avatar_emoji}</span><span>{a.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
          {!sessionId && <p className="text-sm text-muted-foreground">Save an entry and open discussion.</p>}
          {messages.map(m => {
            const agent = agents.find(a => a.slug === m.agent_slug);
            const isUser = m.role === "user";
            return (
              <div key={m.id} className="space-y-1">
                <div className="flex items-center gap-2 text-xs" style={{ color: isUser ? undefined : colorFor(m.agent_slug ?? "") }}>
                  <span>{isUser ? "🧭" : agent?.avatar_emoji ?? "🤖"}</span>
                  <span className="font-medium">{isUser ? "Operator" : agent?.name ?? m.agent_slug}</span>
                </div>
                <div className="text-sm whitespace-pre-wrap pl-6">{m.content}</div>
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
                <div className="text-sm whitespace-pre-wrap pl-6">{text}</div>
              </div>
            );
          })}
        </div>

        {sessionId && (
          <div className="p-3 border-t border-border/50 flex gap-2">
            <Button variant="outline" size="icon" onClick={() => startVoice("input")} disabled={recording}>
              <Mic className={`h-4 w-4 ${recording ? "text-accent animate-pulse" : ""}`} />
            </Button>
            <Input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Speak to the chamber..." disabled={sending} />
            <Button onClick={send} disabled={sending || !input.trim()}><Send className="h-4 w-4" /></Button>
          </div>
        )}
      </div>
    </div>
  );
}
