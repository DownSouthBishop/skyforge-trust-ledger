// Shared helpers for the Projects business OS.
// Keeps the active project id in localStorage so any chat page can read it.

import { supabase as _supabase } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = _supabase as any;

const KEY = "skyforge.active_project_id";

export function getActiveProjectId(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function setActiveProjectId(id: string | null) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
    window.dispatchEvent(new Event("active-project-changed"));
  } catch { /* noop */ }
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  website: string | null;
  mission: string | null;
  goal_revenue_usd: number | null;
  goal_deadline: string | null;
  status: string | null;
}

export async function listProjects(userId: string): Promise<ProjectRow[]> {
  const { data } = await supabase
    .from("business_projects")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  return (data ?? []) as ProjectRow[];
}

export async function buildProjectContextBlock(projectId: string): Promise<string> {
  const [proj, onboard, fin, clients, leads, bottlenecks, mem] = await Promise.all([
    supabase.from("business_projects").select("*").eq("id", projectId).maybeSingle(),
    supabase.from("project_onboarding").select("*").eq("project_id", projectId).maybeSingle(),
    supabase.from("project_financials").select("entry_type,amount_usd").eq("project_id", projectId),
    supabase.from("project_clients").select("id").eq("project_id", projectId).eq("status", "active"),
    supabase.from("project_leads").select("id,temperature").eq("project_id", projectId),
    supabase.from("project_bottlenecks").select("description").eq("project_id", projectId).eq("resolved", false),
    supabase.from("project_memory").select("agent,content,created_at").eq("project_id", projectId)
      .order("created_at", { ascending: false }).limit(10),
  ]);
  const p = proj.data ?? {};
  const o = onboard.data ?? {};
  const revenue = (fin.data ?? []).filter((r: any) => r.entry_type === "revenue")
    .reduce((s: number, r: any) => s + Number(r.amount_usd || 0), 0);
  const hot = (leads.data ?? []).filter((r: any) => r.temperature === "hot").length;
  const bnList = (bottlenecks.data ?? []).map((r: any) => r.description).join("; ") || "none";
  const recent = (mem.data ?? []).map((r: any) => `[${r.agent}] ${r.content}`).join("\n---\n");

  return `ACTIVE PROJECT:
Name: ${p.name ?? ""}
Mission: ${p.mission ?? ""}
Website: ${p.website ?? ""}
Goal: ${p.goal_revenue_usd ?? "n/a"} by ${p.goal_deadline ?? "n/a"}

BUSINESS FOUNDATION:
Customer: ${o.customer_description ?? ""}
Problem solved: ${o.problem_solved ?? ""}
Revenue model: ${o.revenue_model ?? ""}
What was tried: ${o.what_was_tried ?? ""}
Win in 90 days: ${o.win_in_90_days ?? ""}

CURRENT STATE:
Revenue: ${revenue}
Active clients: ${(clients.data ?? []).length}
Hot leads: ${hot}
Open bottlenecks: ${bnList}

RECENT MEMORY:
${recent}

PRIME DIRECTIVE:
You are not a chatbot. You are an operator. Your job is to move this business forward.
Every response must end with one of:
- A specific action you are taking or recommending right now
- A question that unblocks the next decision
- A flag if something is at risk

Never give a response that doesn't advance the business.`;
}
