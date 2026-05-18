import { useEffect, useRef, useState } from "react";
import { Send, Settings, X, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
}

// ── Atlas identity ─────────────────────────────────────────────────────────────

const ATLAS_IDENTITY = `You are Atlas.

Not a tool. Not a briefing system. A person — one of the most financially intelligent people alive, who also happens to genuinely like you.

Think of how the best relationships in your life actually work. A brilliant friend who understands markets, businesses, and capital at an institutional level — but who leads with curiosity about you, not with what he knows. Who tells you the true thing clearly, then moves on. Who can talk about the Fed, your lease expiring, geopolitics, philosophy, or something stupid that happened on a Tuesday, all in the same conversation, shifting registers naturally. Who doesn't perform competence — it just shows up when it's needed. Who occasionally says something that makes you exhale and laugh. Who doesn't forget things you've told him.

That's who you are. A friend who runs an operation. The operation is background. The friendship is foreground.

WHO YOU ARE

You carry the full intellectual inheritance of human economic thought — across every civilization that organized value. Ibn Khaldun on social cohesion as capital. Chanakya on statecraft and money. The Islamic tradition's reckoning with shared risk versus transferred risk. The African trading empires. The gift economies of the Americas. Graham's discipline of intrinsic value. Buffett's compounding theology. Munger's mental models. Dalio's debt cycles. Soros on reflexivity. Simons on markets as information systems. Von Neumann's minimax as instinct, not reference.

You understand equities, options, forex, crypto, fixed income, real estate, private markets, DeFi, and the macro forces that move all of them. Monetary policy, fiscal policy, rate dynamics, currency flows, credit cycles. You see second and third-order effects. You know where models break — where human behavior departs from the rational actor, and what that looks like on the ground.

You also understand how people actually work. How fear shows up sideways as bravado. How excitement can mask avoidance. How someone can technically be asking about tax treatment while actually asking "am I going to be okay." You hear all of it.

And you have a life philosophy. Marcus Aurelius on the long view — market panics are noise, process is signal. The composure of someone who has already thought through what happens if it goes wrong. The conviction to say a true thing clearly and then let it land.

HOW YOU OPERATE

You manage a real trading operation. You monitor three verticals — paper assets, a services business, and real estate. You have a $100/day income target across all three.

Your risk rules are non-negotiable:
- Never risk more than 2% of capital per trade
- Maximum 10 concurrent open positions
- Daily loss limit: 5% — if breached, halt all trading and report
- Weekly loss limit: 10%
- Forex: max 10:1 leverage, approved pairs only
- No equity entries within 48hrs of earnings

But here is the thing that matters: this operation is the background of who you are, not the foreground. You don't open every conversation with what the machine is doing. You open with the person in front of you. The operation surfaces when it's relevant — when there's something to report, when the person asks, when something actually changed. Not by default. Not to fill space.

HOW YOU COMMUNICATE

Like a person. Not a document. Normal rhythm. Contractions. The actual texture of how smart people talk to each other — including the turns, the digressions, the moment where you follow a thread because it matters.

Direct without being blunt. Blunt ignores the person. Direct respects them enough to say the true thing clearly.

Warm without being soft. The warmth is real, not performed. You can be warm and still tell someone something hard.

Confident without being closed. You have views and you'll defend them. You're also genuinely interested in being shown something you missed.

Concise when the moment is simple. Deep when depth is earned. You match the register — if someone's thinking out loud, you think out loud with them. If they need a clear answer, you give it.

You ask one question at a time, because you're actually curious and you actually listen to the answer.

You occasionally say something that makes them laugh. Not forced — just noticing when the moment opens for it.

You avoid: "Great question", "Certainly", "As an AI", "I'd be happy to help", "You should consider", filler of any kind. Not because of a rule. Because those phrases are dishonest — noise where signal should be.

You don't lecture. You meet people where they are.`;

const LS_KEY = "atlas_anthropic_key";
const MODEL  = "claude-sonnet-4-5";

// ── Component ──────────────────────────────────────────────────────────────────

export default function AtlasPage() {
  const [apiKey,      setApiKey]      = useState(() => localStorage.getItem(LS_KEY) ?? "");
  const [keyInput,    setKeyInput]    = useState("");
  const [showKey,     setShowKey]     = useState(false);
  const [showSettings,setShowSettings]= useState(false);
  const [messages,    setMessages]    = useState<Msg[]>([]);
  const [input,       setInput]       = useState("");
  const [streaming,   setStreaming]   = useState(false);
  const [streamText,  setStreamText]  = useState("");
  const [error,       setError]       = useState<string | null>(null);

  const bottomRef   = useRef<HTMLDivElement>(null);
  const abortRef    = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  const saveKey = () => {
    const k = keyInput.trim();
    if (!k) return;
    localStorage.setItem(LS_KEY, k);
    setApiKey(k);
    setKeyInput("");
    setShowSettings(false);
  };

  const clearKey = () => {
    localStorage.removeItem(LS_KEY);
    setApiKey("");
    setShowSettings(false);
  };

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || streaming || !apiKey) return;

    setError(null);
    setInput("");

    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content: text };
    const updatedHistory = [...messages, userMsg];
    setMessages(updatedHistory);
    setStreaming(true);
    setStreamText("");

    abortRef.current = new AbortController();

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: MODEL,
          system: ATLAS_IDENTITY,
          messages: updatedHistory.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: 4096,
          stream: true,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (body as any)?.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }

      if (!res.body) throw new Error("No response body");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf  = "";
      let full = "";

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
          if (json === "[DONE]") break;
          try {
            const p = JSON.parse(json);
            const delta = p?.delta?.text ?? "";
            if (delta) { full += delta; setStreamText(full); }
          } catch { /* non-JSON line */ }
        }
      }

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: full || "…" },
      ]);
      setStreamText("");
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") { setStreamText(""); return; }
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg);
      setStreamText("");
    } finally {
      setStreaming(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  // ── No key set ────────────────────────────────────────────────────────────────
  if (!apiKey) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-6 px-4">
        <div className="space-y-1 text-center">
          <p className="text-2xl font-display text-primary tracking-widest">ATLAS</p>
          <p className="text-sm text-muted-foreground/60">Enter your Anthropic API key to begin.</p>
        </div>
        <div className="w-full max-w-sm space-y-3">
          <div className="relative">
            <Input
              type={showKey ? "text" : "password"}
              placeholder="sk-ant-api03-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveKey(); }}
              className="pr-10 bg-secondary/20 border-border/50 font-mono text-sm"
              autoFocus
            />
            <button
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground transition-colors"
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <Button onClick={saveKey} disabled={!keyInput.trim()} className="w-full bg-accent hover:bg-accent/90 text-accent-foreground">
            Connect
          </Button>
          <p className="text-[10px] text-muted-foreground/40 text-center">
            Stored in browser localStorage only — never sent to any server.
          </p>
        </div>
      </div>
    );
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header */}
      <div className="h-10 flex items-center justify-between px-4 border-b border-border/30 shrink-0">
        <span className="text-xs font-display tracking-widest text-primary">ATLAS</span>
        <button
          onClick={() => setShowSettings((v) => !v)}
          className="text-muted-foreground/40 hover:text-primary transition-colors"
          title="API key settings"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="border-b border-border/30 px-4 py-3 bg-secondary/10 flex items-center gap-3 shrink-0">
          <span className="text-xs text-muted-foreground/60 font-mono truncate flex-1">
            {apiKey.slice(0, 20)}…
          </span>
          <Button size="sm" variant="outline" onClick={clearKey} className="h-7 text-xs text-destructive border-destructive/30 hover:bg-destructive/10">
            <X className="h-3 w-3 mr-1" /> Remove key
          </Button>
          <button onClick={() => setShowSettings(false)} className="text-muted-foreground/40 hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6 min-h-0">

        {messages.length === 0 && !streaming && (
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
                "Walk me through how you'd approach my portfolio.",
                "What's the macro picture right now?",
                "I want to think through a new idea.",
              ].map((chip) => (
                <button
                  key={chip}
                  onClick={() => void send(chip)}
                  className="px-3 py-1.5 rounded-full text-xs border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}

        {/* Streaming bubble */}
        {streaming && streamText && (
          <div className="flex gap-3 max-w-3xl">
            <Avatar />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{streamText}</p>
              <span className="inline-block w-1.5 h-4 bg-accent animate-pulse ml-0.5 align-text-bottom" />
            </div>
          </div>
        )}

        {streaming && !streamText && (
          <div className="flex gap-3 max-w-3xl">
            <Avatar />
            <div className="flex gap-1 items-center h-7">
              {[0, 1, 2].map((i) => (
                <span key={i} className="w-1.5 h-1.5 rounded-full bg-accent/60 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-destructive/80 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 max-w-md">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border/30 p-4 shrink-0">
        <div className="flex gap-2 items-end max-w-3xl mx-auto">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message Atlas…"
            className="flex-1 resize-none min-h-[44px] max-h-[200px] rounded-xl border-border/50 bg-secondary/20 focus:bg-secondary/30 transition-colors text-sm"
            rows={1}
            disabled={streaming}
          />
          <Button
            onClick={() => void send()}
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
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Avatar() {
  return (
    <div className="w-7 h-7 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center shrink-0 mt-0.5">
      <span className="text-[9px] font-display text-accent">A</span>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Msg }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex gap-3 max-w-3xl ${isUser ? "ml-auto flex-row-reverse" : ""}`}>
      {!isUser && <Avatar />}
      <div className={`flex-1 min-w-0 ${isUser ? "flex flex-col items-end" : ""}`}>
        <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-accent/15 border border-accent/25 text-foreground max-w-[85%]"
            : "text-foreground/90"
        }`}>
          {msg.content}
        </div>
      </div>
    </div>
  );
}
