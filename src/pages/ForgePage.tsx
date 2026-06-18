import { useEffect, useRef, useState } from "react";
import { getAgentVoice } from "@/lib/agent-voice";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Flame, Copy, RefreshCw, Trash2, Paperclip, X, Bell, Calculator, TrendingUp, Globe, Newspaper, Mic, Volume2, VolumeX } from "lucide-react";
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

type Commitment = {
  id: string;
  description: string;
  made_at: string;
  target_date: string | null;
  follow_up_count: number;
};

const DEFAULT_CHIPS = [
  "What's worth paying attention to today?",
  "Run me through the current state of things.",
  "What should I be thinking about this week?",
];

const IDEA_PRIMER    = "I want to think through a new idea with you.";
const NUMBERS_PRIMER = "Run the numbers on this for me —";

const FORGE_URL          = `${"https://hycpzeskartlkybsfkbh.supabase.co"}/functions/v1/forge_chat`;
const FORGE_COMPRESS_URL = `${"https://hycpzeskartlkybsfkbh.supabase.co"}/functions/v1/forge_compress`;
const FORGE_SUGGEST_URL  = `${"https://hycpzeskartlkybsfkbh.supabase.co"}/functions/v1/forge_suggest`;
const ATLAS_BRIEF_URL    = `${"https://hycpzeskartlkybsfkbh.supabase.co"}/functions/v1/atlas_market_brief`;
const ATLAS_FOREX_URL    = `${"https://hycpzeskartlkybsfkbh.supabase.co"}/functions/v1/atlas_forex_scan`;
const FORGE_LEARN_URL    = `${"https://hycpzeskartlkybsfkbh.supabase.co"}/functions/v1/forge_learn`;

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

// Compression fires after 20 messages, keeps 8 recent.
// The dossier extraction captures what was in the compressed messages before they're gone.
const COMPRESS_THRESHOLD = 20;
const COMPRESS_KEEP = 8;

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
  const [runningBrief, setRunningBrief] = useState(false);
  const [scanningForex, setScanningForex] = useState(false);
  const [attachments, setAttachments] = useState<{ name: string; media_type: string; data: string; preview?: string }[]>([]);
  const [openCommitments, setOpenCommitments] = useState<Commitment[]>([]);
  const [forgeAlerts, setForgeAlerts] = useState<{ id: string; signal_type: string; message: string }[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const [automationCandidates, setAutomationCandidates] = useState<{ id: string; value: string }[]>([]);
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const v = localStorage.getItem("atlas_tts_enabled");
    return v === null ? true : v === "true";
  });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceIndex, setVoiceIndex] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    return parseInt(localStorage.getItem("atlas_voice_index") ?? "0", 10) || 0;
  });
  const [listening, setListening] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const lastSpokenRef = useRef<string>("");

  // Load browser voices
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.onvoiceschanged = load;
  }, []);

  useEffect(() => { localStorage.setItem("atlas_tts_enabled", String(ttsEnabled)); }, [ttsEnabled]);
  useEffect(() => { localStorage.setItem("atlas_voice_index", String(voiceIndex)); }, [voiceIndex]);

  // Speak completed assistant replies
  useEffect(() => {
    if (!ttsEnabled || streaming) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || !last.content) return;
    if (lastSpokenRef.current === last.content) return;
    lastSpokenRef.current = last.content;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(last.content);
      const profile = getAgentVoice("atlas", voices);
      u.voice = (voiceIndex >= 0 && voices[voiceIndex]) ? voices[voiceIndex] : (profile.voice ?? u.voice);
      u.pitch = profile.pitch;
      u.rate = profile.rate;
      window.speechSynthesis.speak(u);
    } catch { /* */ }
  }, [messages, streaming, ttsEnabled, voices, voiceIndex]);

  const startListening = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { toast.error("Voice not supported in this browser."); return; }
    const recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setInput(transcript);
      setListening(false);
      void runStream([{ role: "user", content: transcript }], {}, []);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    setListening(true);
    recognition.start();
  };


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

    // Load open commitments
    void loadCommitments();

    // Check for CRM opportunities
    try {
      const { data: opps } = await supabase.rpc("get_crm_opportunities", { _user_id: user!.id });
      setHasCrmOpps(Array.isArray(opps) && opps.length > 0);
    } catch (e) {
      console.error("crm opps check failed", e);
    }

    // Pull re-engagement message + stamp last_seen_at
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("atlas_reengagement_message, last_seen_at")
      .eq("user_id", user!.id)
      .maybeSingle();

    const reengagementMsg = (profile as any)?.atlas_reengagement_message as string | null;

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

    // Load alerts from forge context
    try {
      const { data: ctxData } = await supabase.rpc("get_forge_context", { _user_id: user!.id });
      const ctx = ctxData as any;
      if (Array.isArray(ctx?.alerts) && ctx.alerts.length > 0) {
        setForgeAlerts(ctx.alerts.slice(0, 3));
      }

      // Intake detection: empty dossier + no message history
      const dossier = ctx?.dossier ?? {};
      const isEmpty = !dossier.life_context && !dossier.north_star &&
        (!Array.isArray(dossier.businesses) || dossier.businesses.length === 0);

      if (isEmpty && (!history || history.length === 0)) {
        // mode: "intake" — server reads body.mode, no sentinel string needed
        await runStream([], { intake: true });
        return;
      }
    } catch (e) {
      console.error("context load failed", e);
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
      void refreshChips(loaded);
    } else {
      // Try to inject today's morning brief before opening
      const today = new Date().toISOString().slice(0, 10);
      const { data: briefRow } = await supabase
        .from("shared_operator_memory")
        .select("value")
        .eq("user_id", user!.id)
        .eq("memory_type", "morning_brief")
        .eq("key", `brief_${today}`)
        .maybeSingle();
      if (briefRow?.value) {
        const briefMsg: Msg = { role: "assistant", content: briefRow.value };
        const id = await persistMessage(briefMsg);
        briefMsg.id = id;
        setMessages([briefMsg]);
      } else {
        await runStream([], { opening: true });
      }
    }

    // Load automation candidates
    void loadAutomationCandidates();
  };

  const loadAutomationCandidates = async () => {
    const { data } = await supabase
      .from("shared_operator_memory")
      .select("id, value")
      .eq("user_id", user!.id)
      .eq("memory_type", "automation_candidate")
      .order("updated_at", { ascending: false })
      .limit(10);
    setAutomationCandidates((data ?? []) as { id: string; value: string }[]);
  };

  const approveAutomation = async (id: string, value: string) => {
    await supabase.from("shared_operator_memory").insert({
      user_id: user!.id, source_agent: "atlas", memory_type: "automation_approved",
      key: `approved_${Date.now()}`, value, context: "automation", confidence: 1.0,
    });
    await supabase.from("shared_operator_memory").delete().eq("id", id);
    setAutomationCandidates((prev) => prev.filter((c) => c.id !== id));
  };

  const dismissAutomation = async (id: string) => {
    await supabase.from("shared_operator_memory").delete().eq("id", id);
    setAutomationCandidates((prev) => prev.filter((c) => c.id !== id));
  };


  const loadCommitments = async () => {
    try {
      const { data } = await supabase
        .from("forge_commitments")
        .select("id, description, made_at, target_date, follow_up_count")
        .eq("user_id", user!.id)
        .eq("resolution_status", "open")
        .order("made_at", { ascending: false })
        .limit(3);
      setOpenCommitments((data ?? []) as Commitment[]);
    } catch (e) {
      console.error("commitments load failed", e);
    }
  };

  const resolveCommitment = async (id: string, status: "kept" | "missed") => {
    try {
      await supabase
        .from("forge_commitments")
        .update({ resolution_status: status, resolution_at: new Date().toISOString() })
        .eq("id", id);
      setOpenCommitments((prev) => prev.filter((c) => c.id !== id));
      // No toast — quiet resolution. Atlas will notice through the data.
    } catch (e) {
      console.error("resolve commitment failed", e);
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
          messages: [{ role: "user", content: "[Generate today's directive.]" }],
          mode: "directive",
        }),
      });
      if (!res.ok || !res.body) throw new Error("directive generation failed");
      const text = await readStreamToText(res.body);
      setDirective(text.trim());
      await supabase.from("forge_directives").insert({
        user_id: user!.id,
        directive: text.trim(),
        confidence_score: 75,
      });
    } catch (e) {
      console.error(e);
      setDirective("Check your open positions. The next move starts with your current exposure.");
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
          const c = p.choices?.[0]?.delta?.content ?? p.delta?.text ?? "";
          if (c) out += c;
        } catch { buf = line + "\n" + buf; break; }
      }
    }
    return out;
  };

  // Memory compression: fires at COMPRESS_THRESHOLD, keeps COMPRESS_KEEP raw messages.
  // The dossier extraction in the summarize endpoint captures what was in the older messages
  // before they're compressed out of the API context window.
  const compressIfNeeded = async (history: Msg[]): Promise<{ role: string; content: string }[]> => {
    if (history.length <= COMPRESS_THRESHOLD) {
      return history.map((m) => ({ role: m.role, content: m.content }));
    }
    const older = history.slice(0, history.length - COMPRESS_KEEP);
    const recent = history.slice(history.length - COMPRESS_KEEP);

    try {
      const res = await fetch(FORGE_COMPRESS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          messages: older.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const j = await res.json();
      const summary = j?.summary ?? "";
      // Reload commitments after compression — new ones may have been extracted
      void loadCommitments();
      const msgs: { role: string; content: string }[] = [];
      if (summary) {
        msgs.push({ role: "system", content: `Earlier conversation summary:\n${summary}` });
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
      const res = await fetch(FORGE_SUGGEST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ lastUser, lastAssistant }),
      });
      const j = await res.json();
      if (Array.isArray(j?.suggestions) && j.suggestions.length > 0) {
        setChips(j.suggestions.slice(0, 3));
      }
    } catch (e) {
      console.error("chip refresh failed", e);
    }
  };

  const fireLearn = (userMsg: string, atlasMsg: string) => {
    if (!session?.access_token || !userMsg || !atlasMsg) return;
    fetch(FORGE_LEARN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ user_message: userMsg.slice(0, 2000), atlas_message: atlasMsg.slice(0, 2000) }),
    }).catch(() => {});
  };

  const runStream = async (
    extraMessages: Msg[],
    opts: { opening?: boolean; intake?: boolean } = {},
    pendingAttachments: { name: string; media_type: string; data: string }[] = [],
  ) => {
    if (streaming) return;
    setStreaming(true);

    const baseHistory = messages;

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

    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

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
          messages: (opts.opening || opts.intake)
            ? [{ role: "user", content: "[Operator just opened the app.]" }]
            : apiMessages,
          opening: opts.opening ?? false,
          mode: opts.intake ? "intake" : "chat",
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
            const c = p.choices?.[0]?.delta?.content ?? p.delta?.text ?? "";
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
      const finalHistory = await postProcess(acc, visibleHistory, !!(opts.opening || opts.intake));
      void refreshChips(finalHistory);
    } catch (e) {
      console.error(e);
    } finally {
      setStreaming(false);
    }
  };

  const postProcess = async (raw: string, visibleHistory: Msg[], isSystemTurn = false): Promise<Msg[]> => {
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

    // Fire-and-forget learning extraction — skip on system-generated turns
    const lastUserMsg = visibleHistory.filter(m => m.role === "user").at(-1)?.content ?? "";
    if (!isSystemTurn && lastUserMsg && finalAssistant.content) {
      fireLearn(typeof lastUserMsg === "string" ? lastUserMsg : "", finalAssistant.content);
    }

    return [...visibleHistory, finalAssistant];
  };

  const dismissForgeAlert = async (id: string) => {
    setDismissedAlerts((prev) => new Set([...prev, id]));
    await supabase.from("forge_alerts").update({ read_at: new Date().toISOString() }).eq("id", id);
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
      await fetch(FORGE_COMPRESS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      await supabase
        .from("user_profiles")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("user_id", user!.id);
      // Reload commitments — sync may have extracted new ones
      void loadCommitments();
      toast.success("Synced — Atlas will remember this when you return.");
    } catch (e) {
      console.error("omni sync failed", e);
      toast.error("Sync failed. Try again.");
    } finally {
      setSyncing(false);
    }
  };

  const handleRunBrief = async () => {
    if (runningBrief || streaming) return;
    setRunningBrief(true);
    try {
      await fetch(ATLAS_BRIEF_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ user_id: user!.id }),
      });
      toast.success("Market brief generated — check the Vault.");
      void runStream([{ role: "user", content: "You just ran my market brief. Give me the key points I need to know right now." }]);
    } catch {
      toast.error("Brief failed — try again.");
    } finally {
      setRunningBrief(false);
    }
  };

  const handleForexScan = async () => {
    if (scanningForex || streaming) return;
    setScanningForex(true);
    try {
      await fetch(ATLAS_FOREX_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ user_id: user!.id }),
      });
      toast.success("Forex scan complete — check the Vault.");
      void runStream([{ role: "user", content: "You just ran the forex scan. What setups are worth looking at and why?" }]);
    } catch {
      toast.error("Forex scan failed.");
    } finally {
      setScanningForex(false);
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
  };

  const encodeFile = (file: File): Promise<{ name: string; media_type: string; data: string; preview?: string }> => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return Promise.reject(new Error(`${file.name} exceeds the 10 MB limit.`));
    }
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
      toast.error(err instanceof Error ? err.message : "Could not read file.");
    }
    e.target.value = "";
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)] md:h-[calc(100vh-2rem)] max-w-4xl mx-auto p-4 md:p-6 gap-4">

      {/* TOP: Directive + open commitments */}
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
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => { if (ttsEnabled) window.speechSynthesis?.cancel(); setTtsEnabled((v) => !v); }}
              title={ttsEnabled ? "Mute voice" : "Enable voice"}
              className="p-1 rounded hover:bg-secondary/40 text-muted-foreground hover:text-accent transition-colors"
            >
              {ttsEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
            </button>
            {ttsEnabled && voices.length > 0 && (
              <select
                value={voiceIndex}
                onChange={(e) => setVoiceIndex(parseInt(e.target.value, 10))}
                className="text-[10px] bg-secondary/40 border border-border/30 rounded px-1 py-0.5 text-muted-foreground max-w-[120px]"
                title="Atlas voice"
              >
                {voices.slice(0, 5).map((v, i) => (
                  <option key={v.name} value={i}>{v.name}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        <p className="text-base md:text-lg text-foreground leading-snug">
          {directive ?? (directiveLoading ? "Reading the field…" : "—")}
        </p>

        {/* Atlas alerts — proactive signals */}
        {forgeAlerts.filter((a) => !dismissedAlerts.has(a.id)).length > 0 && (
          <div className="mt-4 pt-4 border-t border-border/20 space-y-2">
            {forgeAlerts.filter((a) => !dismissedAlerts.has(a.id)).map((a) => (
              <div key={a.id} className="flex items-start gap-2 text-xs text-accent/80">
                <Bell className="h-3 w-3 mt-0.5 shrink-0 text-accent/60" />
                <span className="flex-1 leading-snug">{a.message}</span>
                <button
                  onClick={() => dismissForgeAlert(a.id)}
                  className="opacity-40 hover:opacity-80 transition-opacity shrink-0"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Open commitments — quiet threads Atlas is tracking */}
        {openCommitments.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border/20">
            <span className="text-[10px] font-display tracking-widest text-muted-foreground/50 uppercase">
              Open Threads
            </span>
            <div className="mt-2 space-y-2">
              {openCommitments.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground flex-1 leading-snug">
                    "{c.description}"
                  </span>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => resolveCommitment(c.id, "kept")}
                      className="text-[10px] px-2 py-0.5 rounded-full border border-primary/30 text-primary hover:bg-primary/10 transition-colors"
                    >
                      Done
                    </button>
                    <button
                      onClick={() => resolveCommitment(c.id, "missed")}
                      className="text-[10px] px-2 py-0.5 rounded-full border border-border/40 text-muted-foreground hover:border-border/70 hover:text-foreground/60 transition-colors"
                    >
                      Not yet
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
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
                        m.content.split("\n")[0].slice(0, 60).trim() || "Atlas asset";
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
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={onFilesSelected}
        />
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a, i) => (
              <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-secondary/60 border border-border/40 text-xs text-muted-foreground">
                {a.preview ? (
                  <img src={a.preview} alt={a.name} className="h-6 w-6 rounded object-cover" />
                ) : (
                  <Paperclip className="h-3 w-3" />
                )}
                <span className="max-w-[120px] truncate">{a.name}</span>
                <button onClick={() => removeAttachment(i)} className="hover:text-foreground transition-colors">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {automationCandidates.length > 0 && (
          <div className="space-y-2">
            {automationCandidates.map((c) => (
              <div key={c.id} className="flex items-start gap-2 px-3 py-2 rounded-lg border border-accent/30 bg-accent/5">
                <span className="text-sm shrink-0">💡</span>
                <span className="flex-1 text-xs text-foreground/80 leading-snug">{c.value.slice(0, 120)}</span>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => approveAutomation(c.id, c.value)} className="text-[10px] px-2 py-0.5 rounded border border-primary/40 text-primary hover:bg-primary/10">✓ Approve</button>
                  <button onClick={() => dismissAutomation(c.id)} className="text-[10px] px-2 py-0.5 rounded border border-border/40 text-muted-foreground hover:bg-secondary/40">✗ Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        )}

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
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="self-end"
            onClick={() => fileInputRef.current?.click()}
            disabled={streaming}
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="self-end"
            onClick={startListening}
            disabled={streaming || listening}
            title="Voice input"
          >
            <Mic className={`h-4 w-4 ${listening ? "text-accent animate-pulse" : ""}`} />
          </Button>
          <Button onClick={onSendClick} disabled={streaming || !input.trim()} size="icon" className="self-end">
            <Send className="h-4 w-4" />
          </Button>

        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onChipClick(IDEA_PRIMER)}
            disabled={streaming}
            className="text-xs px-3 py-1.5 rounded-full border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
          >
            New Idea
          </button>
          <button
            onClick={() => {
              setInput(NUMBERS_PRIMER);
              setTimeout(() => {
                const ta = document.querySelector("textarea");
                ta?.focus();
                ta?.setSelectionRange(NUMBERS_PRIMER.length, NUMBERS_PRIMER.length);
              }, 0);
            }}
            disabled={streaming}
            className="text-xs px-3 py-1.5 rounded-full border border-accent/30 bg-accent/5 text-accent/80 hover:bg-accent/10 transition-colors disabled:opacity-50 flex items-center gap-1"
          >
            <Calculator className="h-3 w-3" />
            Run the Numbers
          </button>
          <button
            onClick={handleRunBrief}
            disabled={streaming || runningBrief}
            className="text-xs px-3 py-1.5 rounded-full border border-blue-400/40 bg-blue-400/5 text-blue-400/80 hover:bg-blue-400/10 transition-colors disabled:opacity-50 flex items-center gap-1"
          >
            <Newspaper className="h-3 w-3" />
            {runningBrief ? "Briefing…" : "Run Brief"}
          </button>
          <button
            onClick={handleForexScan}
            disabled={streaming || scanningForex}
            className="text-xs px-3 py-1.5 rounded-full border border-green-400/40 bg-green-400/5 text-green-400/80 hover:bg-green-400/10 transition-colors disabled:opacity-50 flex items-center gap-1"
          >
            <Globe className="h-3 w-3" />
            {scanningForex ? "Scanning…" : "Forex Scan"}
          </button>
          <button
            onClick={() => onChipClick("Summarize my open positions and current market exposure.")}
            disabled={streaming}
            className="text-xs px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 text-primary/70 hover:bg-primary/10 transition-colors disabled:opacity-50 flex items-center gap-1"
          >
            <TrendingUp className="h-3 w-3" />
            Check Positions
          </button>
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
