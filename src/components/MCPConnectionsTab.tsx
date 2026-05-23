import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Trash2, Edit2, RefreshCw, Download, Copy, CheckCircle2, AlertCircle,
  Search, ChevronDown, X, Code2, FolderSync, Power, Plug,
} from "lucide-react";

type Transport = "sse" | "stdio";

type MCPConnection = {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  transport: Transport;
  url: string | null;
  command: string | null;
  args: string[] | null;
  env_vars: Record<string, string>;
  is_active: boolean;
  is_verified: boolean;
  last_ping_at: string | null;
  capabilities: Array<{ name: string; description?: string }>;
  notes: string | null;
  category: string | null;
};

type DirectoryEntry = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  transport: Transport;
  url: string | null;
  command: string | null;
  args: string[] | null;
  required_env_vars: Array<{ key: string; required?: boolean }>;
  icon: string | null;
  docs_url: string | null;
  is_featured: boolean;
};

type EnvRow = { key: string; value: string; required: boolean; saved: boolean };

const CATEGORIES = ["All", "Productivity", "Development", "Finance", "Communication", "Data", "AI Tools", "Browser", "Storage"];
const SYNC_INTERVALS = ["5m", "15m", "30m", "1h"];
const COWORK_ACTIONS = ["read", "create", "edit", "run", "move", "delete"];

function timeAgo(ts: string | null): string {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default function MCPConnectionsTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const formRef = useRef<HTMLDivElement>(null);

  const [connections, setConnections] = useState<MCPConnection[]>([]);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<MCPConnection | null>(null);

  // Directory filters
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  // Add/edit form
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [formCategory, setFormCategory] = useState("general");
  const [formTransport, setFormTransport] = useState<Transport>("sse");
  const [formUrl, setFormUrl] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formEnv, setFormEnv] = useState<EnvRow[]>([]);
  const [formNotes, setFormNotes] = useState("");
  const [formSaving, setFormSaving] = useState(false);

  // Preferences
  const [claudeCode, setClaudeCode] = useState<{ project_path: string; mode: string; auto_sync: boolean }>({
    project_path: "", mode: "read+edit", auto_sync: true,
  });
  const [cowork, setCowork] = useState<{ enabled: boolean; folders: string[]; interval: string; auto_brief: boolean; actions: string[] }>({
    enabled: false, folders: [], interval: "15m", auto_brief: true, actions: ["read", "edit"],
  });
  const [newFolder, setNewFolder] = useState("");
  const [activity, setActivity] = useState<Array<{ id: string; action_type: string; target_path: string | null; detail: string | null; created_at: string }>>([]);

  // ── Load all data ───────────────────────────────────────────────────────
  async function loadAll() {
    if (!user) return;
    setLoading(true);
    const [conns, dir, prefs, log] = await Promise.all([
      supabase.from("atlas_mcp_connections").select("*").eq("user_id", user.id).order("created_at", { ascending: false }),
      supabase.from("mcp_directory").select("*").order("is_featured", { ascending: false }).order("name"),
      supabase.from("atlas_preferences").select("*").eq("user_id", user.id).maybeSingle(),
      supabase.from("cowork_activity_log").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(10),
    ]);
    if (conns.data) setConnections(conns.data as unknown as MCPConnection[]);
    if (dir.data) setDirectory(dir.data as unknown as DirectoryEntry[]);
    if (prefs.data) {
      const cc = (prefs.data as any).claude_code_config ?? {};
      const cw = (prefs.data as any).cowork_config ?? {};
      setClaudeCode({
        project_path: cc.project_path ?? "",
        mode: cc.mode ?? "read+edit",
        auto_sync: cc.auto_sync ?? true,
      });
      setCowork({
        enabled: cw.enabled ?? false,
        folders: cw.folders ?? [],
        interval: cw.interval ?? "15m",
        auto_brief: cw.auto_brief ?? true,
        actions: cw.actions ?? ["read", "edit"],
      });
    }
    if (log.data) setActivity(log.data as any);
    setLoading(false);
  }

  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, [user?.id]);

  // ── Preference saves ────────────────────────────────────────────────────
  async function savePreferences(patch: { claude?: typeof claudeCode; cowork?: typeof cowork }) {
    if (!user) return;
    const claude_code_config = patch.claude ?? claudeCode;
    const cowork_config = patch.cowork ?? cowork;
    const { error } = await supabase.from("atlas_preferences").upsert({
      user_id: user.id,
      claude_code_config: claude_code_config as any,
      cowork_config: cowork_config as any,
    }, { onConflict: "user_id" });
    if (error) toast({ title: "Save failed", description: error.message, variant: "destructive" });
    else toast({ title: "Saved" });
  }

  // ── Connection actions ──────────────────────────────────────────────────
  async function pingConnection(c: MCPConnection) {
    setBusyId(c.id);
    try {
      const { data, error } = await supabase.functions.invoke("atlas_mcp_ping", {
        body: { connection_id: c.id, confirm_stdio: c.transport === "stdio" },
      });
      if (error) throw error;
      toast({
        title: data?.verified ? "Verified" : "Ping failed",
        description: data?.verified ? `${(data?.capabilities ?? []).length} tools discovered` : data?.error ?? "unknown error",
        variant: data?.verified ? "default" : "destructive",
      });
      await loadAll();
    } catch (e: any) {
      toast({ title: "Ping failed", description: e.message, variant: "destructive" });
    } finally { setBusyId(null); }
  }

  async function toggleActive(c: MCPConnection) {
    const { error } = await supabase.from("atlas_mcp_connections").update({ is_active: !c.is_active }).eq("id", c.id);
    if (error) toast({ title: "Update failed", description: error.message, variant: "destructive" });
    else loadAll();
  }

  async function deleteConnection(c: MCPConnection) {
    const { error } = await supabase.from("atlas_mcp_connections").delete().eq("id", c.id);
    if (error) toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    else { toast({ title: "Removed" }); loadAll(); }
    setConfirmDelete(null);
  }

  // ── Form handlers ───────────────────────────────────────────────────────
  function resetForm() {
    setEditingId(null); setFormName(""); setFormSlug(""); setFormCategory("general");
    setFormTransport("sse"); setFormUrl(""); setFormCommand(""); setFormArgs("");
    setFormEnv([]); setFormNotes("");
  }

  function openAddForm() {
    resetForm(); setFormOpen(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function openEditForm(c: MCPConnection) {
    setEditingId(c.id);
    setFormName(c.name); setFormSlug(c.slug);
    setFormCategory(c.category ?? "general");
    setFormTransport(c.transport);
    setFormUrl(c.url ?? ""); setFormCommand(c.command ?? "");
    setFormArgs((c.args ?? []).join(" "));
    setFormEnv(Object.keys(c.env_vars ?? {}).map(k => ({ key: k, value: "", required: false, saved: true })));
    setFormNotes(c.notes ?? "");
    setFormOpen(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function connectFromDirectory(d: DirectoryEntry) {
    resetForm();
    setFormName(d.name); setFormSlug(d.slug);
    setFormCategory(d.category ?? "general");
    setFormTransport(d.transport);
    setFormUrl(d.url ?? ""); setFormCommand(d.command ?? "");
    setFormArgs((d.args ?? []).join(" "));
    setFormEnv((d.required_env_vars ?? []).map(v => ({ key: v.key, value: "", required: v.required !== false, saved: false })));
    setFormOpen(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  async function saveConnection() {
    if (!user || !formName.trim() || !formSlug.trim()) {
      toast({ title: "Missing fields", description: "Name and slug are required.", variant: "destructive" }); return;
    }
    setFormSaving(true);
    try {
      // Build env_vars: preserve existing saved values when blank
      let existingEnv: Record<string, string> = {};
      if (editingId) {
        const existing = connections.find(c => c.id === editingId);
        existingEnv = existing?.env_vars ?? {};
      }
      const env_vars: Record<string, string> = {};
      for (const row of formEnv) {
        if (!row.key.trim()) continue;
        if (row.value) env_vars[row.key] = row.value;
        else if (row.saved && existingEnv[row.key]) env_vars[row.key] = existingEnv[row.key];
      }
      const payload = {
        user_id: user.id,
        name: formName.trim(),
        slug: formSlug.trim(),
        category: formCategory,
        transport: formTransport,
        url: formTransport === "sse" ? formUrl.trim() || null : null,
        command: formTransport === "stdio" ? formCommand.trim() || null : null,
        args: formTransport === "stdio" ? formArgs.split(/\s+/).filter(Boolean) : null,
        env_vars,
        notes: formNotes.trim() || null,
        is_active: true,
      };
      const { data, error } = editingId
        ? await supabase.from("atlas_mcp_connections").update(payload).eq("id", editingId).select().single()
        : await supabase.from("atlas_mcp_connections").upsert(payload, { onConflict: "user_id,slug" }).select().single();
      if (error) throw error;

      toast({ title: editingId ? "Updated" : "Connected" });
      setFormOpen(false); resetForm(); await loadAll();

      if (data && (data as any).transport === "sse") {
        await pingConnection(data as unknown as MCPConnection);
      }
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally { setFormSaving(false); }
  }

  // ── Config export ───────────────────────────────────────────────────────
  function downloadConfig() {
    const mcpServers: Record<string, any> = {};
    for (const c of connections.filter(c => c.is_active && c.is_verified)) {
      if (c.transport === "sse") {
        mcpServers[c.slug] = { transport: "sse", url: c.url };
      } else {
        const env: Record<string, string> = {};
        for (const k of Object.keys(c.env_vars ?? {})) env[k] = "REPLACE_WITH_YOUR_VALUE";
        mcpServers[c.slug] = {
          command: c.command, args: c.args ?? [], transport: "stdio",
          ...(Object.keys(env).length ? { env } : {}),
        };
      }
    }
    if (claudeCode.project_path) {
      mcpServers["claude-code"] = { command: "claude", args: ["--mcp-server", claudeCode.project_path], transport: "stdio" };
    }
    if (cowork.enabled) {
      mcpServers["cowork"] = { command: "cowork-mcp", args: ["--watch", ...cowork.folders], transport: "stdio" };
    }
    const json = JSON.stringify({ mcpServers }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "claude_desktop_config.json"; a.click();
    URL.revokeObjectURL(a.href);
  }

  function copyToClipboard(text: string, label = "Copied") {
    navigator.clipboard.writeText(text);
    toast({ title: label });
  }

  // ── Filtered directory ──────────────────────────────────────────────────
  const filteredDirectory = useMemo(() => {
    const q = search.toLowerCase().trim();
    return directory.filter(d => {
      if (activeCategory !== "All" && d.category !== activeCategory) return false;
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || (d.description ?? "").toLowerCase().includes(q) || (d.category ?? "").toLowerCase().includes(q);
    });
  }, [directory, search, activeCategory]);

  const connectedSlugs = useMemo(() => new Set(connections.map(c => c.slug)), [connections]);

  // ── Render ──────────────────────────────────────────────────────────────
  if (loading) return <div className="text-sm text-muted-foreground p-8 text-center">Loading MCP connections…</div>;

  return (
    <div className="space-y-6">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">MCP Connections</h2>
          <p className="text-sm text-muted-foreground">Tools Atlas can use directly. Connect, configure, and download a Claude Desktop config.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={downloadConfig}><Download className="h-4 w-4" />Download Config</Button>
          <Button onClick={openAddForm}><Plus className="h-4 w-4" />Add MCP</Button>
        </div>
      </div>

      {/* Claude Code */}
      <Card className="relative overflow-hidden border-primary/30">
        <div className="absolute top-0 inset-x-0 h-0.5 bg-gradient-to-r from-primary via-accent to-primary" />
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <Code2 className="h-5 w-5 text-primary" />
              <div>
                <CardTitle className="text-lg">Claude Code</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">Direct access to your codebase via Claude Code's agentic coding environment.</p>
              </div>
            </div>
            <Badge variant={claudeCode.project_path ? "default" : "secondary"}>
              {claudeCode.project_path ? "Connected" : "Not Connected"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="md:col-span-2">
              <Label>Project Path</Label>
              <Input value={claudeCode.project_path} onChange={e => setClaudeCode({ ...claudeCode, project_path: e.target.value })}
                placeholder="/Users/you/code/skyforge-trust-ledger" />
            </div>
            <div>
              <Label>Mode</Label>
              <Select value={claudeCode.mode} onValueChange={v => setClaudeCode({ ...claudeCode, mode: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="read-only">Read only</SelectItem>
                  <SelectItem value="read+edit">Read + Edit</SelectItem>
                  <SelectItem value="full">Full autonomy</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Label>Auto-sync to Atlas</Label>
                <p className="text-xs text-muted-foreground">Surface file changes in context.</p>
              </div>
              <Switch checked={claudeCode.auto_sync} onCheckedChange={v => setClaudeCode({ ...claudeCode, auto_sync: v })} />
            </div>
          </div>

          <div className="rounded-md border bg-muted/40 p-3 text-xs font-mono whitespace-pre overflow-x-auto">
{`"claude-code": {
  "command": "claude",
  "args": ["--mcp-server"${claudeCode.project_path ? `, "${claudeCode.project_path}"` : ""}],
  "transport": "stdio"
}`}
          </div>
          <p className="text-xs text-muted-foreground">
            Add this to <code className="text-foreground">~/.claude/claude_desktop_config.json</code> under <code className="text-foreground">mcpServers</code>.
          </p>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" onClick={() => savePreferences({ claude: claudeCode })}>Save</Button>
            <Button size="sm" variant="outline" onClick={() => copyToClipboard(
              `"claude-code": {\n  "command": "claude",\n  "args": ["--mcp-server"${claudeCode.project_path ? `, "${claudeCode.project_path}"` : ""}],\n  "transport": "stdio"\n}`
            )}><Copy className="h-3 w-3" />Copy Config</Button>
            <Button size="sm" variant="outline" onClick={() => copyToClipboard("~/.claude/claude_desktop_config.json", "Path copied")}>
              Copy Config Path
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Cowork */}
      <Card className="relative overflow-hidden border-accent/30">
        <div className="absolute top-0 inset-x-0 h-0.5 bg-gradient-to-r from-accent via-primary to-accent" />
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <FolderSync className="h-5 w-5 text-accent" />
              <div>
                <CardTitle className="text-lg">Claude Cowork</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">Let Atlas monitor and act on files, tasks, and automation across your desktop.</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={cowork.enabled ? "default" : "secondary"}>{cowork.enabled ? "Active" : "Inactive"}</Badge>
              <Switch checked={cowork.enabled} onCheckedChange={v => setCowork({ ...cowork, enabled: v })} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Watched Folders</Label>
            <div className="flex gap-2 mb-2">
              <Input value={newFolder} onChange={e => setNewFolder(e.target.value)} placeholder="/Users/you/Documents" />
              <Button variant="outline" onClick={() => {
                if (!newFolder.trim()) return;
                setCowork({ ...cowork, folders: [...cowork.folders, newFolder.trim()] });
                setNewFolder("");
              }}><Plus className="h-4 w-4" />Add</Button>
            </div>
            <div className="space-y-1">
              {cowork.folders.map((f, i) => (
                <div key={i} className="flex items-center justify-between bg-muted/40 rounded px-3 py-1.5 text-sm">
                  <span className="font-mono text-xs">{f}</span>
                  <button onClick={() => setCowork({ ...cowork, folders: cowork.folders.filter((_, j) => j !== i) })}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {!cowork.folders.length && <p className="text-xs text-muted-foreground">No folders watched yet.</p>}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label>Sync Interval</Label>
              <Select value={cowork.interval} onValueChange={v => setCowork({ ...cowork, interval: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SYNC_INTERVALS.map(i => <SelectItem key={i} value={i}>Every {i}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Label>Auto-brief Atlas</Label>
                <p className="text-xs text-muted-foreground">Include Cowork summary in morning brief.</p>
              </div>
              <Switch checked={cowork.auto_brief} onCheckedChange={v => setCowork({ ...cowork, auto_brief: v })} />
            </div>
          </div>

          <div>
            <Label>Allowed Actions</Label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
              {COWORK_ACTIONS.map(a => (
                <label key={a} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={cowork.actions.includes(a)} onCheckedChange={(v) => {
                    if (v) setCowork({ ...cowork, actions: [...cowork.actions, a] });
                    else setCowork({ ...cowork, actions: cowork.actions.filter(x => x !== a) });
                  }} />
                  <span className="capitalize">{a}{a === "delete" ? " (confirm)" : ""}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="rounded-md border bg-muted/40 p-3 text-xs font-mono whitespace-pre overflow-x-auto">
{`"cowork": {
  "command": "cowork-mcp",
  "args": ["--watch"${cowork.folders.length ? ", " + cowork.folders.map(f => `"${f}"`).join(", ") : ""}],
  "transport": "stdio"
}`}
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" onClick={() => savePreferences({ cowork })}>Save</Button>
            <Button size="sm" variant="outline" onClick={() => copyToClipboard(
              `"cowork": {\n  "command": "cowork-mcp",\n  "args": ["--watch"${cowork.folders.length ? ", " + cowork.folders.map(f => `"${f}"`).join(", ") : ""}],\n  "transport": "stdio"\n}`
            )}><Copy className="h-3 w-3" />Copy Config</Button>
          </div>

          <div>
            <Label className="text-xs uppercase tracking-wider">Activity Feed</Label>
            <div className="mt-2 max-h-48 overflow-y-auto rounded-md border divide-y">
              {activity.length === 0 && (
                <p className="text-xs text-muted-foreground p-3">No activity yet — Cowork will log actions here once connected.</p>
              )}
              {activity.map(a => (
                <div key={a.id} className="px-3 py-2 text-xs flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="font-medium uppercase tracking-wider mr-2">{a.action_type}</span>
                    <span className="font-mono text-muted-foreground truncate">{a.target_path ?? a.detail ?? ""}</span>
                  </div>
                  <span className="text-muted-foreground shrink-0">{timeAgo(a.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Connected MCPs */}
      <div className="space-y-3">
        <h3 className="text-sm uppercase tracking-wider text-muted-foreground">Connected MCPs ({connections.length})</h3>
        {connections.length === 0 && (
          <Card><CardContent className="p-6 text-sm text-muted-foreground text-center">
            No MCP connections yet. Browse the directory below or click Add MCP.
          </CardContent></Card>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {connections.map(c => (
            <Card key={c.id} className={c.is_active ? "" : "opacity-60"}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-semibold truncate">{c.name}</h4>
                      <Badge variant="outline" className="text-xs">{c.transport}</Badge>
                      {c.category && <Badge variant="secondary" className="text-xs">{c.category}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">{c.slug}</p>
                    {c.url && <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">{c.url}</p>}
                  </div>
                  <Badge className={
                    c.is_verified ? "bg-green-500/20 text-green-400 border-green-500/30"
                    : "bg-amber-500/20 text-amber-400 border-amber-500/30"
                  }>
                    {c.is_verified ? <><CheckCircle2 className="h-3 w-3 mr-1" />Verified</>
                      : <><AlertCircle className="h-3 w-3 mr-1" />Unverified</>}
                  </Badge>
                </div>

                <div className="text-xs text-muted-foreground">
                  Last verified {timeAgo(c.last_ping_at)}
                  {c.capabilities?.length ? ` · ${c.capabilities.length} tools` : ""}
                </div>

                {c.capabilities?.length > 0 && (
                  <Collapsible>
                    <CollapsibleTrigger className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground">
                      <ChevronDown className="h-3 w-3" />Tools
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-2 flex flex-wrap gap-1">
                      {c.capabilities.map((t, i) => (
                        <Badge key={i} variant="outline" className="text-[10px]">{t.name}</Badge>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                )}

                <div className="flex items-center gap-2 flex-wrap pt-2 border-t">
                  <Button size="sm" variant="outline" disabled={busyId === c.id} onClick={() => pingConnection(c)}>
                    <RefreshCw className={`h-3 w-3 ${busyId === c.id ? "animate-spin" : ""}`} />Ping
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openEditForm(c)}><Edit2 className="h-3 w-3" />Edit</Button>
                  <Button size="sm" variant="outline" onClick={() => toggleActive(c)}>
                    <Power className="h-3 w-3" />{c.is_active ? "Disable" : "Enable"}
                  </Button>
                  <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirmDelete(c)}>
                    <Trash2 className="h-3 w-3" />Remove
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Add/Edit form */}
      {formOpen && (
        <Card ref={formRef as any} className="border-primary/40">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">{editingId ? "Edit Connection" : "New MCP Connection"}</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => { setFormOpen(false); resetForm(); }}><X className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <Label>Name</Label>
                <Input value={formName} onChange={e => {
                  setFormName(e.target.value);
                  if (!editingId && !formSlug) setFormSlug(slugify(e.target.value));
                }} />
              </div>
              <div>
                <Label>Slug</Label>
                <Input value={formSlug} onChange={e => setFormSlug(slugify(e.target.value))} disabled={!!editingId} />
              </div>
              <div>
                <Label>Category</Label>
                <Select value={formCategory} onValueChange={setFormCategory}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.filter(c => c !== "All").concat(["general"]).map(c => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Transport</Label>
                <Select value={formTransport} onValueChange={v => setFormTransport(v as Transport)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sse">SSE (Remote)</SelectItem>
                    <SelectItem value="stdio">STDIO (Local)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {formTransport === "sse" ? (
              <div>
                <Label>Server URL</Label>
                <Input value={formUrl} onChange={e => setFormUrl(e.target.value)} placeholder="https://mcp.example.com/sse" />
              </div>
            ) : (
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <Label>Command</Label>
                  <Input value={formCommand} onChange={e => setFormCommand(e.target.value)} placeholder="npx" />
                </div>
                <div>
                  <Label>Args (space-separated)</Label>
                  <Input value={formArgs} onChange={e => setFormArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-github" />
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Environment Variables</Label>
                <Button variant="outline" size="sm" onClick={() =>
                  setFormEnv([...formEnv, { key: "", value: "", required: false, saved: false }])
                }><Plus className="h-3 w-3" />Add Row</Button>
              </div>
              <div className="space-y-2">
                {formEnv.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input className="flex-1 font-mono text-xs" placeholder="KEY"
                      value={row.key} disabled={row.required}
                      onChange={e => {
                        const next = [...formEnv]; next[i].key = e.target.value; setFormEnv(next);
                      }} />
                    <Input className="flex-1" type="password"
                      placeholder={row.saved ? "●●●●●●●● (saved)" : "value"}
                      value={row.value}
                      onChange={e => {
                        const next = [...formEnv]; next[i].value = e.target.value; setFormEnv(next);
                      }} />
                    {row.required && <Badge variant="outline" className="text-[10px]">required</Badge>}
                    {row.saved && (
                      <Button size="sm" variant="ghost" onClick={() => {
                        const next = [...formEnv]; next[i].saved = false; next[i].value = ""; setFormEnv(next);
                      }}>Clear</Button>
                    )}
                    {!row.required && (
                      <Button size="sm" variant="ghost" onClick={() =>
                        setFormEnv(formEnv.filter((_, j) => j !== i))
                      }><X className="h-3 w-3" /></Button>
                    )}
                  </div>
                ))}
                {!formEnv.length && <p className="text-xs text-muted-foreground">No env vars required.</p>}
              </div>
            </div>

            <div>
              <Label>Notes (optional)</Label>
              <Textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} rows={2} />
            </div>

            <div className="flex gap-2">
              <Button onClick={saveConnection} disabled={formSaving}>
                {formSaving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                Save Connection
              </Button>
              <Button variant="outline" onClick={() => { setFormOpen(false); resetForm(); }}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* MCP Directory */}
      <div className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold">MCP Directory</h3>
          <p className="text-sm text-muted-foreground">Browse and connect any MCP server. Click Connect to add it to Atlas instantly.</p>
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search by name, description, category…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        <div className="flex gap-1 overflow-x-auto pb-1">
          {CATEGORIES.map(cat => (
            <button key={cat} onClick={() => setActiveCategory(cat)}
              className={`shrink-0 px-3 py-1 rounded-full text-xs border transition-colors ${
                activeCategory === cat
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:text-foreground"
              }`}>
              {cat}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredDirectory.map(d => {
            const connected = connectedSlugs.has(d.slug);
            return (
              <Card key={d.id} className="hover:border-primary/40 transition-colors">
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-2xl">{d.icon ?? "🔌"}</span>
                      <div className="min-w-0">
                        <h4 className="font-semibold truncate">{d.name}</h4>
                        <div className="flex gap-1 mt-0.5">
                          {d.category && <Badge variant="secondary" className="text-[10px]">{d.category}</Badge>}
                          <Badge variant="outline" className="text-[10px]">{d.transport}</Badge>
                        </div>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2rem]">{d.description}</p>
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" variant={connected ? "secondary" : "default"}
                      disabled={connected} onClick={() => connectFromDirectory(d)} className="flex-1">
                      {connected ? <><CheckCircle2 className="h-3 w-3" />Connected</> : <><Plug className="h-3 w-3" />Connect</>}
                    </Button>
                    {d.docs_url && (
                      <Button size="sm" variant="ghost" asChild>
                        <a href={d.docs_url} target="_blank" rel="noreferrer">Docs</a>
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
        {filteredDirectory.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">No MCPs match your filter.</p>
        )}
      </div>

      {/* Delete confirmation */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {confirmDelete?.name}?</DialogTitle>
            <DialogDescription>
              This will delete the connection and revoke Atlas's access to its tools. Stored secrets are deleted permanently.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => confirmDelete && deleteConnection(confirmDelete)}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
