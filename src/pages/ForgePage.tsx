import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Flame, Copy, RefreshCw, Trash2, Paperclip, X } from "lucide-react";
import { toast } from "sonner";

type Msg = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  ui?: "result_check";
  arsenal_item_id?: string;
  resolved?: boolean;
  attachments?: { name: string; media_type: string; data: string }[] | null;
};

const DEFAULT_CHIPS = [
  "What should I focus on today?",
  "Where am I leaking money?",
  "What's my next move?",
];

const FORGE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/forge_chat`;

const ForgePage = () => {
  const { user, session } = useAuth();
  const [directive, setDirective] = useState<string | null>(null);
  const [directiveLoading, setDirectiveLoading] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [chips, setChips] = useState<string[]>(DEFAULT_CHIPS);
  const [hasCrmOpps, setHasCrmOpps] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [attachments, setAttachments] = useState<{ name: string; media_type: string; data: string; preview?: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    if (!user) return;
    void initialize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const initialize = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await supabase
      .from("forge_directives")
      .select("directive")
      .eq("user_id", user!.id)
      .gte("generated_at", `${today}T00:00:00`)
      .order("generated_at", { ascending: false })
      .limit(1);

    if (existing && existing.length > 0) {
      setDirective(existing[0].directive);
      setDirectiveLoading(false);
    } else {
      await generateOnDemandDirective();
    }

    // Check for CRM opportunities to conditionally show the follow-up chip
    try {
      const { data: opps } = await supabase.rpc("get_crm_opportunities", { _user_id: user!.id });
      setHasCrmOpps(Array.isArray(opps) && opps.length > 0);
    } catch (e) {
      console.error("crm opps check failed", e);
    }

    // Pull profile bits we need: re-engagement message + last_seen_at
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("atlas_reengagement_message, last_seen_at")
      .eq("user_id", user!.id)
      .maybeSingle();

    const reengagementMsg = (profile as any)?.atlas_reengagement_message as string | null;

    // Stamp last_seen_at NOW + clear any pending re-engagement message
    await supabase
      .from("user_profiles")
      .update({
        last_seen_at: new Date().toISOString(),
        atlas_reengagement_message: null,
      })
      .eq("user_id", user!.id);

    const { data: history } = await supabase
      .from("forge_messages")
      .select("id, role, content, ui, arsenal_item_id, resolved, created_at")
      .eq("user_id", user!.id)
      .order("created_at", { ascending: true })
      .limit(200);

    setHistoryLoaded(true);

    // If a re-engagement message is queued, surface it as the first assistant message.
    if (reengagementMsg) {
      const reMsg: Msg = { role: "assistant", content: reengagementMsg };
      const id = await persistMessage(reMsg);
      reMsg.id = id;
      const base = (history ?? []).map((h: any) => ({
        id: h.id,
        role: h.role as "user" | "assistant",
        content: h.content,
        ui: h.ui ?? undefined,
        arsenal_item_id: h.arsenal_item_id ?? undefined,
        resolved: h.resolved,
      }));
      const combined = [...base, reMsg];
      setMessages(combined);
      void refreshChips(combined);
      return;
    }

    if (history && history.length > 0) {
      const loaded = history.map((h: any) => ({
        id: h.id,
        role: h.role as "user" | "assistant",
        content: h.content,
        ui: h.ui ?? undefined,
        arsenal_item_id: h.arsenal_item_id ?? undefined,
        resolved: h.resolved,
      }));
      setMessages(loaded);
      // Refresh chips based on last exchange
      void refreshChips(loaded);
    } else {
      // First-ever visit — Atlas opens
      await runStream([], { opening: true });
    }
  };

  const persistMessage = async (m: Msg): Promise<string | undefined> => {
    if (!user) return;
    const { data, error } = await supabase
      .from("forge_messages")
      .insert({
        user_id: user.id,
        role: m.role,
        content: m.content,
        ui: m.ui ?? null,
        arsenal_item_id: m.arsenal_item_id ?? null,
        resolved: m.resolved ?? false,
        attachments: m.attachments ?? null,
      })
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("persist message failed", error);
      return;
    }
    return data?.id;
  };

  const updateMessage = async (id: string, patch: Partial<Msg>) => {
    if (!user || !id) return;
    const dbPatch: any = {};
    if (patch.content !== undefined) dbPatch.content = patch.content;
    if (patch.ui !== undefined) dbPatch.ui = patch.ui;
    if (patch.arsenal_item_id !== undefined) dbPatch.arsenal_item_id = patch.arsenal_item_id;
    if (patch.resolved !== undefined) dbPatch.resolved = patch.resolved;
    const { error } = await supabase.from("forge_messages").update(dbPatch).eq("id", id);
    if (error) console.error("update message failed", error);
  };

  const generateOnDemandDirective = async () => {
    setDirectiveLoading(true);
    try {
      const res = await fetch(FORGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content:
                "[SYSTEM: Generate ONE directive sentence for today based on this operator's data. Return ONLY the sentence — no preamble, no explanation, no [ARSENAL] tag.]",
            },
          ],
        }),
      });
      if (!res.ok || !res.body) throw new Error("directive generation failed");
      const text = await readStreamToText(res.body);
      const cleaned = text.replace(/\[ARSENAL:[^\]]+\]/g, "").trim();
      setDirective(cleaned);
      await supabase.from("forge_directives").insert({
        user_id: user!.id,
        directive: cleaned,
        confidence_score: 75,
      });
    } catch (e) {
      console.error(e);
      setDirective("Look at your last verified receipt. The next move starts there.");
    } finally {
      setDirectiveLoading(false);
    }
  };

  const readStreamToText = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let out = "";
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      if (d) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data: ")) continue;
        const json = line.slice(6).trim();
        if (json === "[DONE]") { done = true; break; }
        try {
          const p = JSON.parse(json);
          const c = p.choices?.[0]?.delta?.content;
          if (c) out += c;
        } catch { buf = line + "\n" + buf; break; }
      }
    }
    return out;
  };

  /**
   * Memory compression: if conversation > 10 messages, summarize all but the most recent 6.
   * Returns the messages array to send to the API (max 6 raw + 1 summary system msg).
   */
  const compressIfNeeded = async (history: Msg[]): Promise<{ role: string; content: string }[]> => {
    const RECENT_KEEP = 6;
    if (history.length <= 10) {
      return history.map((m) => ({ role: m.role, content: m.content }));
    }
    const older = history.slice(0, history.length - RECENT_KEEP);
    const recent = history.slice(history.length - RECENT_KEEP);

    try {
      const res = await fetch(FORGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          mode: "summarize",
          messages: older.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const j = await res.json();
      const summary = j?.summary ?? "";
      const msgs: { role: string; content: string }[] = [];
      if (summary) {
        msgs.push({
          role: "system",
          content: `Earlier conversation summary:\n${summary}`,
        });
      }
      for (const m of recent) msgs.push({ role: m.role, content: m.content });
      return msgs;
    } catch (e) {
      console.error("compression failed, falling back to recent only", e);
      return recent.map((m) => ({ role: m.role, content: m.content }));
    }
  };

  const refreshChips = async (history: Msg[]) => {
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
    const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
    if (!lastAssistant) return;
    try {
      const res = await fetch(FORGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ mode: "suggest", lastUser, lastAssistant }),
      });
      const j = await res.json();
      if (Array.isArray(j?.suggestions) && j.suggestions.length > 0) {
        setChips(j.suggestions.slice(0, 3));
      }
    } catch (e) {
      console.error("chip refresh failed", e);
    }
  };

  /**
   * Unified streaming runner.
   * - opts.opening: this is the first-ever message; backend uses opening instruction
   * - opts.userMessage: optional new user message to append + persist
   */
  const runStream = async (
    extraMessages: Msg[],
    opts: { opening?: boolean } = {},
    pendingAttachments: { name: string; media_type: string; data: string }[] = [],
  ) => {
    if (streaming) return;
    setStreaming(true);

    const baseHistory = messages;

    // Persist user message(s) first
    const persistedExtras: Msg[] = [];
    for (const m of extraMessages) {
      if (m.role === "user") {
        const id = await persistMessage(m);
        persistedExtras.push({ ...m, id });
      } else {
        persistedExtras.push(m);
      }
    }
    const visibleHistory = [...baseHistory, ...persistedExtras];
    if (persistedExtras.length > 0) setMessages(visibleHistory);

    // Add empty assistant placeholder immediately (no spinner — bubble fills in)
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    // Compress before sending
    const apiMessages = await compressIfNeeded(visibleHistory);

    let acc = "";
    try {
      const res = await fetch(FORGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          messages: opts.opening
            ? [{ role: "user", content: "[Operator just opened the app.]" }]
            : apiMessages,
          opening: opts.opening ?? false,
          attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
        }),
      });
      if (res.status === 429) { toast.error("Rate limit. Try again shortly."); throw new Error("rate"); }
      if (res.status === 402) { toast.error("AI credits exhausted."); throw new Error("credits"); }
      if (!res.ok || !res.body) throw new Error("stream failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          let line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") { done = true; break; }
          try {
            const p = JSON.parse(json);
            const c = p.choices?.[0]?.delta?.content;
            if (c) {
              acc += c;
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === "assistant") next[next.length - 1] = { ...last, content: acc };
                return next;
              });
            }
          } catch { buf = line + "\n" + buf; break; }
        }
      }
      const finalHistory = await postProcess(acc, visibleHistory);
      // Refresh chips off the new exchange
      void refreshChips(finalHistory);
    } catch (e) {
      console.error(e);
    } finally {
      setStreaming(false);
    }
  };

  const postProcess = async (raw: string, visibleHistory: Msg[]): Promise<Msg[]> => {
    const arsenalMatch = raw.match(/\[ARSENAL:([^\]]+)\]/);
    const resultMatch = raw.match(/\[RESULT_CHECK:([^\]]+)\]/);

    let finalContent = raw;
    let finalUi: "result_check" | undefined;
    let finalArsenalId: string | undefined;
    let createdArsenalRowId: string | undefined;

    if (arsenalMatch) {
      const title = arsenalMatch[1].trim();
      finalContent = raw.replace(/\[ARSENAL:[^\]]+\]/, "").trim();
      const { data: inserted } = await supabase
        .from("arsenal_items")
        .insert({
          user_id: user!.id,
          title,
          content: finalContent,
          type: "asset",
          source: "forge_generated",
        })
        .select("id")
        .maybeSingle();
      createdArsenalRowId = inserted?.id;
    }

    if (resultMatch) {
      finalArsenalId = resultMatch[1].trim();
      finalContent = "Quick question — did that script close the job?";
      finalUi = "result_check";
    }

    const finalAssistant: Msg = {
      role: "assistant",
      content: finalContent,
      ui: finalUi,
      arsenal_item_id: finalArsenalId ?? createdArsenalRowId,
    };

    const persistedId = await persistMessage(finalAssistant);
    finalAssistant.id = persistedId;

    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "assistant") next[next.length - 1] = finalAssistant;
      return next;
    });

    return [...visibleHistory, finalAssistant];
  };

  const onSendClick = () => {
    const t = input.trim();
    if ((!t && attachments.length === 0) || streaming) return;
    const currentAttachments = attachments;
    setInput("");
    setAttachments([]);
    void runStream([{ role: "user", content: t || "[Attachment]" }], {}, currentAttachments);
  };

  const onChipClick = (text: string) => {
    if (streaming) return;
    void runStream([{ role: "user", content: text }], {}, []);
  };

  const onResultTap = async (msgIdx: number, arsenalItemId: string, won: boolean) => {
    await supabase.from("arsenal_results").insert({
      user_id: user!.id,
      arsenal_item_id: arsenalItemId,
      converted: won,
    });
    const { data: item } = await supabase
      .from("arsenal_items")
      .select("use_count, win_count")
      .eq("id", arsenalItemId)
      .maybeSingle();
    if (item) {
      await supabase
        .from("arsenal_items")
        .update({
          use_count: (item.use_count ?? 0) + 1,
          win_count: (item.win_count ?? 0) + (won ? 1 : 0),
        })
        .eq("id", arsenalItemId);
    }
    const target = messages[msgIdx];
    if (target?.id) await updateMessage(target.id, { resolved: true });
    setMessages((prev) => {
      const next = [...prev];
      next[msgIdx] = { ...next[msgIdx], resolved: true };
      return next;
    });
  };

  const onOmniSync = async () => {
    if (syncing || streaming || messages.length === 0) return;
    setSyncing(true);
    try {
      await fetch(FORGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          mode: "summarize",
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      await supabase
        .from("user_profiles")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("user_id", user!.id);
      toast.success("Synced — Atlas will remember this when you return.");
    } catch (e) {
      console.error("omni sync failed", e);
      toast.error("Sync failed. Try again.");
    } finally {
      setSyncing(false);
    }
  };

  const onClearThread = async () => {
    if (clearing || streaming) return;
    setClearing(true);
    try {
      await supabase.from("forge_messages").delete().eq("user_id", user!.id);
      setMessages([]);
      setChips(DEFAULT_CHIPS);
      await runStream([], { opening: true });
      toast.success("Thread cleared.");
    } catch (e) {
      console.error("clear thread failed", e);
      toast.error("Could not clear thread.");
    } finally {
      setClearing(false);
    }
  const encodeFile = (file: File): Promise<{ name: string; media_type: string; data: string; preview?: string }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const data = result.split(",")[1];
        const preview = file.type.startsWith("image/") ? result : undefined;
        resolve({ name: file.name, media_type: file.type || "application/octet-stream", data, preview });
      };
      reader.onerror = () => reject(new Error("File read failed"));
      reader.readAsDataURL(file);
    });
  };

  const onFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    try {
      const encoded = await Promise.all(files.map(encodeFile));
      setAttachments((prev) => [...prev, ...encoded]);
    } catch (err) {
      toast.error("Could not read file.");
    }
    e.target.value = "";
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)] md:h-[calc(100vh-2rem)] max-w-4xl mx-auto p-4 md:p-6 gap-4">
      {/* TOP: Directive */}
      <div
        className={`glass-card p-5 ${directiveLoading ? "animate-pulse-border" : ""}`}
        style={
          directiveLoading
            ? { boxShadow: "0 0 0 1px hsla(24, 95%, 54%, 0.4)", animation: "pulse 2s ease-in-out infinite" }
            : undefined
        }
      >
        <div className="flex items-center gap-2 mb-2">
          <Flame className="h-4 w-4 text-accent" />
          <span className="text-xs font-display tracking-widest text-accent">TODAY'S DIRECTIVE</span>
        </div>
        <p className="text-base md:text-lg text-foreground leading-snug">
          {directive ?? (directiveLoading ? "Reading the field…" : "—")}
        </p>
      </div>

      {/* MIDDLE: Thread */}
      <div
        ref={threadRef}
        className="flex-1 overflow-y-auto glass-card p-4 space-y-4"
      >
        {messages.length === 0 && (
          <div className="text-muted-foreground text-sm text-center py-8">
            {historyLoaded ? "Atlas is reading your numbers…" : "Loading conversation…"}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={m.id ?? i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} gap-2 group`}>
            {m.role === "assistant" && (
              <div className="w-8 h-8 rounded-full bg-accent/20 border border-accent/40 flex items-center justify-center shrink-0">
                <span className="text-accent font-display text-sm">A</span>
              </div>
            )}
            <div className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"} max-w-[80%]`}>
              <div
                className={`rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  m.role === "user"
                    ? "bg-primary/15 border border-primary/30 text-foreground"
                    : "bg-secondary/60 border border-border/40 text-foreground"
                }`}
              >
                {m.content}
                {m.ui === "result_check" && !m.resolved && (
                  <div className="flex gap-2 mt-3">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => onResultTap(i, m.arsenal_item_id!, true)}
                    >
                      Yes
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onResultTap(i, m.arsenal_item_id!, false)}
                    >
                      No
                    </Button>
                  </div>
                )}
              </div>
              {m.content && (
                <div className="flex gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(m.content);
                      toast.success("Copied");
                    }}
                    className="p-1 rounded hover:bg-secondary/60 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="Copy message"
                    title="Copy"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={async () => {
                      if (!user) return;
                      const title =
                        m.content.split("\n")[0].slice(0, 60).trim() ||
                        "Atlas asset";
                      const { error } = await supabase
                        .from("arsenal_items")
                        .insert({
                          user_id: user.id,
                          title,
                          content: m.content,
                          type: "asset",
                          source: "forge_upgrade",
                        });
                      if (error) {
                        toast.error("Could not upgrade to Arsenal");
                      } else {
                        toast.success("Upgraded to Arsenal");
                      }
                    }}
                    className="p-1 rounded hover:bg-accent/20 text-muted-foreground hover:text-accent transition-colors"
                    aria-label="Upgrade Arsenal"
                    title="Upgrade Arsenal"
                  >
                    <Flame className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* BOTTOM: Input + chips */}
      <div className="space-y-3">
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onOmniSync}
            disabled={syncing || streaming || messages.length === 0}
            className="text-xs gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Omni Sync"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearThread}
            disabled={clearing || streaming}
            className="text-xs gap-1.5 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {clearing ? "Clearing…" : "Clear Thread"}
          </Button>
        </div>
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Speak to Atlas."
            className="min-h-[44px] max-h-32 resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSendClick();
              }
            }}
            disabled={streaming}
          />
          <Button onClick={onSendClick} disabled={streaming || !input.trim()} size="icon" className="self-end">
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasCrmOpps && (
            <button
              onClick={() => onChipClick("Who should I follow up with today?")}
              disabled={streaming}
              className="text-xs px-3 py-1.5 rounded-full border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
            >
              Who should I follow up with today?
            </button>
          )}
          {chips.map((c) => (
            <button
              key={c}
              onClick={() => onChipClick(c)}
              disabled={streaming}
              className="text-xs px-3 py-1.5 rounded-full border border-border/50 bg-secondary/40 text-muted-foreground hover:text-foreground hover:border-accent/40 transition-colors disabled:opacity-50"
            >
              {c}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ForgePage;
