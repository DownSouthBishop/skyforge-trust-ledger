// airtable-oauth — OAuth 2.0 (PKCE) flow + token storage for Airtable
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SCOPES = ["data.records:read", "data.records:write", "schema.bases:read"].join(" ");

function env(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(digest);
}

function randomVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return b64url(bytes).slice(0, 64);
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

async function storeTokens(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  tokens: { access_token: string; refresh_token: string; expires_in: number },
) {
  const existing = await fetch(
    `${supabaseUrl}/rest/v1/airtable_tokens?user_id=eq.${userId}&select=id`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = await existing.json();

  const payload = {
    user_id: userId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (rows?.length) {
    await fetch(`${supabaseUrl}/rest/v1/airtable_tokens?user_id=eq.${userId}`, {
      method: "PATCH",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });
  } else {
    await fetch(`${supabaseUrl}/rest/v1/airtable_tokens`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });
  }
}

async function loadTokens(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<{ access_token: string; refresh_token: string; expires_at: string } | null> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/airtable_tokens?user_id=eq.${userId}&select=access_token,refresh_token,expires_at&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = await res.json();
  return rows?.[0] ?? null;
}

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch("https://airtable.com/oauth2/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth(clientId, clientSecret) },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh failed: " + JSON.stringify(data));
  return { access_token: data.access_token, refresh_token: data.refresh_token ?? refreshToken, expires_in: data.expires_in };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
    const clientId = env("AIRTABLE_CLIENT_ID");
    const clientSecret = env("AIRTABLE_CLIENT_SECRET");

    const body = await req.json().catch(() => ({}));
    const { action, code, state, code_verifier, redirect_uri: bodyRedirect } = body;
    const redirectUri = bodyRedirect || Deno.env.get("AIRTABLE_REDIRECT_URI");
    if ((action === "get_auth_url" || action === "exchange_code") && !redirectUri) {
      throw new Error("Missing redirect_uri");
    }

    if (action === "get_auth_url") {
      const userId = await verifyUser(supabaseUrl, req.headers.get("authorization"), req.headers.get("apikey"));
      const verifier = randomVerifier();
      const challenge = await codeChallengeFor(verifier);
      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri!,
        scope: SCOPES,
        state: userId,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      return new Response(
        JSON.stringify({ url: `https://airtable.com/oauth2/v1/authorize?${params}`, code_verifier: verifier }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "exchange_code") {
      const userId = state || (await verifyUser(supabaseUrl, req.headers.get("authorization"), req.headers.get("apikey")));
      if (!code_verifier) throw new Error("Missing code_verifier");
      const tokenRes = await fetch("https://airtable.com/oauth2/v1/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth(clientId, clientSecret) },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri!,
          code_verifier,
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) throw new Error("Token exchange failed: " + JSON.stringify(tokens));
      await storeTokens(supabaseUrl, serviceKey, userId, tokens);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "get_token") {
      const userId = await verifyUser(supabaseUrl, req.headers.get("authorization"), req.headers.get("apikey"));
      const stored = await loadTokens(supabaseUrl, serviceKey, userId);
      if (!stored) return new Response(JSON.stringify({ connected: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

      const expiresAt = new Date(stored.expires_at).getTime();
      let accessToken = stored.access_token;
      if (Date.now() > expiresAt - 60_000) {
        const refreshed = await refreshAccessToken(clientId, clientSecret, stored.refresh_token);
        accessToken = refreshed.access_token;
        await storeTokens(supabaseUrl, serviceKey, userId, refreshed);
      }
      return new Response(JSON.stringify({ connected: true, access_token: accessToken }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "disconnect") {
      const userId = await verifyUser(supabaseUrl, req.headers.get("authorization"), req.headers.get("apikey"));
      await fetch(`${supabaseUrl}/rest/v1/airtable_tokens?user_id=eq.${userId}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
