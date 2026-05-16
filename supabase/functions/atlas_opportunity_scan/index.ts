// Atlas Opportunity Scan — Phase 6
// Scans Reddit, SSRN, and other financial communities for actionable arbitrage plays.
// Runs on cron (system-level, no user auth needed).

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

    const subreddits = ["churning", "personalfinance", "investing"];
    const [churn, pf, inv, ssrnCandidates] = await Promise.all([
      fetchSubreddit(subreddits[0]),
      fetchSubreddit(subreddits[1]),
      fetchSubreddit(subreddits[2]),
      fetchSSRN(),
    ]);

    const allCandidates: Candidate[] = [
      ...churn,
      ...pf,
      ...inv,
      ...ssrnCandidates,
    ].slice(0, 20);

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
        // Insert into atlas_tasks
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

    return new Response(
      JSON.stringify({
        candidates_scanned: allCandidates.length,
        promoted,
        monitoring,
        rejected,
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
