import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Flame } from "lucide-react";
import { toast } from "sonner";

type Msg = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  ui?: "result_check";
  arsenal_item_id?: string;
  resolved?: boolean;
};

const BOTTLENECK_CHIPS: Record<string, string[]> = {
  no_activity: [
    "Where do I find my first client?",
    "What should I charge starting out?",
    "How do I get my first verified job?",
  ],
  verification: [
    "How do I get clients to verify faster?",
    "Write me a verification ask script",
    "Why are clients ignoring the link?",
  ],
  disputes: [
    "How do I prevent disputes?",
    "Draft a clearer scope-of-work template",
    "How should I respond to a dispute?",
  ],
  closing: [
    "Write me a closing script",
    "Why am I losing pending receipts?",
    "How do I push a stalled job over the line?",
  ],
  pricing: [
    "Am I underpriced?",
    "Build me a tiered pricing structure",
    "How do I justify a rate increase?",
  ],
  volume: [
    "How do I double my job count this month?",
    "Write me a referral ask",
    "What's the fastest lead source for me?",
  ],
  scale: [
    "How do I hire my first crew?",
    "What systems break next at this volume?",
    "Build me a delegation playbook",
  ],
};

const ForgePage = () => {
  const { user, session } = useAuth();
  const [directive, setDirective] = useState<string | null>(null);
  const [directiveLoading, setDirectiveLoading] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [bottleneck, setBottleneck] = useState<string>("no_activity");
  const [historyLoaded, setHistoryLoaded] = useState(false);
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
    // Get today's directive
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

    // Fetch bottleneck
    const { data: ctx } = await supabase.rpc("get_forge_context", { _user_id: user!.id });
    if (ctx && (ctx as any).bottleneck) setBottleneck((ctx as any).bottleneck);

    // Load persisted history
    const { data: history } = await supabase
      .from("forge_messages")
      .select("id, role, content, ui, arsenal_item_id, resolved, created_at")
      .eq("user_id", user!.id)
      .order("created_at", { ascending: true })
      .limit(200);

    setHistoryLoaded(true);

    if (history && history.length > 0) {
      setMessages(
        history.map((h: any) => ({
          id: h.id,
          role: h.role,
          content: h.content,
          ui: h.ui ?? undefined,
          arsenal_item_id: h.arsenal_item_id ?? undefined,
          resolved: h.resolved,
        })),
      );
    } else {
      // First-ever visit — Forge speaks first
      await streamOpening();
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

  const streamOpening = async () => {
    const openingPrompt =
      "[SYSTEM: Operator just opened the app. Open the conversation. Reference one specific number from their recent activity. Identify the highest-leverage action available right now. Deliver as a statement, not a question. Do not introduce yourself. Do not explain what you are. Just begin.]";
    await runStream([{ role: "user", content: openingPrompt }], { hideUserPrompt: true });
  };

  const generateOnDemandDirective = async () => {
    setDirectiveLoading(true);
    try {
      const { data: ctx } = await supabase.rpc("get_forge_context", { _user_id: user!.id });
      const ctxStr = JSON.stringify(ctx);
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/forge_chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content: `[SYSTEM: Generate ONE directive sentence for today based on this operator's data. Return ONLY the sentence — no preamble, no explanation, no [ARSENAL] tag.] ${ctxStr}`,
              },
            ],
          }),
        },
      );
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
   * Unified streaming runner.
   * - extraMessages: messages to APPEND to current `messages` for the API call
   * - hideUserPrompt: if true, the extra user message is NOT shown in UI / NOT persisted
   */
  const runStream = async (
    extraMessages: Msg[],
    opts: { hideUserPrompt?: boolean } = {},
  ) => {
    if (streaming) return;
    setStreaming(true);

    const baseHistory = messages;
    let visibleHistory = baseHistory;

    if (!opts.hideUserPrompt) {
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
      visibleHistory = [...baseHistory, ...persistedExtras];
      setMessages(visibleHistory);
    }

    // Add empty assistant placeholder in UI
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    const apiMessages = [...baseHistory, ...extraMessages].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let acc = "";
    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/forge_chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ messages: apiMessages }),
        },
      );
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
      await postProcess(acc);
    } catch (e) {
      console.error(e);
    } finally {
      setStreaming(false);
      const { data: ctx } = await supabase.rpc("get_forge_context", { _user_id: user!.id });
      if (ctx && (ctx as any).bottleneck) setBottleneck((ctx as any).bottleneck);
    }
  };

  const postProcess = async (raw: string) => {
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

    // Persist the assistant message with final content
    const persistedId = await persistMessage({
      role: "assistant",
      content: finalContent,
      ui: finalUi,
      arsenal_item_id: finalArsenalId ?? createdArsenalRowId,
    });

    // Update the in-memory placeholder with final values + db id
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "assistant") {
        next[next.length - 1] = {
          ...last,
          id: persistedId,
          content: finalContent,
          ui: finalUi,
          arsenal_item_id: finalArsenalId ?? createdArsenalRowId,
        };
      }
      return next;
    });
  };

  const onSendClick = () => {
    const t = input.trim();
    if (!t || streaming) return;
    setInput("");
    void runStream([{ role: "user", content: t }]);
  };

  const onChipClick = (text: string) => {
    if (streaming) return;
    void runStream([{ role: "user", content: text }]);
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

  const chips = BOTTLENECK_CHIPS[bottleneck] ?? BOTTLENECK_CHIPS.no_activity;

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
            {historyLoaded ? "Forge is reading your numbers…" : "Loading conversation…"}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={m.id ?? i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} gap-2`}>
            {m.role === "assistant" && (
              <div className="w-8 h-8 rounded-full bg-accent/20 border border-accent/40 flex items-center justify-center shrink-0">
                <span className="text-accent font-display text-sm">F</span>
              </div>
            )}
            <div
              className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-primary/15 border border-primary/30 text-foreground"
                  : "bg-secondary/60 border border-border/40 text-foreground"
              }`}
            >
              {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
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
          </div>
        ))}
      </div>

      {/* BOTTOM: Input + chips */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Speak."
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
