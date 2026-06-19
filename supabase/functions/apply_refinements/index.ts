// apply_refinements — closes the self-improve loop.
// Reads approved prompt_refinement dossier_suggestions (applied_at IS NULL),
// appends refinements to each agent's system_prompt, marks applied_at.
// Runs every 2 hours via pg_cron.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODEL = "gemini-2.5-flash";

async function gemini(apiKey: string, system: string, user: string, maxTokens = 1500): Promise<string> {
  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content ?? "";
  } catch { return ""; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_KEY") ?? "";
    const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

    const h = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    // Resolve operator via skyforge_agents
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyforge_agents?select=user_id&is_active=eq.true&limit=1`,
      { headers: h },
    );
    const agentRows = agentRes.ok ? (await agentRes.json() as any[]) : [];
    if (!agentRows.length) {
      return new Response(JSON.stringify({ ok: false, error: "No agents found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const uid = agentRows[0].user_id as string;

    // Fetch approved prompt_refinements that haven't been applied yet
    const refinementsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/dossier_suggestions?user_id=eq.${uid}&entry_type=eq.prompt_refinement&status=eq.approved&applied_at=is.null&select=id,agent_slug,title,context&order=created_at.asc&limit=10`,
      { headers: h },
    );
    const refinements = refinementsRes.ok ? (await refinementsRes.json() as any[]) : [];

    if (!refinements.length) {
      return new Response(
        JSON.stringify({ ok: true, applied: 0, message: "No approved refinements pending" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const applied: Array<{ agent: string; title: string }> = [];

    for (const suggestion of refinements) {
      try {
        const { id, agent_slug, title, context } = suggestion as {
          id: string;
          agent_slug: string;
          title: string;
          context: string;
        };

        // Fetch current system_prompt for this agent
        const agentDataRes = await fetch(
          `${SUPABASE_URL}/rest/v1/skyforge_agents?user_id=eq.${uid}&slug=eq.${agent_slug}&select=id,system_prompt&limit=1`,
          { headers: h },
        );
        const agentDataRows = agentDataRes.ok ? (await agentDataRes.json() as any[]) : [];
        if (!agentDataRows.length) continue;

        const { system_prompt } = agentDataRows[0] as { system_prompt: string };

        // Check if there's already a refinements block to update
        const REFINEMENTS_MARKER = "\n\n---\nLEARNED REFINEMENTS";
        const hasExistingBlock = system_prompt.includes(REFINEMENTS_MARKER);

        let updatedPrompt: string;

        if (GOOGLE_KEY) {
          // Use Gemini to surgically integrate refinements into existing prompt
          const MERGE_SYSTEM = `You are a system prompt editor for an AI agent.

Your job is to integrate proposed refinements into an existing system prompt WITHOUT:
- Changing the agent's core identity, voice, or personality
- Removing existing constraints or memory entries
- Rewriting sections that aren't being improved
- Adding filler or commentary

If the prompt already has a "LEARNED REFINEMENTS" section, replace it with the updated list.
If not, append a new "LEARNED REFINEMENTS" section at the very end.

The refinements section format:
---
LEARNED REFINEMENTS
Applied: ${new Date().toISOString().split("T")[0]}
[numbered list of refinements]
---

Return ONLY the complete updated system prompt. No explanation, no preamble.`;

          const MERGE_USER = `CURRENT SYSTEM PROMPT:
${system_prompt}

PROPOSED REFINEMENTS TO INTEGRATE:
${context}

Write the complete updated system prompt with refinements integrated.`;

          const merged = await gemini(GOOGLE_KEY, MERGE_SYSTEM, MERGE_USER, 2000);

          if (merged && merged.length > 100) {
            updatedPrompt = merged;
          } else {
            // Fallback: append refinements block
            const refinementBlock = `${REFINEMENTS_MARKER}\nApplied: ${new Date().toISOString().split("T")[0]}\n${context}\n---`;
            updatedPrompt = hasExistingBlock
              ? system_prompt.replace(/\n\n---\nLEARNED REFINEMENTS[\s\S]*?---/, refinementBlock)
              : system_prompt + refinementBlock;
          }
        } else {
          // No Gemini — append refinements block
          const refinementBlock = `${REFINEMENTS_MARKER}\nApplied: ${new Date().toISOString().split("T")[0]}\n${context}\n---`;
          updatedPrompt = hasExistingBlock
            ? system_prompt.replace(/\n\n---\nLEARNED REFINEMENTS[\s\S]*?---/, refinementBlock)
            : system_prompt + refinementBlock;
        }

        // Update the agent's system_prompt
        const updateRes = await fetch(
          `${SUPABASE_URL}/rest/v1/skyforge_agents?user_id=eq.${uid}&slug=eq.${agent_slug}`,
          {
            method: "PATCH",
            headers: { ...h, Prefer: "return=minimal" },
            body: JSON.stringify({ system_prompt: updatedPrompt, updated_at: new Date().toISOString() }),
          },
        );

        if (!updateRes.ok) continue;

        // Mark the suggestion as applied
        await fetch(
          `${SUPABASE_URL}/rest/v1/dossier_suggestions?id=eq.${id}`,
          {
            method: "PATCH",
            headers: { ...h, Prefer: "return=minimal" },
            body: JSON.stringify({ applied_at: new Date().toISOString() }),
          },
        );

        // Write to cross_memory
        await fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, {
          method: "POST",
          headers: { ...h, Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id: uid,
            source_agent: agent_slug,
            summary: `Self-improvement applied: system prompt updated from approved refinement "${title.slice(0, 80)}".`,
            topic: "self_improvement",
          }),
        });

        applied.push({ agent: agent_slug, title });

      } catch (e) {
        console.error(`[apply_refinements] error for suggestion ${suggestion.id}:`, e);
      }
    }

    // Telegram notification if anything was applied
    if (applied.length > 0 && BOT_TOKEN && CHAT_ID) {
      const lines = applied.map(a => `• *${a.agent.toUpperCase()}*: refinements applied`).join("\n");
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: `🧬 *Agent Self-Improvement Applied*\n\n${lines}\n\nSystem prompts updated. Refinements are now active.`,
          parse_mode: "Markdown",
        }),
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({ ok: true, applied: applied.length, agents: applied }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    console.error("[apply_refinements]", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
