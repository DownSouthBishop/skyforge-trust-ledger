// Shared gateway utility for all forge edge functions.
// Provides retry with exponential backoff and centralised auth.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

// callGatewayWithRetry: retries on 429/5xx with exponential backoff.
// On 429 it respects the Retry-After header when present.
export async function callGatewayWithRetry(
  body: Record<string, unknown>,
  apiKey: string,
  maxRetries = 3,
): Promise<Response> {
  let attempt = 0;
  let lastResp: Response | null = null;

  while (attempt <= maxRetries) {
    const resp = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) return resp;

    // Don't retry auth failures — they won't resolve
    if (resp.status === 401 || resp.status === 402 || resp.status === 403) {
      return resp;
    }

    lastResp = resp.clone();
    attempt++;
    if (attempt > maxRetries) break;

    let delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s

    if (resp.status === 429) {
      const retryAfter = resp.headers.get("Retry-After");
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) delayMs = seconds * 1000;
      }
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }

  return lastResp!;
}

// verifyUser: validates the JWT and returns the user ID.
// Throws with a descriptive message on failure.
export async function verifyUser(
  supabaseUrl: string,
  serviceKey: string,
  authHeader: string | null,
): Promise<string> {
  if (!authHeader) throw new AuthError("Missing Authorization header");

  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) throw new AuthError("Empty token");

  const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceKey },
  });

  if (!resp.ok) throw new AuthError("Invalid or expired token");

  const data = await resp.json();
  if (!data?.id) throw new AuthError("No user ID in token");

  return data.id as string;
}

export class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

// parseEnv: reads a required env var, throws clearly if missing.
export function parseEnv(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Required env var ${key} is not set`);
  return val;
}

// modelEnv: reads a model name from env with a fallback.
export function modelEnv(envKey: string, fallback: string): string {
  return Deno.env.get(envKey) ?? fallback;
}
