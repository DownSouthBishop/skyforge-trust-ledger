import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, RefreshCw, Plus, Trash2, Link2, CheckCircle2, XCircle } from "lucide-react";
import { airtable, type AirtableBase, type AirtableTable, type AirtableRecord, type AirtableField } from "@/lib/airtable";

const POLL_MS = 8000;

const EDITABLE_TYPES = new Set([
  "singleLineText", "multilineText", "email", "url", "phoneNumber",
  "number", "checkbox", "singleSelect", "multipleSelects", "date",
]);

function fieldChoices(field: AirtableField): string[] {
  const options = field.options as { choices?: { name: string }[] } | undefined;
  return options?.choices?.map((c) => c.name) ?? [];
}

function linkedTableId(field: AirtableField): string | undefined {
  const options = field.options as { linkedTableId?: string } | undefined;
  return options?.linkedTableId;
}

export default function AirtablePage() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [bases, setBases] = useState<AirtableBase[]>([]);
  const [baseId, setBaseId] = useState<string>("");
  const [tables, setTables] = useState<AirtableTable[]>([]);
  const [tableId, setTableId] = useState<string>("");
  const [records, setRecords] = useState<AirtableRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ recordId: string; fieldId: string } | null>(null);
  const [linkLabels, setLinkLabels] = useState<Record<string, Record<string, string>>>({});

  const inFlight = useRef(false);

  const checkConnection = useCallback(async () => {
    try {
      const r = await airtable.getStatus();
      setConnected(r.connected);
      return r.connected;
    } catch {
      setConnected(false);
      return false;
    }
  }, []);

  useEffect(() => { checkConnection(); }, [checkConnection]);

  useEffect(() => {
    if (!connected) return;
    airtable.listBases().then((r) => {
      setBases(r.bases ?? []);
      if (!baseId && r.bases?.length) setBaseId(r.bases[0].id);
    }).catch((e) => toast.error("Failed to list bases: " + e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  useEffect(() => {
    if (!baseId) return;
    airtable.listTables(baseId).then((r) => {
      setTables(r.tables ?? []);
      if (r.tables?.length) setTableId(r.tables[0].id);
    }).catch((e) => toast.error("Failed to list tables: " + e.message));
  }, [baseId]);

  const table = tables.find((t) => t.id === tableId);

  const loadRecords = useCallback(async () => {
    if (!baseId || !tableId || inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await airtable.listRecords(baseId, tableId, { pageSize: 100 });
      setRecords(r.records ?? []);
    } catch (e) {
      toast.error("Failed to load records: " + (e as Error).message);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [baseId, tableId]);

  useEffect(() => {
    if (!tableId) return;
    setLoading(true);
    loadRecords();
    const interval = setInterval(loadRecords, POLL_MS);
    return () => clearInterval(interval);
  }, [tableId, loadRecords]);

  // Lazily resolve display labels for linked-record chips
  useEffect(() => {
    if (!table) return;
    const linkFields = table.fields.filter((f) => f.type === "multipleRecordLinks");
    for (const f of linkFields) {
      const linkedId = linkedTableId(f);
      if (!linkedId || linkLabels[linkedId]) continue;
      airtable.listRecords(baseId, linkedId, { pageSize: 100 }).then((r) => {
        const linkedTable = tables.find((t) => t.id === linkedId);
        const primaryField = linkedTable?.fields.find((f) => f.id === linkedTable.primaryFieldId);
        const map: Record<string, string> = {};
        for (const rec of r.records ?? []) {
          const label = primaryField ? rec.fields[primaryField.name] : undefined;
          map[rec.id] = (label as string) ?? (Object.values(rec.fields)[0] as string) ?? rec.id;
        }
        setLinkLabels((prev) => ({ ...prev, [linkedId]: map }));
      }).catch(() => { /* best-effort; fall back to raw IDs */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, baseId]);

  async function handleConnect() {
    setConnecting(true);
    try {
      const url = await airtable.getAuthUrl();
      window.location.href = url;
    } catch (e) {
      toast.error("Failed to start Airtable auth: " + (e as Error).message);
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setConnecting(true);
    try {
      await airtable.disconnect();
      setConnected(false);
      setBases([]); setTables([]); setRecords([]);
      toast.success("Airtable account disconnected.");
    } catch (e) {
      toast.error("Disconnect failed: " + (e as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  async function saveField(recordId: string, fieldId: string, fieldName: string, value: unknown) {
    const prev = records;
    setRecords((rs) => rs.map((r) => (r.id === recordId ? { ...r, fields: { ...r.fields, [fieldName]: value } } : r)));
    setEditing(null);
    try {
      await airtable.updateRecord(baseId, tableId, recordId, { [fieldName]: value });
    } catch (e) {
      setRecords(prev);
      toast.error("Save failed: " + (e as Error).message);
    }
  }

  async function addRecord() {
    try {
      const rec = await airtable.createRecord(baseId, tableId, {});
      setRecords((rs) => [rec, ...rs]);
    } catch (e) {
      toast.error("Create failed: " + (e as Error).message);
    }
  }

  async function deleteRecord(recordId: string) {
    if (!confirm("Delete this record from Airtable? This can't be undone.")) return;
    const prev = records;
    setRecords((rs) => rs.filter((r) => r.id !== recordId));
    try {
      await airtable.deleteRecord(baseId, tableId, recordId);
      toast.success("Record deleted.");
    } catch (e) {
      setRecords(prev);
      toast.error("Delete failed: " + (e as Error).message);
    }
  }

  function renderCell(rec: AirtableRecord, field: AirtableField) {
    const value = rec.fields[field.name];
    const isEditing = editing?.recordId === rec.id && editing?.fieldId === field.id;

    if (field.type === "multipleRecordLinks") {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const linkedId = linkedTableId(field);
      const labels = linkedId ? linkLabels[linkedId] : undefined;
      return (
        <div className="flex flex-wrap gap-1">
          {ids.map((id) => (
            <span key={id} className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent flex items-center gap-1">
              <Link2 className="h-2.5 w-2.5" />{labels?.[id] ?? id}
            </span>
          ))}
          {ids.length === 0 && <span className="text-muted-foreground/30 text-xs">—</span>}
        </div>
      );
    }

    if (field.type === "multipleAttachments") {
      const atts = Array.isArray(value) ? (value as { id: string; url: string; filename: string }[]) : [];
      return (
        <div className="flex flex-wrap gap-1">
          {atts.map((a) => (
            <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="text-[10px] text-primary/70 underline underline-offset-2">
              {a.filename}
            </a>
          ))}
          {atts.length === 0 && <span className="text-muted-foreground/30 text-xs">—</span>}
        </div>
      );
    }

    if (!EDITABLE_TYPES.has(field.type)) {
      return <span className="text-xs text-muted-foreground/60">{value != null ? String(value) : "—"}</span>;
    }

    if (field.type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => saveField(rec.id, field.id, field.name, e.target.checked)}
          className="h-3.5 w-3.5"
        />
      );
    }

    if (isEditing && field.type === "singleSelect") {
      const choices = fieldChoices(field);
      return (
        <select
          autoFocus
          value={(value as string) ?? ""}
          onChange={(e) => saveField(rec.id, field.id, field.name, e.target.value || null)}
          onBlur={() => setEditing(null)}
          className="bg-secondary/20 border border-border/30 rounded px-1.5 py-0.5 text-xs text-foreground outline-none"
        >
          <option value="">—</option>
          {choices.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      );
    }

    if (isEditing) {
      const inputType = field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
      const initial = field.type === "multipleSelects" && Array.isArray(value) ? (value as string[]).join(", ") : (value ?? "");
      return (
        <Input
          autoFocus
          type={inputType}
          defaultValue={initial as string | number}
          className="h-6 text-xs px-1.5"
          onBlur={(e) => {
            let v: unknown = e.target.value;
            if (field.type === "number") v = e.target.value === "" ? null : Number(e.target.value);
            if (field.type === "multipleSelects") v = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
            saveField(rec.id, field.id, field.name, v);
          }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(null); }}
        />
      );
    }

    const display = Array.isArray(value) ? value.join(", ") : value;
    return (
      <button
        onClick={() => setEditing({ recordId: rec.id, fieldId: field.id })}
        className="text-xs text-foreground/80 text-left hover:bg-secondary/20 rounded px-1 py-0.5 -mx-1 w-full truncate"
        title={display != null ? String(display) : ""}
      >
        {display != null && display !== "" ? String(display) : <span className="text-muted-foreground/30">—</span>}
      </button>
    );
  }

  if (connected === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="p-6 max-w-lg mx-auto space-y-4 text-center">
        <h1 className="font-display text-lg tracking-widest text-primary">AIRTABLE</h1>
        <p className="text-xs text-muted-foreground/60">Connect your Airtable account to browse and edit bases directly from Skyforge.</p>
        <Button onClick={handleConnect} disabled={connecting} className="bg-blue-700 hover:bg-blue-600 text-white">
          {connecting && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
          Connect Airtable Account
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-sm font-display tracking-widest text-primary uppercase flex items-center gap-2">
            AIRTABLE
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-900/40 text-green-400 flex items-center gap-1">
              <CheckCircle2 className="h-2.5 w-2.5" />Connected
            </span>
          </h1>
          <p className="text-xs text-muted-foreground/60 mt-0.5">Live view, polling every {POLL_MS / 1000}s. Editable fields save straight back to Airtable.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={loadRecords} className="text-xs gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={handleDisconnect} disabled={connecting} className="text-xs text-muted-foreground hover:text-destructive">
            <XCircle className="h-3.5 w-3.5 mr-1" />Disconnect
          </Button>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <select value={baseId} onChange={(e) => { setBaseId(e.target.value); setTableId(""); setRecords([]); }} className="bg-secondary/20 border border-border/30 rounded-md px-3 py-2 text-xs text-foreground outline-none">
          {bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      <div className="flex gap-1 flex-wrap">
        {tables.map((t) => (
          <button
            key={t.id}
            onClick={() => { setTableId(t.id); setRecords([]); }}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${tableId === t.id ? "border-accent/60 bg-accent/10 text-accent" : "border-border/40 text-muted-foreground hover:border-border/70"}`}
          >
            {t.name}
          </button>
        ))}
      </div>

      {table && (
        <div className="glass-card overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border/20">
                {table.fields.map((f) => (
                  <th key={f.id} className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground/60 whitespace-nowrap">{f.name}</th>
                ))}
                <th className="px-3 py-2 w-8" />
              </tr>
            </thead>
            <tbody>
              {records.map((rec) => (
                <tr key={rec.id} className="border-b border-border/10 hover:bg-secondary/5">
                  {table.fields.map((f) => (
                    <td key={f.id} className="px-3 py-1.5 min-w-[120px] max-w-[240px]">{renderCell(rec, f)}</td>
                  ))}
                  <td className="px-3 py-1.5">
                    <button onClick={() => deleteRecord(rec.id)} className="text-muted-foreground/30 hover:text-destructive transition-colors">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {records.length === 0 && !loading && (
                <tr><td colSpan={table.fields.length + 1} className="px-3 py-8 text-center text-xs text-muted-foreground/50">No records.</td></tr>
              )}
            </tbody>
          </table>
          <div className="p-2 border-t border-border/10">
            <Button size="sm" variant="ghost" onClick={addRecord} className="text-xs gap-1.5 text-muted-foreground hover:text-foreground">
              <Plus className="h-3.5 w-3.5" />Add record
            </Button>
          </div>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground/40">
        Linked-record and attachment fields are shown live but read-only here — edit those directly in Airtable. All other field types save back immediately.
      </p>
    </div>
  );
}
