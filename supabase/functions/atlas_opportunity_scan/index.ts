// Atlas Opportunity Scan — Phase 7
// Scans Reddit, SSRN, and business/income communities for actionable plays.
// Runs on cron every 12 hours. Promotes plays to forge_execute for autonomous action.

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

interface Candidate {
  title: string;
  score: number;
  url: string;
  text: string;
  source: string;
}

interface RelevanceItem {
  title: string;
  relevance_score: number;
  opportunity_type: string;
}

interface EvaluationResult {
  legality: number;
  feasibility: number;
  roi_estimate: number;
  repeatability: number;
  time_cost: number;
  legal_basis: string;
  play_type: string;
  verdict: "PROMOTE" | "MONITOR" | "REJECT";
  rationale: string;
  execution_plan?: string;
  expected_yield_usd?: number;
}

interface BusinessEvalResult {
  feasibility: number;
  time_to_prod_hours: number;
  liquidity_window_hrs: number;
  marginal_cost_est: number;
  expected_yield_usd: number;
  play_type: string;
  legal_basis: string;
  target_audience: string;
  extracted_logic: string;
  execution_plan: string;
  verdict: "PROMOTE" | "MONITOR" | "REJECT";
  rationale: string;
}

async function fetchSubreddit(sub: string): Promise<Candidate[]> {
  try {
    const res = await fetch(
      `https://www.reddit.com/r/${sub}/top.json?t=day&limit=25`,
      { headers: { "User-Agent": "AtlasBot/1.0" } },
    );
    if (!res.ok) return [];
    const data = await res.json();
    const children: unknown[] = data?.data?.children ?? [];
    const results: Candidate[] = [];
    for (const child of children) {
      const post = (child as { data: Record<string, unknown> }).data;
      const score = Number(post.score ?? 0);
      if (score > 100) {
        results.push({
          title: String(post.title ?? ""),
          score,
          url: String(post.url ?? ""),
          text: String(post.selftext ?? "").slice(0, 500),
          source: `r/${sub}`,
        });
      }
    }
    return results;
  } catch (e) {
    console.warn(`Reddit fetch failed for r/${sub}:`, e);
    return [];
  }
}

async function fetchSSRN(): Promise<Candidate[]> {
  try {
    const res = await fetch(
      "https://papers.ssrn.com/sol3/topten/topTenResults.cfm?npage=1&subjectGroupCode=19",
    );
    if (!res.ok) return [];
    const text = await res.text();
    // Return raw text as a single candidate for AI parsing
    return [{
      title: "SSRN Top Finance Papers",
      score: 999,
      url: "https://papers.ssrn.com/sol3/topten/topTenResults.cfm?npage=1&subjectGroupCode=19",
      text: text.slice(0, 2000),
      source: "SSRN",
    }];
  } catch (e) {
    console.warn("SSRN fetch failed:", e);
    return [];
  }
}

function extractJson<T>(text: string): T | null {
  // Try to extract JSON from markdown code blocks first, then bare JSON
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    // Try to find the first [ or { and parse from there
    const arrStart = jsonText.indexOf("[");
    const objStart = jsonText.indexOf("{");
    const start = arrStart !== -1 && (objStart === -1 || arrStart < objStart)
      ? arrStart
      : objStart;
    if (start !== -1) {
      try {
        return JSON.parse(jsonText.slice(start)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const GATEWAY_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? Deno.env.get("GATEWAY_API_KEY");
    if (!GATEWAY_KEY) {
      console.warn("No AI gateway key found — opportunity scan unavailable");
      return new Response(
        JSON.stringify({ status: "ok", message: "AI gateway key not configured" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const fastModel  = modelEnv("FAST_MODEL",  "google/gemini-2.5-flash");
    const atlasModel = modelEnv("ATLAS_MODEL", "openai/gpt-4o");

    // ── 1. Source scanning ───────────────────────────────────────────────────

    // ── 1a. Financial arbitrage sources (existing) ───────────────────────────
    const [churn, pf, inv, ssrnCandidates] = await Promise.all([
      fetchSubreddit("churning"),
      fetchSubreddit("personalfinance"),
      fetchSubreddit("investing"),
      fetchSSRN(),
    ]);

    // ── 1b. Viral income / business model sources (new) ──────────────────────
    const [ent, side, passive, dm, freelance] = await Promise.all([
      fetchSubreddit("entrepreneur"),
      fetchSubreddit("sidehustle"),
      fetchSubreddit("passive_income"),
      fetchSubreddit("digitalmarketing"),
      fetchSubreddit("freelance"),
    ]);

    const financeCandidates: Candidate[] = [
      ...churn,
      ...pf,
      ...inv,
      ...ssrnCandidates,
    ].slice(0, 20);

    const businessCandidates: Candidate[] = [
      ...ent,
      ...side,
      ...passive,
      ...dm,
      ...freelance,
    ].slice(0, 25);

    const allCandidates: Candidate[] = financeCandidates;

    if (allCandidates.length === 0) {
      return new Response(
        JSON.stringify({ candidates_scanned: 0, promoted: 0, monitoring: 0, rejected: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 2. AI relevance filter ───────────────────────────────────────────────

    const relevancePrompt =
      `Below are recent posts and papers from financial communities. For each item, rate 1-5 its relevance to: legal financial arbitrage, yield optimization, bonus stacking, rate spread opportunities, market structure inefficiencies. Return JSON array: [{title, relevance_score, opportunity_type}]. Only include items with relevance_score >= 3. Items:\n${allCandidates.map((c) => c.title).join("\n")}`;

    const relevanceResp = await callGatewayWithRetry(
      {
        model: fastModel,
        messages: [{ role: "user", content: relevancePrompt }],
        temperature: 0.2,
      },
      GATEWAY_KEY,
    );

    let relevantItems: RelevanceItem[] = [];
    if (relevanceResp.ok) {
      const relevanceData = await relevanceResp.json();
      const rawContent: string = relevanceData?.choices?.[0]?.message?.content ?? "";
      relevantItems = extractJson<RelevanceItem[]>(rawContent) ?? [];
    } else {
      console.warn("Relevance filter AI call failed:", relevanceResp.status);
    }

    // Map back to full candidate objects (up to 10)
    const itemsToEvaluate = relevantItems.slice(0, 10).map((item) => {
      const match = allCandidates.find((c) => c.title === item.title) ?? {
        title: item.title,
        score: 0,
        url: "",
        text: "",
        source: "unknown",
      };
      return { ...match, opportunity_type: item.opportunity_type };
    });

    // ── 3. Evaluation pass ───────────────────────────────────────────────────

    let promoted  = 0;
    let monitoring = 0;
    let rejected  = 0;

    for (const item of itemsToEvaluate) {
      const evalPrompt =
        `Evaluate this financial opportunity for a retail/small institutional trader:\n\nTitle: ${item.title}\nSource: ${item.source}\nDescription: ${item.text}\n\nScore on:\n- legality: Is this clearly legal and publicly documented? (1-10, must cite the legal basis)\n- feasibility: Can this be executed with standard brokerage/bank accounts? (1-10)\n- roi_estimate: What is a realistic annualized ROI %? (number)\n- repeatability: Can this be repeated multiple times? (1-10)\n- time_cost: Hours of active management per execution? (number)\n\nReturn JSON only:\n{\n  "legality": number,\n  "feasibility": number,\n  "roi_estimate": number,\n  "repeatability": number,\n  "time_cost": number,\n  "legal_basis": "description of legal basis",\n  "verdict": "PROMOTE" | "MONITOR" | "REJECT",\n  "rationale": "one sentence"\n}`;

      let evaluation: EvaluationResult | null = null;
      try {
        const evalResp = await callGatewayWithRetry(
          {
            model: atlasModel,
            messages: [{ role: "user", content: evalPrompt }],
            temperature: 0.1,
          },
          GATEWAY_KEY,
        );
        if (evalResp.ok) {
          const evalData = await evalResp.json();
          const rawContent: string = evalData?.choices?.[0]?.message?.content ?? "";
          evaluation = extractJson<EvaluationResult>(rawContent);
        }
      } catch (e) {
        console.warn(`Evaluation failed for "${item.title}":`, e);
      }

      if (!evaluation) continue;

      // Apply legality override
      if (evaluation.legality < 7) {
        evaluation.verdict = "MONITOR";
        evaluation.rationale = "Legal basis insufficient for active play.";
      }

      const taskPayload = {
        title: item.title,
        source: item.source,
        url: item.url,
        opportunity_type: item.opportunity_type,
        legality: evaluation.legality,
        feasibility: evaluation.feasibility,
        roi_estimate: evaluation.roi_estimate,
        repeatability: evaluation.repeatability,
        time_cost: evaluation.time_cost,
        legal_basis: evaluation.legal_basis,
        rationale: evaluation.rationale,
      };

      const authHeaders: Record<string, string> = {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      };

      if (evaluation.verdict === "PROMOTE") {
        // Insert into atlas_tasks (existing behavior)
        await fetch(`${SUPABASE_URL}/rest/v1/atlas_tasks`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            user_id: "00000000-0000-0000-0000-000000000000",
            task_type: "opportunity_candidate",
            status: "active",
            payload: taskPayload,
          }),
        });

        // Insert into research_notes
        await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            user_id: "00000000-0000-0000-0000-000000000000",
            note_type: "research",
            symbol: "OPPORTUNITY",
            title: item.title,
            content: JSON.stringify(evaluation, null, 2),
            synced_to_obsidian: false,
          }),
        });

        await sendTelegramAlert(
          `*NEW PLAY DISCOVERED*\n${item.title}\nEstimated ROI: ${evaluation.roi_estimate}%\nSource: ${item.source}\nAtlas verdict: PROMOTED TO ACTIVE\n${evaluation.legal_basis}`,
        );
        promoted++;
      } else if (evaluation.verdict === "MONITOR") {
        await fetch(`${SUPABASE_URL}/rest/v1/atlas_tasks`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            user_id: "00000000-0000-0000-0000-000000000000",
            task_type: "opportunity_candidate",
            status: "monitoring",
            payload: taskPayload,
          }),
        });
        monitoring++;
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/atlas_tasks`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            user_id: "00000000-0000-0000-0000-000000000000",
            task_type: "opportunity_candidate",
            status: "rejected",
            payload: taskPayload,
          }),
        });
        rejected++;
      }
    }

    // ── 4. Business model / viral income pass ────────────────────────────────

    let businessPromoted = 0;

    if (businessCandidates.length > 0) {
      const bizRelevancePrompt =
        `Below are Reddit posts about entrepreneurship, side hustles, and income generation. ` +
        `For each, rate 1-5 how actionable it is as a business model that can be executed with AI tools, Claude, and web APIs. ` +
        `Strip all hype ("unethical", "loophole", "secret") and extract the actual business logic. ` +
        `Return JSON array: [{title, relevance_score, extracted_logic, play_type}] ` +
        `where play_type is one of: content | service_offer | automation | research | trade | arbitrage. ` +
        `Only include items with relevance_score >= 3.\n\nItems:\n` +
        businessCandidates.map((c) => `${c.title}: ${c.text.slice(0, 200)}`).join("\n\n");

      const bizRelevanceResp = await callGatewayWithRetry(
        { model: fastModel, messages: [{ role: "user", content: bizRelevancePrompt }], temperature: 0.2 },
        GATEWAY_KEY,
      );

      let bizItems: any[] = [];
      if (bizRelevanceResp.ok) {
        const data = await bizRelevanceResp.json();
        bizItems = extractJson<any[]>(data?.choices?.[0]?.message?.content ?? "") ?? [];
      }

      for (const bizItem of bizItems.slice(0, 8)) {
        const match = businessCandidates.find((c) => c.title === bizItem.title) ?? {
          title: bizItem.title, score: 0, url: "", text: "", source: "reddit",
        };

        const bizEvalPrompt =
          `Evaluate this business/income opportunity for autonomous execution by an AI agent:\n\n` +
          `Title: ${match.title}\nExtracted logic: ${bizItem.extracted_logic ?? match.text.slice(0, 300)}\n\n` +
          `Score and return JSON:\n` +
          `{\n` +
          `  "feasibility": 1-10 (can this be done with Claude + Supabase + web APIs?),\n` +
          `  "time_to_prod_hours": realistic hours to execute,\n` +
          `  "liquidity_window_hrs": hours until first payment possible,\n` +
          `  "marginal_cost_est": ongoing cost per unit in USD,\n` +
          `  "expected_yield_usd": realistic first-30-days yield,\n` +
          `  "play_type": "content" | "service_offer" | "automation" | "research" | "trade" | "arbitrage",\n` +
          `  "legal_basis": "why this is legal",\n` +
          `  "target_audience": "who pays",\n` +
          `  "extracted_logic": "the actual business model in 2 sentences",\n` +
          `  "execution_plan": "specific steps to execute autonomously",\n` +
          `  "verdict": "PROMOTE" | "MONITOR" | "REJECT",\n` +
          `  "rationale": "one sentence"\n` +
          `}`;

        let bizEval: BusinessEvalResult | null = null;
        try {
          const evalResp = await callGatewayWithRetry(
            { model: atlasModel, messages: [{ role: "user", content: bizEvalPrompt }], temperature: 0.1 },
            GATEWAY_KEY,
          );
          if (evalResp.ok) {
            const evalData = await evalResp.json();
            bizEval = extractJson<BusinessEvalResult>(evalData?.choices?.[0]?.message?.content ?? "");
          }
        } catch (e) {
          console.warn(`Business eval failed for "${match.title}":`, e);
        }

        if (!bizEval || bizEval.verdict !== "PROMOTE") continue;
        if (bizEval.feasibility < 6) continue;

        // Write to atlas_opportunity_signals and trigger forge_execute
        const sigResp = await fetch(`${SUPABASE_URL}/rest/v1/atlas_opportunity_signals`, {
          method: "POST",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            user_id: "00000000-0000-0000-0000-000000000000",
            raw_title: match.title,
            raw_source: match.source,
            source_url: match.url,
            extracted_logic: bizEval.extracted_logic ?? bizItem.extracted_logic ?? match.text.slice(0, 500),
            target_audience: bizEval.target_audience,
            play_type: bizEval.play_type,
            feasibility_score: bizEval.feasibility / 10,
            time_to_prod_hours: bizEval.time_to_prod_hours,
            liquidity_window_hrs: bizEval.liquidity_window_hrs,
            marginal_cost_est: bizEval.marginal_cost_est ?? 0,
            expected_yield_usd: bizEval.expected_yield_usd ?? 0,
            status: "approved",
            atlas_reasoning: bizEval.rationale,
            execution_plan: bizEval.execution_plan,
            evaluated_at: new Date().toISOString(),
          }),
        });

        if (sigResp.ok) {
          const signals = await sigResp.json();
          const signal = signals?.[0];
          if (signal?.id) {
            // Fire forge_execute — fully autonomous
            fetch(`${SUPABASE_URL}/functions/v1/forge_execute`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${SERVICE_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                signal_id: signal.id,
                user_id: "00000000-0000-0000-0000-000000000000",
                execution_plan: bizEval.execution_plan,
              }),
            }).catch((e) => console.warn("forge_execute trigger failed:", e));
          }
        }

        await sendTelegramAlert(
          `*ATLAS AUTONOMOUS PLAY*\n${match.title}\n` +
          `Type: ${bizEval.play_type} | Yield est: $${bizEval.expected_yield_usd}\n` +
          `${bizEval.rationale}\nExecuting now.`,
        );

        businessPromoted++;
      }
    }

    return new Response(
      JSON.stringify({
        candidates_scanned: allCandidates.length + businessCandidates.length,
        finance: { promoted, monitoring, rejected },
        business: { promoted: businessPromoted },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
