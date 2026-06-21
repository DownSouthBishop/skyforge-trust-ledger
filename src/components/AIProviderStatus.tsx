import { useState, useEffect, useCallback } from "react";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { RefreshCw, CheckCircle2, XCircle, AlertTriangle, Clock, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";

type AStatus = "ok" | "credits" | "quota" | "error" | "checking" | "unknown";
type GStatus = "ok" | "quota" | "error" | "checking" | "unknown";

interface ProviderState {
  status: AStatus | GStatus;
  message: string;
}

interface StatusResult {
  checked_at: string;
  seconds_until_gemini_reset: number;
  providers: {
    anthropic: { status: AStatus; message: string };
    gemini: { status: GStatus; message: string; key_tail: string };
  };
}

const CACHE_KEY = "wig_ai_status_v1";
const CACHE_TTL = 30 * 60 * 1000;

const CFG: Record<string, { label: string; color: string; dot: string }> = {
  ok:       { label: "Online",           color: "text-green-400 border-green-400/30 bg-green-400/5",   dot: "bg-green-400" },
  credits:  { label: "No Credits",       color: "text-red-400 border-red-400/30 bg-red-400/5",         dot: "bg-red-400" },
  quota:    { label: "Quota Exceeded",   color: "text-amber-400 border-amber-400/30 bg-amber-400/5",   dot: "bg-amber-400" },
  error:    { label: "Error",            color: "text-red-400 border-red-400/30 bg-red-400/5",         dot: "bg-red-400" },
  checking: { label: "Checking…",        color: "text-blue-400 border-blue-400/30 bg-blue-400/5",      dot: "bg-blue-400 animate-pulse" },
  unknown:  { label: "Unknown",          color: "text-muted-foreground border-border/30 bg-secondary/10", dot: "bg-muted-foreground/40" },
};

function pad(n: number) { return String(n).padStart(2, "0"); }

function secondsToHMS(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return { h, m, sec };
}

function getActiveRoute(a: AStatus | GStatus, g: AStatus | GStatus) {
  if (g === "ok")            return { text: "Google Gemini (primary)", color: "text-green-400" };
  if (a === "ok")            return { text: "Anthropic Claude (fallback)", color: "text-amber-400" };
  if (a === "checking" || g === "checking") return { text: "Checking providers…", color: "text-blue-400/70" };
  return { text: "All providers unavailable", color: "text-red-400" };
}

export default function AIProviderStatus() {
  const [anthropic, setAnthropic] = useState<ProviderState>({ status: "unknown", message: "" });
  const [gemini, setGemini]       = useState<ProviderState>({ status: "unknown", message: "" });
  const [geminiKeyTail, setGeminiKeyTail] = useState("");
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [loading, setLoading]     = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Live countdown ticker
  useEffect(() => {
    const tick = setInterval(() => {
      setSecondsLeft(s => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  const check = useCallback(async (force = false) => {
    if (!force) {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        try {
          const { ts, result }: { ts: number; result: StatusResult } = JSON.parse(raw);
          if (Date.now() - ts < CACHE_TTL) {
            apply(result, ts);
            return;
          }
        } catch { /* ignore */ }
      }
    }

    setLoading(true);
    setAnthropic({ status: "checking", message: "" });
    setGemini({ status: "checking", message: "" });

    try {
      const { data, error } = await supabase.functions.invoke("check-ai-status");
      if (error || !data) throw new Error("no data");
      const result = data as StatusResult;
      apply(result, Date.now());
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), result }));
    } catch {
      setAnthropic({ status: "error", message: "Status check failed" });
      setGemini({ status: "error", message: "Status check failed" });
    } finally {
      setLoading(false);
    }
  }, []);

  function apply(result: StatusResult, ts: number) {
    setAnthropic({ status: result.providers.anthropic.status, message: result.providers.anthropic.message });
    setGemini({ status: result.providers.gemini.status, message: result.providers.gemini.message });
    setGeminiKeyTail(result.providers.gemini.key_tail ?? "");
    setCheckedAt(new Date(ts).toLocaleTimeString());
    // Adjust seconds left by how long ago the check was
    const elapsed = Math.floor((Date.now() - ts) / 1000);
    setSecondsLeft(Math.max(0, result.seconds_until_gemini_reset - elapsed));
  }

  useEffect(() => { void check(); }, [check]);

  const { h, m, sec } = secondsToHMS(secondsLeft);
  const route = getActiveRoute(anthropic.status, gemini.status);

  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-primary/60" />
          <h2 className="text-sm font-display tracking-widest text-primary uppercase">AI Provider Status</h2>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => check(true)}
          disabled={loading}
          className="text-muted-foreground hover:text-foreground text-xs gap-1.5 h-7"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Active route indicator */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/20 border border-border/20">
        <div className={`h-1.5 w-1.5 rounded-full ${CFG[anthropic.status]?.dot ?? CFG.unknown.dot}`} />
        <span className="text-[11px] font-mono text-muted-foreground/70">Active route:</span>
        <span className={`text-[11px] font-mono font-medium ${route.color}`}>{route.text}</span>
      </div>

      {/* Provider cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

        {/* Anthropic */}
        <div className="p-4 rounded-lg border border-border/20 bg-secondary/10 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-display uppercase text-foreground/80">Anthropic Claude</div>
              <div className="text-[10px] text-muted-foreground/50 font-mono mt-0.5">claude-haiku-4-5 · Fallback</div>
            </div>
            <StatusBadge status={anthropic.status} />
          </div>
          {anthropic.message && (
            <p className="text-[10px] text-muted-foreground/60 leading-relaxed">{anthropic.message}</p>
          )}
          {anthropic.status === "credits" && (
            <div className="text-[10px] text-muted-foreground/40 space-y-0.5">
              <p>Add credits at console.anthropic.com to restore primary routing.</p>
            </div>
          )}
          {anthropic.status === "ok" && (
            <p className="text-[10px] text-green-400/60">Available as fallback when Gemini is unavailable.</p>
          )}
        </div>

        {/* Gemini */}
        <div className="p-4 rounded-lg border border-border/20 bg-secondary/10 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-display uppercase text-foreground/80">Google Gemini</div>
              <div className="text-[10px] text-muted-foreground/50 font-mono mt-0.5">gemini-2.5-flash · Primary</div>
            </div>
            <StatusBadge status={gemini.status} />
          </div>

          {gemini.status === "quota" && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                Free tier: 1,500 req/day exhausted. Quota resets at midnight UTC daily.
              </p>
              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground/40 uppercase tracking-widest">Resets in</div>
                <div className="font-mono text-2xl tracking-widest text-amber-400/90 tabular-nums">
                  {pad(h)}:{pad(m)}:{pad(sec)}
                </div>
              </div>
            </div>
          )}

          {gemini.status === "ok" && (
            <p className="text-[10px] text-green-400/60">Primary provider healthy and available.</p>
          )}

          {gemini.status === "error" && gemini.message && (
            <p className="text-[10px] text-red-400/60 leading-relaxed">{gemini.message}</p>
          )}

          {geminiKeyTail && (
            <p className="text-[10px] text-muted-foreground/30 font-mono">Key: {geminiKeyTail}</p>
          )}
        </div>
      </div>

      {/* Quota info row */}
      <div className="grid grid-cols-2 gap-3 text-[10px] text-muted-foreground/40">
        <div className="px-3 py-2 rounded border border-border/10 bg-secondary/5 space-y-1">
          <div className="uppercase tracking-widest">Anthropic</div>
          <div className="text-foreground/40 font-mono">Pay-per-token · no daily cap</div>
        </div>
        <div className="px-3 py-2 rounded border border-border/10 bg-secondary/5 space-y-1">
          <div className="uppercase tracking-widest">Gemini Free Tier</div>
          <div className="text-foreground/40 font-mono">1,500 req/day · resets midnight UTC</div>
        </div>
      </div>

      {checkedAt && (
        <p className="text-[10px] text-muted-foreground/25 font-mono">Checked at {checkedAt} · refreshes every 30 min</p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: AStatus | GStatus }) {
  const cfg = CFG[status] ?? CFG.unknown;
  const Icon = status === "ok" ? CheckCircle2
    : status === "checking" ? RefreshCw
    : status === "quota" ? AlertTriangle
    : status === "unknown" ? Clock
    : XCircle;

  return (
    <span className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded border whitespace-nowrap ${cfg.color}`}>
      <Icon className={`h-3 w-3 shrink-0 ${status === "checking" ? "animate-spin" : ""}`} />
      {cfg.label}
    </span>
  );
}
