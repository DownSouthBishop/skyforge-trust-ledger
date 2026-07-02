import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { SUPABASE_URL } from "@/lib/supabase-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { NotebookText, Plus, Trash2, FileText, Link as LinkIcon, Send, Loader2, X, Upload } from "lucide-react";
import { toast } from "sonner";

interface Notebook { id: string; title: string; created_at: string }
interface Source { id: string; title: string; source_type: string; media_type: string | null; created_at: string }
interface ChatMsg { id: string; role: string; content: string; created_at: string }

export default function NotebookPage() {
  const { user } = useAuth();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadNotebooks = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from("notebooks").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    setNotebooks(data ?? []);
  }, [user?.id]);

  useEffect(() => { loadNotebooks(); }, [loadNotebooks]);

  const loadNotebookDetail = useCallback(async (id: string) => {
    const [sourcesRes, messagesRes] = await Promise.all([
      supabase.from("notebook_sources").select("id,title,source_type,media_type,created_at").eq("notebook_id", id).order("created_at", { ascending: true }),
      supabase.from("notebook_messages").select("id,role,content,created_at").eq("notebook_id", id).order("created_at", { ascending: true }),
    ]);
    setSources(sourcesRes.data ?? []);
    setMessages(messagesRes.data ?? []);
  }, []);

  useEffect(() => {
    if (activeId) loadNotebookDetail(activeId);
    else { setSources([]); setMessages([]); }
  }, [activeId, loadNotebookDetail]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const createNotebook = async () => {
    if (!user) return;
    const { data, error } = await supabase.from("notebooks").insert({ user_id: user.id, title: `Notebook ${new Date().toLocaleString()}` }).select().single();
    if (error) return toast.error(error.message);
    setNotebooks((prev) => [data as Notebook, ...prev]);
    setActiveId((data as Notebook).id);
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

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || !activeId || streaming) return;
    if (sources.length === 0) return toast.error("Add a source before asking questions");
    setChatInput("");
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: text, created_at: new Date().toISOString() }]);
    setStreaming(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/notebook-chat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({ notebook_id: activeId, message: text }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${resp.status}`);
      }
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = ""; let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          let line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") continue;
          try {
            const p = JSON.parse(json);
            if (p.type === "content_block_delta" && p.delta?.type === "text_delta") {
              full += p.delta.text;
            }
          } catch { /* */ }
        }
      }
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: full || "…", created_at: new Date().toISOString() }]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="h-screen bg-background text-foreground">
      <ResizablePanelGroup direction="horizontal" className="h-full">
        <ResizablePanel defaultSize={18} minSize={12} maxSize={30}>
          <div className="h-full flex flex-col border-r border-border/50">
            <div className="p-3 border-b border-border/50 flex items-center justify-between">
              <h2 className="font-display text-sm tracking-widest text-primary flex items-center gap-2">
                <NotebookText className="h-4 w-4" /> NOTEBOOK
              </h2>
              <Button size="sm" variant="ghost" onClick={createNotebook}><Plus className="h-4 w-4" /></Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {notebooks.length === 0 && <div className="p-3 text-xs text-muted-foreground">No notebooks yet.</div>}
              {notebooks.map((nb) => (
                <div key={nb.id} className={`group relative w-full border-b border-border/30 hover:bg-primary/5 ${activeId === nb.id ? "bg-primary/10" : ""}`}>
                  <button onClick={() => setActiveId(nb.id)} className="w-full text-left p-3 pr-8">
                    <div className="text-sm font-medium truncate">{nb.title}</div>
                    <div className="text-[10px] text-muted-foreground">{new Date(nb.created_at).toLocaleDateString()}</div>
                  </button>
                  <button onClick={() => deleteNotebook(nb.id)} className="absolute opacity-0 group-hover:opacity-100 right-2 top-3 p-1 hover:text-destructive">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={27} minSize={15}>
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

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={55} minSize={25}>
          <div className="h-full flex flex-col">
            <div ref={bottomRef} className="flex-1 overflow-y-auto p-4 space-y-4">
              {!activeId && <p className="text-sm text-muted-foreground">Select a notebook, add a source, then ask questions grounded in it.</p>}
              {messages.map((m) => (
                <div key={m.id} className="space-y-1">
                  <div className="text-xs text-muted-foreground">{m.role === "user" ? "You" : "Notebook"}</div>
                  <div className="text-sm whitespace-pre-wrap leading-relaxed">{m.content}</div>
                </div>
              ))}
            </div>
            <div className="p-3 border-t border-border/50 flex gap-2 items-center">
              <Textarea value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                placeholder={activeId ? "Ask about your sources…" : "Select a notebook first"}
                disabled={!activeId || streaming} className="min-h-[44px] max-h-32 resize-none" />
              <Button size="icon" onClick={sendChat} disabled={!activeId || streaming || !chatInput.trim()}>
                {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
