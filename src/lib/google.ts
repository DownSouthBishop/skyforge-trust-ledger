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
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      },
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
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Google API error");
  return data;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const google = {
  /** Returns the Google OAuth consent URL. Redirect the user there. */
  getAuthUrl: () => callOAuth({ action: "get_auth_url" }) as Promise<{ url: string }>,

  /** Exchange the OAuth code returned by Google after consent. */
  exchangeCode: (code: string, state: string) =>
    callOAuth({ action: "exchange_code", code, state }) as Promise<{ ok: boolean }>,

  /** Check if Google is connected (returns { connected: boolean }). */
  getStatus: () => callOAuth({ action: "get_token" }) as Promise<{ connected: boolean; access_token?: string }>,

  /** Revoke stored tokens and disconnect Google. */
  disconnect: () => callOAuth({ action: "disconnect" }) as Promise<{ ok: boolean }>,

  // ── Gmail ─────────────────────────────────────────────────────────────────

  gmail: {
    listThreads: (query?: string, maxResults = 20) =>
      callApi({ service: "gmail", action: "list_threads", query, maxResults }),

    getThread: (threadId: string) =>
      callApi({ service: "gmail", action: "get_thread", threadId }),

    listMessages: (query?: string, maxResults = 20) =>
      callApi({ service: "gmail", action: "list_messages", query, maxResults }),

    getMessage: (messageId: string) =>
      callApi({ service: "gmail", action: "get_message", messageId }),

    send: (to: string, subject: string, body: string, cc?: string, bcc?: string) =>
      callApi({ service: "gmail", action: "send", to, subject, body, cc, bcc }),

    createDraft: (to: string, subject: string, body: string) =>
      callApi({ service: "gmail", action: "create_draft", to, subject, body }),

    modifyLabels: (messageId: string, addLabelIds: string[], removeLabelIds: string[]) =>
      callApi({ service: "gmail", action: "modify_labels", messageId, addLabelIds, removeLabelIds }),

    listLabels: () => callApi({ service: "gmail", action: "list_labels" }),
  },

  // ── Calendar ──────────────────────────────────────────────────────────────

  calendar: {
    listCalendars: () => callApi({ service: "calendar", action: "list_calendars" }),

    listEvents: (opts: {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      query?: string;
      maxResults?: number;
    } = {}) => callApi({ service: "calendar", action: "list_events", ...opts }),

    getEvent: (eventId: string, calendarId = "primary") =>
      callApi({ service: "calendar", action: "get_event", eventId, calendarId }),

    createEvent: (event: Record<string, unknown>, calendarId = "primary") =>
      callApi({ service: "calendar", action: "create_event", event, calendarId }),

    updateEvent: (eventId: string, event: Record<string, unknown>, calendarId = "primary") =>
      callApi({ service: "calendar", action: "update_event", eventId, event, calendarId }),

    deleteEvent: (eventId: string, calendarId = "primary") =>
      callApi({ service: "calendar", action: "delete_event", eventId, calendarId }),
  },

  // ── Drive ─────────────────────────────────────────────────────────────────

  drive: {
    listFiles: (opts: { query?: string; folderId?: string; pageSize?: number } = {}) =>
      callApi({ service: "drive", action: "list_files", ...opts }),

    getFile: (fileId: string) => callApi({ service: "drive", action: "get_file", fileId }),

    readFile: (fileId: string) => callApi({ service: "drive", action: "read_file", fileId }),

    createFolder: (name: string, parentId?: string) =>
      callApi({ service: "drive", action: "create_folder", name, parentId }),

    deleteFile: (fileId: string) => callApi({ service: "drive", action: "delete_file", fileId }),

    search: (query: string, pageSize = 20) =>
      callApi({ service: "drive", action: "search", query, pageSize }),
  },

  // ── Sheets ────────────────────────────────────────────────────────────────

  sheets: {
    getSpreadsheet: (spreadsheetId: string) =>
      callApi({ service: "sheets", action: "get_spreadsheet", spreadsheetId }),

    getValues: (spreadsheetId: string, range: string) =>
      callApi({ service: "sheets", action: "get_values", spreadsheetId, range }),

    updateValues: (spreadsheetId: string, range: string, values: unknown[][]) =>
      callApi({ service: "sheets", action: "update_values", spreadsheetId, range, values }),

    appendValues: (spreadsheetId: string, range: string, values: unknown[][]) =>
      callApi({ service: "sheets", action: "append_values", spreadsheetId, range, values }),

    createSpreadsheet: (title: string) =>
      callApi({ service: "sheets", action: "create_spreadsheet", title }),

    batchUpdate: (spreadsheetId: string, requests: unknown[]) =>
      callApi({ service: "sheets", action: "batch_update", spreadsheetId, requests }),
  },
};
