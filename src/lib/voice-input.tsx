import { useRef, useState, useCallback } from "react";
import { Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";

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
