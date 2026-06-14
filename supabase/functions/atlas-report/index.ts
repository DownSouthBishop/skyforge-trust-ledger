// atlas-report — daily report generation and publishing
// Actions: generate, publish, verify_predictions, get_archive

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
const FAST_MODEL  = () => modelEnv("FAST_MODEL",  "claude-haiku-4-5");

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

// ─── Generate report ──────────────────────────────────────────────────────────
async function handleGenerate(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const reportDate = (body.report_date as string) ?? new Date().toISOString().split("T")[0];

  // Step 1: Pull signal data (all anonymized before passing to AI)
  const [regimeRows, tradeRows, reMetricsRows, bizMetricsRows, researchRows, bsRows] = await Promise.all([
    dbGet(`${supabaseUrl}/rest/v1/atlas_state?user_id=eq.${uid}&order=updated_at.desc&limit=1&select=regime,regime_confidence,recommended_strategy`, serviceKey),
    dbGet(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&status=eq.closed&closed_at=gte.${reportDate}&select=symbol,asset_class,direction,pnl_usd`, serviceKey),
    (async () => {
      try {
        const r = await fetch(`${supabaseUrl}/rest/v1/atlas_re_portfolio?user_id=eq.${uid}&order=updated_at.desc&limit=1&select=total_value,total_equity,net_cash_flow_monthly`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
        return r.ok ? await r.json() : [];
      } catch { return []; }
    })(),
    dbGet(`${supabaseUrl}/rest/v1/business_ledger?user_id=eq.${uid}&created_at=gte.${new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()}&select=entry_type,amount_usd,status`, serviceKey),
    dbGet(`${supabaseUrl}/rest/v1/research_notes?user_id=eq.${uid}&order=created_at.desc&limit=5&select=title,content,note_type,created_at`, serviceKey),
    dbGet(`${supabaseUrl}/rest/v1/balance_sheet_snapshots?user_id=eq.${uid}&order=snapshot_date.desc&limit=1&select=net_worth_usd,paper_assets_pct,business_pct,re_pct`, serviceKey),
  ]);

  const regime = (regimeRows as Array<{ regime: string; regime_confidence: number; recommended_strategy: string }>)[0] ?? null;
  const trades = tradeRows as Array<{ symbol: string; asset_class: string; direction: string; pnl_usd: number | null }>;
  const reMetrics = (reMetricsRows as Array<{ total_value: number; total_equity: number; net_cash_flow_monthly: number }>)[0] ?? null;
  const bizLedger = bizMetricsRows as Array<{ entry_type: string; amount_usd: number; status: string }>;
  const research = researchRows as Array<{ title: string; content: string; note_type: string; created_at: string }>;
  const bs = (bsRows as Array<{ net_worth_usd: number | null; paper_assets_pct: number; business_pct: number; re_pct: number }>)[0] ?? null;

  const bizRevenue = bizLedger.filter(e => e.entry_type === "revenue" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
  const tradingPnl = trades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);

  // Anonymized signal data (no personal identifiers)
  const signalData = {
    date: reportDate,
    market_regime: regime?.regime ?? "unknown",
    regime_confidence: regime?.regime_confidence ?? 0,
    strategy_bias: regime?.recommended_strategy ?? "",
    trading_session_pnl: tradingPnl,
    trade_count: trades.length,
    asset_classes_active: [...new Set(trades.map(t => t.asset_class))],
    business_revenue_mtd: bizRevenue,
    re_portfolio_equity: reMetrics?.total_equity ?? 0,
    re_monthly_cashflow: reMetrics?.net_cash_flow_monthly ?? 0,
    portfolio_net_worth: bs?.net_worth_usd ?? 0,
    allocation: bs ? { paper: bs.paper_assets_pct, business: bs.business_pct, re: bs.re_pct } : null,
    recent_research_topics: research.slice(0, 3).map(r => r.title),
  };

  // Step 2: Identify verifiable signal claims
  const claimsResp = await callAnthropic({
    model: FAST_MODEL(),
    max_tokens: 600, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: "Extract verifiable market signal claims from data. Return JSON array of strings. Each claim must be falsifiable against public market data within 30 days.",
    messages: [{
      role: "user",
      content: `Based on this data, what are 3-5 specific, verifiable market signal claims?
Regime: ${signalData.market_regime} (${(signalData.regime_confidence * 100).toFixed(0)}% confidence)
Strategy bias: ${signalData.strategy_bias}
Asset classes active: ${signalData.asset_classes_active.join(", ")}

Return JSON: {claims: ["claim 1", "claim 2", ...]}
Each claim must reference a specific market condition that can be verified against public data.`,
    }],
  }, apiKey);

  let verifiableClaims: string[] = [];
  if (claimsResp.ok) {
    const claimsData = await claimsResp.json();
    const claimsContent = claimsData?.content?.[0]?.text ?? "{}";
    try {
      const start = claimsContent.indexOf("{");
      const end = claimsContent.lastIndexOf("}");
      if (start !== -1) {
        const parsed = JSON.parse(claimsContent.slice(start, end + 1)) as { claims?: string[] };
        verifiableClaims = parsed.claims ?? [];
      }
    } catch { verifiableClaims = []; }
  }

  // Step 3: Generate three tier versions
  const tiers = ["FREE", "SIGNAL", "INSTITUTIONAL"] as const;
  const tierPrompts: Record<string, string> = {
    FREE: `Generate a brief FREE tier market intelligence report (directional only, no specific levels or positions).

Signal data: ${JSON.stringify({ regime: signalData.market_regime, strategy_bias: signalData.strategy_bias, date: signalData.date })}

Rules for FREE tier:
- Directional bias only (bullish/bearish/neutral on major indices)
- Sector themes (which sectors look strong/weak)
- No specific price levels, no specific trade setups
- No portfolio data
- Max 300 words
- End with: "Upgrade to SIGNAL tier for sector breakdowns and specific setups."`,
    SIGNAL: `Generate a SIGNAL tier market intelligence report (sector breakdowns included).

Signal data: ${JSON.stringify({ ...signalData, portfolio_net_worth: undefined })}

SIGNAL tier includes:
- Directional bias per asset class
- Sector performance breakdown
- Key levels to watch (support/resistance)
- 2-3 specific setup ideas (no personal portfolio data)
- Risk considerations
- Max 600 words
- End with: "Upgrade to INSTITUTIONAL tier for full model outputs with confidence intervals."`,
    INSTITUTIONAL: `Generate an INSTITUTIONAL tier market intelligence report (full analysis with confidence intervals).

Full signal data: ${JSON.stringify(signalData)}
Verifiable claims: ${verifiableClaims.join("; ")}

INSTITUTIONAL tier includes:
- Complete regime analysis with confidence intervals
- Full asset class breakdown
- Specific setups with entry/exit levels and position sizing guidance
- Quantitative risk metrics
- Cross-asset correlation signals
- Macro context and second-order effects
- Prediction registry entries (verifiable claims with timeframes)
- Max 1200 words`,
  };

  const tierContents: Record<string, string> = {};
  for (const tier of tiers) {
    try {
      const resp = await callAnthropic({
        model: ATLAS_MODEL(),
        max_tokens: tier === "INSTITUTIONAL" ? 2000 : tier === "SIGNAL" ? 1000 : 500,
        system: ATLAS_SYSTEM_PROMPT,
        messages: [{ role: "user", content: tierPrompts[tier] }],
      }, apiKey);
      if (resp.ok) {
        const d = await resp.json();
        tierContents[tier] = d?.content?.[0]?.text ?? `${tier} report generation failed.`;
      } else {
        tierContents[tier] = `${tier} report generation failed (${resp.status}).`;
      }
    } catch (e) {
      tierContents[tier] = `${tier} error: ${e instanceof Error ? e.message : e}`;
    }
  }

  // Step 4: Store to atlas_report_archive
  let reportId: string | null = null;
  try {
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/atlas_report_archive`, {
      method: "POST",
      headers: { ...dbHeaders(serviceKey), Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: uid,
        report_date: reportDate,
        free_content: tierContents.FREE,
        signal_content: tierContents.SIGNAL,
        institutional_content: tierContents.INSTITUTIONAL,
        verifiable_claims: verifiableClaims,
        signal_data: signalData,
        published: false,
        created_at: new Date().toISOString(),
      }),
    });
    if (insertRes.ok) {
      const rows = await insertRes.json() as Array<{ id: string }>;
      reportId = rows?.[0]?.id ?? null;
    }
  } catch { /* handle gracefully */ }

  return new Response(JSON.stringify({
    report_id: reportId,
    report_date: reportDate,
    tiers: tierContents,
    verifiable_claims: verifiableClaims,
    generated_at: new Date().toISOString(),
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Publish report ───────────────────────────────────────────────────────────
async function handlePublish(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const reportId = body.report_id as string;
  if (!reportId) return new Response(JSON.stringify({ error: "report_id required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // Fetch report
  const reportRows = await dbGet(`${supabaseUrl}/rest/v1/atlas_report_archive?id=eq.${reportId}&user_id=eq.${uid}`, serviceKey) as Array<{
    report_date: string; free_content: string; signal_content: string; institutional_content: string;
  }>;

  if (reportRows.length === 0) {
    return new Response(JSON.stringify({ error: "Report not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const report = reportRows[0];
  const results: Record<string, unknown> = {};

  // Publish FREE tier to Ghost
  const ghostApiUrl = Deno.env.get("GHOST_API_URL");
  const ghostApiKey = Deno.env.get("GHOST_API_KEY");
  if (ghostApiUrl && ghostApiKey) {
    try {
      // Generate Ghost JWT (Admin API requires HS256 signed token)
      const [id, secret] = ghostApiKey.split(":");
      const now = Math.floor(Date.now() / 1000);
      // Simple JWT-like header/payload/signature (Ghost Admin API format)
      const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id })).replace(/=/g, "");
      const payload = btoa(JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" })).replace(/=/g, "");

      // For Deno — use crypto.subtle to sign
      const secretBytes = new Uint8Array(secret.match(/.{2}/g)!.map(b => parseInt(b, 16)));
      const keyMaterial = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signatureBytes = await crypto.subtle.sign("HMAC", keyMaterial, new TextEncoder().encode(`${header}.${payload}`));
      const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      const ghostToken = `${header}.${payload}.${signature}`;

      const ghostRes = await fetch(`${ghostApiUrl}/ghost/api/admin/posts/`, {
        method: "POST",
        headers: { Authorization: `Ghost ${ghostToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          posts: [{
            title: `Atlas Intelligence Report — ${report.report_date}`,
            html: `<div>${report.free_content.replace(/\n/g, "<br>")}</div>`,
            status: "published",
            visibility: "public",
            tags: [{ name: "Atlas Intelligence" }, { name: "Free Tier" }],
          }],
        }),
      });
      results.ghost = ghostRes.ok ? "published" : `error_${ghostRes.status}`;
    } catch (e) {
      results.ghost = `error: ${e instanceof Error ? e.message : e}`;
    }
  } else {
    results.ghost = "skipped — GHOST_API_URL or GHOST_API_KEY not configured";
  }

  // Publish SIGNAL/INSTITUTIONAL tiers via Resend to subscribers
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (resendKey) {
    // Pull SIGNAL subscribers
    const signalSubs = await dbGet(`${supabaseUrl}/rest/v1/report_subscribers?tier=eq.SIGNAL&status=eq.active&select=email`, serviceKey) as Array<{ email: string }>;
    const instSubs = await dbGet(`${supabaseUrl}/rest/v1/report_subscribers?tier=eq.INSTITUTIONAL&status=eq.active&select=email`, serviceKey) as Array<{ email: string }>;

    const adminEmail = Deno.env.get("ADMIN_EMAIL");
    const signalEmails = signalSubs.map(s => s.email);
    const instEmails = instSubs.map(s => s.email);

    // Default to admin if no subscribers
    if (signalEmails.length === 0 && adminEmail) signalEmails.push(adminEmail);
    if (instEmails.length === 0 && adminEmail) instEmails.push(adminEmail);

    for (const [tier, emails, content] of [
      ["SIGNAL", signalEmails, report.signal_content],
      ["INSTITUTIONAL", instEmails, report.institutional_content],
    ] as Array<[string, string[], string]>) {
      if (emails.length === 0) { results[tier.toLowerCase()] = "no subscribers"; continue; }
      try {
        const emailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Atlas Intelligence <atlas@resend.dev>",
            to: emails.slice(0, 50), // Resend batch limit
            subject: `[Atlas ${tier}] Intelligence Report — ${report.report_date}`,
            text: content,
          }),
        });
        results[tier.toLowerCase()] = emailRes.ok ? `sent to ${emails.length} subscribers` : `error_${emailRes.status}`;
      } catch (e) {
        results[tier.toLowerCase()] = `error: ${e instanceof Error ? e.message : e}`;
      }
    }
  } else {
    results.signal_email = "skipped — RESEND_API_KEY not configured";
    results.institutional_email = "skipped — RESEND_API_KEY not configured";
  }

  // Mark as published
  await fetch(`${supabaseUrl}/rest/v1/atlas_report_archive?id=eq.${reportId}`, {
    method: "PATCH",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({ published: true, published_at: new Date().toISOString() }),
  }).catch(() => {});

  return new Response(JSON.stringify({ status: "published", report_id: reportId, results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Verify predictions ───────────────────────────────────────────────────────
async function handleVerifyPredictions(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

  // Pull reports older than 30 days with unverified claims
  const oldReports = await dbGet(
    `${supabaseUrl}/rest/v1/atlas_report_archive?user_id=eq.${uid}&created_at=lte.${thirtyDaysAgo}&select=id,report_date,verifiable_claims&limit=20`,
    serviceKey,
  ) as Array<{ id: string; report_date: string; verifiable_claims: string[] }>;

  if (oldReports.length === 0) {
    return new Response(JSON.stringify({ message: "No reports to verify", verified: 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const allClaims = oldReports.flatMap(r =>
    (r.verifiable_claims ?? []).map(claim => ({ report_id: r.id, report_date: r.report_date, claim }))
  );

  if (allClaims.length === 0) {
    return new Response(JSON.stringify({ message: "No claims to verify", verified: 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 1500, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: "You verify market prediction claims against public market data. Be specific and data-grounded. Note that you have knowledge up to your training cutoff.",
    messages: [{
      role: "user",
      content: `Verify these market signal claims that were made 30+ days ago.

${allClaims.slice(0, 10).map(c => `Date: ${c.report_date}\nClaim: ${c.claim}`).join("\n\n")}

For each claim: was it directionally correct? What actually happened?
Return JSON: {verifications: [{report_date, claim, verdict: "correct"|"incorrect"|"partially_correct"|"unverifiable", actual_outcome: string, confidence: 0.0-1.0}]}`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Verify predictions AI failed: ${resp.status}`);
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "{}";
  let result: { verifications?: Array<{ report_date: string; claim: string; verdict: string; actual_outcome: string; confidence: number }> } = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1) result = JSON.parse(content.slice(start, end + 1));
  } catch { result = { verifications: [] }; }

  // Store verification results
  const verifications = result.verifications ?? [];
  for (const v of verifications) {
    await fetch(`${supabaseUrl}/rest/v1/verified_predictions`, {
      method: "POST",
      headers: dbHeaders(serviceKey),
      body: JSON.stringify({ user_id: uid, ...v, verified_at: new Date().toISOString() }),
    }).catch(() => {});
  }

  const correct = verifications.filter(v => v.verdict === "correct").length;
  const accuracy = verifications.length > 0 ? (correct / verifications.length * 100).toFixed(1) : "N/A";

  return new Response(JSON.stringify({
    verified: verifications.length,
    accuracy_pct: accuracy,
    verifications,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Get archive ──────────────────────────────────────────────────────────────
async function handleGetArchive(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const tier = ((body.tier as string) ?? "FREE").toUpperCase();
  const page = Number(body.page ?? 1);
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  // Column selection based on tier
  const tierColumn = tier === "INSTITUTIONAL"
    ? "id,report_date,free_content,signal_content,institutional_content,verifiable_claims,published,created_at"
    : tier === "SIGNAL"
      ? "id,report_date,free_content,signal_content,published,created_at"
      : "id,report_date,free_content,published,created_at";

  let query = `${supabaseUrl}/rest/v1/atlas_report_archive?user_id=eq.${uid}&published=eq.true&order=report_date.desc&limit=${pageSize}&offset=${offset}&select=${tierColumn}`;

  const reports = await dbGet(query, serviceKey);

  // Count total
  let total = 0;
  try {
    const countRes = await fetch(
      `${supabaseUrl}/rest/v1/atlas_report_archive?user_id=eq.${uid}&published=eq.true&select=id`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: "count=exact", Range: "0-0" } },
    );
    const rangeHeader = countRes.headers.get("Content-Range");
    total = parseInt(rangeHeader?.split("/")?.[1] ?? "0", 10);
  } catch { /* ignore */ }

  return new Response(JSON.stringify({
    reports,
    tier,
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
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
    const action = (body.action as string) ?? "generate";

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
      case "generate":             return await handleGenerate(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "publish":              return await handlePublish(body, SUPABASE_URL, SERVICE_KEY, userId);
      case "verify_predictions":   return await handleVerifyPredictions(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "get_archive":          return await handleGetArchive(body, SUPABASE_URL, SERVICE_KEY, userId);
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
    console.error("[atlas-report] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
