import { supabase } from "@/integrations/supabase/client";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase-url";

async function authHeader(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not authenticated");
  return `Bearer ${token}`;
}

async function callOAuth(body: Record<string, unknown>) {
  const auth = await authHeader();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/airtable-oauth`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Airtable OAuth error");
  return data;
}

async function callApi(body: Record<string, unknown>) {
  const auth = await authHeader();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/airtable-api`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Airtable API error");
  return data;
}

const REDIRECT_URI = typeof window !== "undefined" ? `${window.location.origin}/auth/airtable/callback` : "";
const VERIFIER_KEY = "airtable_pkce_verifier";

export interface AirtableBase { id: string; name: string; permissionLevel: string }
export interface AirtableField { id: string; name: string; type: string; options?: Record<string, unknown> }
export interface AirtableTable { id: string; name: string; primaryFieldId: string; fields: AirtableField[] }
export interface AirtableRecord { id: string; createdTime: string; fields: Record<string, unknown> }

export const airtable = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  async getAuthUrl(): Promise<string> {
    const { url, code_verifier } = await callOAuth({ action: "get_auth_url", redirect_uri: REDIRECT_URI }) as { url: string; code_verifier: string };
    sessionStorage.setItem(VERIFIER_KEY, code_verifier);
    return url;
  },
  exchangeCode: (code: string, state: string) => {
    const code_verifier = sessionStorage.getItem(VERIFIER_KEY) ?? "";
    sessionStorage.removeItem(VERIFIER_KEY);
    return callOAuth({ action: "exchange_code", code, state, code_verifier, redirect_uri: REDIRECT_URI }) as Promise<{ ok: boolean }>;
  },
  getStatus: () => callOAuth({ action: "get_token" }) as Promise<{ connected: boolean }>,
  disconnect: () => callOAuth({ action: "disconnect" }) as Promise<{ ok: boolean }>,

  // ── Diagnostics ───────────────────────────────────────────────────────────
  whoami: () => callApi({ action: "whoami" }) as Promise<{ id: string; email?: string; scopes?: string[] }>,

  // ── Schema ────────────────────────────────────────────────────────────────
  listBases: () => callApi({ action: "list_bases" }) as Promise<{ bases: AirtableBase[] }>,
  listTables: (baseId: string) => callApi({ action: "list_tables", baseId }) as Promise<{ tables: AirtableTable[] }>,

  // ── Records ───────────────────────────────────────────────────────────────
  listRecords: (baseId: string, table: string, opts: { pageSize?: number; offset?: string } = {}) =>
    callApi({ action: "list_records", baseId, table, ...opts }) as Promise<{ records: AirtableRecord[]; offset?: string }>,
  createRecord: (baseId: string, table: string, fields: Record<string, unknown>) =>
    callApi({ action: "create_record", baseId, table, fields }) as Promise<AirtableRecord>,
  updateRecord: (baseId: string, table: string, recordId: string, fields: Record<string, unknown>) =>
    callApi({ action: "update_record", baseId, table, recordId, fields }) as Promise<AirtableRecord>,
  deleteRecord: (baseId: string, table: string, recordId: string) =>
    callApi({ action: "delete_record", baseId, table, recordId }) as Promise<{ id: string; deleted: boolean }>,
};
