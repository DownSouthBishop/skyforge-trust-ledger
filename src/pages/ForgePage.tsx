import { useEffect, useRef, useState } from "react";
import { Flame, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type Msg = {
  role: "user" | "assistant";
  content: string;
  resultCheckFor?: string | null;
  arsenalSaved?: { id: string | null; title: string } | null;
  resultAnswered?: boolean;
};

const BOTTLENECK_CHIPS: Record<string, string[]> = {
  no_activity: [
    "How do I land my first job?",
    "Write me a cold outreach script",
    "What pricing should I start at?",
  ],
  verification: [
    "How do I get clients to verify faster?",
    "Draft a follow-up message",
    "Why are receipts stuck pending?",
  ],
  disputes: [
    "How do I prevent disputes?",
    "Write a clear scope-of-work template",
    "How should I respond to a dispute?",
  ],
  closing: [
    "Write me a closing script",
    "How do I handle price objections?",
    "What's killing my close rate?",
  ],
  pricing: [
    "Help me raise my prices",
    "Build a tiered pricing structure",
    "Write a value-anchoring opener",
  ],
  volume: [
    "How do I get more leads this week?",
    "Build a referral request script",
    "What channels should I focus on?",
  ],
  scale: [
    "How do I systemize my best work?",
    "Build a hiring pitch",
    "What should I delegate first?",
  ],
};

const ForgePage = () => {
  const { toast } = useToast();
  const [directive, setDirective] = useState<string | null>(null);
  const [directiveLoading, setDirectiveLoading] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [bottleneck, setBottleneck] = useState<string>("no_activity");
  const [hasCrm, setHasCrm] = useState<boolean>(false);
  const threadRef = useRef<HTMLDivElement>(null);

  const chips = BOTTLENECK_CHIPS[bottleneck] ?? BOTTLENECK_CHIPS.no_activity;

  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, sending]);

  // Load / generate directive + open conversation
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        // Try fetch today's directive
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const { data: existing } = await supabase
          .from("forge_directives")
          .select("directive")
          .eq("user_id", session.user.id)
          .gte("generated_at", todayStart.toISOString())
          .order("generated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (cancelled) return;

        if (existing) {
          setDirective(existing.directive);
          setDirectiveLoading(false);
        } else {
          // Generate now
          const { data, error } = await supabase.functions.invoke(
            "forge-directive",
            { body: {} },
          );
          if (cancelled) return;
          if (error) {
            console.error(error);
            setDirective("Today's directive is being forged.");
          } else {
            setDirective(data?.directive?.directive ?? "Stay on the work.");
          }
          setDirectiveLoading(false);
        }

        // Opening message — let Forge speak first
        await openConversation();
      } catch (e) {
        console.error(e);
        setDirectiveLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openConversation = async () => {
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("forge-chat", {
        body: {
          messages: [
            {
              role: "user",
              content:
                "[SYSTEM_OPEN] Open the conversation. Reference a specific number from my recent activity. Identify the highest-leverage action available right now. Deliver it as a statement, not a question. Do not introduce yourself. Do not explain what you are. Just begin.",
            },
          ],
        },
      });
      if (error) throw error;
      handleAssistantPayload(data);
    } catch (e) {
      console.error(e);
    } finally {
      setSending(false);
    }
  };

  const handleAssistantPayload = (data: any) => {
    if (!data) return;
    if (data.bottleneck) setBottleneck(data.bottleneck);
    if (typeof data.has_crm_opportunities === "boolean") setHasCrm(data.has_crm_opportunities);

    const reply: string = data.reply ?? "";
    const resultCheckFor: string | null = data.result_check_for ?? null;
    const arsenalSaved = data.arsenal_saved ?? null;

    if (resultCheckFor) {
      // Replace assistant message per spec: send only the tap-response.
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Quick question — did that script close the job?",
          resultCheckFor,
        },
      ]);
      return;
    }

    if (reply.trim()) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: reply, arsenalSaved },
      ]);
    }
  };

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const nextHistory: Msg[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];
    setMessages(nextHistory);
    setInput("");
    setSending(true);
    try {
      const apiMessages = nextHistory.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const { data, error } = await supabase.functions.invoke("forge-chat", {
        body: { messages: apiMessages },
      });
      if (error) throw error;
      handleAssistantPayload(data);
    } catch (e: any) {
      console.error(e);
      toast({
        title: "Forge unreachable",
        description: e?.message ?? "Try again shortly.",
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  const answerResultCheck = async (
    msgIndex: number,
    arsenalItemId: string,
    converted: boolean,
  ) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      await supabase.from("arsenal_results").insert({
        user_id: session.user.id,
        arsenal_item_id: arsenalItemId,
        converted,
      });

      // Increment counters
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
            win_count: (item.win_count ?? 0) + (converted ? 1 : 0),
          })
          .eq("id", arsenalItemId);
      }

      setMessages((prev) =>
        prev.map((m, i) => (i === msgIndex ? { ...m, resultAnswered: true } : m))
      );
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-1rem)] md:h-[calc(100vh-2rem)] max-w-4xl mx-auto p-4 md:p-6 gap-4">
      {/* Top zone: directive */}
      <div
        className={`glass-card p-5 border ${
          directiveLoading ? "pulse-border" : "border-accent/30"
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/15 border border-accent/40 flex items-center justify-center">
            <Flame className="h-5 w-5 text-accent" />
          </div>
          <div className="flex-1">
            <div className="text-[10px] tracking-[0.25em] font-display text-accent/80">
              TODAY'S DIRECTIVE
            </div>
            <p className="text-sm md:text-base text-foreground mt-1">
              {directive ?? "Forging today's directive…"}
            </p>
          </div>
        </div>
      </div>

      {/* Middle zone: thread */}
      <div
        ref={threadRef}
        className="glass-card flex-1 overflow-y-auto p-4 md:p-5 space-y-4"
      >
        {messages.length === 0 && sending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            Forge is reading your numbers…
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === "user") {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl bg-primary/15 border border-primary/30 px-4 py-2.5 text-sm text-foreground">
                  {m.content}
                </div>
              </div>
            );
          }
          return (
            <div key={i} className="flex gap-3 items-start">
              <div className="w-8 h-8 rounded-full bg-accent/20 border border-accent/40 flex items-center justify-center shrink-0 font-display text-accent text-sm">
                F
              </div>
              <div className="max-w-[85%] space-y-2">
                <div className="rounded-2xl bg-secondary/60 border border-border/40 px-4 py-2.5 text-sm text-foreground whitespace-pre-wrap">
                  {m.content}
                </div>
                {m.arsenalSaved && (
                  <div className="text-[10px] tracking-widest font-display text-accent/70">
                    SAVED TO ARSENAL · {m.arsenalSaved.title.toUpperCase()}
                  </div>
                )}
                {m.resultCheckFor && !m.resultAnswered && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-accent/40 text-accent hover:bg-accent/10"
                      onClick={() =>
                        answerResultCheck(i, m.resultCheckFor!, true)}
                    >
                      Yes
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-border text-muted-foreground"
                      onClick={() =>
                        answerResultCheck(i, m.resultCheckFor!, false)}
                    >
                      No
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {sending && messages.length > 0 && (
          <div className="flex gap-3 items-center text-xs text-muted-foreground">
            <div className="w-8 h-8 rounded-full bg-accent/20 border border-accent/40 flex items-center justify-center font-display text-accent text-sm">
              F
            </div>
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <span
                className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
                style={{ animationDelay: "0.2s" }}
              />
              <span
                className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
                style={{ animationDelay: "0.4s" }}
              />
            </span>
          </div>
        )}
      </div>

      {/* Bottom zone: input + chips */}
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {hasCrm && (
            <button
              type="button"
              onClick={() => sendMessage("Who should I follow up with today?")}
              disabled={sending}
              className="text-xs px-3 py-1.5 rounded-full border border-accent/40 bg-accent/10 text-accent hover:bg-accent/15 transition-colors disabled:opacity-50"
            >
              Who should I follow up with today?
            </button>
          )}
          {chips.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => sendMessage(c)}
              disabled={sending}
              className="text-xs px-3 py-1.5 rounded-full border border-border/60 bg-secondary/40 text-muted-foreground hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-50"
            >
              {c}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage(input);
          }}
          className="flex gap-2 items-end"
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage(input);
              }
            }}
            placeholder="Speak to Forge…"
            rows={2}
            className="flex-1 resize-none bg-secondary/40 border-border/60"
          />
          <Button
            type="submit"
            disabled={sending || !input.trim()}
            className="bg-accent hover:bg-accent/90 text-accent-foreground"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
};

export default ForgePage;
