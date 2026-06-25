import { supabase } from "@/integrations/supabase/client";

async function authHeader(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not authenticated");
  return `Bearer ${token}`;
}

async function callOAuth(body: Record<string, unknown>) {
  const auth = await authHeader();
  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-oauth`,
    {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json", apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Google OAuth error");
  return data;
}

async function callApi(body: Record<string, unknown>) {
  const auth = await authHeader();
  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-api`,
    {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json", apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Google API error");
  return data;
}

export const google = {
  // ── Auth ────────────────────────────────────────────────────────────────────
  getAuthUrl: () => callOAuth({ action: "get_auth_url" }) as Promise<{ url: string }>,
  exchangeCode: (code: string, state: string) => callOAuth({ action: "exchange_code", code, state }) as Promise<{ ok: boolean }>,
  getStatus: () => callOAuth({ action: "get_token" }) as Promise<{ connected: boolean; access_token?: string }>,
  disconnect: () => callOAuth({ action: "disconnect" }) as Promise<{ ok: boolean }>,

  // ── Gmail ────────────────────────────────────────────────────────────────────
  gmail: {
    listThreads: (query?: string, maxResults = 20) => callApi({ service: "gmail", action: "list_threads", query, maxResults }),
    getThread: (threadId: string) => callApi({ service: "gmail", action: "get_thread", threadId }),
    listMessages: (query?: string, maxResults = 20) => callApi({ service: "gmail", action: "list_messages", query, maxResults }),
    getMessage: (messageId: string) => callApi({ service: "gmail", action: "get_message", messageId }),
    send: (to: string, subject: string, body: string, cc?: string, bcc?: string) => callApi({ service: "gmail", action: "send", to, subject, body, cc, bcc }),
    createDraft: (to: string, subject: string, body: string) => callApi({ service: "gmail", action: "create_draft", to, subject, body }),
    modifyLabels: (messageId: string, addLabelIds: string[], removeLabelIds: string[]) => callApi({ service: "gmail", action: "modify_labels", messageId, addLabelIds, removeLabelIds }),
    listLabels: () => callApi({ service: "gmail", action: "list_labels" }),
    getProfile: () => callApi({ service: "gmail", action: "get_profile" }),
    trash: (messageId: string) => callApi({ service: "gmail", action: "trash", messageId }),
    untrash: (messageId: string) => callApi({ service: "gmail", action: "untrash", messageId }),
  },

  // ── Calendar ─────────────────────────────────────────────────────────────────
  calendar: {
    listCalendars: () => callApi({ service: "calendar", action: "list_calendars" }),
    listEvents: (opts: { calendarId?: string; timeMin?: string; timeMax?: string; query?: string; maxResults?: number } = {}) => callApi({ service: "calendar", action: "list_events", ...opts }),
    getEvent: (eventId: string, calendarId = "primary") => callApi({ service: "calendar", action: "get_event", eventId, calendarId }),
    createEvent: (event: Record<string, unknown>, calendarId = "primary") => callApi({ service: "calendar", action: "create_event", event, calendarId }),
    updateEvent: (eventId: string, event: Record<string, unknown>, calendarId = "primary") => callApi({ service: "calendar", action: "update_event", eventId, event, calendarId }),
    deleteEvent: (eventId: string, calendarId = "primary") => callApi({ service: "calendar", action: "delete_event", eventId, calendarId }),
    quickAdd: (text: string, calendarId = "primary") => callApi({ service: "calendar", action: "quick_add", text, calendarId }),
    listAcl: (calendarId = "primary") => callApi({ service: "calendar", action: "list_acl", calendarId }),
  },

  // ── Drive ────────────────────────────────────────────────────────────────────
  drive: {
    listFiles: (opts: { query?: string; folderId?: string; pageSize?: number } = {}) => callApi({ service: "drive", action: "list_files", ...opts }),
    getFile: (fileId: string) => callApi({ service: "drive", action: "get_file", fileId }),
    readFile: (fileId: string) => callApi({ service: "drive", action: "read_file", fileId }),
    createFolder: (name: string, parentId?: string) => callApi({ service: "drive", action: "create_folder", name, parentId }),
    deleteFile: (fileId: string) => callApi({ service: "drive", action: "delete_file", fileId }),
    search: (query: string, pageSize = 20) => callApi({ service: "drive", action: "search", query, pageSize }),
    copyFile: (fileId: string, name: string) => callApi({ service: "drive", action: "copy_file", fileId, name }),
    moveFile: (fileId: string, newParentId: string, oldParentId: string) => callApi({ service: "drive", action: "move_file", fileId, newParentId, oldParentId }),
    getStorage: () => callApi({ service: "drive", action: "get_storage" }),
  },

  // ── Sheets ────────────────────────────────────────────────────────────────────
  sheets: {
    getSpreadsheet: (spreadsheetId: string) => callApi({ service: "sheets", action: "get_spreadsheet", spreadsheetId }),
    getValues: (spreadsheetId: string, range: string) => callApi({ service: "sheets", action: "get_values", spreadsheetId, range }),
    updateValues: (spreadsheetId: string, range: string, values: unknown[][]) => callApi({ service: "sheets", action: "update_values", spreadsheetId, range, values }),
    appendValues: (spreadsheetId: string, range: string, values: unknown[][]) => callApi({ service: "sheets", action: "append_values", spreadsheetId, range, values }),
    clearValues: (spreadsheetId: string, range: string) => callApi({ service: "sheets", action: "clear_values", spreadsheetId, range }),
    createSpreadsheet: (title: string) => callApi({ service: "sheets", action: "create_spreadsheet", title }),
    batchUpdate: (spreadsheetId: string, requests: unknown[]) => callApi({ service: "sheets", action: "batch_update", spreadsheetId, requests }),
    addSheet: (spreadsheetId: string, title: string) => callApi({ service: "sheets", action: "add_sheet", spreadsheetId, title }),
  },

  // ── Docs ──────────────────────────────────────────────────────────────────────
  docs: {
    getDocument: (documentId: string) => callApi({ service: "docs", action: "get_document", documentId }),
    createDocument: (title: string) => callApi({ service: "docs", action: "create_document", title }),
    batchUpdate: (documentId: string, requests: unknown[]) => callApi({ service: "docs", action: "batch_update", documentId, requests }),
    insertText: (documentId: string, text: string, index = 1) => callApi({ service: "docs", action: "insert_text", documentId, text, index }),
  },

  // ── Slides ────────────────────────────────────────────────────────────────────
  slides: {
    getPresentation: (presentationId: string) => callApi({ service: "slides", action: "get_presentation", presentationId }),
    createPresentation: (title: string) => callApi({ service: "slides", action: "create_presentation", title }),
    batchUpdate: (presentationId: string, requests: unknown[]) => callApi({ service: "slides", action: "batch_update", presentationId, requests }),
  },

  // ── Forms ─────────────────────────────────────────────────────────────────────
  forms: {
    getForm: (formId: string) => callApi({ service: "forms", action: "get_form", formId }),
    listResponses: (formId: string) => callApi({ service: "forms", action: "list_responses", formId }),
    getResponse: (formId: string, responseId: string) => callApi({ service: "forms", action: "get_response", formId, responseId }),
  },

  // ── Contacts ──────────────────────────────────────────────────────────────────
  contacts: {
    listContacts: (opts: { personFields?: string; pageSize?: number } = {}) => callApi({ service: "contacts", action: "list_contacts", ...opts }),
    getContact: (resourceName: string) => callApi({ service: "contacts", action: "get_contact", resourceName }),
    searchContacts: (query: string, pageSize = 10) => callApi({ service: "contacts", action: "search_contacts", query, pageSize }),
    createContact: (person: Record<string, unknown>) => callApi({ service: "contacts", action: "create_contact", person }),
    updateContact: (resourceName: string, person: Record<string, unknown>, updatePersonFields?: string) => callApi({ service: "contacts", action: "update_contact", resourceName, person, updatePersonFields }),
    deleteContact: (resourceName: string) => callApi({ service: "contacts", action: "delete_contact", resourceName }),
    listDirectory: (pageSize = 50) => callApi({ service: "contacts", action: "list_directory", pageSize }),
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────────
  tasks: {
    listTasklists: () => callApi({ service: "tasks", action: "list_tasklists" }),
    listTasks: (tasklistId?: string, opts: { showCompleted?: boolean; maxResults?: number } = {}) => callApi({ service: "tasks", action: "list_tasks", tasklistId, ...opts }),
    getTask: (taskId: string, tasklistId?: string) => callApi({ service: "tasks", action: "get_task", taskId, tasklistId }),
    createTask: (task: Record<string, unknown>, tasklistId?: string) => callApi({ service: "tasks", action: "create_task", task, tasklistId }),
    updateTask: (taskId: string, task: Record<string, unknown>, tasklistId?: string) => callApi({ service: "tasks", action: "update_task", taskId, task, tasklistId }),
    completeTask: (taskId: string, tasklistId?: string) => callApi({ service: "tasks", action: "complete_task", taskId, tasklistId }),
    deleteTask: (taskId: string, tasklistId?: string) => callApi({ service: "tasks", action: "delete_task", taskId, tasklistId }),
  },

  // ── YouTube ───────────────────────────────────────────────────────────────────
  youtube: {
    search: (query: string, opts: { maxResults?: number; type?: string } = {}) => callApi({ service: "youtube", action: "search", query, ...opts }),
    getVideo: (videoId: string) => callApi({ service: "youtube", action: "get_video", videoId }),
    listChannelVideos: (channelId: string, maxResults = 20) => callApi({ service: "youtube", action: "list_channel_videos", channelId, maxResults }),
    getChannel: (channelId?: string) => callApi({ service: "youtube", action: "get_channel", channelId }),
    listPlaylists: (maxResults = 20) => callApi({ service: "youtube", action: "list_playlists", maxResults }),
    listSubscriptions: (maxResults = 50) => callApi({ service: "youtube", action: "list_subscriptions", maxResults }),
    getMyChannel: () => callApi({ service: "youtube", action: "get_my_channel" }),
    listComments: (videoId: string, maxResults = 20) => callApi({ service: "youtube", action: "list_comments", videoId, maxResults }),
  },

  // ── Search Console ────────────────────────────────────────────────────────────
  searchConsole: {
    listSites: () => callApi({ service: "search_console", action: "list_sites" }),
    querySearchAnalytics: (siteUrl: string, opts: { startDate: string; endDate: string; dimensions?: string[]; rowLimit?: number }) => callApi({ service: "search_console", action: "query_search_analytics", siteUrl, ...opts }),
    listSitemaps: (siteUrl: string) => callApi({ service: "search_console", action: "list_sitemaps", siteUrl }),
  },

  // ── Analytics (GA4) ──────────────────────────────────────────────────────────
  analytics: {
    runReport: (propertyId: string, opts: { dateRanges?: unknown[]; dimensions?: unknown[]; metrics?: unknown[]; limit?: number } = {}) => callApi({ service: "analytics", action: "run_report", propertyId, ...opts }),
    runRealtimeReport: (propertyId: string, opts: { dimensions?: unknown[]; metrics?: unknown[] } = {}) => callApi({ service: "analytics", action: "run_realtime_report", propertyId, ...opts }),
    listAccounts: () => callApi({ service: "analytics", action: "list_accounts" }),
    listProperties: (accountId: string) => callApi({ service: "analytics", action: "list_properties", accountId }),
  },

  // ── Chat ──────────────────────────────────────────────────────────────────────
  chat: {
    listSpaces: () => callApi({ service: "chat", action: "list_spaces" }),
    getSpace: (spaceName: string) => callApi({ service: "chat", action: "get_space", spaceName }),
    listMessages: (spaceName: string, pageSize = 25) => callApi({ service: "chat", action: "list_messages", spaceName, pageSize }),
    sendMessage: (spaceName: string, text: string) => callApi({ service: "chat", action: "send_message", spaceName, text }),
    listMembers: (spaceName: string) => callApi({ service: "chat", action: "list_members", spaceName }),
  },

  // ── Gemini AI (API key — no OAuth needed) ────────────────────────────────────
  gemini: {
    generateContent: (prompt: string, opts: { system?: string; model?: string; maxOutputTokens?: number; messages?: Array<{ role: string; content: string }> } = {}) =>
      callApi({ service: "gemini", action: "generate_content", prompt, ...opts }),
    embedContent: (text: string, model?: string) => callApi({ service: "gemini", action: "embed_content", text, model }),
    listModels: () => callApi({ service: "gemini", action: "list_models" }),
  },

  // ── Maps (API key — no OAuth needed) ─────────────────────────────────────────
  maps: {
    geocode: (address: string) => callApi({ service: "maps", action: "geocode", address }),
    reverseGeocode: (latlng: string) => callApi({ service: "maps", action: "reverse_geocode", latlng }),
    searchPlaces: (query: string, opts: { location?: string; radius?: number } = {}) => callApi({ service: "maps", action: "search_places", query, ...opts }),
    getPlaceDetails: (placeId: string, fields?: string) => callApi({ service: "maps", action: "get_place_details", placeId, fields }),
    nearbySearch: (location: string, opts: { radius?: number; type?: string } = {}) => callApi({ service: "maps", action: "nearby_search", location, ...opts }),
    getDirections: (origin: string, destination: string, mode?: string) => callApi({ service: "maps", action: "get_directions", origin, destination, mode }),
    distanceMatrix: (origins: string, destinations: string) => callApi({ service: "maps", action: "distance_matrix", origins, destinations }),
  },
};
