import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;

const AGENTS = [
  { slug: "atlas", name: "Atlas", emoji: "⚡", color: "text-blue-400" },
  { slug: "janus", name: "Janus", emoji: "🌐", color: "text-purple-400" },
  { slug: "linda", name: "Linda", emoji: "💼", color: "text-pink-400" },
  { slug: "izzy", name: "Izzy", emoji: "🧠", color: "text-emerald-400" },
];

interface AgentMetrics {
  slug: string;
  tasks_total: number;
  tasks_completed: number;
  tasks_failed: number;
  avg_steps: number;
  suggestions_total: number;
  suggestions_approved: number;
  suggestions_dismissed: number;
  alerts_total: number;
  alerts_noise: number;
  journal_entries: number;
}

interface CouncilSession {
  id: string;
  topic: string;
  agents: string[];
  created_at: string;
}

function pct(num: number, den: number): string {
  if (den === 0) return "—";
  return `${Math.round((num / den) * 100)}%`;
}

function bar(value: number, max: number, color: string) {
  const w = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div className="h-1 w-full bg-border/30 rounded-full overflow-hidden mt-1">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${w}%` }} />
    </div>
  );
}

export default function MetricsPage() {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<AgentMetrics[]>([]);
  const [councils, setCouncils] = useState<CouncilSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastConsolidate, setLastConsolidate] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [user?.id]);

  async function load() {
    if (!user) return;
    setLoading(true);
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const [tasksRes, suggestionsRes, alertsRes, journalRes, councilRes, profileRes] = await Promise.all([
        supabase.from("agent_tasks").select("agent_slug,status,steps_taken").eq("user_id", user.id).gte("created_at", thirtyDaysAgo),
        supabase.from("dossier_suggestions").select("agent_slug,status").eq("user_id", user.id).gte("created_at", thirtyDaysAgo),
        supabase.from("proactive_alerts").select("agent_slug,feedback").eq("user_id", user.id).gte("created_at", thirtyDaysAgo),
        supabase.from("agent_journal").select("agent_slug").eq("user_id", user.id).gte("created_at", thirtyDaysAgo),
        supabase.from("council_log").select("id,topic,agents,created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(5),
        supabase.from("operator_profile").select("generated_at").eq("user_id", user.id).single(),
      ]);

      const tasks = (tasksRes.data ?? []) as Array<{ agent_slug: string; status: string; steps_taken: number }>;
      const suggestions = (suggestionsRes.data ?? []) as Array<{ agent_slug: string; status: string }>;
      const alerts = (alertsRes.data ?? []) as Array<{ agent_slug: string; feedback: string | null }>;
      const journal = (journalRes.data ?? []) as Array<{ agent_slug: string }>;

      const agentMetrics: AgentMetrics[] = AGENTS.map(({ slug }) => {
        const agentTasks = tasks.filter(t => t.agent_slug === slug);
        const completed = agentTasks.filter(t => t.status === "completed");
        const failed = agentTasks.filter(t => t.status === "failed");
        const totalSteps = completed.reduce((s, t) => s + (t.steps_taken ?? 0), 0);

        const agentSuggestions = suggestions.filter(s => s.agent_slug === slug);
        const agentAlerts = alerts.filter(a => a.agent_slug === slug);

        return {
          slug,
          tasks_total: agentTasks.length,
          tasks_completed: completed.length,
          tasks_failed: failed.length,
          avg_steps: completed.length ? Math.round(totalSteps / completed.length * 10) / 10 : 0,
          suggestions_total: agentSuggestions.length,
          suggestions_approved: agentSuggestions.filter(s => s.status === "approved").length,
          suggestions_dismissed: agentSuggestions.filter(s => s.status === "dismissed").length,
          alerts_total: agentAlerts.length,
          alerts_noise: agentAlerts.filter(a => a.feedback === "noise").length,
          journal_entries: journal.filter(j => j.agent_slug === slug).length,
        };
      });

      setMetrics(agentMetrics);
      setCouncils((councilRes.data ?? []) as CouncilSession[]);
      setLastConsolidate(profileRes.data?.generated_at ?? null);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }

  const totalTasks = metrics.reduce((s, m) => s + m.tasks_total, 0);
  const totalSuggestions = metrics.reduce((s, m) => s + m.suggestions_total, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40 text-xs text-muted-foreground/40">
        Loading metrics…
      </div>
    );
  }

  return (
    <div className="p-6 space-y-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-display tracking-widest text-primary">AGENT METRICS</h1>
          <div className="text-xs text-muted-foreground/50 mt-0.5">Last 30 days · {totalTasks} tasks · {totalSuggestions} suggestions</div>
        </div>
        {lastConsolidate && (
          <div className="text-[10px] text-muted-foreground/30">
            Profile consolidated {new Date(lastConsolidate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </div>
        )}
      </div>

      {/* Agent cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {metrics.map(m => {
          const agent = AGENTS.find(a => a.slug === m.slug)!;
          const completionRate = m.tasks_total > 0 ? (m.tasks_completed / m.tasks_total) : 0;
          const approvalRate = m.suggestions_total > 0 ? (m.suggestions_approved / m.suggestions_total) : 0;
          const noiseRate = m.alerts_total > 0 ? (m.alerts_noise / m.alerts_total) : 0;

          return (
            <div key={m.slug} className="border border-border/40 rounded-xl p-4 bg-card/20 space-y-4">
              {/* Agent header */}
              <div className="flex items-center gap-2">
                <span className="text-xl">{agent.emoji}</span>
                <span className={`text-sm font-semibold ${agent.color}`}>{agent.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground/30">{m.journal_entries} journal entries</span>
              </div>

              {/* Stat rows */}
              <div className="space-y-3">
                {/* Task completion */}
                <div>
                  <div className="flex justify-between text-[10px] text-muted-foreground/60 mb-0.5">
                    <span>Task completion</span>
                    <span className="font-mono">{pct(m.tasks_completed, m.tasks_total)} <span className="text-muted-foreground/30">({m.tasks_completed}/{m.tasks_total})</span></span>
                  </div>
                  {bar(Math.round(completionRate * 100), 100, "bg-emerald-400/60")}
                </div>

                {/* Suggestion approval */}
                <div>
                  <div className="flex justify-between text-[10px] text-muted-foreground/60 mb-0.5">
                    <span>Suggestion approval</span>
                    <span className="font-mono">{pct(m.suggestions_approved, m.suggestions_total)} <span className="text-muted-foreground/30">({m.suggestions_approved}/{m.suggestions_total})</span></span>
                  </div>
                  {bar(Math.round(approvalRate * 100), 100, "bg-blue-400/60")}
                </div>

                {/* Alert noise */}
                <div>
                  <div className="flex justify-between text-[10px] text-muted-foreground/60 mb-0.5">
                    <span>Alert noise rate</span>
                    <span className="font-mono">{pct(m.alerts_noise, m.alerts_total)} <span className="text-muted-foreground/30">({m.alerts_noise}/{m.alerts_total})</span></span>
                  </div>
                  {bar(Math.round(noiseRate * 100), 100, noiseRate > 0.4 ? "bg-red-400/60" : "bg-yellow-400/40")}
                </div>

                {/* Avg steps */}
                {m.tasks_completed > 0 && (
                  <div className="flex justify-between text-[10px] text-muted-foreground/40">
                    <span>Avg steps/task</span>
                    <span className="font-mono">{m.avg_steps}</span>
                  </div>
                )}

                {/* Failed tasks */}
                {m.tasks_failed > 0 && (
                  <div className="flex justify-between text-[10px] text-red-400/50">
                    <span>Failed tasks</span>
                    <span className="font-mono">{m.tasks_failed}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Council sessions */}
      {councils.length > 0 && (
        <section>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-3">Recent Council Sessions</div>
          <div className="space-y-2">
            {councils.map(c => (
              <div key={c.id} className="border border-border/30 rounded-lg px-3 py-2.5 bg-card/20 flex items-start gap-3">
                <span className="text-base shrink-0">🏛</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-foreground/80 truncate">{c.topic}</div>
                  <div className="text-[10px] text-muted-foreground/40 mt-0.5">
                    {(c.agents as string[]).join(", ")} · {new Date(c.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Zero state */}
      {totalTasks === 0 && councils.length === 0 && (
        <div className="text-center py-12 text-xs text-muted-foreground/30 italic">
          No autonomous activity yet. Metrics populate as agents work on tasks.
        </div>
      )}
    </div>
  );
}

