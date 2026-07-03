// Shared Airtable access for any agent (Atlas, Linda, Janus/agent-chat, and the
// reflection loop). Full read/write against the operator's "Multi-Company
// Command Center" base -- Companies, People, Teams, Projects, Milestones, Tasks,
// all linked by record ID.

const BASE_ID = "appGr592LCUvJgYml";

const KNOWN_TABLES = ["Companies", "People", "Teams", "Projects", "Milestones", "Tasks"];

function airtableHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
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
