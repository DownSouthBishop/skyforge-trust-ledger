// linda-prospect-intake — turns pasted prospect text (LinkedIn search results, Google Maps
// listings, directory pages, referral notes — anything free to gather by hand) into
// qualified linda_leads/linda_companies/linda_contacts rows, and drafts first-touch cold
// email for the ones that clear the fit bar. Drafts land in linda_responses as
// pending_approval, same review flow as everything else Linda writes — nothing sends
// without the operator approving it in Linda's Inbox.

import { corsHeaders, verifyUser, AuthError, callGatewayWithRetry } from "../_shared/gateway.ts";

const MAX_PROSPECTS_PER_RUN = 15;
const MAX_DRAFTS_PER_RUN = 8;

const PARSE_SYSTEM = `You are Linda — Chief of Staff for WIG (Watkins Investment Group), extracting sales prospects from raw pasted text (LinkedIn search results, Google Maps listings, directory pages, referral notes, etc.).

Return ONLY a JSON array (no prose, no markdown fences) of prospect objects:
[{
  "company_name": "...",
  "website": "..." or null,
  "industry": "..." or null,
  "location": "..." or null,
  "contact_name": "..." or null,
  "contact_title": "..." or null,
  "contact_email": "..." or null,
  "contact_phone": "..." or null,
  "linkedin_url": "..." or null,
  "notes": "one-line synthesis of anything relevant",
  "fit_score": 0.0 to 1.0,
  "fit_reason": "one sentence on why this is or isn't a good fit given the ICP"
}]

Skip entries with no company_name. Keep contact fields null if the text doesn't provide them — never invent an email address. Be conservative with fit_score: only score above 0.6 when there's a clear, specific signal of fit, not generic plausibility.`;

const DRAFT_SYSTEM = `You are Linda — Chief of Staff for WIG (Watkins Investment Group), writing a first-touch cold email. Follow this framework exactly:

SUBJECT LINE: reference the specific fit signal from "Why they fit" or "Notes" — never generic ("Quick question", "Partnership opportunity"). If nothing specific is available, reference their industry or role instead of a generic hook.

OPENING LINE: one sentence proving you looked at this specific company/contact — pull from the notes or industry, not a template. Do NOT use "I hope this email finds you well" or any variant.

BODY: 2-3 sentences max. State the relevant WIG/Skyforge offering in terms of the outcome it produces for THEM, not a feature list. No links, no attachments, no "check out our website."

CTA: exactly one clear, low-friction ask — a single yes/no question (e.g. "Worth a 15-minute call next week?" or "Should I send over how this would work for [specific thing]?"). Never end with a vague "let me know your thoughts" or "happy to discuss further."

Total length: 3-5 sentences. Warm, direct, zero salesy language.

Format:
SUBJECT: [subject line]
---
[email body]`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

    let userId: string;
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof AuthError ? e.message : "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { raw_text, service_requested } = await req.json().catch(() => ({}));
    if (!raw_text || String(raw_text).trim().length < 20) {
      return new Response(JSON.stringify({ error: "raw_text required — paste in prospect info (company names, contacts, notes)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

    const icpRes = await fetch(
      `${SUPABASE_URL}/rest/v1/linda_icp?user_id=eq.${userId}&is_active=eq.true&select=name,criteria&limit=3`,
      { headers: h },
    );
    const icps = icpRes.ok ? (await icpRes.json() as any[]) : [];
    const icpContext = icps.length
      ? `Active ICP(s):\n${icps.map((i: any) => `- ${i.name}: ${JSON.stringify(i.criteria)}`).join("\n")}`
      : "No ICP defined yet — use general judgment on fit for a WIG/Skyforge AI-services or marine-construction client.";

    const parseResp = await callGatewayWithRetry({
      max_tokens: 3000,
      messages: [
        { role: "system", content: PARSE_SYSTEM },
        { role: "user", content: `${icpContext}\n\nRAW TEXT:\n---\n${String(raw_text).slice(0, 12000)}\n---\n\nExtract prospects as a JSON array.` },
      ],
    }, "");

    let prospects: any[] = [];
    if (parseResp.ok) {
      const data = await parseResp.json();
      const raw: string = data?.choices?.[0]?.message?.content ?? "[]";
      try {
        const m = raw.match(/\[[\s\S]*\]/);
        if (m) prospects = JSON.parse(m[0]);
      } catch { /* leave empty */ }
    }

    prospects = prospects.filter((p) => p?.company_name).slice(0, MAX_PROSPECTS_PER_RUN);

    if (!prospects.length) {
      return new Response(
        JSON.stringify({ ok: true, companies_created: 0, leads_created: 0, drafts_queued: 0, message: "No prospects could be extracted from the pasted text." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const existingRes = await fetch(`${SUPABASE_URL}/rest/v1/linda_companies?user_id=eq.${userId}&select=name`, { headers: h });
    const existingNames = new Set(
      (existingRes.ok ? (await existingRes.json() as any[]) : []).map((c: any) => String(c.name).toLowerCase().trim()),
    );

    let companiesCreated = 0, leadsCreated = 0, draftsQueued = 0;
    const draftedNames: string[] = [];

    for (const p of prospects) {
      const nameKey = String(p.company_name).toLowerCase().trim();
      if (existingNames.has(nameKey)) continue;
      existingNames.add(nameKey);

      const fitScore = typeof p.fit_score === "number" ? Math.max(0, Math.min(1, p.fit_score)) : 0.5;
      const priority = fitScore >= 0.7 ? "hot" : fitScore >= 0.4 ? "normal" : "cold";

      const leadInsertRes = await fetch(`${SUPABASE_URL}/rest/v1/linda_leads`, {
        method: "POST", headers: { ...h, Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: userId,
          full_name: p.contact_name || p.company_name,
          business_name: p.company_name,
          email: p.contact_email || null,
          phone: p.contact_phone || null,
          city_region: p.location || null,
          service_requested: service_requested ?? "other",
          notes: p.notes || null,
          source: "prospecting_intake",
          status: "new",
          priority,
          linda_notes: p.fit_reason || null,
          linda_confidence: fitScore,
        }),
      });
      if (!leadInsertRes.ok) continue;
      const [leadRow] = await leadInsertRes.json() as any[];
      leadsCreated++;

      await fetch(`${SUPABASE_URL}/rest/v1/linda_companies`, {
        method: "POST", headers: { ...h, Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id: userId, lead_id: leadRow.id,
          name: p.company_name, website: p.website || null, industry: p.industry || null,
          hq_location: p.location || null, description: p.notes || null,
          source_notes: "Imported via prospecting intake", researched_at: new Date().toISOString(),
        }),
      });
      companiesCreated++;

      if (p.contact_name) {
        await fetch(`${SUPABASE_URL}/rest/v1/linda_contacts`, {
          method: "POST", headers: { ...h, Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id: userId, lead_id: leadRow.id,
            full_name: p.contact_name, title: p.contact_title || null,
            email: p.contact_email || null, phone: p.contact_phone || null,
            linkedin_url: p.linkedin_url || null,
          }),
        });
      }

      if (fitScore >= 0.5 && p.contact_email && draftsQueued < MAX_DRAFTS_PER_RUN) {
        const draftResp = await callGatewayWithRetry({
          max_tokens: 400,
          messages: [
            { role: "system", content: DRAFT_SYSTEM },
            { role: "user", content: `PROSPECT:\nCompany: ${p.company_name}\nContact: ${p.contact_name ?? "unknown"}${p.contact_title ? ` (${p.contact_title})` : ""}\nIndustry: ${p.industry ?? "unknown"}\nWhy they fit: ${p.fit_reason ?? "general prospecting"}\nNotes: ${p.notes ?? "none"}\n\nWrite the first-touch email.` },
          ],
        }, "");
        if (draftResp.ok) {
          const dData = await draftResp.json();
          const draft: string = dData?.choices?.[0]?.message?.content ?? "";
          const subjectMatch = draft.match(/^SUBJECT:\s*(.+)/m);
          const subject = subjectMatch ? subjectMatch[1].trim() : `Quick question for ${p.company_name}`;
          const bodyStart = draft.indexOf("---");
          const emailBody = bodyStart !== -1 ? draft.slice(bodyStart + 3).trim() : draft;
          if (emailBody && emailBody.length > 20) {
            const respInsert = await fetch(`${SUPABASE_URL}/rest/v1/linda_responses`, {
              method: "POST", headers: { ...h, Prefer: "return=minimal" },
              body: JSON.stringify({
                user_id: userId, lead_id: leadRow.id, channel: "email",
                subject, body: emailBody, status: "pending_approval", linda_confidence: fitScore,
              }),
            });
            if (respInsert.ok) { draftsQueued++; draftedNames.push(p.company_name); }
          }
        }
      }
    }

    await fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, {
      method: "POST", headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId, source_agent: "linda",
        summary: `Prospecting intake: ${leadsCreated} new lead(s), ${draftsQueued} cold-email draft(s) queued for approval.`,
        topic: "prospecting_intake",
      }),
    }).catch(() => {});

    if (BOT_TOKEN && CHAT_ID && draftsQueued > 0) {
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: `👁 *Linda — Prospecting*\n\n${leadsCreated} new lead(s) added, ${draftsQueued} cold-email draft(s) ready:\n${draftedNames.slice(0, 5).map((n) => `• ${n}`).join("\n")}\n\nReview in Linda's Inbox.`,
          parse_mode: "Markdown",
        }),
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({ ok: true, companies_created: companiesCreated, leads_created: leadsCreated, drafts_queued: draftsQueued }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[linda-prospect-intake]", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
