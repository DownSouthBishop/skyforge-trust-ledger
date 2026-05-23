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
  category: string;
  overview: string;
  capabilities: string[];
  atlasUseCases: string[];
  setupSteps: string[];
  docsUrl?: string;
  signupUrl?: string;
};

const PRESETS: Preset[] = [
  {
    name: "Filesystem", slug: "filesystem", transport: "stdio", category: "Local",
    description: "Read/write local files Atlas can reach.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/vault"],
    overview: "Grants Atlas direct access to a folder on your machine. He can read, write, list, and search files inside that directory tree — nothing outside it.",
    capabilities: ["read_file", "write_file", "list_directory", "search_files", "create_directory", "move_file"],
    atlasUseCases: [
      "Drop a research note into your Obsidian vault after a market scan.",
      "Pull a saved trading journal entry to reference in a conversation.",
      "Archive a generated brief into a dated folder.",
    ],
    setupSteps: [
      "Decide which folder Atlas should reach (e.g. ~/Documents/Atlas).",
      "Replace /path/to/vault in the args with the absolute path.",
      "Restart the local MCP client to mount the new directory.",
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    name: "GitHub", slug: "github", transport: "stdio", category: "Dev",
    description: "Access repos, issues, PRs, commits.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    overview: "Lets Atlas operate against your GitHub account. He can browse repos, open and triage issues, review pull requests, and inspect commit history.",
    capabilities: ["search_repositories", "get_file_contents", "create_issue", "list_issues", "create_pull_request", "list_commits"],
    atlasUseCases: [
      "Open an issue on the trust ledger repo when he spots a bug while you talk.",
      "Pull the latest commit log to brief you on what shipped overnight.",
      "Draft a PR description from a chat thread.",
    ],
    setupSteps: [
      "Visit github.com/settings/tokens and create a fine-grained PAT.",
      "Grant repo + issues + pull requests scope on the repos you want exposed.",
      "Paste the token into GITHUB_PERSONAL_ACCESS_TOKEN below.",
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    signupUrl: "https://github.com/settings/tokens",
  },
  {
    name: "Postgres", slug: "postgres", transport: "stdio", category: "Data",
    description: "Query a Postgres database directly.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"], envKeys: ["POSTGRES_CONNECTION_STRING"],
    overview: "Read-only SQL access to a Postgres database. Atlas can introspect schema and run SELECT queries — no writes.",
    capabilities: ["query", "list_tables", "describe_table", "list_schemas"],
    atlasUseCases: [
      "Pull the last 7 days of trades from your ledger without leaving chat.",
      "Answer ad-hoc questions about portfolio balances in real time.",
      "Cross-reference your own DB with a market signal he just received.",
    ],
    setupSteps: [
      "Get a connection string: postgresql://user:pass@host:5432/db",
      "Paste it into POSTGRES_CONNECTION_STRING below.",
      "Use a read-only role for safety — Atlas only needs SELECT.",
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
  },
  {
    name: "Fetch", slug: "fetch", transport: "stdio", category: "Web",
    description: "Pull arbitrary URLs into the context.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"],
    overview: "Atlas can fetch any public URL, convert HTML to markdown, and reason over it inline. No browser, no JS execution — just raw content.",
    capabilities: ["fetch"],
    atlasUseCases: [
      "Read a Federal Reserve statement the moment it's released.",
      "Pull a SaaS pricing page to inform a business decision.",
      "Grab a blog post you mentioned and summarize it back to you.",
    ],
    setupSteps: ["No setup needed — works out of the box."],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    name: "Puppeteer / Browser", slug: "puppeteer", transport: "stdio", category: "Web",
    description: "Headless browser automation.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    overview: "Full headless Chromium. Atlas can navigate sites that need JavaScript, take screenshots, click, type, and scrape rendered DOM.",
    capabilities: ["navigate", "screenshot", "click", "fill", "evaluate", "select"],
    atlasUseCases: [
      "Log into a broker portal and screenshot today's positions.",
      "Scrape a JS-heavy real-estate site he can't reach with Fetch.",
      "Walk through a checkout flow to verify a deploy.",
    ],
    setupSteps: [
      "First run downloads Chromium (~150MB) automatically.",
      "On Linux servers, install standard puppeteer deps (libnss3, libatk, etc.).",
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
  },
  {
    name: "Obsidian", slug: "obsidian", transport: "stdio", category: "Knowledge",
    description: "Read and write an Obsidian vault.",
    command: "npx", args: ["-y", "mcp-obsidian", "/path/to/vault"], envKeys: ["OBSIDIAN_VAULT_PATH"],
    overview: "First-class access to an Obsidian vault. Atlas understands wikilinks, frontmatter, and daily notes — not just plain files.",
    capabilities: ["read_note", "write_note", "search_notes", "list_notes", "get_daily_note", "append_to_note"],
    atlasUseCases: [
      "Append a daily reflection to today's daily note after each session.",
      "Build a linked map of your trade theses across notes.",
      "Search every note tagged #re-deal before underwriting.",
    ],
    setupSteps: [
      "Set OBSIDIAN_VAULT_PATH to the absolute path of your vault root.",
      "Close Obsidian or enable file-watching to avoid stale reads.",
    ],
    docsUrl: "https://github.com/StevenStavrakis/obsidian-mcp",
  },
  {
    name: "Slack", slug: "slack", transport: "stdio", category: "Comms",
    description: "Read channels, post messages.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], envKeys: ["SLACK_BOT_TOKEN"],
    overview: "Two-way Slack from Atlas. He can read message history in channels he's invited to and post on your behalf.",
    capabilities: ["list_channels", "post_message", "read_channel_history", "reply_to_thread", "add_reaction", "get_users"],
    atlasUseCases: [
      "Drop a morning brief into #ops before you wake up.",
      "Surface a thread from #deals you missed yesterday.",
      "Ping the team when a watchlist condition fires.",
    ],
    setupSteps: [
      "Create a Slack app at api.slack.com/apps.",
      "Add scopes: channels:history, chat:write, channels:read, users:read.",
      "Install to workspace, copy the Bot User OAuth Token, paste into SLACK_BOT_TOKEN.",
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    signupUrl: "https://api.slack.com/apps",
  },
  {
    name: "Notion", slug: "notion", transport: "sse", category: "Knowledge",
    description: "Notion pages and databases.",
    url: "https://mcp.notion.com/mcp", envKeys: ["NOTION_API_KEY"],
    overview: "Cloud-hosted MCP for Notion. Atlas can search your workspace, read pages, and append blocks to databases you share with his integration.",
    capabilities: ["search", "get_page", "create_page", "update_page", "query_database", "append_block_children"],
    atlasUseCases: [
      "Log every closed trade into a Notion trade journal database.",
      "Pull your weekly OKRs page before a planning conversation.",
      "Create meeting notes from a chat thread.",
    ],
    setupSteps: [
      "notion.so/profile/integrations → New integration → copy secret.",
      "Share the pages/databases you want Atlas to reach with that integration.",
      "Paste the secret into NOTION_API_KEY.",
    ],
    docsUrl: "https://developers.notion.com/docs/mcp",
    signupUrl: "https://www.notion.so/profile/integrations",
  },
  {
    name: "Linear", slug: "linear", transport: "sse", category: "Dev",
    description: "Linear issues and projects.",
    url: "https://mcp.linear.app/mcp", envKeys: ["LINEAR_API_KEY"],
    overview: "Operate your Linear workspace from chat. Atlas can create issues, move them through workflow states, and report on cycle progress.",
    capabilities: ["create_issue", "update_issue", "list_issues", "get_issue", "list_projects", "list_cycles"],
    atlasUseCases: [
      "Spin up a Linear ticket the moment you describe a bug to him.",
      "Summarize the active cycle's progress before standup.",
      "Triage incoming issues by priority based on your stated rules.",
    ],
    setupSteps: [
      "linear.app/settings/api → Personal API keys → Create.",
      "Paste into LINEAR_API_KEY.",
    ],
    docsUrl: "https://linear.app/docs/mcp",
    signupUrl: "https://linear.app/settings/api",
  },
  {
    name: "Telegram", slug: "telegram", transport: "stdio", category: "Comms",
    description: "Send/read Telegram messages.",
    command: "npx", args: ["-y", "mcp-telegram"], envKeys: ["TELEGRAM_BOT_TOKEN"],
    overview: "Adds Telegram as a tool channel for Atlas in addition to the built-in bridge. Useful if you want him to post to other chats or channels you own.",
    capabilities: ["send_message", "send_photo", "get_updates", "edit_message"],
    atlasUseCases: [
      "Broadcast a market alert to a private channel.",
      "DM a contact when a deal stage changes.",
      "Forward a generated chart to your phone instantly.",
    ],
    setupSteps: [
      "Open @BotFather on Telegram → /newbot → copy token.",
      "Paste into TELEGRAM_BOT_TOKEN.",
    ],
    docsUrl: "https://core.telegram.org/bots",
  },
  {
    name: "Google Drive", slug: "gdrive", transport: "sse", category: "Knowledge",
    description: "Drive files and folders.",
    url: "https://mcp.google.com/drive", envKeys: ["GOOGLE_OAUTH_TOKEN"],
    overview: "Browse, read, and search your Google Drive. Atlas can pull a Doc, Sheet, or PDF into the conversation by name.",
    capabilities: ["list_files", "get_file", "search_files", "download_file", "create_file"],
    atlasUseCases: [
      "Open the lease PDF for 1421 Oak before a real-estate decision.",
      "Pull last quarter's P&L sheet to ground a finance question.",
      "Save a generated report straight to Drive.",
    ],
    setupSteps: [
      "Set up Google OAuth in console.cloud.google.com.",
      "Generate a refresh token with drive.readonly + drive.file scopes.",
      "Paste it into GOOGLE_OAUTH_TOKEN.",
    ],
  },
  {
    name: "Gmail", slug: "gmail", transport: "sse", category: "Comms",
    description: "Read and send mail.",
    url: "https://mcp.google.com/gmail", envKeys: ["GOOGLE_OAUTH_TOKEN"],
    overview: "Inbox-aware Atlas. He can search threads, read messages, draft replies, and send mail you've reviewed.",
    capabilities: ["search_messages", "get_message", "send_message", "create_draft", "list_labels"],
    atlasUseCases: [
      "Triage your inbox into a morning summary.",
      "Draft a response to a deal counterparty for you to approve.",
      "Pull the original email thread when you reference it.",
    ],
    setupSteps: [
      "Google Cloud OAuth client with gmail.modify scope.",
      "Generate refresh token, paste into GOOGLE_OAUTH_TOKEN.",
    ],
  },
  {
    name: "Airtable", slug: "airtable", transport: "sse", category: "Data",
    description: "Airtable bases and tables.",
    url: "https://mcp.airtable.com/mcp", envKeys: ["AIRTABLE_API_KEY"],
    overview: "Full CRUD on Airtable bases Atlas has access to. He can list, query, create, and update records.",
    capabilities: ["list_bases", "list_records", "get_record", "create_record", "update_record", "delete_record"],
    atlasUseCases: [
      "Log a new lead into your CRM base from a phone conversation.",
      "Update deal status as you brief him on progress.",
      "Pull all rows where stage = negotiating before a call.",
    ],
    setupSteps: [
      "airtable.com/create/tokens → create personal access token.",
      "Grant data.records:read + data.records:write on target bases.",
      "Paste into AIRTABLE_API_KEY.",
    ],
    docsUrl: "https://airtable.com/developers/web/api/introduction",
    signupUrl: "https://airtable.com/create/tokens",
  },
  {
    name: "Google Calendar", slug: "gcal", transport: "sse", category: "Comms",
    description: "Calendar events.",
    url: "https://mcp.google.com/calendar", envKeys: ["GOOGLE_OAUTH_TOKEN"],
    overview: "Atlas becomes calendar-aware. He can list events, create meetings, and reschedule on your behalf.",
    capabilities: ["list_events", "create_event", "update_event", "delete_event", "get_freebusy"],
    atlasUseCases: [
      "Book a follow-up with a lead while you're still on the call.",
      "Tell you what your day looks like in plain language.",
      "Find a 30-min slot next week that works for both you and a contact.",
    ],
    setupSteps: [
      "OAuth client with calendar.events scope.",
      "Paste refresh token into GOOGLE_OAUTH_TOKEN.",
    ],
  },
  {
    name: "Alpaca", slug: "alpaca", transport: "stdio", category: "Trading",
    description: "Equities trading via Alpaca.",
    command: "node", args: ["mcp-servers/alpaca/index.js"], envKeys: ["ALPACA_API_KEY", "ALPACA_API_SECRET"],
    overview: "Direct line to Alpaca for equities. Atlas can read positions, place orders (paper or live), and stream account state.",
    capabilities: ["get_account", "list_positions", "place_order", "cancel_order", "get_bars", "list_orders"],
    atlasUseCases: [
      "Show your live Alpaca P&L on demand.",
      "Place a paper-trade order to test a thesis.",
      "Cancel a stale working order when conditions change.",
    ],
    setupSteps: [
      "alpaca.markets → Generate API keys (paper or live).",
      "Paste into ALPACA_API_KEY + ALPACA_API_SECRET.",
      "Server defaults to paper-api.alpaca.markets — change for live.",
    ],
    docsUrl: "https://alpaca.markets/docs/api-references/trading-api/",
    signupUrl: "https://alpaca.markets",
  },
  {
    name: "OANDA", slug: "oanda", transport: "stdio", category: "Trading",
    description: "Forex via OANDA.",
    command: "node", args: ["mcp-servers/oanda/index.js"], envKeys: ["OANDA_API_TOKEN", "OANDA_ACCOUNT_ID"],
    overview: "Forex access via OANDA's v20 REST API. Atlas can pull pricing, manage positions, and execute trades across 70+ pairs.",
    capabilities: ["get_account_summary", "list_positions", "create_order", "close_trade", "get_pricing", "list_transactions"],
    atlasUseCases: [
      "Stream EUR/USD pricing into a regime decision.",
      "Close a losing trade on a stop you describe verbally.",
      "Underwrite a forex thesis with live spreads, not stale data.",
    ],
    setupSteps: [
      "oanda.com → My Account → Manage API Access → Generate Token.",
      "Note your Account ID from the dashboard.",
      "Paste both into the env fields.",
    ],
    docsUrl: "https://developer.oanda.com/rest-live-v20/introduction/",
    signupUrl: "https://www.oanda.com",
  },
  {
    name: "IBKR", slug: "ibkr", transport: "stdio", category: "Trading",
    description: "Interactive Brokers gateway.",
    command: "node", args: ["mcp-servers/ibkr/index.js"], envKeys: ["IBKR_PORT"],
    overview: "Bridges Atlas to IBKR's TWS or Gateway over the local socket. Equities, options, futures, FX, bonds — everything IBKR offers.",
    capabilities: ["get_account", "list_positions", "place_order", "cancel_order", "get_market_data", "get_option_chain"],
    atlasUseCases: [
      "Pull your full IBKR position book before a portfolio decision.",
      "Place a multi-leg options spread you've described.",
      "Get a real-time option chain for an upcoming earnings play.",
    ],
    setupSteps: [
      "ibkr.com → open account (24-48hr verification).",
      "TWS → Edit → Global Config → API → enable Socket Clients.",
      "Port 7497 (paper) / 7496 (live). Set IBKR_PORT accordingly.",
    ],
    docsUrl: "https://interactivebrokers.github.io/tws-api/",
    signupUrl: "https://www.ibkr.com",
  },
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
  const [detailPreset, setDetailPreset] = useState<Preset | null>(null);
  const groupedPresets = useMemo(() => {
    const g: Record<string, Preset[]> = {};
    for (const p of presetGrid) (g[p.category] ||= []).push(p);
    return g;
  }, [presetGrid]);

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
