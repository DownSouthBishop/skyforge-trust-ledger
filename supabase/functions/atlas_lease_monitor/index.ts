// Atlas Lease Monitor — monitors leases for renewals and overdue rent
// Phase 3B: runs daily at 08:30 UTC

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv, resolveUserIds } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");
const RENEWAL_WINDOW_DAYS = 90;

interface Lease {
  id: string;
  property_id: string;
  tenant_name: string;
  tenant_email: string | null;
  lease_end: string;
  monthly_rent: number;
  status: string;
  renewal_offered: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");
    const RENTCAST_KEY = Deno.env.get("RENTCAST_API_KEY");

    const { user_id: rawUserId } = await req.json();
    if (!rawUserId) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });
    }

    const userIds = await resolveUserIds(SUPABASE_URL, SERVICE_KEY, rawUserId);
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ message: "No users found to process" }), { headers: corsHeaders });
    }
    const user_id = userIds[0];

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const now = new Date();
    const renewalCutoff = new Date(now.getTime() + RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Fetch all active leases
    const leasesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/lease_tracker?user_id=eq.${user_id}&status=eq.active&select=id,property_id,tenant_name,tenant_email,lease_end,monthly_rent,status,renewal_offered`,
      { headers: baseHeaders },
    );
    if (!leasesRes.ok) throw new Error(`Failed to fetch leases: ${leasesRes.status}`);
    const leases: Lease[] = await leasesRes.json();

    let renewalsDrafted = 0;
    let overdueAlerts = 0;

    for (const lease of leases) {
      // Check for upcoming renewals within 90 days
      if (lease.lease_end <= renewalCutoff && !lease.renewal_offered) {
        const daysUntilExpiry = Math.ceil((new Date(lease.lease_end).getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

        // Get market rent from Rentcast if available
        let marketRent = Number(lease.monthly_rent);
        if (RENTCAST_KEY) {
          try {
            const propRes = await fetch(
              `${SUPABASE_URL}/rest/v1/property_portfolio?id=eq.${lease.property_id}&select=address`,
              { headers: baseHeaders },
            );
            if (propRes.ok) {
              const props: Array<{ address: string }> = await propRes.json();
              if (props.length > 0) {
                const rentRes = await fetch(
                  `https://api.rentcast.io/v1/avm/rent/long-term?address=${encodeURIComponent(props[0].address)}`,
                  { headers: { "X-Api-Key": RENTCAST_KEY } },
                );
                if (rentRes.ok) {
                  const rentData = await rentRes.json() as { rent?: number };
                  marketRent = Number(rentData.rent ?? lease.monthly_rent);
                }
              }
            }
          } catch { /* use current rent */ }
        }

        // Draft renewal offer
        const renewalIncrease = Math.max(marketRent, Number(lease.monthly_rent) * 1.03);
        const prompt = `You are Atlas. Draft a professional lease renewal offer.

Tenant: ${lease.tenant_name}${lease.tenant_email ? " (" + lease.tenant_email + ")" : ""}
Current Rent: $${Number(lease.monthly_rent).toFixed(0)}/month
Market Rate: $${marketRent.toFixed(0)}/month
Proposed New Rent: $${renewalIncrease.toFixed(0)}/month
Days Until Expiry: ${daysUntilExpiry}

Draft a renewal letter that is professional, direct, and includes:
- Appreciation for tenancy
- New terms clearly stated
- Response deadline (30 days before lease end)
- Simple yes/no response ask

Return JSON: { subject: string, body: string }`;

        try {
          const aiResp = await callGatewayWithRetry(
            { model: ATLAS_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 600 },
            API_KEY,
          );
          if (aiResp.ok) {
            const aiData = await aiResp.json();
            const rawContent: string = aiData.choices?.[0]?.message?.content?.trim() ?? "{}";
            let draft: { subject: string; body: string } = { subject: "", body: "" };
            try {
              draft = JSON.parse(rawContent.replace(/```json\s*|\s*```/g, "").trim()) as { subject: string; body: string };
            } catch {
              const match = rawContent.match(/\{[\s\S]*\}/);
              if (match) draft = JSON.parse(match[0]) as { subject: string; body: string };
            }

            if (draft.subject && draft.body) {
              // Insert as business_tasks for approval
              await fetch(`${SUPABASE_URL}/rest/v1/business_tasks`, {
                method: "POST",
                headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
                body: JSON.stringify({
                  user_id,
                  task_type: "follow_up",
                  subject: draft.subject,
                  body: draft.body,
                  status: "queued",
                  requires_approval: true,
                  scheduled_for: new Date().toISOString(),
                }),
              });
              renewalsDrafted++;
            }
          }
        } catch (e: unknown) {
          console.error(`[atlas_lease_monitor] Renewal draft error for ${lease.tenant_name}:`, e instanceof Error ? e.message : String(e));
        }

        await sendTelegramAlert(`*LEASE EXPIRING: ${lease.tenant_name}*\nExpires ${lease.lease_end} (${daysUntilExpiry} days)\nCurrent rent: $${Number(lease.monthly_rent).toFixed(0)}/mo\nRenewal draft queued for approval.`);
      }

      // Check for overdue rent — no rent payment logged for current month
      try {
        const rentRes = await fetch(
          `${SUPABASE_URL}/rest/v1/property_ledger?property_id=eq.${lease.property_id}&entry_type=eq.rent&created_at=gte.${thisMonthStart}&select=id,status&limit=1`,
          { headers: baseHeaders },
        );
        if (rentRes.ok) {
          const rentEntries: Array<{ id: string; status: string }> = await rentRes.json();
          if (rentEntries.length === 0) {
            await sendTelegramAlert(`*RENT ALERT: ${lease.tenant_name}*\nNo rent logged for ${now.toLocaleDateString("en-US", { month: "long" })}. Property: ${lease.property_id}`);

            await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
              method: "POST",
              headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
              body: JSON.stringify({
                user_id,
                signal_type: "price_alert",
                message: `Rent not logged for ${lease.tenant_name} — ${now.toLocaleDateString("en-US", { month: "long" })}. May be overdue.`,
              }),
            });
            overdueAlerts++;
          }
        }
      } catch { /* skip overdue check for this lease */ }
    }

    return new Response(JSON.stringify({
      status: "ok",
      leases_monitored: leases.length,
      renewals_drafted: renewalsDrafted,
      overdue_alerts: overdueAlerts,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_lease_monitor] Error:", msg);
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SERVICE_KEY) {
        const body = await req.clone().json().catch(() => ({}));
        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: (body as { user_id?: string }).user_id ?? "system", signal_type: "function_error", message: `atlas_lease_monitor error: ${msg}` }),
        });
      }
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
