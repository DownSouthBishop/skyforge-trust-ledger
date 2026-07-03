import { useRef, useState, useCallback, useEffect } from "react";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cancelSpeech, isSpeaking } from "./agent-voice";

export function useVoiceInput(setText: (t: string) => void, getCurrent: () => string) {
  const [recording, setRecording] = useState(false);
  const recRef = useRef<any>(null);
  const baseRef = useRef<string>("");
  const activeRef = useRef(false);

  const toggle = useCallback(() => {
    if (recording) {
      activeRef.current = false;
      try { recRef.current?.stop(); } catch {}
      setRecording(false);
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert("Voice input not supported in this browser"); return; }
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.lang = "en-US";
    const cur = getCurrent();
    baseRef.current = cur ? cur + " " : "";
    r.onresult = (e: any) => {
      let finalT = ""; let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalT += res[0].transcript + " ";
        else interim += res[0].transcript;
      }
      if (finalT) baseRef.current += finalT;
      setText(baseRef.current + interim);
    };
    r.onerror = (ev: any) => { if (ev.error !== "no-speech") { activeRef.current = false; setRecording(false); } };
    r.onend = () => { if (activeRef.current) { try { r.start(); } catch { activeRef.current = false; setRecording(false); } } };
    recRef.current = r;
    activeRef.current = true;
    setRecording(true);
    try { r.start(); } catch { activeRef.current = false; setRecording(false); }
  }, [recording, setText, getCurrent]);

  return { recording, toggle };
}

export function MicButton({ recording, onToggle, className = "" }: { recording: boolean; onToggle: () => void; className?: string }) {
  return (
    <Button
      type="button"
      variant={recording ? "default" : "outline"}
      size="icon"
      onClick={onToggle}
      className={`relative shrink-0 ${className}`}
      title={recording ? "Stop recording" : "Start voice input"}
    >
      {recording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      {recording && <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500 animate-ping" />}
      {recording && <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500" />}
    </Button>
  );
}

// ─── Continuous conversation mode ──────────────────────────────────────────
// Hands-free, always-listening loop: the mic stays armed, a short silence
// after you stop talking is treated as the end of your turn (auto-sends —
// no button press needed). While an agent is speaking, the mic is treated
// as effectively muted — recognized speech is discarded outright, not just
// prevented from cancelling playback — because without headphones the mic
// picks up the agent's own voice from the speakers, and letting that feed
// into scheduleEndOfTurn/onUtterance sends a phantom "message" built from
// the agent's own words, which is what causes agents to keep responding to
// each other in a runaway loop instead of the turn ever actually ending.
// Callers that want hands-free barge-in (single-agent chat) pass
// canBargeIn — once real words cross the threshold, playback is cancelled
// and the words heard so far during that speech become the start of the
// user's new turn. Callers with multi-speaker playback (the Closed
// Chamber's round-table) pass canBargeIn returning false, so speech is
// simply ignored for as long as any agent is still talking.
const SILENCE_MS = 900;
const BARGE_IN_MIN_CHARS = 4;

export function useConversationMode(onUtterance: (text: string) => void, canBargeIn: () => boolean = () => true) {
  const [active, setActive] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const activeRef = useRef(false);
  const finalRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;
  const canBargeInRef = useRef(canBargeIn);
  canBargeInRef.current = canBargeIn;

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
  };

  const scheduleEndOfTurn = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      const text = finalRef.current.trim();
      finalRef.current = "";
      if (text) onUtteranceRef.current(text);
    }, SILENCE_MS);
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    clearSilenceTimer();
    finalRef.current = "";
    try { recRef.current?.stop(); } catch { /* */ }
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert("Voice input not supported in this browser"); return; }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    r.onresult = (e: any) => {
      if (!activeRef.current) return; // ignore trailing results delivered after stop()
      let finalT = ""; let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalT += res[0].transcript + " ";
        else interim += res[0].transcript;
      }
      const heard = (finalT + interim).trim();

      if (isSpeaking()) {
        // Mic is effectively muted while any agent is talking, unless this
        // result crosses the barge-in threshold and barge-in is allowed —
        // otherwise the agent's own voice bleeding into the mic would get
        // treated as the start of a new user turn. Discard silently.
        if (heard.length >= BARGE_IN_MIN_CHARS && canBargeInRef.current()) {
          cancelSpeech();
          // fall through: this speech becomes the start of the user's new turn
        } else {
          clearSilenceTimer();
          finalRef.current = "";
          return;
        }
      }

      if (finalT) finalRef.current += finalT;
      if (finalT || interim) scheduleEndOfTurn();
    };
    r.onerror = (ev: any) => {
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      activeRef.current = false;
      setListening(false);
    };
    r.onend = () => {
      if (activeRef.current) { try { r.start(); } catch { activeRef.current = false; setListening(false); } }
      else setListening(false);
    };
    r.onstart = () => setListening(true);
    recRef.current = r;
    activeRef.current = true;
    try { r.start(); } catch { activeRef.current = false; return; }
  }, [scheduleEndOfTurn]);

  const toggle = useCallback(() => {
    if (active) { stop(); setActive(false); }
    else { start(); setActive(true); }
  }, [active, start, stop]);

  useEffect(() => stop, [stop]);

  return { active, listening, toggle };
}

export function ConversationModeButton({ active, listening, onToggle, className = "" }: { active: boolean; listening: boolean; onToggle: () => void; className?: string }) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      size="icon"
      onClick={onToggle}
      className={`relative shrink-0 ${className}`}
      title={active ? "Exit hands-free conversation mode" : "Start hands-free conversation (continuous, no button presses)"}
    >
      {active ? <PhoneOff className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
      {active && listening && <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-green-500 animate-pulse" />}
    </Button>
  );
}
