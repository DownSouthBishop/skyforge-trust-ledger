import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { CheckCircle, AlertCircle, Loader2, Mail, Calendar, HardDrive, FileSpreadsheet } from "lucide-react";
import { google } from "@/lib/google";

const SCOPES_DISPLAY = [
  { icon: Mail, label: "Gmail", desc: "Read & send email" },
  { icon: Calendar, label: "Calendar", desc: "Read & manage events" },
  { icon: HardDrive, label: "Drive", desc: "Access files" },
  { icon: FileSpreadsheet, label: "Sheets", desc: "Read & write spreadsheets" },
];

export default function GoogleIntegration() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    google.getStatus()
      .then((r) => setConnected(r.connected))
      .catch(() => setConnected(false));
  }, []);

  async function handleConnect() {
    setLoading(true);
    try {
      const { url } = await google.getAuthUrl();
      window.location.href = url;
    } catch (err) {
      toast.error("Failed to start Google auth: " + (err as Error).message);
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    setLoading(true);
    try {
      await google.disconnect();
      setConnected(false);
      toast.success("Google account disconnected.");
    } catch (err) {
      toast.error("Disconnect failed: " + (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="border border-zinc-800 bg-zinc-900/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-3 text-base">
          <img
            src="https://www.google.com/favicon.ico"
            alt="Google"
            className="h-5 w-5"
          />
          Google Workspace
          {connected === null ? (
            <Badge variant="outline" className="ml-auto text-zinc-400">Checking…</Badge>
          ) : connected ? (
            <Badge className="ml-auto bg-green-900 text-green-300 border-green-700">
              <CheckCircle className="h-3 w-3 mr-1" /> Connected
            </Badge>
          ) : (
            <Badge variant="outline" className="ml-auto text-zinc-500 border-zinc-700">
              <AlertCircle className="h-3 w-3 mr-1" /> Not connected
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SCOPES_DISPLAY.map(({ icon: Icon, label, desc }) => (
            <div
              key={label}
              className="flex flex-col items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-center"
            >
              <Icon className="h-5 w-5 text-zinc-400" />
              <span className="text-xs font-medium text-zinc-300">{label}</span>
              <span className="text-[10px] text-zinc-500">{desc}</span>
            </div>
          ))}
        </div>

        {connected ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleDisconnect}
            disabled={loading}
            className="border-zinc-700 text-zinc-400 hover:text-red-400 hover:border-red-800"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
            Disconnect Google
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={handleConnect}
            disabled={loading || connected === null}
            className="bg-blue-700 hover:bg-blue-600 text-white"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
            Connect Google Account
          </Button>
        )}

        <p className="text-[11px] text-zinc-600">
          Grants access to your Gmail, Calendar, Drive, and Sheets. Tokens are stored
          securely in Supabase and never shared.
        </p>
      </CardContent>
    </Card>
  );
}
