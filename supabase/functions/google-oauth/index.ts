// google-oauth — OAuth 2.0 flow + token storage for Google APIs
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SCOPES = [
  // Gmail
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  // Calendar
  "https://www.googleapis.com/auth/calendar",
  // Drive
  "https://www.googleapis.com/auth/drive",
  // Sheets
  "https://www.googleapis.com/auth/spreadsheets",
  // Docs
  "https://www.googleapis.com/auth/documents",
  // Slides
  "https://www.googleapis.com/auth/presentations",
  // Forms
  "https://www.googleapis.com/auth/forms.body.readonly",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  // Contacts (People API)
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/contacts.readonly",
  // Tasks
  "https://www.googleapis.com/auth/tasks",
  // YouTube
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  // Search Console
  "https://www.googleapis.com/auth/webmasters.readonly",
  // Analytics
  "https://www.googleapis.com/auth/analytics.readonly",
  // Google My Business (profile info)
  "https://www.googleapis.com/auth/business.manage",
  // Chat
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  // Profile
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

function env(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

async function verifyUser(
  supabaseUrl: string,
  serviceKey: string,
  authHeader: string | null,
): Promise<string> {
  if (!authHeader) throw new Error("Missing Authorization header");
  const token = authHeader.replace("Bearer ", "").trim();
  const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceKey },
  });
  if (!resp.ok) throw new Error("Invalid token");
  const data = await resp.json();
  if (!data?.id) throw new Error("No user ID");
  return data.id as string;
}

async function storeTokens(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  tokens: { access_token: string; refresh_token?: string; expiry_date?: number },
) {
  const existing = await fetch(
    `${supabaseUrl}/rest/v1/google_tokens?user_id=eq.${userId}&select=id`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = await existing.json();

  const payload: Record<string, unknown> = {
    user_id: userId,
    access_token: tokens.access_token,
    expires_at: tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : new Date(Date.now() + 3600_000).toISOString(),
  };
  if (tokens.refresh_token) payload.refresh_token = tokens.refresh_token;

  if (rows?.length) {
    await fetch(`${supabaseUrl}/rest/v1/google_tokens?user_id=eq.${userId}`, {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });
  } else {
    await fetch(`${supabaseUrl}/rest/v1/google_tokens`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
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
    `${supabaseUrl}/rest/v1/google_tokens?user_id=eq.${userId}&select=access_token,refresh_token,expires_at&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = await res.json();
  return rows?.[0] ?? null;
}

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ access_token: string; expiry_date: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh failed: " + JSON.stringify(data));
  return { access_token: data.access_token, expiry_date: Date.now() + data.expires_in * 1000 };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
    const clientId = env("GOOGLE_CLIENT_ID");
    const clientSecret = env("GOOGLE_CLIENT_SECRET");

    const body = await req.json().catch(() => ({}));
    const { action, code, state, redirect_uri: bodyRedirect } = body;
    const redirectUri = bodyRedirect || Deno.env.get("GOOGLE_REDIRECT_URI");
    if ((action === "get_auth_url" || action === "exchange_code") && !redirectUri) {
      throw new Error("Missing redirect_uri");
    }

    if (action === "get_auth_url") {
      const userId = await verifyUser(supabaseUrl, serviceKey, req.headers.get("authorization"));
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri!,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent",
        state: userId,
      });
      return new Response(
        JSON.stringify({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "exchange_code") {
      const userId = state || (await verifyUser(supabaseUrl, serviceKey, req.headers.get("authorization")));
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri!,
          grant_type: "authorization_code",
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) throw new Error("Token exchange failed: " + JSON.stringify(tokens));
      await storeTokens(supabaseUrl, serviceKey, userId, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: Date.now() + tokens.expires_in * 1000,
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "get_token") {
      const userId = await verifyUser(supabaseUrl, serviceKey, req.headers.get("authorization"));
      const stored = await loadTokens(supabaseUrl, serviceKey, userId);
      if (!stored) return new Response(JSON.stringify({ connected: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

      const expiresAt = new Date(stored.expires_at).getTime();
      let accessToken = stored.access_token;
      if (Date.now() > expiresAt - 60_000) {
        const refreshed = await refreshAccessToken(clientId, clientSecret, stored.refresh_token);
        accessToken = refreshed.access_token;
        await storeTokens(supabaseUrl, serviceKey, userId, {
          access_token: refreshed.access_token,
          expiry_date: refreshed.expiry_date,
        });
      }

      return new Response(JSON.stringify({ connected: true, access_token: accessToken }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "disconnect") {
      const userId = await verifyUser(supabaseUrl, serviceKey, req.headers.get("authorization"));
      await fetch(`${supabaseUrl}/rest/v1/google_tokens?user_id=eq.${userId}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
