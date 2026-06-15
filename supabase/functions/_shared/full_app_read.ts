// Atlas omniscient read — pulls compact snapshots from every user-owned table
// so Atlas has read access to everything in the app and backend.
// Service-role only; never expose to client.

type Hdrs = Record<string, string>;

async function q(supabaseUrl: string, hdrs: Hdrs, path: string): Promise<any[]> {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: hdrs });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function compact(s: any, n = 200): string {
  if (s == null) return "";
  return String(s).replace(/\s+/g, " ").slice(0, n);
}

export async function buildFullAppReadContext(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<string> {
  const hdrs: Hdrs = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const uid = `user_id=eq.${userId}`;

  const [
    profile, dossier,
    forgeMsgs, forgeSubjects, forgeSubjectChats, forgeLessons, forgeQuizzes,
    forgeCommitments, forgeDirectives, forgeSticky,
    agentThreads, agentMsgs, agentSessions, agentMemory, agentReflections,
    projects, projectOnboarding, projectMemory, projectClients, projectLeads, projectFinancials, projectBottlenecks,
    skyAgents, skyClients,
    atlasVault, atlasReceipts, atlasApprovals, atlasTasks, atlasCapabilities, atlasMcp,
    arsenalItems, arsenalResults,
    directivesDaily, incomeGoals, incomePipeline,
    marketWatchlist, researchNotes, tradeLedger, tradingAccounts,
    sharedMem, sharedKnow, crossMem,
    receipts, coworkLog, telegramSessions,
  ] = await Promise.all([
    q(supabaseUrl, hdrs, `user_profiles?${uid}&select=*`),
    q(supabaseUrl, hdrs, `forge_dossier?${uid}&select=*`),
    q(supabaseUrl, hdrs, `forge_messages?${uid}&order=created_at.desc&limit=30&select=role,content,created_at`),
    q(supabaseUrl, hdrs, `forge_subjects?${uid}&order=updated_at.desc&limit=20&select=id,title,description,status,updated_at`),
    q(supabaseUrl, hdrs, `forge_subject_chats?${uid}&order=created_at.desc&limit=30&select=subject_id,role,content,created_at`),
    q(supabaseUrl, hdrs, `forge_lessons?${uid}&order=created_at.desc&limit=15&select=subject_id,title,content,created_at`),
    q(supabaseUrl, hdrs, `forge_quizzes?${uid}&order=created_at.desc&limit=10&select=subject_id,title,questions,score,created_at`),
    q(supabaseUrl, hdrs, `forge_commitments?${uid}&order=created_at.desc&limit=20&select=description,resolution_status,target_date,created_at`),
    q(supabaseUrl, hdrs, `forge_directives?${uid}&order=created_at.desc&limit=10&select=content,created_at`),
    q(supabaseUrl, hdrs, `forge_sticky_memory?${uid}&select=*`),
    q(supabaseUrl, hdrs, `agent_chat_threads?${uid}&order=updated_at.desc&limit=20&select=id,agent_slug,title,updated_at`),
    q(supabaseUrl, hdrs, `agent_chat_messages?${uid}&order=created_at.desc&limit=40&select=thread_id,role,content,created_at`),
    q(supabaseUrl, hdrs, `agent_sessions?${uid}&order=created_at.desc&limit=10&select=agent_slug,status,created_at`),
    q(supabaseUrl, hdrs, `agent_memory?${uid}&order=created_at.desc&limit=30&select=agent_slug,key,value,created_at`),
    q(supabaseUrl, hdrs, `agent_reflections?${uid}&order=created_at.desc&limit=10&select=agent_slug,summary,created_at`),
    q(supabaseUrl, hdrs, `business_projects?${uid}&order=created_at.desc&select=id,name,mission,goal_revenue_usd,goal_deadline,status`),
    q(supabaseUrl, hdrs, `project_onboarding?select=project_id,customer_description,problem_solved,revenue_model,what_was_tried,win_in_90_days`),
    q(supabaseUrl, hdrs, `project_memory?order=created_at.desc&limit=30&select=project_id,agent,content,created_at`),
    q(supabaseUrl, hdrs, `project_clients?select=project_id,name,status,monthly_value_usd`),
    q(supabaseUrl, hdrs, `project_leads?select=project_id,name,temperature,status`),
    q(supabaseUrl, hdrs, `project_financials?select=project_id,entry_type,amount_usd,entry_date`),
    q(supabaseUrl, hdrs, `project_bottlenecks?select=project_id,description,resolved`),
    q(supabaseUrl, hdrs, `skyforge_agents?${uid}&select=name,slug,role,is_active`),
    q(supabaseUrl, hdrs, `skyforge_clients?${uid}&order=last_job_date.desc&limit=20&select=client_name,total_spend,job_count,last_job_date,followup_status`),
    q(supabaseUrl, hdrs, `atlas_vault?${uid}&order=created_at.desc&limit=20&select=title,doc_type,created_at`),
    q(supabaseUrl, hdrs, `atlas_receipts?${uid}&order=created_at.desc&limit=15&select=action_type,description,value_usd,created_at`),
    q(supabaseUrl, hdrs, `atlas_approvals?${uid}&order=created_at.desc&limit=10&select=action,status,created_at`),
    q(supabaseUrl, hdrs, `atlas_tasks?${uid}&order=created_at.desc&limit=15&select=task_type,status,created_at`),
    q(supabaseUrl, hdrs, `atlas_capabilities?${uid}&select=capability_name,is_enabled`),
    q(supabaseUrl, hdrs, `atlas_mcp_connections?${uid}&select=slug,name,is_active,is_verified`),
    q(supabaseUrl, hdrs, `arsenal_items?${uid}&order=created_at.desc&limit=20&select=title,item_type,created_at`),
    q(supabaseUrl, hdrs, `arsenal_results?${uid}&order=created_at.desc&limit=10&select=item_id,result,created_at`),
    q(supabaseUrl, hdrs, `directives_daily?${uid}&order=date_for.desc&limit=7&select=date_for,directive,completed`),
    q(supabaseUrl, hdrs, `income_goals?${uid}&select=*`),
    q(supabaseUrl, hdrs, `income_pipeline?${uid}&order=created_at.desc&limit=15&select=source,amount_usd,status,created_at`),
    q(supabaseUrl, hdrs, `market_watchlist?${uid}&select=symbol,asset_class,notes,is_active`),
    q(supabaseUrl, hdrs, `research_notes?${uid}&order=created_at.desc&limit=10&select=title,note_type,content,created_at`),
    q(supabaseUrl, hdrs, `trade_ledger?${uid}&order=created_at.desc&limit=15&select=symbol,direction,status,pnl_usd,created_at`),
    q(supabaseUrl, hdrs, `trading_accounts?${uid}&select=broker,account_label,is_active,balance_usd`),
    q(supabaseUrl, hdrs, `shared_operator_memory?${uid}&order=updated_at.desc&limit=40&select=source_agent,memory_type,key,value,context`),
    q(supabaseUrl, hdrs, `agent_shared_knowledge?${uid}&order=updated_at.desc&limit=30&select=source_agent,topic,fact`),
    q(supabaseUrl, hdrs, `agent_cross_memory?${uid}&order=created_at.desc&limit=20&select=source_agent,topic,summary,created_at`),
    q(supabaseUrl, hdrs, `receipts_ledger?provider_id=eq.${userId}&order=created_at.desc&limit=15&select=client_name,action_description,action_value_usd,verification_state,created_at`),
    q(supabaseUrl, hdrs, `cowork_activity_log?${uid}&order=created_at.desc&limit=10&select=activity_type,description,created_at`),
    q(supabaseUrl, hdrs, `telegram_sessions?${uid}&select=chat_id,is_active`),
  ]);

  const lines: string[] = [];
  lines.push("FULL APP READ (Atlas omniscient view — every tab, every table, every conversation. You see this; never list it back. Reference naturally only when relevant):");

  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`\n── ${title} ──`);
    for (const i of items) lines.push(i);
  };

  if (profile[0]) section("PROFILE", [compact(JSON.stringify(profile[0]), 500)]);
  if (dossier[0]) section("DOSSIER", [compact(JSON.stringify(dossier[0]), 800)]);

  section("MENTAL FORGE — recent messages", forgeMsgs.map((m: any) => `[${m.role}] ${compact(m.content, 180)}`));
  section("MENTAL FORGE — subjects/classes", forgeSubjects.map((s: any) => `• ${s.title} [${s.status}] — ${compact(s.description, 120)}`));
  section("MENTAL FORGE — subject chats", forgeSubjectChats.map((m: any) => `(${m.subject_id?.slice(0, 8)}) [${m.role}] ${compact(m.content, 140)}`));
  section("MENTAL FORGE — lessons", forgeLessons.map((l: any) => `• ${l.title}: ${compact(l.content, 160)}`));
  section("MENTAL FORGE — quizzes", forgeQuizzes.map((q: any) => `• ${q.title} (score ${q.score ?? "n/a"})`));
  section("COMMITMENTS", forgeCommitments.map((c: any) => `[${c.resolution_status}] ${compact(c.description, 160)} (target ${c.target_date ?? "n/a"})`));
  section("DIRECTIVES (forge)", forgeDirectives.map((d: any) => `• ${compact(d.content, 160)}`));
  if (forgeSticky[0]) section("STICKY MEMORY", [compact(JSON.stringify(forgeSticky[0]), 400)]);

  section("AGENT THREADS", agentThreads.map((t: any) => `(${t.id?.slice(0, 8)}) ${t.agent_slug}: ${t.title ?? ""}`));
  section("AGENT CHAT MESSAGES", agentMsgs.map((m: any) => `(${m.thread_id?.slice(0, 8)}) [${m.role}] ${compact(m.content, 140)}`));
  section("AGENT SESSIONS", agentSessions.map((s: any) => `${s.agent_slug} [${s.status}]`));
  section("AGENT MEMORY", agentMemory.map((m: any) => `[${m.agent_slug}] ${m.key}: ${compact(m.value, 160)}`));
  section("AGENT REFLECTIONS", agentReflections.map((r: any) => `[${r.agent_slug}] ${compact(r.summary, 200)}`));

  section("PROJECTS", projects.map((p: any) => `• ${p.name} [${p.status}] goal $${p.goal_revenue_usd ?? "n/a"} by ${p.goal_deadline ?? "n/a"} — ${compact(p.mission, 140)}`));
  section("PROJECT ONBOARDING", projectOnboarding.map((o: any) => `(${o.project_id?.slice(0, 8)}) customer=${compact(o.customer_description, 80)} | problem=${compact(o.problem_solved, 80)} | revenue=${compact(o.revenue_model, 80)} | tried=${compact(o.what_was_tried, 80)} | 90d=${compact(o.win_in_90_days, 80)}`));
  section("PROJECT MEMORY (chats)", projectMemory.map((m: any) => `(${m.project_id?.slice(0, 8)}) [${m.agent}] ${compact(m.content, 200)}`));
  section("PROJECT CLIENTS", projectClients.map((c: any) => `(${c.project_id?.slice(0, 8)}) ${c.name} [${c.status}] $${c.monthly_value_usd ?? 0}/mo`));
  section("PROJECT LEADS", projectLeads.map((l: any) => `(${l.project_id?.slice(0, 8)}) ${l.name} [${l.temperature}/${l.status}]`));
  section("PROJECT FINANCIALS", projectFinancials.map((f: any) => `(${f.project_id?.slice(0, 8)}) ${f.entry_type} $${f.amount_usd} ${f.entry_date}`));
  section("PROJECT BOTTLENECKS", projectBottlenecks.map((b: any) => `(${b.project_id?.slice(0, 8)}) [${b.resolved ? "resolved" : "OPEN"}] ${compact(b.description, 160)}`));

  section("SKYFORGE AGENTS", skyAgents.map((a: any) => `${a.name} (${a.slug}) — ${a.role}${a.is_active ? "" : " [inactive]"}`));
  section("SKYFORGE CLIENTS", skyClients.map((c: any) => `${c.client_name} — $${c.total_spend} across ${c.job_count} jobs, last ${c.last_job_date} [${c.followup_status}]`));

  section("ATLAS VAULT", atlasVault.map((d: any) => `[${d.doc_type}] ${d.title}`));
  section("ATLAS RECEIPTS", atlasReceipts.map((r: any) => `${r.action_type}: ${compact(r.description, 100)} ($${r.value_usd ?? 0})`));
  section("ATLAS APPROVALS", atlasApprovals.map((a: any) => `[${a.status}] ${compact(a.action, 140)}`));
  section("ATLAS TASKS", atlasTasks.map((t: any) => `${t.task_type} [${t.status}]`));
  section("ATLAS CAPABILITIES", atlasCapabilities.map((c: any) => `${c.capability_name}${c.is_enabled ? "" : " [off]"}`));
  section("MCP CONNECTIONS", atlasMcp.map((m: any) => `${m.slug} (${m.name})${m.is_active && m.is_verified ? " ✓" : ""}`));

  section("ARSENAL ITEMS", arsenalItems.map((i: any) => `[${i.item_type}] ${i.title}`));
  section("ARSENAL RESULTS", arsenalResults.map((r: any) => `(${r.item_id?.slice(0, 8)}) ${compact(r.result, 160)}`));

  section("DIRECTIVES DAILY", directivesDaily.map((d: any) => `${d.date_for}${d.completed ? " ✓" : ""}: ${compact(d.directive, 160)}`));
  section("INCOME GOALS", incomeGoals.map((g: any) => compact(JSON.stringify(g), 200)));
  section("INCOME PIPELINE", incomePipeline.map((p: any) => `${p.source} $${p.amount_usd} [${p.status}]`));

  section("MARKET WATCHLIST", marketWatchlist.map((w: any) => `${w.symbol} (${w.asset_class})${w.notes ? " — " + compact(w.notes, 80) : ""}`));
  section("RESEARCH NOTES", researchNotes.map((n: any) => `[${n.note_type}] ${n.title}: ${compact(n.content, 160)}`));
  section("TRADE LEDGER", tradeLedger.map((t: any) => `${t.symbol} ${t.direction} [${t.status}] P&L $${t.pnl_usd ?? 0}`));
  section("TRADING ACCOUNTS", tradingAccounts.map((a: any) => `${a.broker} ${a.account_label} $${a.balance_usd ?? 0}${a.is_active ? "" : " [inactive]"}`));

  section("SHARED OPERATOR MEMORY", sharedMem.map((m: any) => `[${m.source_agent}/${m.memory_type}] ${m.key}: ${compact(m.value, 160)}`));
  section("SHARED KNOWLEDGE", sharedKnow.map((k: any) => `[${k.source_agent}${k.topic ? "·" + k.topic : ""}] ${compact(k.fact, 200)}`));
  section("CROSS-AGENT MEMORY", crossMem.map((c: any) => `[${c.source_agent}${c.topic ? "·" + c.topic : ""}] ${compact(c.summary, 200)}`));

  section("RECEIPTS LEDGER", receipts.map((r: any) => `${r.client_name ?? "?"} — ${compact(r.action_description, 100)} $${r.action_value_usd ?? 0} [${r.verification_state}]`));
  section("COWORK ACTIVITY", coworkLog.map((c: any) => `${c.activity_type}: ${compact(c.description, 140)}`));
  section("TELEGRAM SESSIONS", telegramSessions.map((t: any) => `chat ${t.chat_id}${t.is_active ? " ✓" : ""}`));

  // Truncate hard cap to keep prompt under control
  const out = lines.join("\n");
  return out.length > 60000 ? out.slice(0, 60000) + "\n…[truncated]" : out;
}
