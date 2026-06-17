import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX, ChevronDown, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const KEY = "agent_voice_map";

function read(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
function write(m: Record<string, boolean>) {
  localStorage.setItem(KEY, JSON.stringify(m));
  window.dispatchEvent(new CustomEvent("agent-voice-change"));
}

export function isAgentVoiceOn(slug: string): boolean {
  return !!read()[slug?.toLowerCase()];
}

export function setAgentVoice(slug: string, on: boolean) {
  const m = read();
  m[slug.toLowerCase()] = on;
  write(m);
  if (!on && typeof window !== "undefined") window.speechSynthesis?.cancel();
}

export function useAgentVoice(slug: string): [boolean, () => void] {
  const [on, setOn] = useState(() => isAgentVoiceOn(slug));
  useEffect(() => {
    const sync = () => setOn(isAgentVoiceOn(slug));
    window.addEventListener("agent-voice-change", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("agent-voice-change", sync);
      window.removeEventListener("storage", sync);
    };
  }, [slug]);
  return [on, () => setAgentVoice(slug, !on)];
}

type VoiceProfile = { names: string[]; pitch: number; rate: number };

const AGENT_VOICE_PROFILES: Record<string, VoiceProfile> = {
  atlas: { names: ["Google UK English Male", "Microsoft David", "Daniel"], pitch: 0.85, rate: 0.80 },
  janus: { names: ["Microsoft David", "Microsoft Mark", "Google US English Male"], pitch: 0.90, rate: 0.72 },
  linda: { names: ["Microsoft Zira", "Google US English", "Samantha", "Karen"], pitch: 1.08, rate: 0.92 },
};

export function getAgentVoice(slug: string, voices: SpeechSynthesisVoice[]): { voice: SpeechSynthesisVoice | null; pitch: number; rate: number } {
  const profile = AGENT_VOICE_PROFILES[slug.toLowerCase()];
  if (!profile) return { voice: null, pitch: 1.0, rate: 0.95 };
  const voice = profile.names.reduce<SpeechSynthesisVoice | null>((found, name) => {
    return found ?? (voices.find(v => v.name.includes(name)) ?? null);
  }, null);
  return { voice, pitch: profile.pitch, rate: profile.rate };
}

let _voices: SpeechSynthesisVoice[] = [];
if (typeof window !== "undefined" && window.speechSynthesis) {
  const sync = () => { _voices = window.speechSynthesis.getVoices(); };
  sync();
  window.speechSynthesis.addEventListener("voiceschanged", sync);
}

export function speakAs(slug: string, text: string) {
  if (!isAgentVoiceOn(slug)) return;
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const doSpeak = (voices: SpeechSynthesisVoice[]) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      const profile = getAgentVoice(slug, voices);
      if (profile.voice) {
        u.voice = profile.voice;
      } else {
        const idx = parseInt(localStorage.getItem(`voice_${slug.toLowerCase()}`) ?? "-1", 10);
        if (idx >= 0 && voices[idx]) u.voice = voices[idx];
      }
      u.pitch = profile.pitch;
      u.rate = profile.rate;
      window.speechSynthesis.cancel();
      setTimeout(() => window.speechSynthesis.speak(u), 100);
    } catch { /* ignore */ }
  };
  if (_voices.length) { doSpeak(_voices); return; }
  // voices not ready yet — wait once
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    _voices = window.speechSynthesis.getVoices();
    doSpeak(_voices);
  }, { once: true });
}

export function speakChunked(slug: string, text: string) {
  if (!isAgentVoiceOn(slug)) return;
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  let i = 0;
  const speakNext = (voices: SpeechSynthesisVoice[]) => {
    if (i >= sentences.length) return;
    const u = new SpeechSynthesisUtterance(sentences[i++]);
    const profile = getAgentVoice(slug, voices);
    if (profile.voice) u.voice = profile.voice;
    u.pitch = profile.pitch;
    u.rate = profile.rate;
    u.onend = () => speakNext(voices);
    window.speechSynthesis.speak(u);
  };
  window.speechSynthesis.cancel();
  setTimeout(() => {
    if (_voices.length) { speakNext(_voices); return; }
    window.speechSynthesis.addEventListener("voiceschanged", () => {
      _voices = window.speechSynthesis.getVoices();
      speakNext(_voices);
    }, { once: true });
  }, 100);
}

export function AgentVoiceToggle({ slug, className = "", size = 14 }: { slug: string; className?: string; size?: number }) {
  const [on, toggle] = useAgentVoice(slug);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); toggle(); }}
      title={on ? `Voice on — ${slug} will speak` : `Voice off — text only`}
      aria-label={on ? "Disable voice" : "Enable voice"}
      className={`inline-flex items-center justify-center p-1 rounded-full transition-colors ${on ? "text-accent bg-accent/10" : "text-muted-foreground hover:text-foreground"} ${className}`}
    >
      {on ? <Volume2 style={{ width: size, height: size }} /> : <VolumeX style={{ width: size, height: size }} />}
    </button>
  );
}

// ─── Voice Picker ─────────────────────────────────────────────────────
type Rec = { index: number; name: string; reason: string };

function recsKey(slug: string) { return `voice_recs_${slug.toLowerCase()}`; }

export function AgentVoicePicker({ slug, className = "", size = 14 }: { slug: string; className?: string; size?: number }) {
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [recs, setRecs] = useState<Rec[]>(() => {
    try { return JSON.parse(localStorage.getItem(recsKey(slug)) || "[]"); } catch { return []; }
  });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number>(() => parseInt(localStorage.getItem(`voice_${slug.toLowerCase()}`) ?? "-1", 10));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis?.getVoices() ?? []);
    load();
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = load;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const fetchRecs = async () => {
    if (!voices.length) return;
    setLoading(true);
    try {
      const { data: agents } = await supabase
        .from("skyforge_agents")
        .select("system_prompt, style_notes, role")
        .eq("slug", slug.toLowerCase())
        .limit(1);
      const agent = agents?.[0];
      if (!agent) { setLoading(false); return; }
      const { data, error } = await supabase.functions.invoke("agent_voice_recommend", {
        body: {
          system_prompt: agent.system_prompt,
          style_notes: agent.style_notes,
          role: agent.role,
          voices: voices.map((v) => ({ name: v.name, lang: v.lang })),
        },
      });
      if (error) throw error;
      const list: Rec[] = (data as any)?.recommendations ?? [];
      setRecs(list);
      localStorage.setItem(recsKey(slug), JSON.stringify(list));
    } catch (e) { console.error("[voice-picker]", e); }
    finally { setLoading(false); }
  };

  const pick = (idx: number) => {
    setSelected(idx);
    localStorage.setItem(`voice_${slug.toLowerCase()}`, String(idx));
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(`Hello, I am ${slug}.`);
      if (voices[idx]) u.voice = voices[idx];
      const profile = getAgentVoice(slug, voices);
      u.pitch = profile.pitch;
      u.rate = profile.rate;
      window.speechSynthesis.speak(u);
    } catch { /* */ }
  };

  return (
    <div ref={ref} className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); if (!recs.length) fetchRecs(); }}
        title="Choose voice"
        className="inline-flex items-center gap-0.5 p-1 rounded-full text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown style={{ width: size, height: size }} />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-80 max-h-96 overflow-auto rounded-lg border border-white/10 bg-zinc-950/95 backdrop-blur-md shadow-2xl p-2">
          <div className="flex items-center justify-between px-2 py-1.5">
            <div className="text-[11px] uppercase tracking-wider text-zinc-400">Voice profiles — {slug}</div>
            <button onClick={fetchRecs} disabled={loading || !voices.length}
              className="text-[10px] px-2 py-0.5 rounded border border-orange-500/30 text-orange-400 hover:bg-orange-500/10 disabled:opacity-50 inline-flex items-center gap-1">
              {loading ? <><Loader2 className="w-3 h-3 animate-spin" /> Analyzing</> : "Re-analyze"}
            </button>
          </div>
          {recs.length === 0 && !loading && (
            <div className="px-2 py-3 text-xs text-zinc-500">No profiles yet. Click Re-analyze.</div>
          )}
          {loading && recs.length === 0 && (
            <div className="px-2 py-3 text-xs text-zinc-500 inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Profiling voice character…</div>
          )}
          <div className="space-y-1">
            {recs.map((r) => {
              const v = voices[r.index];
              if (!v) return null;
              const active = selected === r.index;
              return (
                <button key={r.index} onClick={() => pick(r.index)}
                  className="w-full text-left p-2 rounded-md border transition-all hover:bg-white/5"
                  style={{ borderColor: active ? "#f97316" : "rgba(255,255,255,0.08)", background: active ? "rgba(249,115,22,0.08)" : "transparent" }}>
                  <div className="text-xs text-white font-medium">{v.name} <span className="text-[10px] text-zinc-500">({v.lang})</span></div>
                  <div className="text-[11px] text-zinc-400 mt-0.5 leading-snug">{r.reason}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
