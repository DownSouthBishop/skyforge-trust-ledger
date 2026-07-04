import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { airtable } from "@/lib/airtable";
import { Loader2 } from "lucide-react";

export default function AirtableCallbackPage() {
  const navigate = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state") ?? "";
    const error = params.get("error");

    if (error) {
      toast.error("Airtable auth denied: " + error);
      navigate("/airtable");
      return;
    }

    if (!code) {
      toast.error("No auth code returned from Airtable.");
      navigate("/airtable");
      return;
    }

    airtable.exchangeCode(code, state)
      .then(() => {
        toast.success("Airtable account connected!");
        navigate("/airtable");
      })
      .catch((err: Error) => {
        toast.error("Failed to connect Airtable: " + err.message);
        navigate("/airtable");
      });
  }, [navigate]);

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950">
      <div className="flex flex-col items-center gap-4 text-zinc-400">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="text-sm">Connecting your Airtable account…</p>
      </div>
    </div>
  );
}
