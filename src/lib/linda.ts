import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;

const SUPABASE_URL = "https://hycpzeskartlkybsfkbh.supabase.co";

// Approves a linda_responses row and actually sends it (email channel only, via linda-send-email).
// Throws with a human-readable message on failure so callers can surface it.
export async function approveAndSendResponse(responseId: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token ?? "";

  const res = await fetch(`${SUPABASE_URL}/functions/v1/linda-send-email`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ response_id: responseId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `Send failed (HTTP ${res.status})`);
  }
}
