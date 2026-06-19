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

      // Alerts — gracefully handle missing table
      if (!alertsRes.error) {
        setAlerts((alertsRes.data ?? []) as ProactiveAlert[]);
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

  const impDot = (i: string) =>
    i === "high" ? "bg-red-400" : i === "low" ? "bg-green-400" : "bg-yellow-400";

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

      {/* D. Recent Alerts */}
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
                  <button
                    onClick={() => markAlertRead(a.id)}
                    className="text-[10px] text-muted-foreground/40 hover:text-accent transition-colors shrink-0 mt-0.5 px-1.5 py-0.5 border border-border/30 rounded"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
