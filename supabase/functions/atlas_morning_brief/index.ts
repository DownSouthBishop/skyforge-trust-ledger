// Nightly cron: scans last 7 days of shared_operator_memory + agent_unified_history
// for every user, then writes morning_brief + automation_candidate records.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-sonnet-4-6";

async function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function runForUser(user_id: string) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  const [memRes, histRes] = await Promise.all([
    rest(`shared_operator_memory?user_id=eq.${user_id}&updated_at=gte.${since}&order=updated_at.desc&limit=200&select=memory_type,key,value,context,updated_at`),
    rest(`agent_unified_history?user_id=eq.${user_id}&created_at=gte.${since}&order=created_at.desc&limit=300&select=medium,agent_slug,role,content,created_at`),
  ]);
  const memory = memRes.ok ? await memRes.json() : [];
  const history = histRes.ok ? await histRes.json() : [];
  if (!memory.length && !history.length) return;

  const memBlock = memory.map((m: any) => `[${m.memory_type}] ${m.key}: ${m.value}`).join("\n").slice(0, 8000);
  const histBlock = history.reverse().map((h: any) => `[${h.medium}] ${h.role === "user" ? "Op" : h.agent_slug}: ${(h.content ?? "").toString().replace(/\s+/g, " ").slice(0, 200)}`).join("\n").slice(0, 8000);

  const prompt = `You are Atlas. Analyze the operator's last 7 days.

MEMORY:
${memBlock}

CONVERSATIONS:
${histBlock}

Tasks:
1. Identify recurring patterns in how they think, communicate, what they focus on.
2. Predict what is likely on their mind tomorrow.
3. Flag any manual task that repeats 3+ times.

Return STRICT JSON:
{
 "brief": "3-4 line morning message in Atlas's voice — what's coming, what was noticed, what to watch",
 "automations": [{"value": "describe pattern + suggested automation"}, ...]
}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
  });
  if (!resp.ok) { console.error("anthropic", user_id, resp.status, await resp.text()); return; }
  const data = await resp.json();
  const text: string = data?.content?.[0]?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return;
  let parsed: any;
  try { parsed = JSON.parse(jsonMatch[0]); } catch { return; }

  if (parsed.brief) {
    await rest("shared_operator_memory", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        user_id, source_agent: "atlas", memory_type: "morning_brief",
        key: `brief_${today}`, value: parsed.brief, context: "morning_brief", confidence: 1.0,
      }),
    }).catch(() => {});
  }

  if (Array.isArray(parsed.automations)) {
    for (const a of parsed.automations) {
      if (!a?.value) continue;
      await rest("shared_operator_memory", {
        method: "POST",
        body: JSON.stringify({
          user_id, source_agent: "atlas", memory_type: "automation_candidate",
          key: `candidate_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          value: a.value, context: "automation", confidence: 0.8,
        }),
      }).catch(() => {});
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const usersRes = await rest("user_profiles?select=user_id");
    const users = usersRes.ok ? await usersRes.json() : [];
    for (const u of users) {
      try { await runForUser(u.user_id); } catch (e) { console.error("user fail", u.user_id, e); }
    }
    return new Response(JSON.stringify({ ok: true, count: users.length }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
