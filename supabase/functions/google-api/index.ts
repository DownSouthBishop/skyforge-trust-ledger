// google-api — unified proxy for Gmail, Calendar, Drive, Sheets
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

async function getValidToken(
  supabaseUrl: string,
  serviceKey: string,
  clientId: string,
  clientSecret: string,
  userId: string,
): Promise<string> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/google_tokens?user_id=eq.${userId}&select=access_token,refresh_token,expires_at&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = await res.json();
  if (!rows?.length) throw new Error("Google account not connected. Visit Profile → Google to connect.");

  const { access_token, refresh_token, expires_at } = rows[0];
  const expiresAt = new Date(expires_at).getTime();

  if (Date.now() < expiresAt - 60_000) return access_token;

  // Refresh
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("Token refresh failed");

  await fetch(`${supabaseUrl}/rest/v1/google_tokens?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      access_token: tokenData.access_token,
      expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
    }),
  });

  return tokenData.access_token;
}

async function gFetch(
  token: string,
  url: string,
  options: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google API error ${res.status}: ${body}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

async function gmailHandler(token: string, action: string, params: Record<string, unknown>) {
  const base = "https://gmail.googleapis.com/gmail/v1/users/me";

  if (action === "list_threads") {
    const q = params.query ? `&q=${encodeURIComponent(params.query as string)}` : "";
    const maxResults = params.maxResults ?? 20;
    return gFetch(token, `${base}/threads?maxResults=${maxResults}${q}`);
  }

  if (action === "get_thread") {
    return gFetch(token, `${base}/threads/${params.threadId}?format=full`);
  }

  if (action === "list_messages") {
    const q = params.query ? `&q=${encodeURIComponent(params.query as string)}` : "";
    const maxResults = params.maxResults ?? 20;
    return gFetch(token, `${base}/messages?maxResults=${maxResults}${q}`);
  }

  if (action === "get_message") {
    return gFetch(token, `${base}/messages/${params.messageId}?format=full`);
  }

  if (action === "send") {
    // params: { to, subject, body, cc?, bcc? }
    const { to, subject, body, cc, bcc } = params as Record<string, string>;
    const lines = [
      `To: ${to}`,
      cc ? `Cc: ${cc}` : null,
      bcc ? `Bcc: ${bcc}` : null,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].filter(Boolean).join("\r\n");
    const raw = btoa(unescape(encodeURIComponent(lines)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return gFetch(token, `${base}/messages/send`, {
      method: "POST",
      body: JSON.stringify({ raw }),
    });
  }

  if (action === "create_draft") {
    const { to, subject, body } = params as Record<string, string>;
    const lines = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].join("\r\n");
    const raw = btoa(unescape(encodeURIComponent(lines)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return gFetch(token, `${base}/drafts`, {
      method: "POST",
      body: JSON.stringify({ message: { raw } }),
    });
  }

  if (action === "modify_labels") {
    return gFetch(token, `${base}/messages/${params.messageId}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds: params.addLabelIds ?? [], removeLabelIds: params.removeLabelIds ?? [] }),
    });
  }

  if (action === "list_labels") {
    return gFetch(token, `${base}/labels`);
  }

  throw new Error(`Unknown Gmail action: ${action}`);
}

// ── Calendar ──────────────────────────────────────────────────────────────────

async function calendarHandler(token: string, action: string, params: Record<string, unknown>) {
  const base = "https://www.googleapis.com/calendar/v3";
  const calId = (params.calendarId as string) ?? "primary";

  if (action === "list_calendars") {
    return gFetch(token, `${base}/users/me/calendarList`);
  }

  if (action === "list_events") {
    const p = new URLSearchParams({ maxResults: String(params.maxResults ?? 20) });
    if (params.timeMin) p.set("timeMin", params.timeMin as string);
    if (params.timeMax) p.set("timeMax", params.timeMax as string);
    if (params.query) p.set("q", params.query as string);
    p.set("singleEvents", "true");
    p.set("orderBy", "startTime");
    return gFetch(token, `${base}/calendars/${encodeURIComponent(calId)}/events?${p}`);
  }

  if (action === "get_event") {
    return gFetch(token, `${base}/calendars/${encodeURIComponent(calId)}/events/${params.eventId}`);
  }

  if (action === "create_event") {
    return gFetch(token, `${base}/calendars/${encodeURIComponent(calId)}/events`, {
      method: "POST",
      body: JSON.stringify(params.event),
    });
  }

  if (action === "update_event") {
    return gFetch(token, `${base}/calendars/${encodeURIComponent(calId)}/events/${params.eventId}`, {
      method: "PUT",
      body: JSON.stringify(params.event),
    });
  }

  if (action === "delete_event") {
    await fetch(`${base}/calendars/${encodeURIComponent(calId)}/events/${params.eventId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    return { ok: true };
  }

  throw new Error(`Unknown Calendar action: ${action}`);
}

// ── Drive ─────────────────────────────────────────────────────────────────────

async function driveHandler(token: string, action: string, params: Record<string, unknown>) {
  const base = "https://www.googleapis.com/drive/v3";

  if (action === "list_files") {
    const p = new URLSearchParams({
      pageSize: String(params.pageSize ?? 20),
      fields: "files(id,name,mimeType,modifiedTime,size,webViewLink)",
    });
    if (params.query) p.set("q", params.query as string);
    if (params.folderId) p.set("q", `'${params.folderId}' in parents`);
    return gFetch(token, `${base}/files?${p}`);
  }

  if (action === "get_file") {
    return gFetch(token, `${base}/files/${params.fileId}?fields=*`);
  }

  if (action === "read_file") {
    const res = await fetch(`${base}/files/${params.fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Drive read error: ${res.status}`);
    return res.text();
  }

  if (action === "create_folder") {
    return gFetch(token, `${base}/files`, {
      method: "POST",
      body: JSON.stringify({
        name: params.name,
        mimeType: "application/vnd.google-apps.folder",
        parents: params.parentId ? [params.parentId] : undefined,
      }),
    });
  }

  if (action === "delete_file") {
    await fetch(`${base}/files/${params.fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    return { ok: true };
  }

  if (action === "search") {
    const p = new URLSearchParams({
      q: params.query as string,
      pageSize: String(params.pageSize ?? 20),
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    });
    return gFetch(token, `${base}/files?${p}`);
  }

  throw new Error(`Unknown Drive action: ${action}`);
}

// ── Sheets ────────────────────────────────────────────────────────────────────

async function sheetsHandler(token: string, action: string, params: Record<string, unknown>) {
  const base = "https://sheets.googleapis.com/v4/spreadsheets";
  const spreadsheetId = params.spreadsheetId as string;

  if (action === "get_spreadsheet") {
    return gFetch(token, `${base}/${spreadsheetId}`);
  }

  if (action === "get_values") {
    const range = encodeURIComponent(params.range as string);
    return gFetch(token, `${base}/${spreadsheetId}/values/${range}`);
  }

  if (action === "update_values") {
    const range = encodeURIComponent(params.range as string);
    return gFetch(token, `${base}/${spreadsheetId}/values/${range}?valueInputOption=${params.valueInputOption ?? "USER_ENTERED"}`, {
      method: "PUT",
      body: JSON.stringify({ values: params.values }),
    });
  }

  if (action === "append_values") {
    const range = encodeURIComponent(params.range as string);
    return gFetch(token, `${base}/${spreadsheetId}/values/${range}:append?valueInputOption=${params.valueInputOption ?? "USER_ENTERED"}&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: JSON.stringify({ values: params.values }),
    });
  }

  if (action === "create_spreadsheet") {
    return gFetch(token, base, {
      method: "POST",
      body: JSON.stringify({ properties: { title: params.title } }),
    });
  }

  if (action === "batch_update") {
    return gFetch(token, `${base}/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: params.requests }),
    });
  }

  throw new Error(`Unknown Sheets action: ${action}`);
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
    const clientId = env("GOOGLE_CLIENT_ID");
    const clientSecret = env("GOOGLE_CLIENT_SECRET");

    const userId = await verifyUser(supabaseUrl, serviceKey, req.headers.get("authorization"));
    const token = await getValidToken(supabaseUrl, serviceKey, clientId, clientSecret, userId);

    const { service, action, ...params } = await req.json();

    let result: unknown;
    if (service === "gmail") result = await gmailHandler(token, action, params);
    else if (service === "calendar") result = await calendarHandler(token, action, params);
    else if (service === "drive") result = await driveHandler(token, action, params);
    else if (service === "sheets") result = await sheetsHandler(token, action, params);
    else throw new Error(`Unknown service: ${service}`);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes("not connected") ? 401 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
