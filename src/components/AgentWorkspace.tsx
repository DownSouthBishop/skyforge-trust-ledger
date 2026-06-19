import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;

interface CrossMemory {
  id: string;
  summary: string;
  created_at: string;
}

interface Goal {
  id: string;
  title: string;
  status: string;
}

interface Task {
  id: string;
  title: string;
  code: string;
  due_date: string | null;
  status: string;
  importance: string;
}

interface ProactiveAlert {
  id: string;
  title: string;
  content: string | null;
  created_at: string;
}

interface AutonomousTask {
  id: string;
  task_type: string;
  task_description: string;
  status: string;
  priority: string;
  steps_taken: number;
  result_summary: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ExecLogEntry {
  id: string;
  step_number: number;
  action_type: string;
  action_description: string | null;
  result: string | null;
}

interface JournalEntry {
  id: string;
  entry: string;
  created_at: string;
}

interface OutboundAction {
  id: string;
  action_type: "email_draft" | "calendar_event";
  payload: Record<string, string | number | null>;
  status: string;
  created_at: string;
}

interface GoalWithProgress extends Goal {
  pct: number;
}

interface Props {
  agentSlug: string;
  agentName: string;
  agentEmoji: string;
}

export default function AgentWorkspace({ agentSlug, agentName, agentEmoji }: Props) {
  const { user } = useAuth();

  const [crossMemory, setCrossMemory] = useState<CrossMemory[]>([]);
  const [goals, setGoals] = useState<GoalWithProgress[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [alerts, setAlerts] = useState<ProactiveAlert[]>([]);
  const [autonomousTasks, setAutonomousTasks] = useState<AutonomousTask[]>([]);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [execLog, setExecLog] = useState<ExecLogEntry[]>([]);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [outboundActions, setOutboundActions] = useState<OutboundAction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, agentSlug]);

  async function load() {
    if (!user) return;
    setLoading(true);
    try {
      const [memRes, goalsRes, tasksRes, allTasksRes, alertsRes] = await Promise.all([
        supabase
          .from("agent_cross_memory")
          .select("id,summary,created_at")
          .eq("user_id", user.id)
          .eq("source_agent", agentSlug)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("goals")
          .select("id,title,status")
          .eq("user_id", user.id)
          .eq("status", "active"),
        supabase
          .from("tasks")
          .select("id,title,code,due_date,status,importance,objective_id")
          .eq("user_id", user.id)
          .eq("status", "pending")
          .not("due_date", "is", null)
          .order("due_date", { ascending: true })
          .limit(5),
        supabase
          .from("tasks")
          .select("id,objective_id,status")
          .eq("user_id", user.id),
        supabase
          .from("proactive_alerts")
          .select("id,title,content,created_at")
          .eq("user_id", user.id)
          .eq("agent_slug", agentSlug)
          .eq("status", "unread")
          .order("created_at", { ascending: false })
          .limit(3),
      ]);

      setCrossMemory((memRes.data ?? []) as CrossMemory[]);
      setTasks((tasksRes.data ?? []) as Task[]);

      // Compute goal progress from all tasks
      const allTasks = (allTasksRes.data ?? []) as Array<{ objective_id: string; status: string }>;
      const rawGoals = (goalsRes.data ?? []) as Goal[];

      // We need objectives to link tasks → goals; use a lightweight approach
      const { data: objRows } = await supabase
        .from("objectives")
        .select("id,goal_id")
        .eq("user_id", user.id);
      const objMap: Record<string, string> = {};
      for (const o of (objRows ?? [])) objMap[o.id] = o.goal_id;

      const goalsWithPct: GoalWithProgress[] = rawGoals.map(g => {
        const gTasks = allTasks.filter(t => objMap[t.objective_id] === g.id);
        const done = gTasks.filter(t => t.status === "complete").length;
        const pct = gTasks.length ? Math.round((done / gTasks.length) * 100) : 0;
        return { ...g, pct };
      });
      setGoals(goalsWithPct);

      if (!alertsRes.error) {
        setAlerts((alertsRes.data ?? []) as ProactiveAlert[]);
      }

      // Autonomous tasks — gracefully handle missing table
      const autoRes = await supabase
        .from("agent_tasks")
        .select("id,task_type,task_description,status,priority,steps_taken,result_summary,created_at,completed_at")
        .eq("user_id", user.id)
        .eq("agent_slug", agentSlug)
        .in("status", ["completed", "running", "failed"])
        .order("created_at", { ascending: false })
        .limit(5);
      if (!autoRes.error) {
        setAutonomousTasks((autoRes.data ?? []) as AutonomousTask[]);
      }

      // Agent journal — first-person identity state
      const journalRes = await supabase
        .from("agent_journal")
        .select("id,entry,created_at")
        .eq("user_id", user.id)
        .eq("agent_slug", agentSlug)
        .order("created_at", { ascending: false })
        .limit(5);
      if (!journalRes.error) {
        setJournalEntries((journalRes.data ?? []) as JournalEntry[]);
      }

      // Outbound actions — pending email drafts and calendar events
      const outboundRes = await supabase
        .from("outbound_actions")
        .select("id,action_type,payload,status,created_at")
        .eq("user_id", user.id)
        .eq("agent_slug", agentSlug)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(5);
      if (!outboundRes.error) {
        setOutboundActions((outboundRes.data ?? []) as OutboundAction[]);
      }
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }

  async function markAlertRead(id: string) {
    await supabase.from("proactive_alerts").update({ status: "read" }).eq("id", id);
    setAlerts(prev => prev.filter(a => a.id !== id));
  }

  async function markAlertFeedback(id: string, feedback: "useful" | "noise") {
    await supabase.from("proactive_alerts").update({ status: "read", feedback }).eq("id", id);
    setAlerts(prev => prev.filter(a => a.id !== id));
  }

  async function dismissOutbound(id: string) {
    await supabase.from("outbound_actions").update({ status: "dismissed", actioned_at: new Date().toISOString() }).eq("id", id);
    setOutboundActions(prev => prev.filter(a => a.id !== id));
  }

  function gmailUrl(payload: Record<string, string | number | null>): string {
    const p = new URLSearchParams();
    if (payload.to) p.set("to", String(payload.to));
    if (payload.subject) p.set("su", String(payload.subject));
    if (payload.body) p.set("body", String(payload.body));
    return `https://mail.google.com/mail/?view=cm&${p.toString()}`;
  }

  function calendarUrl(payload: Record<string, string | number | null>): string {
    const date = String(payload.date ?? "").replace(/-/g, "");
    const startTime = String(payload.time ?? "09:00").replace(":", "");
    const durationMin = Number(payload.duration_minutes ?? 60);
    const endHour = Math.floor((parseInt(startTime.slice(0, 2)) * 60 + parseInt(startTime.slice(2)) + durationMin) / 60);
    const endMin = (parseInt(startTime.slice(0, 2)) * 60 + parseInt(startTime.slice(2)) + durationMin) % 60;
    const endTime = `${String(endHour).padStart(2, "0")}${String(endMin).padStart(2, "0")}`;
    const p = new URLSearchParams({
      action: "TEMPLATE",
      text: String(payload.title ?? ""),
      dates: `${date}T${startTime}00/${date}T${endTime}00`,
    });
    if (payload.description) p.set("details", String(payload.description));
    return `https://www.google.com/calendar/render?${p.toString()}`;
  }

  async function toggleExecLog(taskId: string) {
    if (expandedTaskId === taskId) {
      setExpandedTaskId(null);
      setExecLog([]);
      return;
    }
    setExpandedTaskId(taskId);
    const { data } = await supabase
      .from("agent_execution_log")
      .select("id,step_number,action_type,action_description,result")
      .eq("task_id", taskId)
      .order("step_number", { ascending: true });
    setExecLog((data ?? []) as ExecLogEntry[]);
  }

  const impDot = (i: string) =>
    i === "high" ? "bg-red-400" : i === "low" ? "bg-green-400" : "bg-yellow-400";

  const statusDot = (s: string) =>
    s === "completed" ? "bg-emerald-400" : s === "running" ? "bg-yellow-400 animate-pulse" : "bg-red-400";

  const actionIcon = (a: string) => {
    const icons: Record<string, string> = {
      think: "💭", read_goals: "🎯", read_cross_memory: "🧠", call_agent: "🤖",
      write_dossier_entry: "📝", suggest_task: "✅", write_alert: "🔔",
      write_cross_memory: "📡", schedule_followup: "⏰", finish: "✓", error: "✗",
    };
    return icons[a] ?? "•";
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40 text-xs text-muted-foreground/40">
        Loading workspace…
      </div>
    );
  }

  return (
    <div className="p-4 space-y-5 overflow-y-auto">
      <div className="flex items-center gap-2">
        <span className="text-lg">{agentEmoji}</span>
        <span className="text-sm font-semibold text-primary">{agentName} Workspace</span>
      </div>

      {/* A. Recent Cross-Memory */}
      <section>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Recent Activity</div>
        {crossMemory.length === 0 ? (
          <div className="text-xs text-muted-foreground/30 italic">No recent cross-memory.</div>
        ) : (
          <div className="space-y-2">
            {crossMemory.map(m => (
              <div key={m.id} className="border border-border/40 rounded-lg p-2.5 bg-card/30">
                <div className="text-xs text-foreground/80 leading-relaxed">{m.summary}</div>
                <div className="text-[10px] text-muted-foreground/40 mt-1">
                  {new Date(m.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* B. Active Goals */}
      <section>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Active Goals</div>
        {goals.length === 0 ? (
          <div className="text-xs text-muted-foreground/30 italic">No active goals.</div>
        ) : (
          <div className="space-y-2">
            {goals.map(g => (
              <div key={g.id} className="border border-border/40 rounded-lg p-2.5 bg-card/30">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-foreground/90 flex-1 min-w-0 truncate">🎯 {g.title}</span>
                  <span className="text-[10px] text-muted-foreground/50 shrink-0">{g.pct}%</span>
                </div>
                <div className="mt-1.5 h-1 rounded-full bg-border/40 overflow-hidden">
                  <div className="h-full bg-accent/60 rounded-full" style={{ width: `${g.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* C. Pending Tasks */}
      <section>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Pending Tasks</div>
        {tasks.length === 0 ? (
          <div className="text-xs text-muted-foreground/30 italic">No upcoming tasks.</div>
        ) : (
          <div className="space-y-1.5">
            {tasks.map(t => (
              <div key={t.id} className="flex items-center gap-2 px-2.5 py-2 border border-border/40 rounded-lg bg-card/30">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${impDot(t.importance)}`} />
                <span className="text-[10px] font-mono text-accent shrink-0">{t.code}</span>
                <span className="text-xs text-foreground/80 flex-1 min-w-0 truncate">{t.title}</span>
                {t.due_date && (
                  <span className="text-[10px] text-muted-foreground/50 shrink-0">{t.due_date}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* E. Autonomous Actions */}
      {autonomousTasks.length > 0 && (
        <section>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Autonomous Actions</div>
          <div className="space-y-2">
            {autonomousTasks.map(t => (
              <div key={t.id} className="border border-border/40 rounded-lg overflow-hidden bg-card/30">
                <button
                  onClick={() => toggleExecLog(t.id)}
                  className="w-full text-left px-2.5 py-2 flex items-start gap-2 hover:bg-accent/5 transition-colors"
                >
                  <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(t.status)}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-foreground/80 truncate">
                      {t.task_type.replace(/_/g, " ")}
                      {t.steps_taken > 0 && <span className="text-muted-foreground/40 ml-1">· {t.steps_taken} steps</span>}
                    </div>
                    {t.result_summary && (
                      <div className="text-[10px] text-muted-foreground/50 mt-0.5 line-clamp-1">{t.result_summary}</div>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground/30 shrink-0">{expandedTaskId === t.id ? "▲" : "▼"}</span>
                </button>

                {expandedTaskId === t.id && (
                  <div className="border-t border-border/30 px-2.5 py-2 space-y-1.5 bg-background/30">
                    {execLog.length === 0 ? (
                      <div className="text-[10px] text-muted-foreground/30 italic">Loading execution log…</div>
                    ) : (
                      execLog.map(entry => (
                        <div key={entry.id} className="flex gap-2 text-[10px]">
                          <span className="shrink-0 text-muted-foreground/50 w-4 text-center">{actionIcon(entry.action_type)}</span>
                          <div className="flex-1 min-w-0">
                            <span className="text-accent/70 font-mono">{entry.action_type}</span>
                            {entry.action_description && (
                              <span className="text-muted-foreground/50 ml-1">— {entry.action_description.slice(0, 80)}</span>
                            )}
                            {entry.result && entry.action_type !== "finish" && (
                              <div className="text-foreground/50 mt-0.5 line-clamp-2 pl-1 border-l border-border/30">{entry.result.slice(0, 150)}</div>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* F. Agent Journal */}
      {journalEntries.length > 0 && (
        <section>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Agent Journal</div>
          <div className="space-y-1.5">
            {journalEntries.map(j => (
              <div key={j.id} className="border-l-2 border-accent/30 pl-2.5 py-0.5">
                <div className="text-xs text-foreground/70 leading-relaxed">{j.entry}</div>
                <div className="text-[10px] text-muted-foreground/30 mt-0.5">
                  {new Date(j.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* G. Outbound Actions */}
      {outboundActions.length > 0 && (
        <section>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Queued Actions</div>
          <div className="space-y-2">
            {outboundActions.map(a => {
              const isEmail = a.action_type === "email_draft";
              const href = isEmail ? gmailUrl(a.payload) : calendarUrl(a.payload);
              const label = isEmail
                ? `Draft: ${String(a.payload.subject ?? "").slice(0, 40)}`
                : `Event: ${String(a.payload.title ?? "").slice(0, 40)} · ${a.payload.date}`;
              return (
                <div key={a.id} className="border border-border/40 rounded-lg p-2.5 bg-card/30 flex items-start gap-2">
                  <span className="text-sm shrink-0">{isEmail ? "✉" : "📅"}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-foreground/80 truncate">{label}</div>
                    {isEmail && a.payload.to && (
                      <div className="text-[10px] text-muted-foreground/40">to: {String(a.payload.to)}</div>
                    )}
                    {!isEmail && a.payload.description && (
                      <div className="text-[10px] text-muted-foreground/40 line-clamp-1">{String(a.payload.description)}</div>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] px-1.5 py-0.5 bg-accent/20 hover:bg-accent/40 text-accent rounded transition-colors"
                      onClick={() => supabase.from("outbound_actions").update({ status: "executed", actioned_at: new Date().toISOString() }).eq("id", a.id).then(() => setOutboundActions(prev => prev.filter(x => x.id !== a.id)))}
                    >
                      Open
                    </a>
                    <button
                      onClick={() => dismissOutbound(a.id)}
                      className="text-[10px] px-1.5 py-0.5 border border-border/30 text-muted-foreground/40 hover:text-destructive rounded transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* D. Alerts with feedback */}
      {alerts.length > 0 && (
        <section>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Alerts</div>
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className="border border-accent/20 rounded-lg p-2.5 bg-accent/5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-primary">{a.title}</div>
                    {a.content && <div className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">{a.content}</div>}
                  </div>
                  <div className="flex gap-1 shrink-0 mt-0.5">
                    <button
                      onClick={() => markAlertFeedback(a.id, "useful")}
                      title="Useful"
                      className="text-[10px] px-1.5 py-0.5 border border-border/30 text-muted-foreground/40 hover:text-emerald-400 hover:border-emerald-400/40 rounded transition-colors"
                    >
                      ✓
                    </button>
                    <button
                      onClick={() => markAlertFeedback(a.id, "noise")}
                      title="Not useful"
                      className="text-[10px] px-1.5 py-0.5 border border-border/30 text-muted-foreground/40 hover:text-red-400 hover:border-red-400/40 rounded transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
