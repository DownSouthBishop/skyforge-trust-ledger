// google-api — unified proxy for all Google APIs
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-atlas-user-id",
};

function env(key: string): string {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

async function verifyUser(
  supabaseUrl: string,
  _serviceKey: string,
  authHeader: string | null,
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
    headers: { Authorization: `Bearer ${token}`, apikey: token },
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
  if (Date.now() < new Date(expires_at).getTime() - 60_000) return access_token;

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

async function gFetch(token: string, url: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Google API error ${res.status}: ${await res.text()}`);
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : res.text();
}

// ── Gmail ─────────────────────────────────────────────────────────────────────
async function gmailHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://gmail.googleapis.com/gmail/v1/users/me";
  if (action === "list_threads") return gFetch(token, `${b}/threads?maxResults=${p.maxResults ?? 20}${p.query ? `&q=${encodeURIComponent(p.query as string)}` : ""}`);
  if (action === "get_thread") return gFetch(token, `${b}/threads/${p.threadId}?format=full`);
  if (action === "list_messages") return gFetch(token, `${b}/messages?maxResults=${p.maxResults ?? 20}${p.query ? `&q=${encodeURIComponent(p.query as string)}` : ""}`);
  if (action === "get_message") return gFetch(token, `${b}/messages/${p.messageId}?format=full`);
  if (action === "send") {
    const lines = [`To: ${p.to}`, p.cc ? `Cc: ${p.cc}` : null, p.bcc ? `Bcc: ${p.bcc}` : null,
      `Subject: ${p.subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", p.body].filter(Boolean).join("\r\n");
    const raw = btoa(unescape(encodeURIComponent(lines))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return gFetch(token, `${b}/messages/send`, { method: "POST", body: JSON.stringify({ raw }) });
  }
  if (action === "create_draft") {
    const lines = [`To: ${p.to}`, `Subject: ${p.subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", p.body].join("\r\n");
    const raw = btoa(unescape(encodeURIComponent(lines))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return gFetch(token, `${b}/drafts`, { method: "POST", body: JSON.stringify({ message: { raw } }) });
  }
  if (action === "modify_labels") return gFetch(token, `${b}/messages/${p.messageId}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: p.addLabelIds ?? [], removeLabelIds: p.removeLabelIds ?? [] }) });
  if (action === "list_labels") return gFetch(token, `${b}/labels`);
  if (action === "get_profile") return gFetch(token, `${b}/profile`);
  if (action === "trash") return gFetch(token, `${b}/messages/${p.messageId}/trash`, { method: "POST" });
  if (action === "untrash") return gFetch(token, `${b}/messages/${p.messageId}/untrash`, { method: "POST" });
  throw new Error(`Unknown Gmail action: ${action}`);
}

// ── Calendar ──────────────────────────────────────────────────────────────────
async function calendarHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://www.googleapis.com/calendar/v3";
  const cal = (p.calendarId as string) ?? "primary";
  if (action === "list_calendars") return gFetch(token, `${b}/users/me/calendarList`);
  if (action === "list_events") {
    const qs = new URLSearchParams({ maxResults: String(p.maxResults ?? 20), singleEvents: "true", orderBy: "startTime" });
    if (p.timeMin) qs.set("timeMin", p.timeMin as string);
    if (p.timeMax) qs.set("timeMax", p.timeMax as string);
    if (p.query) qs.set("q", p.query as string);
    return gFetch(token, `${b}/calendars/${encodeURIComponent(cal)}/events?${qs}`);
  }
  if (action === "get_event") return gFetch(token, `${b}/calendars/${encodeURIComponent(cal)}/events/${p.eventId}`);
  if (action === "create_event") return gFetch(token, `${b}/calendars/${encodeURIComponent(cal)}/events`, { method: "POST", body: JSON.stringify(p.event) });
  if (action === "update_event") return gFetch(token, `${b}/calendars/${encodeURIComponent(cal)}/events/${p.eventId}`, { method: "PUT", body: JSON.stringify(p.event) });
  if (action === "delete_event") { await fetch(`${b}/calendars/${encodeURIComponent(cal)}/events/${p.eventId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); return { ok: true }; }
  if (action === "quick_add") return gFetch(token, `${b}/calendars/${encodeURIComponent(cal)}/events/quickAdd?text=${encodeURIComponent(p.text as string)}`, { method: "POST" });
  if (action === "list_acl") return gFetch(token, `${b}/calendars/${encodeURIComponent(cal)}/acl`);
  throw new Error(`Unknown Calendar action: ${action}`);
}

// ── Drive ─────────────────────────────────────────────────────────────────────
async function driveHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://www.googleapis.com/drive/v3";
  if (action === "list_files") {
    const qs = new URLSearchParams({ pageSize: String(p.pageSize ?? 20), fields: "files(id,name,mimeType,modifiedTime,size,webViewLink,parents)" });
    if (p.query) qs.set("q", p.query as string);
    if (p.folderId) qs.set("q", `'${p.folderId}' in parents`);
    return gFetch(token, `${b}/files?${qs}`);
  }
  if (action === "get_file") return gFetch(token, `${b}/files/${p.fileId}?fields=*`);
  if (action === "read_file") {
    const res = await fetch(`${b}/files/${p.fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive read error: ${res.status}`);
    return res.text();
  }
  if (action === "create_folder") return gFetch(token, `${b}/files`, { method: "POST", body: JSON.stringify({ name: p.name, mimeType: "application/vnd.google-apps.folder", parents: p.parentId ? [p.parentId] : undefined }) });
  if (action === "delete_file") { await fetch(`${b}/files/${p.fileId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); return { ok: true }; }
  if (action === "search") return gFetch(token, `${b}/files?${new URLSearchParams({ q: p.query as string, pageSize: String(p.pageSize ?? 20), fields: "files(id,name,mimeType,modifiedTime,webViewLink)" })}`);
  if (action === "copy_file") return gFetch(token, `${b}/files/${p.fileId}/copy`, { method: "POST", body: JSON.stringify({ name: p.name }) });
  if (action === "get_storage") return gFetch(token, "https://www.googleapis.com/drive/v3/about?fields=storageQuota");
  if (action === "move_file") return gFetch(token, `${b}/files/${p.fileId}?addParents=${p.newParentId}&removeParents=${p.oldParentId}`, { method: "PATCH", body: JSON.stringify({}) });
  throw new Error(`Unknown Drive action: ${action}`);
}

// ── Sheets ────────────────────────────────────────────────────────────────────
async function sheetsHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://sheets.googleapis.com/v4/spreadsheets";
  const sid = p.spreadsheetId as string;
  if (action === "get_spreadsheet") return gFetch(token, `${b}/${sid}`);
  if (action === "get_values") return gFetch(token, `${b}/${sid}/values/${encodeURIComponent(p.range as string)}`);
  if (action === "update_values") return gFetch(token, `${b}/${sid}/values/${encodeURIComponent(p.range as string)}?valueInputOption=${p.valueInputOption ?? "USER_ENTERED"}`, { method: "PUT", body: JSON.stringify({ values: p.values }) });
  if (action === "append_values") return gFetch(token, `${b}/${sid}/values/${encodeURIComponent(p.range as string)}:append?valueInputOption=${p.valueInputOption ?? "USER_ENTERED"}&insertDataOption=INSERT_ROWS`, { method: "POST", body: JSON.stringify({ values: p.values }) });
  if (action === "create_spreadsheet") return gFetch(token, b, { method: "POST", body: JSON.stringify({ properties: { title: p.title } }) });
  if (action === "batch_update") return gFetch(token, `${b}/${sid}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: p.requests }) });
  if (action === "clear_values") return gFetch(token, `${b}/${sid}/values/${encodeURIComponent(p.range as string)}:clear`, { method: "POST" });
  if (action === "add_sheet") return gFetch(token, `${b}/${sid}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [{ addSheet: { properties: { title: p.title } } }] }) });
  throw new Error(`Unknown Sheets action: ${action}`);
}

// ── Docs ──────────────────────────────────────────────────────────────────────
async function docsHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://docs.googleapis.com/v1/documents";
  if (action === "get_document") return gFetch(token, `${b}/${p.documentId}`);
  if (action === "create_document") return gFetch(token, b, { method: "POST", body: JSON.stringify({ title: p.title }) });
  if (action === "batch_update") return gFetch(token, `${b}/${p.documentId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: p.requests }) });
  if (action === "insert_text") return gFetch(token, `${b}/${p.documentId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [{ insertText: { location: { index: p.index ?? 1 }, text: p.text } }] }) });
  throw new Error(`Unknown Docs action: ${action}`);
}

// ── Slides ────────────────────────────────────────────────────────────────────
async function slidesHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://slides.googleapis.com/v1/presentations";
  if (action === "get_presentation") return gFetch(token, `${b}/${p.presentationId}`);
  if (action === "create_presentation") return gFetch(token, b, { method: "POST", body: JSON.stringify({ title: p.title }) });
  if (action === "batch_update") return gFetch(token, `${b}/${p.presentationId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: p.requests }) });
  throw new Error(`Unknown Slides action: ${action}`);
}

// ── Forms ─────────────────────────────────────────────────────────────────────
async function formsHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://forms.googleapis.com/v1/forms";
  if (action === "get_form") return gFetch(token, `${b}/${p.formId}`);
  if (action === "list_responses") return gFetch(token, `${b}/${p.formId}/responses`);
  if (action === "get_response") return gFetch(token, `${b}/${p.formId}/responses/${p.responseId}`);
  throw new Error(`Unknown Forms action: ${action}`);
}

// ── Contacts (People API) ─────────────────────────────────────────────────────
async function contactsHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://people.googleapis.com/v1";
  if (action === "list_contacts") {
    const qs = new URLSearchParams({ personFields: (p.personFields as string) ?? "names,emailAddresses,phoneNumbers,organizations,photos", pageSize: String(p.pageSize ?? 50) });
    return gFetch(token, `${b}/people/me/connections?${qs}`);
  }
  if (action === "get_contact") return gFetch(token, `${b}/${p.resourceName}?personFields=names,emailAddresses,phoneNumbers,organizations,photos,addresses`);
  if (action === "search_contacts") return gFetch(token, `${b}/people:searchContacts?${new URLSearchParams({ query: p.query as string, readMask: "names,emailAddresses,phoneNumbers", pageSize: String(p.pageSize ?? 10) })}`);
  if (action === "create_contact") return gFetch(token, `${b}/people:createContact`, { method: "POST", body: JSON.stringify(p.person) });
  if (action === "update_contact") return gFetch(token, `${b}/${p.resourceName}:updateContact?updatePersonFields=${p.updatePersonFields ?? "names,emailAddresses,phoneNumbers"}`, { method: "PATCH", body: JSON.stringify(p.person) });
  if (action === "delete_contact") { await fetch(`${b}/${p.resourceName}:deleteContact`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); return { ok: true }; }
  if (action === "list_directory") return gFetch(token, `${b}/people:listDirectoryPeople?${new URLSearchParams({ readMask: "names,emailAddresses", sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE", pageSize: String(p.pageSize ?? 50) })}`);
  throw new Error(`Unknown Contacts action: ${action}`);
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
async function tasksHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://tasks.googleapis.com/tasks/v1";
  if (action === "list_tasklists") return gFetch(token, `${b}/users/@me/lists`);
  if (action === "list_tasks") return gFetch(token, `${b}/lists/${p.tasklistId ?? "@default"}/tasks?showCompleted=${p.showCompleted ?? false}&maxResults=${p.maxResults ?? 50}`);
  if (action === "get_task") return gFetch(token, `${b}/lists/${p.tasklistId ?? "@default"}/tasks/${p.taskId}`);
  if (action === "create_task") return gFetch(token, `${b}/lists/${p.tasklistId ?? "@default"}/tasks`, { method: "POST", body: JSON.stringify(p.task) });
  if (action === "update_task") return gFetch(token, `${b}/lists/${p.tasklistId ?? "@default"}/tasks/${p.taskId}`, { method: "PUT", body: JSON.stringify(p.task) });
  if (action === "complete_task") return gFetch(token, `${b}/lists/${p.tasklistId ?? "@default"}/tasks/${p.taskId}`, { method: "PATCH", body: JSON.stringify({ status: "completed" }) });
  if (action === "delete_task") { await fetch(`${b}/lists/${p.tasklistId ?? "@default"}/tasks/${p.taskId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); return { ok: true }; }
  throw new Error(`Unknown Tasks action: ${action}`);
}

// ── YouTube ───────────────────────────────────────────────────────────────────
async function youtubeHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://www.googleapis.com/youtube/v3";
  if (action === "search") return gFetch(token, `${b}/search?${new URLSearchParams({ q: p.query as string, part: "snippet", maxResults: String(p.maxResults ?? 10), type: (p.type as string) ?? "video" })}`);
  if (action === "get_video") return gFetch(token, `${b}/videos?${new URLSearchParams({ id: p.videoId as string, part: "snippet,statistics,contentDetails" })}`);
  if (action === "list_channel_videos") return gFetch(token, `${b}/search?${new URLSearchParams({ channelId: p.channelId as string, part: "snippet", order: "date", maxResults: String(p.maxResults ?? 20), type: "video" })}`);
  if (action === "get_channel") return gFetch(token, `${b}/channels?${new URLSearchParams({ part: "snippet,statistics,contentDetails", id: (p.channelId as string) ?? "mine" })}`);
  if (action === "list_playlists") return gFetch(token, `${b}/playlists?${new URLSearchParams({ part: "snippet,contentDetails", mine: "true", maxResults: String(p.maxResults ?? 20) })}`);
  if (action === "list_subscriptions") return gFetch(token, `${b}/subscriptions?${new URLSearchParams({ part: "snippet", mine: "true", maxResults: String(p.maxResults ?? 50) })}`);
  if (action === "get_my_channel") return gFetch(token, `${b}/channels?part=snippet,statistics,brandingSettings&mine=true`);
  if (action === "list_comments") return gFetch(token, `${b}/commentThreads?${new URLSearchParams({ videoId: p.videoId as string, part: "snippet", maxResults: String(p.maxResults ?? 20) })}`);
  throw new Error(`Unknown YouTube action: ${action}`);
}

// ── Search Console ────────────────────────────────────────────────────────────
async function searchConsoleHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://searchconsole.googleapis.com";
  if (action === "list_sites") return gFetch(token, `${b}/webmasters/v3/sites`);
  if (action === "query_search_analytics") {
    return gFetch(token, `${b}/webmasters/v3/sites/${encodeURIComponent(p.siteUrl as string)}/searchAnalytics/query`, {
      method: "POST",
      body: JSON.stringify({
        startDate: p.startDate,
        endDate: p.endDate,
        dimensions: p.dimensions ?? ["query"],
        rowLimit: p.rowLimit ?? 25,
      }),
    });
  }
  if (action === "list_sitemaps") return gFetch(token, `${b}/webmasters/v3/sites/${encodeURIComponent(p.siteUrl as string)}/sitemaps`);
  throw new Error(`Unknown Search Console action: ${action}`);
}

// ── Analytics (GA4) ──────────────────────────────────────────────────────────
async function analyticsHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://analyticsdata.googleapis.com/v1beta";
  if (action === "run_report") {
    return gFetch(token, `${b}/properties/${p.propertyId}:runReport`, {
      method: "POST",
      body: JSON.stringify({
        dateRanges: p.dateRanges ?? [{ startDate: "30daysAgo", endDate: "today" }],
        dimensions: p.dimensions ?? [{ name: "date" }],
        metrics: p.metrics ?? [{ name: "sessions" }, { name: "activeUsers" }],
        limit: p.limit ?? 100,
      }),
    });
  }
  if (action === "run_realtime_report") {
    return gFetch(token, `${b}/properties/${p.propertyId}:runRealtimeReport`, {
      method: "POST",
      body: JSON.stringify({
        dimensions: p.dimensions ?? [{ name: "country" }],
        metrics: p.metrics ?? [{ name: "activeUsers" }],
      }),
    });
  }
  if (action === "list_properties") return gFetch(token, `https://analyticsadmin.googleapis.com/v1beta/properties?filter=parent:accounts/${p.accountId}`);
  if (action === "list_accounts") return gFetch(token, "https://analyticsadmin.googleapis.com/v1beta/accounts");
  throw new Error(`Unknown Analytics action: ${action}`);
}

// ── Chat ──────────────────────────────────────────────────────────────────────
async function chatHandler(token: string, action: string, p: Record<string, unknown>) {
  const b = "https://chat.googleapis.com/v1";
  if (action === "list_spaces") return gFetch(token, `${b}/spaces`);
  if (action === "get_space") return gFetch(token, `${b}/${p.spaceName}`);
  if (action === "list_messages") return gFetch(token, `${b}/${p.spaceName}/messages?pageSize=${p.pageSize ?? 25}`);
  if (action === "send_message") return gFetch(token, `${b}/${p.spaceName}/messages`, { method: "POST", body: JSON.stringify({ text: p.text }) });
  if (action === "list_members") return gFetch(token, `${b}/${p.spaceName}/members`);
  throw new Error(`Unknown Chat action: ${action}`);
}

// ── Gemini (Generative AI — API key, not OAuth) ───────────────────────────────
async function geminiHandler(action: string, p: Record<string, unknown>) {
  const key = Deno.env.get("GOOGLE_AI_KEY");
  if (!key) throw new Error("GOOGLE_AI_KEY not set. Add it in Supabase secrets.");
  const model = (p.model as string) ?? "gemini-2.5-flash";

  if (action === "generate_content") {
    const prompt = p.prompt as string;
    if (!prompt) throw new Error("prompt is required");
    const messages: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    if (Array.isArray(p.messages)) {
      for (const m of p.messages as Array<{ role: string; content: string }>) {
        messages.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
      }
    } else {
      messages.push({ role: "user", parts: [{ text: prompt }] });
    }
    const body: Record<string, unknown> = {
      contents: messages,
      generationConfig: { maxOutputTokens: (p.maxOutputTokens as number) ?? 4000 },
    };
    if (p.system) body.systemInstruction = { parts: [{ text: p.system as string }] };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts ?? [])
      .filter((part: { thought?: boolean }) => !part.thought)
      .map((part: { text?: string }) => part.text ?? "").join("");
    return { text, model, usage: data.usageMetadata };
  }

  if (action === "embed_content") {
    const text = p.text as string;
    if (!text) throw new Error("text is required");
    const embedModel = (p.model as string) ?? "text-embedding-004";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${embedModel}:embedContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: `models/${embedModel}`, content: { parts: [{ text }] } }) },
    );
    if (!res.ok) throw new Error(`Gemini embed error ${res.status}: ${await res.text()}`);
    return res.json();
  }

  if (action === "list_models") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
    );
    if (!res.ok) throw new Error(`Gemini list_models error ${res.status}: ${await res.text()}`);
    return res.json();
  }

  throw new Error(`Unknown Gemini action: ${action}`);
}

// custom gFetch without auth header (for Maps key-auth requests)
async function gFetchNoAuth(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Maps API error ${res.status}`);
  return res.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
    const clientId = env("GOOGLE_CLIENT_ID");
    const clientSecret = env("GOOGLE_CLIENT_SECRET");

    const body = await req.json();
    const { service, action, ...params } = body;

    let result: unknown;

    if (service === "gemini") {
      // Gemini uses API key — no user OAuth required
      result = await geminiHandler(action, params);
    } else if (service === "maps") {
      // Maps uses API key — no user OAuth needed
      const mapsKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
      if (!mapsKey) throw new Error("GOOGLE_MAPS_API_KEY not set");
      const b = "https://maps.googleapis.com";
      if (action === "geocode") result = await gFetchNoAuth(`${b}/maps/api/geocode/json?${new URLSearchParams({ address: params.address, key: mapsKey })}`);
      else if (action === "reverse_geocode") result = await gFetchNoAuth(`${b}/maps/api/geocode/json?${new URLSearchParams({ latlng: params.latlng, key: mapsKey })}`);
      else if (action === "search_places") result = await gFetchNoAuth(`${b}/maps/api/place/textsearch/json?${new URLSearchParams({ query: params.query, key: mapsKey, ...(params.location ? { location: params.location } : {}), ...(params.radius ? { radius: String(params.radius) } : {}) })}`);
      else if (action === "get_place_details") result = await gFetchNoAuth(`${b}/maps/api/place/details/json?${new URLSearchParams({ place_id: params.placeId, key: mapsKey, fields: params.fields ?? "name,formatted_address,geometry,rating,user_ratings_total,price_level,types,formatted_phone_number,website" })}`);
      else if (action === "nearby_search") result = await gFetchNoAuth(`${b}/maps/api/place/nearbysearch/json?${new URLSearchParams({ location: params.location, radius: String(params.radius ?? 1000), type: params.type ?? "establishment", key: mapsKey })}`);
      else if (action === "get_directions") result = await gFetchNoAuth(`${b}/maps/api/directions/json?${new URLSearchParams({ origin: params.origin, destination: params.destination, mode: params.mode ?? "driving", key: mapsKey })}`);
      else if (action === "distance_matrix") result = await gFetchNoAuth(`${b}/maps/api/distancematrix/json?${new URLSearchParams({ origins: params.origins, destinations: params.destinations, key: mapsKey })}`);
      else throw new Error(`Unknown Maps action: ${action}`);
    } else {
      // Allow any agent (service key caller) to pass the user id via header
      // Frontend calls fall back to verifying the JWT from Authorization
      const agentUserId = req.headers.get("x-atlas-user-id");
      const userId = agentUserId ?? await verifyUser(supabaseUrl, serviceKey, req.headers.get("authorization"));
      const token = await getValidToken(supabaseUrl, serviceKey, clientId, clientSecret, userId);

      if (service === "gmail") result = await gmailHandler(token, action, params);
      else if (service === "calendar") result = await calendarHandler(token, action, params);
      else if (service === "drive") result = await driveHandler(token, action, params);
      else if (service === "sheets") result = await sheetsHandler(token, action, params);
      else if (service === "docs") result = await docsHandler(token, action, params);
      else if (service === "slides") result = await slidesHandler(token, action, params);
      else if (service === "forms") result = await formsHandler(token, action, params);
      else if (service === "contacts") result = await contactsHandler(token, action, params);
      else if (service === "tasks") result = await tasksHandler(token, action, params);
      else if (service === "youtube") result = await youtubeHandler(token, action, params);
      else if (service === "search_console") result = await searchConsoleHandler(token, action, params);
      else if (service === "analytics") result = await analyticsHandler(token, action, params);
      else if (service === "chat") result = await chatHandler(token, action, params);
      else throw new Error(`Unknown service: ${service}`);
    }

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
