// Atlas Expense Audit — scans business_ledger for anomalies in recurring expenses
// Phase 2B: runs first of every month at 06:00 UTC

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");

interface LedgerEntry {
  id: string;
  entry_type: string;
  category: string;
  description: string;
  amount_usd: number;
  status: string;
  recurring: boolean;
  recurrence_interval: string | null;
  created_at: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });
    }

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const monthLabel = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });

    // Pull all ledger entries for last 2 months
    const [thisMonthRes, lastMonthRes, recurringRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/business_ledger?user_id=eq.${user_id}&created_at=gte.${thisMonth}&select=id,entry_type,category,description,amount_usd,status,recurring,recurrence_interval,created_at`,
        { headers: baseHeaders },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/business_ledger?user_id=eq.${user_id}&created_at=gte.${lastMonth}&created_at=lt.${thisMonth}&select=id,entry_type,category,description,amount_usd,status,recurring,recurrence_interval,created_at`,
        { headers: baseHeaders },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/business_ledger?user_id=eq.${user_id}&recurring=eq.true&entry_type=eq.expense&select=id,category,description,amount_usd,recurrence_interval`,
        { headers: baseHeaders },
      ),
    ]);

    const thisMonthEntries: LedgerEntry[] = thisMonthRes.ok ? await thisMonthRes.json() : [];
    const lastMonthEntries: LedgerEntry[] = lastMonthRes.ok ? await lastMonthRes.json() : [];
    const recurringExpenses: LedgerEntry[] = recurringRes.ok ? await recurringRes.json() : [];

    // Compute MoM metrics
    const thisRevenue  = thisMonthEntries.filter(e => e.entry_type === "revenue" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
    const thisExpenses = thisMonthEntries.filter(e => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount_usd), 0);
    const lastExpenses = lastMonthEntries.filter(e => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount_usd), 0);

    // Flags
    const flags: string[] = [];

    // 1. Expenses that increased >10% MoM by category
    const thisExpByCategory = thisMonthEntries.filter(e => e.entry_type === "expense").reduce((acc: Record<string, number>, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + Number(e.amount_usd);
      return acc;
    }, {});
    const lastExpByCategory = lastMonthEntries.filter(e => e.entry_type === "expense").reduce((acc: Record<string, number>, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + Number(e.amount_usd);
      return acc;
    }, {});

    for (const [cat, amount] of Object.entries(thisExpByCategory)) {
      const lastAmount = lastExpByCategory[cat] ?? 0;
      if (lastAmount > 0 && (amount - lastAmount) / lastAmount > 0.10) {
        flags.push(`EXPENSE SPIKE: ${cat} up ${(((amount - lastAmount) / lastAmount) * 100).toFixed(0)}% MoM ($${lastAmount.toFixed(0)} → $${amount.toFixed(0)})`);
      }
    }

    // 2. Subscriptions with no corresponding revenue category
    const revenueCategories = new Set(thisMonthEntries.filter(e => e.entry_type === "revenue").map(e => e.category));
    for (const exp of recurringExpenses) {
      if (!revenueCategories.has(exp.category)) {
        flags.push(`ORPHANED SUBSCRIPTION: ${exp.description} ($${Number(exp.amount_usd).toFixed(0)}/${exp.recurrence_interval ?? "month"}) — no matching revenue category`);
      }
    }

    // 3. Expense ratio >60% of revenue
    if (thisRevenue > 0 && thisExpenses / thisRevenue > 0.60) {
      flags.push(`EXPENSE RATIO: ${((thisExpenses / thisRevenue) * 100).toFixed(0)}% of revenue — exceeds 60% threshold (MTD: $${thisExpenses.toFixed(0)} expenses on $${thisRevenue.toFixed(0)} revenue)`);
    }

    const prompt = `You are Atlas. Analyze this expense audit data and generate a structured report.

AUDIT DATA — ${monthLabel}:
MTD Revenue: $${thisRevenue.toFixed(0)}
MTD Expenses: $${thisExpenses.toFixed(0)}
Prior Month Expenses: $${lastExpenses.toFixed(0)}
Expense Ratio: ${thisRevenue > 0 ? ((thisExpenses / thisRevenue) * 100).toFixed(0) : "N/A"}%
Recurring Expenses: ${recurringExpenses.length} subscriptions/fixed costs

FLAGS DETECTED:
${flags.length > 0 ? flags.join("\n") : "No anomalies detected."}

RECURRING EXPENSES:
${recurringExpenses.slice(0, 10).map(e => `- ${e.description}: $${Number(e.amount_usd).toFixed(0)}/${e.recurrence_interval ?? "month"} [${e.category}]`).join("\n")}

Generate a structured expense audit with: 1) Summary of financial position, 2) Analysis of each flag with severity, 3) Specific action items to address issues, 4) One-sentence verdict on expense health.`;

    const aiResp = await callGatewayWithRetry(
      { model: ATLAS_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 1200 },
      API_KEY,
    );
    if (!aiResp.ok) throw new Error(`AI call failed: ${aiResp.status}`);

    const aiData = await aiResp.json();
    const auditReport: string = aiData.choices?.[0]?.message?.content ?? "Audit failed.";

    await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        title: `Expense Audit — ${monthLabel}`,
        content: auditReport,
        note_type: "research",
        synced_to_obsidian: false,
      }),
    });

    if (flags.length > 0) {
      await sendTelegramAlert(`*EXPENSE AUDIT — ${monthLabel}*\n${flags.length} flag${flags.length !== 1 ? "s" : ""} detected:\n${flags.slice(0, 3).map(f => `• ${f.slice(0, 100)}`).join("\n")}\n\nCheck Vault for full report.`);
    }

    return new Response(JSON.stringify({ status: "ok", month: monthLabel, flags_count: flags.length, flags, revenue: thisRevenue, expenses: thisExpenses }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_expense_audit] Error:", msg);
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SERVICE_KEY) {
        const body = await req.clone().json().catch(() => ({}));
        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: (body as { user_id?: string }).user_id ?? "system", signal_type: "function_error", message: `atlas_expense_audit error: ${msg}` }),
        });
      }
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
