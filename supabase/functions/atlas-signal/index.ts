// atlas-signal — intelligence aggregation and alerting
// Consolidates: forge_morning_engine, forge_weekly_review, forge_alerts
//
// Actions: morning_brief, weekly_review, send_alert, aggregate_signals

import {
  corsHeaders,
  verifyUser,
  parseEnv,
  modelEnv,
  AuthError,
  resolveUserIds,
} from "../_shared/gateway.ts";
import { ATLAS_SYSTEM_PROMPT } from "../_shared/atlas_prompt.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "claude-sonnet-4-6");
const MIN_SIGNALS_BEFORE_OUTPUT = 10; // anonymization minimum

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

// ─── Morning brief ────────────────────────────────────────────────────────────
async function handleMorningBrief(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;

  const [regimeRows, openTradesRes, pendingDecisionsRows, portfolioStateRows, bizPipeRows] = await Promise.all([
    dbGet(`${supabaseUrl}/rest/v1/atlas_state?user_id=eq.${uid}&order=updated_at.desc&limit=1&select=regime,regime_confidence,recommended_strategy`, serviceKey),
    dbGet(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&status=eq.open&select=symbol,direction,entry_price,pnl_usd&limit=20`, serviceKey),
    (async () => {
      try {
        const r = await fetch(`${supabaseUrl}/rest/v1/atlas_decision_queue?user_id=eq.${uid}&status=eq.pending&order=created_at.desc&limit=10&select=color,decision_type,summary`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
        return r.ok ? await r.json() : [];
      } catch { return []; }
    })(),
    (async () => {
      try {
        const r = await fetch(`${supabaseUrl}/rest/v1/atlas_portfolio_state?user_id=eq.${uid}&order=updated_at.desc&limit=1`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
        return r.ok ? await r.json() : [];
      } catch { return []; }
    })(),
    dbGet(`${supabaseUrl}/rest/v1/business_pipeline?user_id=eq.${uid}&stage=not.in.(closed_won,closed_lost)&select=contact_name,stage,next_action_due&limit=10`, serviceKey),
  ]);

  const regime = (regimeRows as Array<{ regime: string; regime_confidence: number; recommended_strategy: string }>)[0] ?? null;
  const openTrades = openTradesRes as Array<{ symbol: string; direction: string; entry_price: number; pnl_usd: number | null }>;
  const pendingDecisions = pendingDecisionsRows as Array<{ color: string; decision_type: string; summary: string }>;
  const portfolioState = (portfolioStateRows as Array<Record<string, unknown>>)[0] ?? null;
  const bizPipe = bizPipeRows as Array<{ contact_name: string; stage: string; next_action_due: string | null }>;

  const now = new Date();
  const overduePipeline = bizPipe.filter(p => p.next_action_due && new Date(p.next_action_due) < now);

  const prompt = `Generate the morning brief for ${now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}.

MARKET REGIME: ${regime ? `${regime.regime} (${(regime.regime_confidence * 100).toFixed(0)}% confidence) — ${regime.recommended_strategy}` : "Unknown — run regime detection"}

OPEN POSITIONS (${openTrades.length}):
${openTrades.length > 0 ? openTrades.map(t => `${t.symbol} ${t.direction} — P&L: $${Number(t.pnl_usd ?? 0).toFixed(2)}`).join("\n") : "No open positions."}

PORTFOLIO: ${portfolioState ? `Net worth $${Number((portfolioState as Record<string, unknown>).net_worth_usd ?? 0).toLocaleString()} | Rebalancing needed: ${(portfolioState as Record<string, unknown>).rebalancing_needed ?? false}` : "No snapshot available."}

PENDING DECISIONS (${pendingDecisions.length}):
${pendingDecisions.length > 0 ? pendingDecisions.map(d => `[${d.color}] ${d.decision_type}: ${d.summary}`).join("\n") : "None pending."}

BUSINESS PIPELINE:
${bizPipe.length > 0 ? `${bizPipe.length} active deals | ${overduePipeline.length} overdue` : "No active pipeline."}
${overduePipeline.length > 0 ? `Overdue: ${overduePipeline.slice(0, 3).map(p => `${p.contact_name} [${p.stage}]`).join(", ")}` : ""}

Generate morning brief covering:
1. Market conditions and regime — what it means for today
2. Open positions — anything to manage
3. Today's priorities across all three verticals (trading/business/RE)
4. Pending decisions requiring attention
5. One key focus for the day

Be direct and actionable.`;

  const resp = await callAnthropic({
    model: ATLAS_MODEL(), max_tokens: 1500, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Morning brief AI failed: ${resp.status}`);
  const aiData = await resp.json();
  const brief = aiData?.content?.[0]?.text ?? "Brief unavailable.";

  // Store to research_notes
  await fetch(`${supabaseUrl}/rest/v1/research_notes`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({
      user_id: uid,
      title: `Morning Brief — ${now.toISOString().split("T")[0]}`,
      content: brief,
      note_type: "research",
      synced_to_obsidian: false,
    }),
  }).catch(() => {});

  return new Response(JSON.stringify({ brief, date: now.toISOString().split("T")[0], open_positions: openTrades.length, pending_decisions: pendingDecisions.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Weekly review ────────────────────────────────────────────────────────────
async function handleWeeklyReview(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  const [weekTradesRes, bizLedgerRes, portfolioRes, reRentRes, bsSnapshotRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&status=eq.closed&closed_at=gte.${sevenDaysAgo}&select=symbol,direction,pnl_usd,closed_at`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/business_ledger?user_id=eq.${uid}&created_at=gte.${monthStart}&select=entry_type,amount_usd,status`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/property_portfolio?user_id=eq.${uid}&status=eq.active&select=address,current_value,gross_rent_monthly`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/property_ledger?user_id=eq.${uid}&created_at=gte.${sevenDaysAgo}&entry_type=eq.rent&status=eq.paid&select=amount_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/balance_sheet_snapshots?user_id=eq.${uid}&order=snapshot_date.desc&limit=2&select=snapshot_date,net_worth_usd,paper_assets_pct,business_pct,re_pct`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
  ]);

  const weekTrades = weekTradesRes.ok ? await weekTradesRes.json() as Array<{ symbol: string; direction: string; pnl_usd: number | null; closed_at: string }> : [];
  const bizLedger = bizLedgerRes.ok ? await bizLedgerRes.json() as Array<{ entry_type: string; amount_usd: number; status: string }> : [];
  const portfolio = portfolioRes.ok ? await portfolioRes.json() as Array<{ address: string; current_value: number | null; gross_rent_monthly: number | null }> : [];
  const reRent = reRentRes.ok ? await reRentRes.json() as Array<{ amount_usd: number }> : [];
  const bsSnapshots = bsSnapshotRes.ok ? await bsSnapshotRes.json() as Array<{ snapshot_date: string; net_worth_usd: number | null; paper_assets_pct: number; business_pct: number; re_pct: number }> : [];

  const weekTradingPnl = weekTrades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);
  const winRate = weekTrades.length > 0 ? (weekTrades.filter(t => Number(t.pnl_usd ?? 0) > 0).length / weekTrades.length * 100).toFixed(1) : "N/A";
  const bizRevenue = bizLedger.filter(e => e.entry_type === "revenue" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
  const bizExpenses = bizLedger.filter(e => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount_usd), 0);
  const reRentWeek = reRent.reduce((s, e) => s + Number(e.amount_usd), 0);

  const latestBs = bsSnapshots[0] ?? null;
  const prevBs = bsSnapshots[1] ?? null;
  const netWorthChange = (latestBs && prevBs) ? Number(latestBs.net_worth_usd ?? 0) - Number(prevBs.net_worth_usd ?? 0) : null;

  const now = new Date();
  const weekLabel = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const prompt = `Generate the weekly performance review.

TRADING PERFORMANCE (7 days):
Closed trades: ${weekTrades.length} | Total P&L: $${weekTradingPnl.toFixed(2)} | Win rate: ${winRate}%
Top trades: ${weekTrades.slice(0, 5).map(t => `${t.symbol} ${t.direction}: $${Number(t.pnl_usd ?? 0).toFixed(0)}`).join(", ") || "None"}

BUSINESS (MTD):
Revenue: $${bizRevenue.toFixed(0)} | Expenses: $${bizExpenses.toFixed(0)} | Net: $${(bizRevenue - bizExpenses).toFixed(0)}

REAL ESTATE (7 days):
Rent collected: $${reRentWeek.toFixed(0)} | Portfolio: ${portfolio.length} properties | Total value: $${portfolio.reduce((s, p) => s + Number(p.current_value ?? 0), 0).toLocaleString()}

NET WORTH:
${latestBs ? `Current: $${Number(latestBs.net_worth_usd ?? 0).toLocaleString()} | Change: ${netWorthChange !== null ? (netWorthChange >= 0 ? "+" : "") + "$" + netWorthChange.toLocaleString() : "N/A"}` : "No snapshot available."}
${latestBs ? `Allocation: Paper ${latestBs.paper_assets_pct.toFixed(1)}% | Business ${latestBs.business_pct.toFixed(1)}% | RE ${latestBs.re_pct.toFixed(1)}%` : ""}

Review sections:
1. Trading Performance — P&L, win rate, notable wins/losses
2. Business Performance — revenue velocity, pipeline progress
3. RE Performance — cash flow, any lease/maintenance issues
4. Capital Position — net worth change, allocation drift
5. Lessons — what worked, what didn't
6. Next Week's Priorities — 3 specific focus areas

Verdict: one sentence on the week.`;

  const resp = await callAnthropic({
    model: ATLAS_MODEL(), max_tokens: 2000, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Weekly review AI failed: ${resp.status}`);
  const aiData = await resp.json();
  const review = aiData?.content?.[0]?.text ?? "Review unavailable.";

  await fetch(`${supabaseUrl}/rest/v1/research_notes`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({ user_id: uid, title: `Weekly Review — ${weekLabel}`, content: review, note_type: "weekly_review", synced_to_obsidian: false }),
  }).catch(() => {});

  return new Response(JSON.stringify({
    review,
    week: weekLabel,
    trading_pnl: weekTradingPnl,
    business_net: bizRevenue - bizExpenses,
    re_rent_week: reRentWeek,
    net_worth_change: netWorthChange,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Send alert ───────────────────────────────────────────────────────────────
async function handleSendAlert(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const { subject, message, alert_type = "general", priority = "normal" } = body;
  if (!subject || !message) {
    return new Response(JSON.stringify({ error: "subject and message required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const resendKey = Deno.env.get("RESEND_API_KEY");
  const adminEmail = Deno.env.get("ADMIN_EMAIL");
  const results: Record<string, unknown> = {};

  // Log to forge_alerts
  await fetch(`${supabaseUrl}/rest/v1/forge_alerts`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({ user_id: uid, signal_type: alert_type, message: `${subject}: ${String(message).slice(0, 500)}` }),
  }).catch(() => {});

  // Send email via Resend if configured
  if (resendKey && adminEmail) {
    try {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Atlas <atlas@resend.dev>",
          to: [adminEmail],
          subject: `[Atlas${priority === "high" ? " 🚨" : ""}] ${subject}`,
          text: String(message),
          html: `<pre style="font-family:monospace;white-space:pre-wrap">${String(message)}</pre>`,
        }),
      });
      results.email = emailRes.ok ? "sent" : `error_${emailRes.status}`;
    } catch (e) {
      results.email = `exception: ${e instanceof Error ? e.message : e}`;
    }
  } else {
    results.email = "skipped — RESEND_API_KEY or ADMIN_EMAIL not configured";
  }

  return new Response(JSON.stringify({ status: "ok", results, alert_type, priority }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Aggregate signals ────────────────────────────────────────────────────────
async function handleAggregateSignals(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  // Pull behavioral signals across all operators (anonymized)
  // Minimum 10 signals before producing any output (privacy floor)
  const signalType = (body.signal_type as string) ?? "all";
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

  let signalQuery = `${supabaseUrl}/rest/v1/atlas_user_preferences?created_at=gte.${thirtyDaysAgo}&select=category,key,value,confidence`;
  if (signalType !== "all") signalQuery += `&category=eq.${signalType}`;
  signalQuery += "&limit=500";

  const signals = await dbGet(signalQuery, serviceKey) as Array<{ category: string; key: string; value: string; confidence: number }>;

  if (signals.length < MIN_SIGNALS_BEFORE_OUTPUT) {
    return new Response(JSON.stringify({
      message: `Insufficient signal volume: ${signals.length}/${MIN_SIGNALS_BEFORE_OUTPUT} required before aggregation output`,
      signal_count: signals.length,
      threshold: MIN_SIGNALS_BEFORE_OUTPUT,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Aggregate patterns — count and average confidence per category/key
  const aggregated: Record<string, { count: number; avg_confidence: number; sample_values: string[] }> = {};
  for (const signal of signals) {
    const key = `${signal.category}:${signal.key}`;
    if (!aggregated[key]) aggregated[key] = { count: 0, avg_confidence: 0, sample_values: [] };
    aggregated[key].count++;
    aggregated[key].avg_confidence += signal.confidence ?? 0.5;
    if (aggregated[key].sample_values.length < 3) aggregated[key].sample_values.push(signal.value);
  }

  // Finalize averages
  for (const k of Object.keys(aggregated)) {
    aggregated[k].avg_confidence = parseFloat((aggregated[k].avg_confidence / aggregated[k].count).toFixed(3));
  }

  // Sort by frequency
  const sorted = Object.entries(aggregated)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20);

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 800, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: "You analyze anonymized behavioral patterns from a financial AI system. All data represents aggregated patterns across many users — no individual can be identified.",
    messages: [{
      role: "user",
      content: `Analyze these aggregated behavioral patterns from ${signals.length} signals across multiple operators:

${sorted.map(([key, data]) => `${key}: n=${data.count}, confidence=${data.avg_confidence}`).join("\n")}

Identify: 1) Most common behavioral patterns 2) High-confidence signals worth acting on 3) Emerging trends in how operators engage with wealth management AI

Do NOT reference any individual. These are population-level patterns only.`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Aggregate signals AI failed: ${resp.status}`);
  const aiData = await resp.json();
  const analysis = aiData?.content?.[0]?.text ?? "Analysis unavailable.";

  return new Response(JSON.stringify({
    analysis,
    signal_count: signals.length,
    top_patterns: sorted.slice(0, 10).map(([key, data]) => ({ pattern: key, count: data.count, avg_confidence: data.avg_confidence })),
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    const body: Record<string, unknown> = await req.json().catch(() => ({}));
    const action = (body.action as string) ?? "morning_brief";

    let userId = "system";
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch {
      const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (authHeader === SERVICE_KEY) {
        userId = "system";
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
      case "morning_brief":      return await handleMorningBrief(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "weekly_review":      return await handleWeeklyReview(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "send_alert":         return await handleSendAlert(body, SUPABASE_URL, SERVICE_KEY, userId);
      case "aggregate_signals":  return await handleAggregateSignals(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
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
    console.error("[atlas-signal] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
