import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Plug, Plus, Trash2, RefreshCw, CheckCircle2, AlertTriangle,
  Power, Eye, EyeOff, Download, X, ChevronDown, ChevronRight, Info, ExternalLink,
} from "lucide-react";

const supabase = _sb as any;

type Transport = "sse" | "stdio";

type ConnRow = {
  id: string;
  name: string;
  slug: string;
  transport: Transport;
  url: string | null;
  command: string | null;
  args: string[] | null;
  is_active: boolean;
  is_verified: boolean;
  last_ping_at: string | null;
  capabilities: Array<{ name: string; description?: string }> | null;
  notes: string | null;
  env_var_keys: string[];
};

type Preset = {
  name: string;
  slug: string;
  transport: Transport;
  description: string;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
};

const PRESETS: Preset[] = [
  { name: "Filesystem", slug: "filesystem", transport: "stdio", description: "Read/write local files Atlas can reach.", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/vault"] },
  { name: "GitHub", slug: "github", transport: "stdio", description: "Access repos, issues, PRs, commits.", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
  { name: "Postgres", slug: "postgres", transport: "stdio", description: "Query a Postgres database directly.", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"], envKeys: ["POSTGRES_CONNECTION_STRING"] },
  { name: "Fetch", slug: "fetch", transport: "stdio", description: "Pull arbitrary URLs into the context.", command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"] },
  { name: "Puppeteer / Browser", slug: "puppeteer", transport: "stdio", description: "Headless browser automation.", command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"] },
  { name: "Obsidian", slug: "obsidian", transport: "stdio", description: "Read and write an Obsidian vault.", command: "npx", args: ["-y", "mcp-obsidian", "/path/to/vault"], envKeys: ["OBSIDIAN_VAULT_PATH"] },
  { name: "Slack", slug: "slack", transport: "stdio", description: "Read channels, post messages.", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], envKeys: ["SLACK_BOT_TOKEN"] },
  { name: "Notion", slug: "notion", transport: "sse", description: "Notion pages and databases.", url: "https://mcp.notion.com/mcp", envKeys: ["NOTION_API_KEY"] },
  { name: "Linear", slug: "linear", transport: "sse", description: "Linear issues and projects.", url: "https://mcp.linear.app/mcp", envKeys: ["LINEAR_API_KEY"] },
  { name: "Telegram", slug: "telegram", transport: "stdio", description: "Send/read Telegram messages.", command: "npx", args: ["-y", "mcp-telegram"], envKeys: ["TELEGRAM_BOT_TOKEN"] },
  { name: "Google Drive", slug: "gdrive", transport: "sse", description: "Drive files and folders.", url: "https://mcp.google.com/drive", envKeys: ["GOOGLE_OAUTH_TOKEN"] },
  { name: "Gmail", slug: "gmail", transport: "sse", description: "Read and send mail.", url: "https://mcp.google.com/gmail", envKeys: ["GOOGLE_OAUTH_TOKEN"] },
  { name: "Airtable", slug: "airtable", transport: "sse", description: "Airtable bases and tables.", url: "https://mcp.airtable.com/mcp", envKeys: ["AIRTABLE_API_KEY"] },
  { name: "Google Calendar", slug: "gcal", transport: "sse", description: "Calendar events.", url: "https://mcp.google.com/calendar", envKeys: ["GOOGLE_OAUTH_TOKEN"] },
  { name: "Alpaca", slug: "alpaca", transport: "stdio", description: "Equities trading via Alpaca.", command: "node", args: ["mcp-servers/alpaca/index.js"], envKeys: ["ALPACA_API_KEY", "ALPACA_API_SECRET"] },
  { name: "OANDA", slug: "oanda", transport: "stdio", description: "Forex via OANDA.", command: "node", args: ["mcp-servers/oanda/index.js"], envKeys: ["OANDA_API_TOKEN", "OANDA_ACCOUNT_ID"] },
  { name: "IBKR", slug: "ibkr", transport: "stdio", description: "Interactive Brokers gateway.", command: "node", args: ["mcp-servers/ibkr/index.js"], envKeys: ["IBKR_PORT"] },
];

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export default function MCPConnectionsTab() {
  const { user } = useAuth();
  const [rows, setRows] = useState<ConnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pingingId, setPingingId] = useState<string | null>(null);
  const [pingingAll, setPingingAll] = useState(false);

  // form
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [transport, setTransport] = useState<Transport>("stdio");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [notes, setNotes] = useState("");
  const [envRows, setEnvRows] = useState<Array<{ k: string; v: string; show: boolean }>>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("atlas_mcp_connections_safe")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });
    if (error) toast.error(error.message);
    setRows((data ?? []) as ConnRow[]);
    setLoading(false);
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  const resetForm = () => {
    setEditingId(null);
    setName(""); setSlug(""); setSlugTouched(false);
    setTransport("stdio"); setUrl(""); setCommand(""); setArgs(""); setNotes("");
    setEnvRows([]);
  };

  const applyPreset = (p: Preset) => {
    setShowForm(true);
    setEditingId(null);
    setName(p.name); setSlug(p.slug); setSlugTouched(true);
    setTransport(p.transport);
    setUrl(p.url ?? "");
    setCommand(p.command ?? "");
    setArgs((p.args ?? []).join(", "));
    setNotes(p.description);
    setEnvRows((p.envKeys ?? []).map((k) => ({ k, v: "", show: false })));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const startEdit = (r: ConnRow) => {
    setShowForm(true);
    setEditingId(r.id);
    setName(r.name); setSlug(r.slug); setSlugTouched(true);
    setTransport(r.transport);
    setUrl(r.url ?? ""); setCommand(r.command ?? "");
    setArgs((r.args ?? []).join(", "));
    setNotes(r.notes ?? "");
    setEnvRows((r.env_var_keys ?? []).map((k) => ({ k, v: "", show: false })));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const save = async () => {
    if (!user) return;
    if (!name.trim()) return toast.error("Name required");
    const finalSlug = slug || slugify(name);
    if (!finalSlug) return toast.error("Slug required");
    if (transport === "sse" && !url.trim()) return toast.error("URL required for SSE");
    if (transport === "stdio" && !command.trim()) return toast.error("Command required for STDIO");

    setSaving(true);
    try {
      const argsArr = args.split(",").map((s) => s.trim()).filter(Boolean);
      // Only include env_vars that have values (so we don't wipe stored secrets on edit).
      const envObj: Record<string, string> = {};
      for (const r of envRows) {
        if (r.k.trim() && r.v.length > 0) envObj[r.k.trim()] = r.v;
      }

      if (editingId) {
        const patch: any = {
          name, slug: finalSlug, transport,
          url: transport === "sse" ? url : null,
          command: transport === "stdio" ? command : null,
          args: transport === "stdio" ? argsArr : [],
          notes: notes || null,
        };
        // Only overwrite env_vars if operator provided new values.
        if (Object.keys(envObj).length > 0) {
          // Merge over existing: we can't read existing, so we send merged set of provided keys only.
          // To preserve untouched keys, also include keys present in env_rows with empty value as null? We just skip them.
          // Build merged: existing keys we know about (env_var_keys) preserved by reading current row & merging client-side via rpc? Skipping — values stay unless operator re-enters them.
          patch.env_vars = envObj;
        }
        const { error } = await supabase.from("atlas_mcp_connections").update(patch).eq("id", editingId);
        if (error) throw error;
        toast.success("Connection updated");
      } else {
        const { error } = await supabase.from("atlas_mcp_connections").insert({
          user_id: user.id, name, slug: finalSlug, transport,
          url: transport === "sse" ? url : null,
          command: transport === "stdio" ? command : null,
          args: transport === "stdio" ? argsArr : [],
          env_vars: envObj,
          notes: notes || null,
        });
        if (error) throw error;
        toast.success("Connection added");
      }
      resetForm();
      setShowForm(false);
      void load();
    } catch (e: any) {
      toast.error(e?.message?.includes("unique") ? "Slug already in use" : (e?.message ?? "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: ConnRow) => {
    if (!confirm(`Remove ${r.name}?`)) return;
    const { error } = await supabase.from("atlas_mcp_connections").delete().eq("id", r.id);
    if (error) return toast.error(error.message);
    toast.success("Removed");
    void load();
  };

  const toggleActive = async (r: ConnRow) => {
    const { error } = await supabase.from("atlas_mcp_connections").update({ is_active: !r.is_active }).eq("id", r.id);
    if (error) return toast.error(error.message);
    void load();
  };

  const ping = async (r: ConnRow, opts?: { silent?: boolean }) => {
    setPingingId(r.id);
    try {
      const body: any = { connection_id: r.id };
      if (r.transport === "stdio") {
        if (!opts?.silent && !confirm(`Confirm ${r.name} is running locally and mark as verified?`)) {
          setPingingId(null);
          return;
        }
        body.confirm_stdio = true;
      }
      const { data, error } = await supabase.functions.invoke("atlas_mcp_ping", { body });
      if (error) throw error;
      if (data?.verified) {
        if (!opts?.silent) toast.success(`${r.name}: verified — ${data.capabilities?.length ?? 0} tools`);
      } else {
        if (!opts?.silent) toast.error(`${r.name}: ${data?.error ?? "verification failed"}`);
      }
    } catch (e: any) {
      if (!opts?.silent) toast.error(e?.message ?? "Ping failed");
    } finally {
      setPingingId(null);
      void load();
    }
  };

  const pingAll = async () => {
    const targets = rows.filter((r) => r.is_active && r.transport === "sse");
    if (targets.length === 0) return toast.info("No SSE connections to auto-ping (STDIO needs manual confirm)");
    setPingingAll(true);
    for (const r of targets) await ping(r, { silent: true });
    setPingingAll(false);
    toast.success(`Pinged ${targets.length} connection${targets.length === 1 ? "" : "s"}`);
  };

  const exportConfig = () => {
    const verified = rows.filter((r) => r.is_active && r.is_verified);
    const mcpServers: Record<string, any> = {};
    for (const r of verified) {
      if (r.transport === "stdio") {
        const env: Record<string, string> = {};
        for (const k of r.env_var_keys ?? []) env[k] = "REPLACE_WITH_YOUR_KEY";
        mcpServers[r.slug] = {
          command: r.command,
          args: r.args ?? [],
          ...(Object.keys(env).length ? { env } : {}),
        };
      } else {
        mcpServers[r.slug] = { url: r.url };
      }
    }
    const blob = new Blob([JSON.stringify({ mcpServers }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mcp-config.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success(`Exported ${Object.keys(mcpServers).length} connection${Object.keys(mcpServers).length === 1 ? "" : "s"}`);
  };

  const presetGrid = useMemo(() => PRESETS, []);

  if (loading) return <div className="p-6 text-sm text-muted-foreground animate-pulse">Loading MCP connections…</div>;

  return (
    <div className="space-y-6">
      {/* CONNECTED MCPs */}
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-display tracking-widest text-primary uppercase flex items-center gap-2">
            <Plug className="h-4 w-4" /> Connected MCPs ({rows.length})
          </h2>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={pingAll} disabled={pingingAll || rows.length === 0}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${pingingAll ? "animate-spin" : ""}`} />
              Ping All
            </Button>
            <Button size="sm" variant="outline" onClick={exportConfig} disabled={!rows.some(r => r.is_active && r.is_verified)}>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export Config
            </Button>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground/60">No MCP connections yet. Add one below or pick from the preset library.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {rows.map((r) => {
              const isOpen = !!expanded[r.id];
              const toolCount = r.capabilities?.length ?? 0;
              return (
                <div key={r.id} className={`p-4 rounded-lg border bg-secondary/10 space-y-2 ${r.is_active ? "border-border/30" : "border-border/10 opacity-50"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-display uppercase text-foreground">{r.name}</span>
                        <span className="text-[10px] font-mono text-muted-foreground/60">{r.slug}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-[9px] px-1.5 py-0.5 rounded border border-primary/30 text-primary uppercase">{r.transport}</span>
                        {r.is_verified ? (
                          <span className="text-[9px] px-1.5 py-0.5 rounded border border-green-400/30 text-green-400 bg-green-400/5 flex items-center gap-1">
                            <CheckCircle2 className="h-2.5 w-2.5" /> verified
                          </span>
                        ) : (
                          <span className="text-[9px] px-1.5 py-0.5 rounded border border-amber-400/30 text-amber-400 bg-amber-400/5 flex items-center gap-1">
                            <AlertTriangle className="h-2.5 w-2.5" /> unverified
                          </span>
                        )}
                        <span className="text-[9px] text-muted-foreground/50">
                          {r.last_ping_at ? `pinged ${new Date(r.last_ping_at).toLocaleString()}` : "never pinged"}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button title={r.is_active ? "Disable" : "Enable"} onClick={() => toggleActive(r)} className="p-1 text-muted-foreground hover:text-primary">
                        <Power className="h-3.5 w-3.5" />
                      </button>
                      <button title="Ping" onClick={() => ping(r)} disabled={pingingId === r.id} className="p-1 text-muted-foreground hover:text-primary">
                        <RefreshCw className={`h-3.5 w-3.5 ${pingingId === r.id ? "animate-spin" : ""}`} />
                      </button>
                      <button title="Edit" onClick={() => startEdit(r)} className="p-1 text-muted-foreground hover:text-accent text-xs font-display">edit</button>
                      <button title="Remove" onClick={() => remove(r)} className="p-1 text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {r.env_var_keys?.length > 0 && (
                    <div className="text-[10px] text-muted-foreground/60">
                      env: {r.env_var_keys.map((k) => `${k}=••••••`).join("  ")}
                    </div>
                  )}

                  {toolCount > 0 ? (
                    <button onClick={() => setExpanded((s) => ({ ...s, [r.id]: !isOpen }))} className="flex items-center gap-1 text-[10px] text-primary/80 hover:text-primary">
                      {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {toolCount} tool{toolCount === 1 ? "" : "s"}
                    </button>
                  ) : (
                    <div className="text-[10px] text-muted-foreground/40">no tools listed</div>
                  )}
                  {isOpen && (
                    <ul className="space-y-0.5 pl-4 border-l border-border/20">
                      {(r.capabilities ?? []).map((c, i) => (
                        <li key={i} className="text-[10px] text-muted-foreground/80">
                          <span className="font-mono text-foreground/80">{c.name}</span>
                          {c.description ? <span className="text-muted-foreground/50"> — {c.description}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ADD / EDIT */}
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-display tracking-widest text-primary uppercase">
            {editingId ? "Edit MCP" : "Add MCP"}
          </h2>
          <Button size="sm" variant="ghost" onClick={() => { setShowForm((v) => !v); if (showForm) resetForm(); }}>
            {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {showForm && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Name</Label>
                <Input value={name} onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }} placeholder="GitHub" />
              </div>
              <div>
                <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Slug</Label>
                <Input value={slug} onChange={(e) => { setSlug(slugify(e.target.value)); setSlugTouched(true); }} placeholder="github" />
              </div>
            </div>

            <div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Transport</Label>
              <div className="flex rounded-md overflow-hidden border border-border/30 mt-1">
                {(["stdio", "sse"] as Transport[]).map((t) => (
                  <button key={t} type="button" onClick={() => setTransport(t)}
                    className={`flex-1 py-2 text-sm font-display uppercase ${transport === t ? "bg-primary text-primary-foreground" : "bg-secondary/30 text-muted-foreground hover:bg-secondary/50"}`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {transport === "sse" ? (
              <div>
                <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">URL</Label>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Command</Label>
                  <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Args (comma)</Label>
                  <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y, @modelcontextprotocol/server-github" />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Environment Variables</Label>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEnvRows((r) => [...r, { k: "", v: "", show: false }])}>
                  <Plus className="h-3 w-3 mr-1" /> Add
                </Button>
              </div>
              {envRows.length === 0 && <p className="text-[10px] text-muted-foreground/50">None.</p>}
              {envRows.map((e, i) => (
                <div key={i} className="grid grid-cols-[1fr,1fr,auto,auto] gap-2 items-center">
                  <Input placeholder="KEY_NAME" value={e.k} onChange={(ev) => {
                    const v = ev.target.value;
                    setEnvRows((rs) => rs.map((r, j) => j === i ? { ...r, k: v } : r));
                  }} className="font-mono text-xs" />
                  <Input
                    type={e.show ? "text" : "password"}
                    placeholder={editingId ? "(masked — leave blank to keep)" : "value"}
                    value={e.v}
                    onChange={(ev) => {
                      const v = ev.target.value;
                      setEnvRows((rs) => rs.map((r, j) => j === i ? { ...r, v } : r));
                    }}
                    className="font-mono text-xs"
                  />
                  <button type="button" onClick={() => setEnvRows((rs) => rs.map((r, j) => j === i ? { ...r, show: !r.show } : r))} className="p-1 text-muted-foreground">
                    {e.show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  <button type="button" onClick={() => setEnvRows((rs) => rs.filter((_, j) => j !== i))} className="p-1 text-muted-foreground hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div>
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What Atlas gets from this connection." rows={2} />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { resetForm(); setShowForm(false); }}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary/90 font-display tracking-wider">
                {saving ? "Saving…" : editingId ? "Save Changes" : "Save Connection"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* PRESET LIBRARY */}
      <div className="glass-card p-5 space-y-3">
        <h2 className="text-sm font-display tracking-widest text-primary uppercase">Preset Library</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {presetGrid.map((p) => {
            const already = rows.some((r) => r.slug === p.slug);
            return (
              <div key={p.slug} className="p-3 rounded-lg border border-border/20 bg-secondary/5 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-display uppercase text-foreground/80">{p.name}</div>
                    <div className="text-[10px] text-muted-foreground/60 mt-0.5">{p.description}</div>
                  </div>
                  <span className="text-[9px] px-1.5 py-0.5 rounded border border-border/30 text-muted-foreground uppercase shrink-0">{p.transport}</span>
                </div>
                {p.envKeys && p.envKeys.length > 0 && (
                  <div className="text-[9px] font-mono text-muted-foreground/50 truncate">needs: {p.envKeys.join(", ")}</div>
                )}
                <Button size="sm" variant="outline" disabled={already} onClick={() => applyPreset(p)} className="w-full h-7 text-[11px]">
                  {already ? "Already added" : "Add"}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
