// forge_execute — Atlas autonomous play executor
// Receives an approved opportunity signal and executes it fully without human input.
// Internal only — authenticated via service role key.

import {
  corsHeaders,
  parseEnv,
} from "../_shared/gateway.ts";
import { ATLAS_SYSTEM_PROMPT, TRADING_INFRASTRUCTURE_PROMPT, AUTONOMOUS_OPS_PROMPT } from "../_shared/atlas_prompt.ts";

const FORGE_EXECUTE_SYSTEM = ATLAS_SYSTEM_PROMPT + "\n\n" + TRADING_INFRASTRUCTURE_PROMPT + "\n\n" + AUTONOMOUS_OPS_PROMPT +
  "\n\nYou are executing an approved opportunity right now. Write exactly what is asked — deliverables only, no preamble or meta-commentary.";

// ─── helpers ────────────────────────────────────────────────────────────────

function extractJson<T>(text: string): T | null {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = block ? block[1].trim() : text.trim();
  try { return JSON.parse(raw) as T; } catch { /* fall through */ }
  const arr = raw.indexOf("[");
  const obj = raw.indexOf("{");
  const start = arr !== -1 && (obj === -1 || arr < obj) ? arr : obj;
  if (start !== -1) {
    try { return JSON.parse(raw.slice(start)) as T; } catch { /* fall through */ }
  }
  return null;
}

async function aiWrite(prompt: string, apiKey: string): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system: FORGE_EXECUTE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) {
    console.warn("Anthropic API error:", resp.status, await resp.text());
    return "";
  }
  const data = await resp.json();
  return data?.content?.[0]?.text ?? "";
}

async function storeNote(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  title: string,
  content: string,
): Promise<string | null> {
  const headers: Record<string, string> = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  const resp = await fetch(`${supabaseUrl}/rest/v1/research_notes`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      user_id: userId,
      note_type: "research",
      symbol: "INCOME_PLAY",
      title,
      content,
      synced_to_obsidian: false,
    }),
  });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return rows?.[0]?.id ?? null;
}

async function createPlay(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  playType: string,
  title: string,
  description: string,
  legalBasis: string,
): Promise<string | null> {
  const headers: Record<string, string> = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  const resp = await fetch(`${supabaseUrl}/rest/v1/atlas_plays`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      user_id: userId,
      play_type: playType,
      title,
      description,
      status: "active",
      source: "atlas_autonomous",
      legal_basis: legalBasis || "Standard commerce",
    }),
  });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return rows?.[0]?.id ?? null;
}

async function logAction(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  signalId: string,
  playId: string | null,
  actionType: string,
  detail: object,
  result: string,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/atlas_execution_log`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      signal_id: signalId,
      play_id: playId,
      action_type: actionType,
      action_detail: detail,
      result,
    }),
  });
}

async function fireAlert(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  message: string,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/forge_alerts`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      signal_type: "atlas_execution",
      message,
    }),
  });
}

async function updateSignal(
  supabaseUrl: string,
  serviceKey: string,
  signalId: string,
  patch: object,
): Promise<void> {
  await fetch(
    `${supabaseUrl}/rest/v1/atlas_opportunity_signals?id=eq.${signalId}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(patch),
    },
  );
}

// ─── play type handlers ──────────────────────────────────────────────────────

async function executeContent(
  signal: any,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
): Promise<string> {
  const written = await aiWrite(
    `Write a complete, high-quality, immediately usable piece of content based on this income strategy:\n\n` +
      `Strategy: ${signal.extracted_logic}\n` +
      `Target audience: ${signal.target_audience ?? "general"}\n\n` +
      `Deliver the full content — article, script, template, or guide as appropriate. Make it genuinely useful and sellable. Include a headline, body, and a clear call to action.`,
    apiKey,
  );

  const noteId = await storeNote(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    signal.raw_title,
    written,
  );
  const playId = await createPlay(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    "content",
    signal.raw_title,
    signal.extracted_logic,
    signal.legal_basis ?? "Content creation",
  );

  await logAction(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    signal.id,
    playId,
    "content_written",
    { note_id: noteId, word_count: written.split(" ").length },
    "Content created and stored in Vault",
  );
  await fireAlert(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    `Atlas executed: "${signal.raw_title}" — content play written and stored in Vault. Ready to publish or sell.`,
  );

  return playId ?? "";
}

async function executeServiceOffer(
  signal: any,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
): Promise<string> {
  const offer = await aiWrite(
    `Create a complete, ready-to-sell service offering based on this strategy:\n\n` +
      `Strategy: ${signal.extracted_logic}\n` +
      `Target audience: ${signal.target_audience ?? "small businesses"}\n\n` +
      `Deliver:\n` +
      `1. SERVICE DESCRIPTION — what you do, who it's for, the transformation they get\n` +
      `2. PRICING STRUCTURE — Entry ($), Standard ($$), Premium ($$$) with realistic prices and what each includes\n` +
      `3. FULFILLMENT PROCESS — exactly how you deliver this in 3-5 steps\n` +
      `4. OUTREACH SCRIPT — what to say to potential clients in a cold message (from an identified business, transparent sender, no deception)\n` +
      `5. FIRST 3 CLIENTS — where to find the first three paying clients this week`,
    apiKey,
  );

  const noteId = await storeNote(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    `SERVICE OFFER: ${signal.raw_title}`,
    offer,
  );
  const playId = await createPlay(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    "service_offer",
    signal.raw_title,
    signal.extracted_logic,
    signal.legal_basis ?? "Service commerce",
  );

  await logAction(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    signal.id,
    playId,
    "service_offer_created",
    { note_id: noteId },
    "Full service offer with pricing and outreach script created",
  );
  await logAction(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    signal.id,
    playId,
    "outreach_staged",
    {},
    "Outreach script staged in service offer document",
  );
  await fireAlert(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    `Atlas built a service offer: "${signal.raw_title}" — pricing, delivery process, and outreach script ready in Vault. Check it and start sending.`,
  );

  return playId ?? "";
}

async function executeAutomation(
  signal: any,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
): Promise<string> {
  const spec = await aiWrite(
    `Build a complete technical specification for this automation opportunity:\n\n` +
      `Opportunity: ${signal.extracted_logic}\n` +
      `Target audience: ${signal.target_audience ?? "businesses"}\n\n` +
      `Deliver:\n` +
      `1. WHAT IT DOES — clear description of the automation and the problem it solves\n` +
      `2. TECH STACK — exact APIs, tools, and services needed (be specific: which API, which plan, estimated cost)\n` +
      `3. BUILD SEQUENCE — step-by-step what to build first through launch, in order of priority\n` +
      `4. TIME & COST ESTIMATE — realistic hours to build, ongoing monthly cost to run\n` +
      `5. REVENUE MODEL — how it makes money, pricing, and projected monthly yield\n` +
      `6. FIRST MOVE — the single action to take in the next 2 hours to start`,
    apiKey,
  );

  const noteId = await storeNote(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    `AUTOMATION SPEC: ${signal.raw_title}`,
    spec,
  );
  const playId = await createPlay(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    "automation",
    signal.raw_title,
    signal.extracted_logic,
    signal.legal_basis ?? "Software automation",
  );

  await logAction(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    signal.id,
    playId,
    "automation_spec_created",
    { note_id: noteId },
    "Full automation spec created with build sequence and revenue model",
  );
  await fireAlert(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    `Atlas designed an automation play: "${signal.raw_title}" — full tech spec, build sequence, and revenue model in Vault.`,
  );

  return playId ?? "";
}

async function executeResearch(
  signal: any,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
): Promise<string> {
  const brief = await aiWrite(
    `Compile a complete, actionable research brief on this opportunity:\n\n` +
      `Opportunity: ${signal.extracted_logic}\n\n` +
      `Deliver:\n` +
      `1. MARKET REALITY — actual market size, who's in it, and what they're earning (be concrete, not vague)\n` +
      `2. WHO'S ALREADY WINNING — 3 examples of people/businesses executing this right now and how\n` +
      `3. ENTRY STRATEGY — the fastest realistic path from zero to first dollar in this market\n` +
      `4. RISK FACTORS — the 3 most likely ways this fails and how to mitigate each\n` +
      `5. FIRST 3 MOVES — specific actions for the next 72 hours to validate this opportunity`,
    apiKey,
  );

  const noteId = await storeNote(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    `RESEARCH: ${signal.raw_title}`,
    brief,
  );
  const playId = await createPlay(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    "research",
    signal.raw_title,
    signal.extracted_logic,
    signal.legal_basis ?? "Market research",
  );

  await logAction(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    signal.id,
    playId,
    "research_packaged",
    { note_id: noteId },
    "Full market research brief compiled and stored",
  );
  await fireAlert(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    `Atlas researched: "${signal.raw_title}" — market analysis, entry strategy, and first moves in Vault.`,
  );

  return playId ?? "";
}

async function executeTrade(
  signal: any,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
): Promise<string> {
  // Parse trade details from execution_plan
  const planJson = extractJson<any>(signal.execution_plan ?? "{}");
  const symbol = planJson?.symbol ?? "SPY";
  const direction = planJson?.direction ?? "long";
  const quantity = planJson?.quantity ?? 1;
  const entryPrice = planJson?.entry_price ?? 0;
  const broker = planJson?.broker ?? "alpaca";
  const assetClass = planJson?.asset_class ?? "equity";

  const tradeResp = await fetch(
    `${supabaseUrl}/functions/v1/atlas_execute_trade`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: signal.user_id,
        symbol,
        asset_class: assetClass,
        direction,
        entry_price: entryPrice,
        quantity,
        broker,
        thesis: signal.extracted_logic,
      }),
    },
  );

  const tradeResult = tradeResp.ok ? await tradeResp.json() : { status: "error" };
  const playId = await createPlay(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    "trade",
    signal.raw_title,
    signal.extracted_logic,
    signal.legal_basis ?? "Market trading",
  );

  await logAction(
    supabaseUrl,
    serviceKey,
    signal.user_id,
    signal.id,
    playId,
    "trade_executed",
    { symbol, direction, quantity, broker, result: tradeResult },
    tradeResult.status === "blocked"
      ? `Trade blocked: ${tradeResult.reason}`
      : `Trade submitted: ${direction} ${quantity} ${symbol} via ${broker}`,
  );

  return playId ?? "";
}

// ─── main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const SUPABASE_URL = parseEnv("SUPABASE_URL");
  const SERVICE_KEY = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
  const API_KEY = parseEnv("ANTHROPIC_API_KEY");

  // Internal only — service role auth
  const auth = req.headers.get("Authorization");
  if (auth !== `Bearer ${SERVICE_KEY}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { signal_id, user_id, execution_plan } = await req.json();
    if (!signal_id || !user_id) {
      return new Response(JSON.stringify({ error: "signal_id and user_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch signal
    const sigResp = await fetch(
      `${SUPABASE_URL}/rest/v1/atlas_opportunity_signals?id=eq.${signal_id}&limit=1`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
      },
    );
    const signals = sigResp.ok ? await sigResp.json() : [];
    const signal = signals?.[0];
    if (!signal) {
      return new Response(JSON.stringify({ error: "Signal not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Patch execution_plan if provided
    if (execution_plan && !signal.execution_plan) {
      signal.execution_plan = execution_plan;
    }

    // Mark as executing
    await updateSignal(SUPABASE_URL, SERVICE_KEY, signal_id, {
      status: "executing",
    });

    let playId = "";
    const playType = signal.play_type ?? "research";

    try {
      if (playType === "content") {
        playId = await executeContent(signal, SUPABASE_URL, SERVICE_KEY, API_KEY);
      } else if (playType === "service_offer") {
        playId = await executeServiceOffer(signal, SUPABASE_URL, SERVICE_KEY, API_KEY);
      } else if (playType === "automation") {
        playId = await executeAutomation(signal, SUPABASE_URL, SERVICE_KEY, API_KEY);
      } else if (playType === "trade" || playType === "arbitrage") {
        playId = await executeTrade(signal, SUPABASE_URL, SERVICE_KEY, API_KEY);
      } else {
        // research or unknown — default to research brief
        playId = await executeResearch(signal, SUPABASE_URL, SERVICE_KEY, API_KEY);
      }

      await updateSignal(SUPABASE_URL, SERVICE_KEY, signal_id, {
        status: "completed",
        play_id: playId || null,
        executed_at: new Date().toISOString(),
      });

      return new Response(
        JSON.stringify({ status: "completed", play_type: playType, play_id: playId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (execErr) {
      const msg = execErr instanceof Error ? execErr.message : String(execErr);
      await updateSignal(SUPABASE_URL, SERVICE_KEY, signal_id, {
        status: "failed",
      });
      await fireAlert(
        SUPABASE_URL,
        SERVICE_KEY,
        signal.user_id,
        `Atlas execution failed for "${signal.raw_title}": ${msg}`,
      );
      throw execErr;
    }
  } catch (e) {
    console.error("forge_execute error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
