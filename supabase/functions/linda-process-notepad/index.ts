// Linda marine notepad processor
// Triggered by POST with a notepad_id
// Reads raw contractor submission → extracts structured data
// → updates marine tables + contractor weekly digest

import { corsHeaders, parseEnv, verifyUser, AuthError } from "../_shared/gateway.ts";

const serve = (Deno as any).serve ?? ((handler: (r: Request) => Response | Promise<Response>) => {
  (globalThis as any).addEventListener("fetch", (event: any) => {
    event.respondWith(handler(event.request));
  });
});

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { supabase, anthropicKey } = parseEnv();
    const user = await verifyUser(req, supabase);
    const { notepad_id } = await req.json();

    if (!notepad_id) {
      return new Response(JSON.stringify({ error: "notepad_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    // 1. Load the notepad entry
    const { data: notepad, error: npErr } = await supabase
      .from("marine_notepad")
      .select("*, marine_contractors(company_name, owner_name)")
      .eq("id", notepad_id)
      .single();

    if (npErr || !notepad) {
      return new Response(JSON.stringify({ error: "Notepad entry not found" }), {
        status: 404,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    if (notepad.processed) {
      return new Response(JSON.stringify({ already_processed: true }), {
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    // 2. Load Linda
    const { data: lindaAgent } = await supabase
      .from("skyforge_agents")
      .select("id, system_prompt")
      .eq("slug", "linda")
      .eq("user_id", user.id)
      .single();

    // 3. Load active jobs for context
    const { data: activeJobs } = await supabase
      .from("marine_jobs")
      .select("id, job_name, job_type, status, start_date, estimated_end")
      .eq("contractor_id", notepad.contractor_id)
      .in("status", ["scheduled", "in_progress"]);

    const processingPrompt = `You are processing a weekly notepad submission from a marine construction contractor.

Contractor: ${(notepad.marine_contractors as any)?.company_name} (${(notepad.marine_contractors as any)?.owner_name})
Submission type: ${notepad.submission_type}
Active jobs: ${JSON.stringify(activeJobs ?? [], null, 2)}

Raw submission:
---
${notepad.raw_content}
---

Extract and return a JSON object with:
{
  "job_updates": [
    {
      "job_identifier": "<job name or description from their text>",
      "status_update": "scheduled" | "in_progress" | "completed" | "paused",
      "notes": "<what happened on this job>",
      "issues": "<any problems flagged>",
      "milestone_hit": true | false
    }
  ],
  "new_leads": [
    {
      "customer_name": "<name if given>",
      "location": "<location if given>",
      "job_type": "dock" | "seawall" | "boatlift" | "combo" | "other",
      "notes": "<what they need>"
    }
  ],
  "trouble_tickets": [
    {
      "type": "materials_delay" | "permit_issue" | "weather" | "crew" | "payment" | "other",
      "description": "<what the problem is>",
      "severity": "low" | "medium" | "high"
    }
  ],
  "service_requests": ["<any service or support requests>"],
  "digest_summary": "<2-3 sentence plain English summary of this week for the weekly digest>",
  "status_color": "green" | "yellow" | "red"
}`;

    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01", "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000, tools: [{ type: "web_search_20250305", name: "web_search" }], 
        system: lindaAgent?.system_prompt ?? "You are a marine construction operations processor.",
        messages: [{ role: "user", content: processingPrompt }],
      }),
    });

    let structured: any = {};
    if (aiResp.ok) {
      const aiData = await aiResp.json();
      const raw = aiData.content?.[0]?.text ?? "{}";
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) structured = JSON.parse(jsonMatch[0]);
      } catch { /* use empty */ }
    }

    // 4. Mark notepad as processed
    await supabase
      .from("marine_notepad")
      .update({
        processed: true,
        processed_at: new Date().toISOString(),
        agent_output: structured,
        week_of: notepad.week_of ?? new Date().toISOString().split("T")[0],
      })
      .eq("id", notepad_id);

    // 5. Create new leads found
    for (const lead of structured.new_leads ?? []) {
      if (lead.customer_name) {
        await supabase.from("marine_leads").insert({
          contractor_id: notepad.contractor_id,
          customer_name: lead.customer_name,
          customer_address: lead.location,
          job_type: lead.job_type ?? "other",
          notes: lead.notes,
          status: "new",
          priority: "warm",
        });
      }
    }

    // 6. Update job statuses
    for (const update of structured.job_updates ?? []) {
      if (!update.job_identifier) continue;
      const matchedJob = (activeJobs ?? []).find((j: any) =>
        j.job_name?.toLowerCase().includes(update.job_identifier.toLowerCase()),
      );
      if (matchedJob) {
        await supabase
          .from("marine_jobs")
          .update({
            status: update.status_update,
            notes: update.notes,
            updated_at: new Date().toISOString(),
          })
          .eq("id", matchedJob.id);
      }
    }

    // 7. Upsert weekly digest
    const weekOf = notepad.week_of ?? new Date().toISOString().split("T")[0];
    await supabase
      .from("marine_weekly_digest")
      .upsert(
        {
          contractor_id: notepad.contractor_id,
          week_of: weekOf,
          jobs_section: structured.job_updates ?? [],
          leads_section: structured.new_leads ?? [],
          status_overall: structured.status_color ?? "green",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "contractor_id,week_of" },
      );

    return new Response(
      JSON.stringify({
        processed: true,
        leads_created: (structured.new_leads ?? []).filter((l: any) => l.customer_name).length,
        jobs_updated: (structured.job_updates ?? []).length,
        trouble_tickets: (structured.trouble_tickets ?? []).length,
        status_color: structured.status_color ?? "green",
      }),
      { headers: { ...corsHeaders, "content-type": "application/json" } },
    );

  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 401,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
});
