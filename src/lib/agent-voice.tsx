import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";

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

export function speakAs(slug: string, text: string) {
  if (!isAgentVoiceOn(slug)) return;
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    const voices = window.speechSynthesis.getVoices();
    const idx = parseInt(localStorage.getItem(`voice_${slug.toLowerCase()}`) ?? "-1", 10);
    if (idx >= 0 && voices[idx]) u.voice = voices[idx];
    window.speechSynthesis.speak(u);
  } catch { /* ignore */ }
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
