// atlas-business — autonomous business pipeline
// Consolidates: atlas_business_brief, atlas_business_risk_check,
//               atlas_pipeline_scout, atlas_send_outreach
//
// Actions: brief, risk_check, scout, send_outreach, evaluate, initialize, monitor

import {
  corsHeaders,
  verifyUser,
  parseEnv,
  modelEnv,
  AuthError,
  resolveUserIds,
} from "../_shared/gateway.ts";
import { ATLAS_SYSTEM_PROMPT } from "../_shared/atlas_prompt.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "claude-sonnet-4-5");

async function callAnthropic(body: Record<string, unknown>, apiKey: string): Promise<Response> {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": "web-search-2025-03-05", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dbHeaders(serviceKey: string) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" };
}

async function dbGet(url: string, serviceKey: string): Promise<unknown[]> {
  try {
    const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    return r.ok ? await r.json() : [];
  } catch { return []; }
}

async function insertDecision(
  supabaseUrl: string, serviceKey: string,
  type: string, context: string, recommendation: Record<string, unknown>, capital = 0,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/atlas_decision_queue`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({
      decision_type: type,
      business_context: context,
      recommendation,
      capital_at_stake: capital,
      status: "PENDING",
    }),
  }).catch(() => {});
}

// ─── Business Brief ───────────────────────────────────────────────────────────

async function handleBrief(
  supabaseUrl: string, serviceKey: string, apiKey: string, userId: string,
): Promise<Response> {
  const [pipelineRows, ledgerRows] = await Promise.all([
    dbGet(`${supabaseUrl}/rest/v1/atlas_business_pipeline?order=created_at.desc&limit=20`, serviceKey),
    dbGet(`${supabaseUrl}/rest/v1/business_ledger?user_id=eq.${userId}&order=created_at.desc&limit=50`, serviceKey),
  ]) as [
    Array<{ id: string; thesis: string; stage: string; projected_monthly_revenue: number; capital_required: number }>,
    Array<{ entry_type: string; amount_usd: number; status: string }>,
  ];

  const totalRevenue = (ledgerRows as Array<{ entry_type: string; amount_usd: number; status: string }>)
    .filter(r => r.entry_type === "revenue" && r.status === "paid")
    .reduce((s, r) => s + Number(r.amount_usd), 0);
  const totalExpenses = (ledgerRows as Array<{ entry_type: string; amount_usd: number; status: string }>)
    .filter(r => r.entry_type === "expense")
    .reduce((s, r) => s + Number(r.amount_usd), 0);

  const pipelineSummary = (pipelineRows as Array<{ thesis: string; stage: string; projected_monthly_revenue: number; capital_required: number }>)
    .map(p => `[${p.stage}] ${p.thesis ?? "No thesis"} | Target: $${p.projected_monthly_revenue ?? 0}/mo | Capital: $${p.capital_required ?? 0}`)
    .join("\n");

  const resp = await callAnthropic({
    model: ATLAS_MODEL(), max_tokens: 1500,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Generate a business vertical brief.

PIPELINE (${pipelineRows.length} ventures):
${pipelineSummary || "No ventures in pipeline."}

FINANCIALS (MTD):
Revenue: $${totalRevenue.toFixed(0)} | Expenses: $${totalExpenses.toFixed(0)} | Net: $${(totalRevenue - totalExpenses).toFixed(0)}

Cover: 1) Pipeline velocity by stage 2) Revenue vs targets 3) Next 30-day priorities 4) Bottlenecks 5) One decision needed this week.`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Business brief AI failed: ${resp.status}`);
  const data = await resp.json();
  const brief = data?.content?.[0]?.text ?? "Brief unavailable.";

  await fetch(`${supabaseUrl}/rest/v1/research_notes`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({
      user_id: userId,
      title: `Business Brief — ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
      content: brief,
      note_type: "research",
    }),
  }).catch(() => {});

  return new Response(JSON.stringify({ brief, pipeline_count: pipelineRows.length, revenue_mtd: totalRevenue }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Risk Check ───────────────────────────────────────────────────────────────

async function handleRiskCheck(
  body: Record<string, unknown>, supabaseUrl: string, serviceKey: string, userId: string,
): Promise<Response> {
  const violations: string[] = [];
  const warnings: string[] = [];

  const capitalRequired = Number(body.capital_required ?? 0);
  const maxCapital = Number(Deno.env.get("MAX_CAPITAL_PER_BUSINESS") ?? 25000);

  if (capitalRequired > maxCapital) {
    violations.push(`Capital required $${capitalRequired.toLocaleString()} exceeds MAX_CAPITAL_PER_BUSINESS $${maxCapital.toLocaleString()}`);
  }

  const compatScore = Number(body.execution_compatibility_score ?? 0);
  if (compatScore < 0.4) {
    violations.push(`Execution compatibility score ${compatScore} is below 0.4 — requires in-house team, not contractor-only`);
  } else if (compatScore < 0.6) {
    warnings.push(`Execution compatibility score ${compatScore} — may require partial in-house resources`);
  }

  // Check existing pipeline concentration
  const existing = await dbGet(`${supabaseUrl}/rest/v1/atlas_business_pipeline?stage=in.(BUILDING,OPERATING)&select=capital_required`, serviceKey) as Array<{ capital_required: number }>;
  const existingCapital = existing.reduce((s, b) => s + Number(b.capital_required ?? 0), 0);
  if (existingCapital + capitalRequired > maxCapital * 3) {
    warnings.push(`Total active business capital would be $${(existingCapital + capitalRequired).toLocaleString()} — high concentration`);
  }

  return new Response(JSON.stringify({
    go: violations.length === 0,
    violations,
    warnings,
    risk_summary: violations.length > 0 ? "BLOCKED" : warnings.length > 0 ? "CAUTION" : "CLEAR",
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Scouting Cycle ───────────────────────────────────────────────────────────

async function handleScout(
  supabaseUrl: string, serviceKey: string, apiKey: string,
): Promise<Response> {
  // Pull context signals
  const [signals, portfolio, activePipeline] = await Promise.all([
    dbGet(`${supabaseUrl}/rest/v1/atlas_signals?order=created_at.desc&limit=20`, serviceKey),
    dbGet(`${supabaseUrl}/rest/v1/atlas_portfolio_state?order=snapshot_at.desc&limit=1`, serviceKey),
    dbGet(`${supabaseUrl}/rest/v1/atlas_business_pipeline?stage=in.(BUILDING,OPERATING)&select=business_type,capital_required`, serviceKey),
  ]);

  const portfolioState = (portfolio as Array<Record<string, unknown>>)[0] ?? {};
  const activePipelineCapital = (activePipeline as Array<{ capital_required: number }>)
    .reduce((s, b) => s + Number(b.capital_required ?? 0), 0);

  const resp = await callAnthropic({
    model: ATLAS_MODEL(), max_tokens: 2500,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Run the autonomous business scouting cycle.

AVAILABLE CAPITAL: ~$${(Number((portfolioState as Record<string, unknown>).total_value ?? 0) * 0.30 - activePipelineCapital).toLocaleString()} (30% allocation minus active ventures)

ACTIVE VENTURES: ${(activePipeline as Array<{ business_type: string }>).map((b) => b.business_type).join(", ") || "None"}

CURRENT MARKET SIGNALS:
${(signals as Array<Record<string, unknown>>).slice(0, 10).map((s) => `- ${JSON.stringify(s).slice(0, 150)}`).join("\n") || "No signals available."}

EXECUTION CONSTRAINTS:
- Must run with contractor-only execution (no employees)
- Must reach profitability within 6 months
- Revenue model must be recurring or repeatable (not one-time)
- Maximum startup capital: $${Deno.env.get("MAX_CAPITAL_PER_BUSINESS") ?? 25000}

Identify 5-8 business opportunities. For each, return structured JSON:
{
  "opportunities": [
    {
      "thesis": "one sentence description",
      "business_type": "DIGITAL_ARBITRAGE|SERVICE_CONTRACTOR|DATA_PRODUCT|ACQUISITION",
      "capital_required": number,
      "projected_monthly_revenue": number,
      "execution_compatibility_score": 0-1,
      "time_to_profitability_months": number,
      "key_risks": ["risk1", "risk2"],
      "conviction": "high|medium|low"
    }
  ],
  "market_summary": "current opportunity landscape in 2-3 sentences"
}`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Scout AI failed: ${resp.status}`);
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "{}";

  let result: { opportunities?: Array<Record<string, unknown>>; market_summary?: string } = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1) result = JSON.parse(content.slice(start, end + 1));
  } catch { result = { market_summary: content }; }

  const opportunities = result.opportunities ?? [];
  const inserted: string[] = [];

  for (const opp of opportunities) {
    const insertResp = await fetch(`${supabaseUrl}/rest/v1/atlas_business_pipeline`, {
      method: "POST",
      headers: { ...dbHeaders(serviceKey), Prefer: "return=representation" },
      body: JSON.stringify({
        stage: "SCOUTING",
        business_type: opp.business_type ?? "DIGITAL_ARBITRAGE",
        thesis: opp.thesis ?? "",
        capital_required: opp.capital_required ?? 0,
        projected_monthly_revenue: opp.projected_monthly_revenue ?? 0,
        execution_compatibility_score: opp.execution_compatibility_score ?? 0.5,
        evaluation_memo: { key_risks: opp.key_risks ?? [], time_to_profitability: opp.time_to_profitability_months ?? 6 },
        last_updated: new Date().toISOString(),
      }),
    }).catch(() => null);
    if (insertResp?.ok) {
      const rows = await insertResp.json().catch(() => []) as Array<{ id: string }>;
      if (rows?.[0]?.id) inserted.push(rows[0].id);
    }
  }

  // Insert YELLOW decision with ranked list
  await insertDecision(supabaseUrl, serviceKey, "YELLOW",
    `Business scouting: ${opportunities.length} opportunities identified — review and approve for evaluation`,
    {
      opportunities: opportunities.slice(0, 8),
      market_summary: result.market_summary ?? "",
      action_required: "Review opportunities and approve 1-3 for full evaluation",
    },
    opportunities.reduce((s, o) => s + Number(o.capital_required ?? 0), 0),
  );

  return new Response(JSON.stringify({
    opportunities_found: opportunities.length,
    pipeline_ids: inserted,
    market_summary: result.market_summary,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Evaluation Memo ──────────────────────────────────────────────────────────

async function handleEvaluate(
  body: Record<string, unknown>, supabaseUrl: string, serviceKey: string, apiKey: string,
): Promise<Response> {
  const businessId = body.business_id as string;
  if (!businessId) {
    return new Response(JSON.stringify({ error: "business_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const r = await fetch(`${supabaseUrl}/rest/v1/atlas_business_pipeline?id=eq.${businessId}&limit=1`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const rows = r.ok ? await r.json() as Array<Record<string, unknown>> : [];
  if (!rows.length) {
    return new Response(JSON.stringify({ error: "Business not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const business = rows[0];

  const resp = await callAnthropic({
    model: ATLAS_MODEL(), max_tokens: 3000,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Generate a full evaluation memo for this business opportunity.

THESIS: ${business.thesis ?? "Not provided"}
TYPE: ${business.business_type ?? "Unknown"}
CAPITAL REQUIRED: $${business.capital_required ?? 0}
PROJECTED MONTHLY REVENUE: $${business.projected_monthly_revenue ?? 0}
EXECUTION SCORE: ${business.execution_compatibility_score ?? 0}

Produce a structured evaluation covering:

1. MARKET ANALYSIS — size, growth, competitive landscape, barriers to entry
2. UNIT ECONOMICS — 3 scenarios (conservative/base/optimistic), break-even timeline
3. EXECUTION PATHWAY — what contractors needed, timeline, sequence of milestones
4. CAPITAL ANALYSIS — startup costs itemized, runway to profitability, monthly burn
5. REGULATORY SCAN — licenses needed, jurisdiction risks, compliance requirements
6. EXECUTION COMPATIBILITY — can this run contractor-only? What are the friction points?
7. VERDICT — GO / CONDITIONAL / NO-GO with one-sentence reason and key condition

Return as structured JSON:
{
  "market_analysis": {...},
  "unit_economics": {"conservative": {...}, "base": {...}, "optimistic": {...}},
  "execution_pathway": [...],
  "capital_analysis": {...},
  "regulatory_scan": {...},
  "execution_compatibility": {...},
  "verdict": "GO|CONDITIONAL|NO-GO",
  "verdict_reason": "...",
  "key_condition": "..."
}`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Evaluation AI failed: ${resp.status}`);
  const aiData = await resp.json();
  const content = aiData?.content?.[0]?.text ?? "{}";

  let memo: Record<string, unknown> = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1) memo = JSON.parse(content.slice(start, end + 1));
  } catch { memo = { raw: content }; }

  // Update business pipeline
  await fetch(`${supabaseUrl}/rest/v1/atlas_business_pipeline?id=eq.${businessId}`, {
    method: "PATCH",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({ stage: "EVALUATION", evaluation_memo: memo, last_updated: new Date().toISOString() }),
  }).catch(() => {});

  // Insert ORANGE decision
  await insertDecision(supabaseUrl, serviceKey, "ORANGE",
    `Business evaluation complete: ${business.thesis ?? "Venture"} — verdict: ${(memo as Record<string, string>).verdict ?? "CONDITIONAL"}`,
    { ...memo, business_id: businessId, thesis: business.thesis },
    Number(business.capital_required ?? 0),
  );

  return new Response(JSON.stringify({ memo, verdict: (memo as Record<string, string>).verdict ?? "CONDITIONAL" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Initialize Business ──────────────────────────────────────────────────────

async function handleInitialize(
  body: Record<string, unknown>, supabaseUrl: string, serviceKey: string, apiKey: string,
): Promise<Response> {
  const businessId = body.business_id as string;
  if (!businessId) {
    return new Response(JSON.stringify({ error: "business_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const r = await fetch(`${supabaseUrl}/rest/v1/atlas_business_pipeline?id=eq.${businessId}&limit=1`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const rows = r.ok ? await r.json() as Array<Record<string, unknown>> : [];
  if (!rows.length) {
    return new Response(JSON.stringify({ error: "Business not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const business = rows[0];

  const resp = await callAnthropic({
    model: ATLAS_MODEL(), max_tokens: 2000,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Generate the initialization package for this approved business.

THESIS: ${business.thesis ?? "Not provided"}
TYPE: ${business.business_type ?? "Unknown"}
EVALUATION MEMO: ${JSON.stringify(business.evaluation_memo ?? {}).slice(0, 1000)}

Produce:
1. ENTITY STRUCTURE — recommended legal structure, formation state, operating parameters
2. CONTRACTOR REQUIREMENTS — roles, qualifications, estimated cost, sourcing approach
3. MONITORING METRICS — 5-7 KPIs with targets and red-flag thresholds
4. INVESTMENT POLICY — capital deployment schedule, reinvestment rules, exit criteria

Identify which actions Atlas can take autonomously (GREEN decisions) vs which require human authorization (ORANGE decisions).

Return JSON:
{
  "entity_structure": {...},
  "contractor_requirements": [...],
  "monitoring_metrics": [...],
  "investment_policy": {...},
  "green_actions": ["action1", "action2"],
  "orange_actions": ["action1", "action2"]
}`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Initialize AI failed: ${resp.status}`);
  const aiData = await resp.json();
  const content = aiData?.content?.[0]?.text ?? "{}";

  let init: Record<string, unknown> = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1) init = JSON.parse(content.slice(start, end + 1));
  } catch { init = { raw: content }; }

  // Update pipeline
  await fetch(`${supabaseUrl}/rest/v1/atlas_business_pipeline?id=eq.${businessId}`, {
    method: "PATCH",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({
      stage: "BUILDING",
      entity_structure: init.entity_structure ?? {},
      contractor_network: init.contractor_requirements ?? [],
      last_updated: new Date().toISOString(),
    }),
  }).catch(() => {});

  // GREEN decisions for autonomous actions
  for (const action of ((init.green_actions ?? []) as string[]).slice(0, 5)) {
    await insertDecision(supabaseUrl, serviceKey, "GREEN",
      `[AUTO] ${business.thesis}: ${action}`,
      { action, business_id: businessId, thesis: business.thesis },
    );
  }

  // ORANGE decisions for human authorization
  for (const action of ((init.orange_actions ?? []) as string[]).slice(0, 5)) {
    await insertDecision(supabaseUrl, serviceKey, "ORANGE",
      `[APPROVAL NEEDED] ${business.thesis}: ${action}`,
      { action, business_id: businessId, thesis: business.thesis },
      Number(business.capital_required ?? 0) / ((init.orange_actions as string[])?.length ?? 1),
    );
  }

  return new Response(JSON.stringify({ init, business_id: businessId }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Monitor Business ─────────────────────────────────────────────────────────

async function handleMonitor(
  body: Record<string, unknown>, supabaseUrl: string, serviceKey: string, apiKey: string,
): Promise<Response> {
  const businessId = body.business_id as string;
  if (!businessId) {
    return new Response(JSON.stringify({ error: "business_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const r = await fetch(`${supabaseUrl}/rest/v1/atlas_business_pipeline?id=eq.${businessId}&limit=1`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const rows = r.ok ? await r.json() as Array<Record<string, unknown>> : [];
  if (!rows.length) {
    return new Response(JSON.stringify({ error: "Business not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const business = rows[0];

  const metrics = business.performance_metrics as Record<string, unknown> ?? {};
  const memo = business.evaluation_memo as Record<string, unknown> ?? {};
  const projectedRevenue = Number(business.projected_monthly_revenue ?? 0);
  const actualRevenue = Number((metrics as Record<string, number>).actual_monthly_revenue ?? 0);

  const revenueVariance = projectedRevenue > 0 ? (actualRevenue - projectedRevenue) / projectedRevenue : 0;
  const consecutiveUnderperformance = Number((metrics as Record<string, number>).consecutive_months_under ?? 0);

  const issues: string[] = [];
  if (revenueVariance < -0.20) issues.push(`Revenue ${(revenueVariance * 100).toFixed(0)}% below projection`);

  let decisionType = "YELLOW";
  let decisionContext = `Weekly check: ${business.thesis ?? "Venture"}`;

  if (consecutiveUnderperformance >= 3) {
    // Sustained underperformance — generate exit analysis
    decisionType = "RED";
    decisionContext = `3+ months underperformance: ${business.thesis ?? "Venture"} — exit analysis required`;
  } else if (issues.length > 0) {
    decisionType = "ORANGE";
    decisionContext = `Anomaly detected: ${issues.join("; ")}`;
  }

  // AI diagnosis if there are issues
  let diagnosis = "";
  if (issues.length > 0 || consecutiveUnderperformance >= 2) {
    const diagResp = await callAnthropic({
      model: ATLAS_MODEL(), max_tokens: 800,
      system: ATLAS_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Diagnose performance issue for this business.
Thesis: ${business.thesis}
Projected revenue: $${projectedRevenue}/mo
Actual revenue: $${actualRevenue}/mo
Months underperforming: ${consecutiveUnderperformance}
Issues: ${issues.join(", ")}
Original memo context: ${JSON.stringify(memo).slice(0, 500)}

Give: 1) Root cause hypothesis 2) Specific corrective action 3) Timeline to see improvement. Be direct and brief.`,
      }],
    }, apiKey).catch(() => null);

    if (diagResp?.ok) {
      const diagData = await diagResp.json();
      diagnosis = diagData?.content?.[0]?.text ?? "";
    }
  }

  // Update metrics
  const updatedMetrics = {
    ...metrics,
    last_checked_at: new Date().toISOString(),
    consecutive_months_under: revenueVariance < -0.20 ? consecutiveUnderperformance + 1 : 0,
    revenue_variance_pct: revenueVariance,
  };

  await fetch(`${supabaseUrl}/rest/v1/atlas_business_pipeline?id=eq.${businessId}`, {
    method: "PATCH",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({ performance_metrics: updatedMetrics, last_updated: new Date().toISOString() }),
  }).catch(() => {});

  await insertDecision(supabaseUrl, serviceKey, decisionType, decisionContext, {
    business_id: businessId,
    thesis: business.thesis,
    revenue_variance_pct: revenueVariance,
    consecutive_months_under: consecutiveUnderperformance,
    issues,
    diagnosis,
  }, projectedRevenue);

  return new Response(JSON.stringify({
    status: decisionType,
    revenue_variance_pct: revenueVariance,
    issues,
    diagnosis: diagnosis.slice(0, 500),
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Send Outreach ────────────────────────────────────────────────────────────

async function handleSendOutreach(
  body: Record<string, unknown>, supabaseUrl: string, serviceKey: string, apiKey: string, userId: string,
): Promise<Response> {
  const { contact_name, contact_email, opportunity, business_id } = body;

  // All outreach requires ORANGE decision — never auto-sends
  const resp = await callAnthropic({
    model: ATLAS_MODEL(), max_tokens: 800,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Draft a professional outreach message.
Contact: ${contact_name ?? "Unknown"}
Opportunity: ${opportunity ?? "Business inquiry"}
Business context: ${business_id ? `Venture ID ${business_id}` : "General pipeline"}

Write a concise, personalized outreach message (under 200 words). Direct, specific, clear value proposition. No filler.`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Outreach AI failed: ${resp.status}`);
  const aiData = await resp.json();
  const draft = aiData?.content?.[0]?.text ?? "";

  // Insert as ORANGE decision — never auto-send
  await insertDecision(supabaseUrl, serviceKey, "ORANGE",
    `Outreach to ${contact_name ?? "prospect"}: ${(opportunity as string ?? "").slice(0, 80)}`,
    {
      contact_name,
      contact_email,
      opportunity,
      draft_message: draft,
      action_required: "Review and approve before sending",
    },
  );

  return new Response(JSON.stringify({ draft, requires_approval: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    const body: Record<string, unknown> = await req.json().catch(() => ({}));
    const action = (body.action as string) ?? "brief";

    let userId = "system";
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch {
      const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (authHeader === SERVICE_KEY) {
        userId = (body.user_id as string) ?? "system";
      } else {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (userId === "system") {
      const resolved = await resolveUserIds(SUPABASE_URL, SERVICE_KEY, "system");
      if (resolved.length > 0) userId = resolved[0];
    }

    switch (action) {
      case "brief":         return await handleBrief(SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "risk_check":    return await handleRiskCheck(body, SUPABASE_URL, SERVICE_KEY, userId);
      case "scout":         return await handleScout(SUPABASE_URL, SERVICE_KEY, API_KEY);
      case "evaluate":      return await handleEvaluate(body, SUPABASE_URL, SERVICE_KEY, API_KEY);
      case "initialize":    return await handleInitialize(body, SUPABASE_URL, SERVICE_KEY, API_KEY);
      case "monitor":       return await handleMonitor(body, SUPABASE_URL, SERVICE_KEY, API_KEY);
      case "send_outreach": return await handleSendOutreach(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("[atlas-business] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
