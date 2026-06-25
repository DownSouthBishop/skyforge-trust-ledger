import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import {
  CheckCircle2, XCircle, Loader2, RefreshCw,
  Mail, Calendar, HardDrive, FileSpreadsheet,
  FileText, Presentation, ClipboardList, Users,
  CheckSquare, Youtube, Search, BarChart3,
  MessageSquare, Map, Link2, Bot,
} from "lucide-react";
import { google } from "@/lib/google";

type ApiDef = {
  key: string;
  label: string;
  icon: React.ElementType;
  description: string;
  scope: "oauth" | "maps_key" | "api_key";
  probe?: () => Promise<unknown>;
};

const APIS: ApiDef[] = [
  { key: "gemini",         label: "Gemini AI",       icon: Bot,           description: "Free Gemini inference & embeddings",  scope: "api_key",  probe: () => google.gemini.listModels() },
  { key: "gmail",          label: "Gmail",           icon: Mail,          description: "Read, send & organize email",         scope: "oauth",    probe: () => google.gmail.getProfile() },
  { key: "calendar",       label: "Calendar",         icon: Calendar,      description: "Events & scheduling",                 scope: "oauth",    probe: () => google.calendar.listCalendars() },
  { key: "drive",          label: "Drive",            icon: HardDrive,     description: "Files & folders",                     scope: "oauth",    probe: () => google.drive.getStorage() },
  { key: "sheets",         label: "Sheets",           icon: FileSpreadsheet, description: "Spreadsheets",                     scope: "oauth" },
  { key: "docs",           label: "Docs",             icon: FileText,      description: "Documents",                           scope: "oauth" },
  { key: "slides",         label: "Slides",           icon: Presentation,  description: "Presentations",                       scope: "oauth" },
  { key: "forms",          label: "Forms",            icon: ClipboardList, description: "Forms & survey responses",             scope: "oauth" },
  { key: "contacts",       label: "Contacts",         icon: Users,         description: "People & contacts (People API)",      scope: "oauth",    probe: () => google.contacts.listContacts({ pageSize: 1 }) },
  { key: "tasks",          label: "Tasks",            icon: CheckSquare,   description: "Task lists & to-dos",                 scope: "oauth",    probe: () => google.tasks.listTasklists() },
  { key: "youtube",        label: "YouTube",          icon: Youtube,       description: "Videos, channels & subscriptions",    scope: "oauth",    probe: () => google.youtube.getMyChannel() },
  { key: "search_console", label: "Search Console",   icon: Search,        description: "SEO & web search performance",        scope: "oauth",    probe: () => google.searchConsole.listSites() },
  { key: "analytics",      label: "Analytics (GA4)",  icon: BarChart3,     description: "Website traffic & conversions",       scope: "oauth",    probe: () => google.analytics.listAccounts() },
  { key: "chat",           label: "Google Chat",      icon: MessageSquare, description: "Spaces & messages",                   scope: "oauth",    probe: () => google.chat.listSpaces() },
  { key: "maps",           label: "Maps / Places",    icon: Map,           description: "Geocoding, places & directions",      scope: "maps_key" },
];

type ApiStatus = "idle" | "checking" | "ok" | "error";

export default function GoogleIntegration() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [apiStatuses, setApiStatuses] = useState<Record<string, ApiStatus>>({});
  const [apiErrors, setApiErrors] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState(false);

  const checkConnection = useCallback(async () => {
    try {
      const r = await google.getStatus();
      setConnected(r.connected);
      return r.connected;
    } catch {
      setConnected(false);
      return false;
    }
  }, []);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  async function probeAllApis() {
    setChecking(true);
    const newStatuses: Record<string, ApiStatus> = {};
    const newErrors: Record<string, string> = {};

    await Promise.all(
      APIS.map(async (api) => {
        if (!api.probe) {
          newStatuses[api.key] = "idle";
          return;
        }
        newStatuses[api.key] = "checking";
        setApiStatuses((s) => ({ ...s, [api.key]: "checking" }));
        try {
          await api.probe();
          newStatuses[api.key] = "ok";
        } catch (err) {
          newStatuses[api.key] = "error";
          newErrors[api.key] = (err as Error).message.slice(0, 80);
        }
      }),
    );

    setApiStatuses(newStatuses);
    setApiErrors(newErrors);
    setChecking(false);
  }

  async function handleConnect() {
    setConnecting(true);
    try {
      const { url } = await google.getAuthUrl();
      window.location.href = url;
    } catch (err) {
      toast.error("Failed to start Google auth: " + (err as Error).message);
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setConnecting(true);
    try {
      await google.disconnect();
      setConnected(false);
      setApiStatuses({});
      toast.success("Google account disconnected.");
    } catch (err) {
      toast.error("Disconnect failed: " + (err as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  function statusIcon(key: string, scope: "oauth" | "maps_key" | "api_key") {
    if (scope === "maps_key") return <Badge variant="outline" className="text-[10px] text-yellow-600 border-yellow-800 py-0">API Key</Badge>;
    const s = apiStatuses[key];
    if (scope === "api_key" && !s) return <Badge variant="outline" className="text-[10px] text-yellow-600 border-yellow-800 py-0">API Key</Badge>;
    if (s === "checking") return <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />;
    if (s === "ok") return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    if (s === "error") return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    return null;
  }

  const probeable = APIS.filter((a) => a.probe).length;
  const okCount = APIS.filter((a) => apiStatuses[a.key] === "ok").length;
  const errCount = APIS.filter((a) => apiStatuses[a.key] === "error").length;

  return (
    <div className="space-y-4">
      {/* Connection header */}
      <Card className="border border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-3 text-base">
            <Link2 className="h-4 w-4 text-zinc-400" />
            Google Workspace
            {connected === null ? (
              <Badge variant="outline" className="ml-auto text-zinc-400">Checking…</Badge>
            ) : connected ? (
              <Badge className="ml-auto bg-green-900 text-green-300 border-green-700">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Connected
              </Badge>
            ) : (
              <Badge variant="outline" className="ml-auto text-zinc-500 border-zinc-700">
                <XCircle className="h-3 w-3 mr-1" /> Not connected
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          {connected ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={probeAllApis}
                disabled={checking}
                className="border-zinc-700 text-zinc-400 hover:text-zinc-200"
              >
                {checking
                  ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
                Test all APIs
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleDisconnect}
                disabled={connecting}
                className="border-zinc-700 text-zinc-400 hover:text-red-400 hover:border-red-800"
              >
                {connecting && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                Disconnect
              </Button>
              {Object.keys(apiStatuses).length > 0 && (
                <span className="text-xs text-zinc-500 ml-auto">
                  {okCount} ok · {errCount} error{errCount !== 1 ? "s" : ""} · {probeable - okCount - errCount} untested
                </span>
              )}
            </>
          ) : (
            <Button
              size="sm"
              onClick={handleConnect}
              disabled={connecting || connected === null}
              className="bg-blue-700 hover:bg-blue-600 text-white"
            >
              {connecting && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Connect Google Account
            </Button>
          )}
        </CardContent>
      </Card>

      {/* API grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {APIS.map((api) => {
          const Icon = api.icon;
          const status = apiStatuses[api.key];
          const errMsg = apiErrors[api.key];
          return (
            <div
              key={api.key}
              className={`flex items-start gap-3 rounded-md border p-3 transition-colors ${
                status === "ok"
                  ? "border-green-900 bg-green-950/20"
                  : status === "error"
                  ? "border-red-900 bg-red-950/20"
                  : "border-zinc-800 bg-zinc-900/40"
              }`}
            >
              <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${status === "ok" ? "text-green-400" : status === "error" ? "text-red-400" : "text-zinc-500"}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-300">{api.label}</span>
                  {statusIcon(api.key, api.scope)}
                </div>
                <p className="text-[10px] text-zinc-600 mt-0.5">{api.description}</p>
                {errMsg && <p className="text-[10px] text-red-500 mt-0.5 truncate" title={errMsg}>{errMsg}</p>}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-zinc-600">
        All OAuth APIs use one shared token stored securely in Supabase.
        Maps uses a separate <code className="text-zinc-500">GOOGLE_MAPS_API_KEY</code> env var.
        Click "Test all APIs" to verify live access for each service.
      </p>
    </div>
  );
}
