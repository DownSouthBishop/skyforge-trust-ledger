// Shared Airtable access for any agent (Atlas, Linda, Janus/agent-chat, and the
// reflection loop). Full read/write against the operator's "Multi-Company
// Command Center" base -- Companies, People, Teams, Projects, Milestones, Tasks,
// all linked by record ID.

const BASE_ID = "appGr592LCUvJgYml";

const KNOWN_TABLES = ["Companies", "People", "Teams", "Projects", "Milestones", "Tasks"];

function airtableHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

// Fetch (and refresh if needed) the operator's Airtable OAuth token stored by
// the airtable-oauth edge function. Lets agents share the same "Connect
// Airtable" button surfaced in the UI -- no separate PAT required.
export async function getUserAirtableToken(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/airtable_tokens?user_id=eq.${userId}&select=access_token,refresh_token,expires_at&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!res.ok) return null;
    const rows: Array<{ access_token: string; refresh_token: string; expires_at: string }> = await res.json();
    if (!rows?.length) return null;
    const { access_token, refresh_token, expires_at } = rows[0];
    if (Date.now() < new Date(expires_at).getTime() - 60_000) return access_token;

    const clientId = Deno.env.get("AIRTABLE_CLIENT_ID");
    const clientSecret = Deno.env.get("AIRTABLE_CLIENT_SECRET");
    if (!clientId || !clientSecret) return access_token;
    const basic = "Basic " + btoa(`${clientId}:${clientSecret}`);
    const tokenRes = await fetch("https://airtable.com/oauth2/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token }),
    });
    if (!tokenRes.ok) return access_token;
    const tokenData = await tokenRes.json();
    if (!tokenData?.access_token) return access_token;
    fetch(`${supabaseUrl}/rest/v1/airtable_tokens?user_id=eq.${userId}`, {
      method: "PATCH",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token ?? refresh_token,
        expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => {});
    return tokenData.access_token as string;
  } catch {
    return null;
  }
}

// Resolves the best Airtable credential for an agent action: prefers the
// operator's per-user OAuth token, falls back to workspace PAT if configured.
export async function resolveAirtableKey(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<string | null> {
  const oauth = await getUserAirtableToken(supabaseUrl, serviceKey, userId);
  if (oauth) return oauth;
  return Deno.env.get("AIRTABLE_API_KEY") ?? null;
}

export async function readAirtable(
  apiKey: string,
  table: string,
  opts: { maxRecords?: number; filterByFormula?: string } = {},
): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
  const params = new URLSearchParams();
  params.set("maxRecords", String(opts.maxRecords ?? 20));
  if (opts.filterByFormula) params.set("filterByFormula", opts.filterByFormula);
  const r = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}?${params.toString()}`,
    { headers: airtableHeaders(apiKey) },
  );
  if (!r.ok) throw new Error(`Airtable read ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.records ?? [];
}

export async function createAirtableRecord(
  apiKey: string,
  table: string,
  fields: Record<string, unknown>,
): Promise<{ id: string; fields: Record<string, unknown> }> {
  const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: airtableHeaders(apiKey),
    body: JSON.stringify({ records: [{ fields }] }),
  });
  if (!r.ok) throw new Error(`Airtable create ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.records[0];
}

export async function updateAirtableRecord(
  apiKey: string,
  table: string,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<{ id: string; fields: Record<string, unknown> }> {
  const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}`, {
    method: "PATCH",
    headers: airtableHeaders(apiKey),
    body: JSON.stringify({ records: [{ id: recordId, fields }] }),
  });
  if (!r.ok) throw new Error(`Airtable update ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.records[0];
}

// Formatted block for tool results / reflection context -- compact, not the raw JSON.
export function formatAirtableRecords(table: string, records: Array<{ id: string; fields: Record<string, unknown> }>): string {
  if (!records.length) return `No ${table} records found.`;
  return records.map(r => {
    const fieldStr = Object.entries(r.fields)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join(" | ");
    return `[${r.id}] ${fieldStr}`;
  }).join("\n");
}

export { KNOWN_TABLES as AIRTABLE_TABLES };
