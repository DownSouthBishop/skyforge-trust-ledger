// airtable-api — unified proxy for Airtable data + schema, using the stored OAuth token
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function env(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

async function verifyUser(
  supabaseUrl: string,
  authHeader: string | null,
  apiKey: string | null,
): Promise<string> {
  if (!authHeader) throw new Error("Missing Authorization header");
  const token = authHeader.replace("Bearer ", "").trim();
  let issuer = "";
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    issuer = payload.iss || "";
  } catch { /* ignore */ }
  const base = issuer.replace(/\/auth\/v1\/?$/, "") || supabaseUrl;
  const resp = await fetch(`${base}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: apiKey || Deno.env.get("SUPABASE_ANON_KEY") || token },
  });
  if (!resp.ok) throw new Error("Invalid token");
  const data = await resp.json();
  if (!data?.id) throw new Error("No user ID");
  return data.id as string;
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function getValidToken(
  supabaseUrl: string,
  serviceKey: string,
  clientId: string,
  clientSecret: string,
  userId: string,
): Promise<string> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/airtable_tokens?user_id=eq.${userId}&select=access_token,refresh_token,expires_at&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = await res.json();
  if (!rows?.length) throw new Error("Airtable account not connected. Visit Profile → Airtable to connect.");

  const { access_token, refresh_token, expires_at } = rows[0];
  if (Date.now() < new Date(expires_at).getTime() - 60_000) return access_token;

  const tokenRes = await fetch("https://airtable.com/oauth2/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth(clientId, clientSecret) },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("Airtable token refresh failed");

  await fetch(`${supabaseUrl}/rest/v1/airtable_tokens?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? refresh_token,
      expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  return tokenData.access_token;
}

async function atFetch(token: string, url: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Airtable API error ${res.status}: ${await res.text()}`);
  return res.json();
}

const META = "https://api.airtable.com/v0/meta";
const DATA = "https://api.airtable.com/v0";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
    const clientId = env("AIRTABLE_CLIENT_ID");
    const clientSecret = env("AIRTABLE_CLIENT_SECRET");

    const userId = await verifyUser(supabaseUrl, req.headers.get("authorization"), req.headers.get("apikey"));
    const token = await getValidToken(supabaseUrl, serviceKey, clientId, clientSecret, userId);

    const p = await req.json().catch(() => ({}));
    const { action, baseId, table, recordId, fields, pageSize, offset } = p;

    let result: unknown;
    if (action === "whoami") {
      result = await atFetch(token, `${META}/whoami`);
    } else if (action === "list_bases") {
      result = await atFetch(token, `${META}/bases`);
    } else if (action === "list_tables") {
      result = await atFetch(token, `${META}/bases/${baseId}/tables`);
    } else if (action === "list_records") {
      const qs = new URLSearchParams();
      if (pageSize) qs.set("pageSize", String(pageSize));
      if (offset) qs.set("offset", String(offset));
      result = await atFetch(token, `${DATA}/${baseId}/${encodeURIComponent(table)}?${qs}`);
    } else if (action === "get_record") {
      result = await atFetch(token, `${DATA}/${baseId}/${encodeURIComponent(table)}/${recordId}`);
    } else if (action === "create_record") {
      result = await atFetch(token, `${DATA}/${baseId}/${encodeURIComponent(table)}`, {
        method: "POST",
        body: JSON.stringify({ fields }),
      });
    } else if (action === "update_record") {
      result = await atFetch(token, `${DATA}/${baseId}/${encodeURIComponent(table)}/${recordId}`, {
        method: "PATCH",
        body: JSON.stringify({ fields }),
      });
    } else if (action === "delete_record") {
      result = await atFetch(token, `${DATA}/${baseId}/${encodeURIComponent(table)}/${recordId}`, { method: "DELETE" });
    } else {
      return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
