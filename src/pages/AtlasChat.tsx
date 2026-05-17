import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Paperclip, X, Brain, TrendingUp, LayoutDashboard, FileText, Command } from "lucide-react";
import { toast } from "sonner";
import { detectDomain, detectEmotionalValence, detectImportanceScore, storeMemory } from "@/lib/atlas-memory";

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  domain?: string;
  timestamp: string;
  memoryIds?: string[];
}

interface DecisionCard {
  id: string;
  decision_type: "ORANGE" | "RED";
  business_context: string;
  recommendation: Record<string, unknown>;
  capital_at_stake: number;
  status: string;
}

interface PortfolioSnapshot {
  total_value: number;
  monthly_cashflow: number;
  annual_return_rate: number;
  rebalancing_needed: boolean;
}

interface CommandPaletteItem {
  label: string;
  description: string;
  action: () => void;
}

// ──────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────

const ATLAS_CORE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/atlas-core`;
const COMPRESS_THRESHOLD = 24;
const COMPRESS_KEEP = 8;

// ──────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────

const AtlasChat = () => {
  const { user, session } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sessionId] = useState(() => crypto.randomUUID());
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showDecisions, setShowDecisions] = useState(false);
  const [showPortfolio, setShowPortfolio] = useState(false);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [pendingDecisions, setPendingDecisions] = useState<DecisionCard[]>([]);
  const [portfolioSnapshot, setPortfolioSnapshot] = useState<PortfolioSnapshot | null>(null);
  const [activeMemoryIds, setActiveMemoryIds] = useState<string[]>([]);
  const [attachment, setAttachment] = useState<{ name: string; media_type: string; data: string } | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Session load ──────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    loadSessionHistory();
    loadPendingDecisions();
  }, [user]);

  async function loadSessionHistory() {
    const { data } = await supabase
      .from("atlas_memory")
      .select("id, content, domain, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(50);

    // Also load from brainiac_sessions for cross-session continuity
    const { data: sessionData } = await supabase
      .from("brainiac_sessions")
      .select("messages")
      .eq("user_id", user!.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessionData?.messages && Array.isArray(sessionData.messages)) {
      const restored: Message[] = (sessionData.messages as Array<Record<string, unknown>>).map((m) => ({
        id: (m.id as string) ?? crypto.randomUUID(),
        role: (m.role as "user" | "assistant") ?? "user",
        content: (m.content as string) ?? "",
        domain: m.domain as string | undefined,
        timestamp: (m.timestamp as string) ?? new Date().toISOString(),
      }));
      setMessages(restored.slice(-COMPRESS_KEEP));
    }

    setHistoryLoaded(true);
  }

  async function loadPendingDecisions() {
    const { data } = await supabase
      .from("atlas_decision_queue")
      .select("*")
      .in("decision_type", ["ORANGE", "RED"])
      .eq("status", "PENDING")
      .order("created_at", { ascending: false })
      .limit(10);
    if (data) setPendingDecisions(data as DecisionCard[]);
  }

  async function loadPortfolioSnapshot() {
    const { data } = await supabase
      .from("atlas_portfolio_state")
      .select("total_value, monthly_cashflow, annual_return_rate, rebalancing_needed")
      .order("snapshot_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) setPortfolioSnapshot(data as PortfolioSnapshot);
  }

  // ── Scroll to bottom ──────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  // ── Keyboard shortcuts ────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "d") {
        e.preventDefault();
        setShowDecisions((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        loadPortfolioSnapshot();
        setShowPortfolio((v) => !v);
      }
      if (e.key === "Escape") {
        setShowCommandPalette(false);
        setShowDecisions(false);
        setShowPortfolio(false);
        setShowMemoryPanel(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Command palette items ─────────────────────────────
  const commandItems: CommandPaletteItem[] = [
    { label: "View decision queue", description: "See pending ORANGE/RED decisions", action: () => { setShowDecisions(true); setShowCommandPalette(false); loadPendingDecisions(); } },
    { label: "Portfolio snapshot", description: "View current portfolio state", action: () => { setShowPortfolio(true); setShowCommandPalette(false); loadPortfolioSnapshot(); } },
    { label: "Morning brief", description: "Request today's market brief", action: () => { setShowCommandPalette(false); sendMessage("Give me the morning brief."); } },
    { label: "Trade thesis", description: "Research a symbol", action: () => { setShowCommandPalette(false); setInput("Run the thesis on "); textareaRef.current?.focus(); } },
    { label: "Forex scan", description: "Scan forex pairs for opportunities", action: () => { setShowCommandPalette(false); sendMessage("Scan the forex pairs."); } },
    { label: "Portfolio allocation check", description: "Check if rebalancing needed", action: () => { setShowCommandPalette(false); sendMessage("Run the allocation check."); } },
  ];

  // ── File attachment ───────────────────────────────────
  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File too large. Maximum 10MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      setAttachment({ name: file.name, media_type: file.type, data: base64 });
    };
    reader.readAsDataURL(file);
  }

  // ── Send message ──────────────────────────────────────
  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || streaming || !session) return;

    setInput("");
    setAttachment(null);

    const domain = detectDomain(text);
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      domain,
      timestamp: new Date().toISOString(),
    };

    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setStreaming(true);

    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", timestamp: new Date().toISOString() },
    ]);

    abortRef.current = new AbortController();

    try {
      const resp = await fetch(ATLAS_CORE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          action: "chat",
          messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
          sessionId,
          domain,
          attachment: attachment ?? undefined,
        }),
        signal: abortRef.current.signal,
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`Atlas responded with ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let buffer = "";
      let detectedMemoryIds: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;
          if (data === "") continue;

          try {
            const parsed = JSON.parse(data);
            // Memory IDs from Atlas context
            if (parsed.memory_ids) {
              detectedMemoryIds = parsed.memory_ids;
              setActiveMemoryIds(parsed.memory_ids);
              continue;
            }
            const delta = parsed?.delta?.text ?? parsed?.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              fullContent += delta;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: fullContent } : m
                )
              );
            }
          } catch {
            // Partial JSON chunk, continue
          }
        }
      }

      // Store memories post-conversation
      if (fullContent && user) {
        const importance = detectImportanceScore(text, domain);
        const valence = detectEmotionalValence(text);

        // Store user message memory
        await storeMemory({
          content: text,
          domain,
          sessionId,
          emotionalValence: valence,
          importanceScore: importance,
        }).catch(() => {});

        // Store assistant response if high importance
        if (importance > 0.6) {
          await storeMemory({
            content: fullContent.slice(0, 1000),
            domain,
            sessionId,
            emotionalValence: 0,
            importanceScore: importance * 0.8,
          }).catch(() => {});
        }
      }

      // Update message with memory IDs
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: fullContent, domain, memoryIds: detectedMemoryIds }
            : m
        )
      );

      // Persist session to brainiac_sessions for cross-session continuity
      const finalMessages = [...newMessages, { id: assistantId, role: "assistant" as const, content: fullContent, domain, timestamp: new Date().toISOString() }];
      await supabase.from("brainiac_sessions").upsert({
        user_id: user!.id,
        session_key: "atlas_chat_main",
        messages: finalMessages.slice(-40) as unknown as never,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,session_key" }).then(() => {});

      // Auto-compress if needed
      if (finalMessages.length >= COMPRESS_THRESHOLD) {
        const toCompress = finalMessages.slice(0, finalMessages.length - COMPRESS_KEEP);
        fetch(ATLAS_CORE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          body: JSON.stringify({ action: "compress", messages: toCompress, sessionId }),
        }).catch(() => {});
        setMessages(finalMessages.slice(-COMPRESS_KEEP));
      }

    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      console.error(err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: "Something went wrong. Try again." }
            : m
        )
      );
    } finally {
      setStreaming(false);
    }
  }, [input, messages, streaming, session, sessionId, attachment, user]);

  // ── Decision resolution ───────────────────────────────
  async function resolveDecision(id: string, approved: boolean) {
    const { error } = await supabase
      .from("atlas_decision_queue")
      .update({
        status: approved ? "APPROVED" : "REJECTED",
        resolved_at: new Date().toISOString(),
        resolution_note: approved ? "Approved via chat interface" : "Rejected via chat interface",
      })
      .eq("id", id);

    if (!error) {
      setPendingDecisions((prev) => prev.filter((d) => d.id !== id));
      toast.success(approved ? "Decision approved." : "Decision rejected.");
    }
  }

  // ── Detect inline decisions in assistant content ──────
  function extractInlineDecision(content: string): DecisionCard | null {
    const match = content.match(/\[DECISION:([A-Z]+)\|([^\]]+)\]/);
    if (!match) return null;
    return {
      id: crypto.randomUUID(),
      decision_type: match[1] as "ORANGE" | "RED",
      business_context: match[2],
      recommendation: { summary: match[2] },
      capital_at_stake: 0,
      status: "PENDING",
    };
  }

  // ── Textarea auto-resize ──────────────────────────────
  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 180) + "px";
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // ── Render ────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">

      {/* ── Header bar ── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/40 shrink-0">
        <span className="font-semibold tracking-widest text-sm text-primary">ATLAS</span>
        <div className="flex items-center gap-2">
          {pendingDecisions.length > 0 && (
            <button
              onClick={() => { setShowDecisions(true); loadPendingDecisions(); }}
              className="relative flex items-center gap-1 px-2 py-1 rounded text-xs text-orange-400 hover:bg-orange-400/10 transition-colors"
            >
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
              {pendingDecisions.filter((d) => d.decision_type === "RED").length > 0 && (
                <span className="w-2 h-2 rounded-full bg-red-500 animate-ping absolute -top-1 -right-1" />
              )}
              {pendingDecisions.length} pending
            </button>
          )}
          <button
            onClick={() => setShowCommandPalette(true)}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
            title="Command palette (⌘K)"
          >
            <Command size={12} />
            <span>⌘K</span>
          </button>
        </div>
      </div>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && historyLoaded && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <p className="text-muted-foreground text-sm max-w-sm">
              Atlas is here. What's on your mind?
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {["What's worth paying attention to today?", "Run the morning brief.", "Check my positions."].map((chip) => (
                <button
                  key={chip}
                  onClick={() => sendMessage(chip)}
                  className="px-3 py-1.5 rounded-full text-xs border border-border/60 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => {
          const inlineDecision = msg.role === "assistant" ? extractInlineDecision(msg.content) : null;
          const cleanContent = msg.content.replace(/\[DECISION:[^\]]+\]/g, "").trim();

          return (
            <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground ml-8"
                    : "bg-muted/40 text-foreground mr-8"
                }`}
              >
                {cleanContent || (msg.role === "assistant" && streaming ? (
                  <span className="inline-block w-2 h-4 bg-current animate-pulse rounded-sm" />
                ) : null)}

                {/* Inline decision card */}
                {inlineDecision && (
                  <div className={`mt-3 p-3 rounded-xl border ${inlineDecision.decision_type === "RED" ? "border-red-500/40 bg-red-500/10" : "border-orange-400/40 bg-orange-400/10"}`}>
                    <div className={`text-xs font-semibold mb-1 ${inlineDecision.decision_type === "RED" ? "text-red-400" : "text-orange-400"}`}>
                      {inlineDecision.decision_type} DECISION
                    </div>
                    <p className="text-xs mb-2">{inlineDecision.business_context}</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => resolveDecision(inlineDecision.id, true)}
                        className="px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:opacity-80 transition-opacity"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => resolveDecision(inlineDecision.id, false)}
                        className="px-3 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}

                {/* Memory indicator */}
                {msg.role === "assistant" && msg.memoryIds && msg.memoryIds.length > 0 && (
                  <button
                    onClick={() => { setActiveMemoryIds(msg.memoryIds!); setShowMemoryPanel(true); }}
                    className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Brain size={10} />
                    <span>{msg.memoryIds.length} memories</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="bg-muted/40 rounded-2xl px-4 py-3 mr-8">
              <span className="inline-block w-2 h-4 bg-current animate-pulse rounded-sm" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Attachment preview ── */}
      {attachment && (
        <div className="px-4 py-2 flex items-center gap-2 border-t border-border/40">
          <div className="flex items-center gap-2 bg-muted/40 rounded px-3 py-1.5 text-xs">
            <Paperclip size={12} />
            <span className="truncate max-w-[200px]">{attachment.name}</span>
            <button onClick={() => setAttachment(null)} className="hover:text-destructive">
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* ── Input ── */}
      <div className="px-4 py-3 border-t border-border/40 shrink-0">
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
          <input ref={fileInputRef} type="file" className="hidden" accept="image/*,.pdf,.txt,.csv" onChange={handleFileSelect} />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="mb-1 p-1.5 rounded text-muted-foreground hover:text-foreground transition-colors"
            title="Attach file"
          >
            <Paperclip size={16} />
          </button>
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Message Atlas..."
            className="flex-1 resize-none min-h-[44px] max-h-[180px] rounded-2xl border-border/60 bg-muted/20 focus:bg-muted/40 transition-colors text-sm"
            rows={1}
            disabled={streaming}
          />
          <button
            onClick={() => streaming ? abortRef.current?.abort() : sendMessage()}
            disabled={!input.trim() && !streaming}
            className="mb-1 p-2 rounded-full bg-primary text-primary-foreground hover:opacity-80 disabled:opacity-30 transition-all"
          >
            <Send size={16} />
          </button>
        </div>
        <p className="text-center text-xs text-muted-foreground mt-1.5">
          ⌘K commands · ⌘D decisions · ⌘P portfolio
        </p>
      </div>

      {/* ── Command palette overlay ── */}
      {showCommandPalette && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-[20vh]"
          onClick={() => setShowCommandPalette(false)}
        >
          <div
            className="w-full max-w-md bg-background border border-border rounded-2xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-border">
              <p className="text-xs text-muted-foreground font-medium tracking-wider">COMMANDS</p>
            </div>
            <div className="py-2">
              {commandItems.map((item) => (
                <button
                  key={item.label}
                  onClick={item.action}
                  className="w-full flex items-start gap-3 px-4 py-3 hover:bg-muted/40 transition-colors text-left"
                >
                  <div>
                    <p className="text-sm font-medium">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Decisions overlay ── */}
      {showDecisions && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setShowDecisions(false)}
        >
          <div
            className="w-full max-w-lg bg-background border border-border rounded-2xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <p className="text-sm font-semibold">Pending Decisions</p>
              <button onClick={() => setShowDecisions(false)} className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-4 space-y-3">
              {pendingDecisions.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No pending decisions.</p>
              )}
              {pendingDecisions.map((d) => (
                <div
                  key={d.id}
                  className={`p-4 rounded-xl border ${d.decision_type === "RED" ? "border-red-500/40 bg-red-500/5" : "border-orange-400/40 bg-orange-400/5"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-xs font-bold ${d.decision_type === "RED" ? "text-red-400" : "text-orange-400"}`}>
                      {d.decision_type}
                    </span>
                    {d.capital_at_stake > 0 && (
                      <span className="text-xs text-muted-foreground">${d.capital_at_stake.toLocaleString()} at stake</span>
                    )}
                  </div>
                  <p className="text-sm mb-3">{d.business_context}</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => resolveDecision(d.id, true)}
                      className="flex-1 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-80 transition-opacity"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => resolveDecision(d.id, false)}
                      className="flex-1 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Portfolio overlay ── */}
      {showPortfolio && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setShowPortfolio(false)}
        >
          <div
            className="w-full max-w-sm bg-background border border-border rounded-2xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <p className="text-sm font-semibold flex items-center gap-2"><TrendingUp size={14} /> Portfolio</p>
              <button onClick={() => setShowPortfolio(false)} className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
            </div>
            <div className="p-4">
              {portfolioSnapshot ? (
                <div className="space-y-3">
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-muted-foreground">Total Value</span>
                    <span className="text-2xl font-semibold">${portfolioSnapshot.total_value.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-muted-foreground">Monthly Cashflow</span>
                    <span className={`text-sm font-medium ${portfolioSnapshot.monthly_cashflow >= 0 ? "text-green-400" : "text-red-400"}`}>
                      ${portfolioSnapshot.monthly_cashflow.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-muted-foreground">Annual Return</span>
                    <span className="text-sm">{portfolioSnapshot.annual_return_rate?.toFixed(1)}%</span>
                  </div>
                  {portfolioSnapshot.rebalancing_needed && (
                    <div className="mt-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                      <p className="text-xs text-yellow-400">Rebalancing recommended</p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">No portfolio snapshot available.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Memory panel ── */}
      {showMemoryPanel && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setShowMemoryPanel(false)}
        >
          <div
            className="w-full max-w-sm bg-background border border-border rounded-2xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <p className="text-sm font-semibold flex items-center gap-2"><Brain size={14} /> Memory Sources</p>
              <button onClick={() => setShowMemoryPanel(false)} className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
            </div>
            <div className="p-4">
              <p className="text-xs text-muted-foreground">Atlas drew from {activeMemoryIds.length} stored memory/memories in this response.</p>
              <p className="text-xs text-muted-foreground mt-2">Memory IDs: {activeMemoryIds.slice(0, 3).map((id) => id.slice(0, 8)).join(", ")}…</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AtlasChat;
