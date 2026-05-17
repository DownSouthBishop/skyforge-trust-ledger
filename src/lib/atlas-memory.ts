import { createClient } from "@/integrations/supabase/client";

export interface AtlasMemory {
  id: string;
  session_id: string | null;
  content: string;
  domain: string | null;
  emotional_valence: number | null;
  importance_score: number | null;
  created_at: string;
  last_accessed: string;
  access_count: number;
  similarity?: number;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
}

const EMBEDDING_DIMENSIONS = 1536;

async function embedText(text: string): Promise<number[]> {
  const supabase = createClient();

  // Call atlas-core edge function for embedding
  const { data, error } = await supabase.functions.invoke("atlas-core", {
    body: { action: "embed", text: text.slice(0, 8000) },
  });

  if (error || !data?.embedding) {
    // Return zero vector as fallback — memory write still succeeds, just not searchable
    return new Array(EMBEDDING_DIMENSIONS).fill(0);
  }

  return data.embedding;
}

export async function storeMemory(params: {
  content: string;
  domain: string;
  sessionId: string;
  emotionalValence?: number;
  importanceScore?: number;
}): Promise<void> {
  const supabase = createClient();
  const { content, domain, sessionId, emotionalValence = 0, importanceScore = 0.5 } = params;

  const embedding = await embedText(content);

  const { error: memoryError } = await supabase.from("atlas_memory").insert({
    session_id: sessionId,
    content,
    embedding: JSON.stringify(embedding),
    domain,
    emotional_valence: emotionalValence,
    importance_score: importanceScore,
  });

  if (memoryError) {
    console.error("Failed to store memory:", memoryError.message);
    return;
  }

  // High-importance memories also go into dossier
  if (importanceScore > 0.8) {
    await supabase.from("atlas_dossier_full").insert({
      entry_type: detectEntryType(content, domain),
      content: { text: content, source: "conversation", session_id: sessionId },
      domain,
      pattern_strength: importanceScore,
    });
  }
}

function detectEntryType(
  content: string,
  domain: string
): "financial_decision" | "avoidance_pattern" | "cultural_preference" | "conversation_insight" | "behavioral_pattern" | "growth_moment" | "recurring_theme" {
  const lower = content.toLowerCase();
  if (domain === "financial" || domain === "trading") {
    if (lower.includes("avoid") || lower.includes("never") || lower.includes("refuse")) return "avoidance_pattern";
    if (lower.includes("decide") || lower.includes("buy") || lower.includes("sell") || lower.includes("invest")) return "financial_decision";
  }
  if (domain === "culture" || domain === "music") return "cultural_preference";
  if (lower.includes("pattern") || lower.includes("always") || lower.includes("tend to")) return "behavioral_pattern";
  if (lower.includes("realized") || lower.includes("learned") || lower.includes("understood")) return "growth_moment";
  return "conversation_insight";
}

export async function recallRelevantMemories(params: {
  query: string;
  domain?: string;
  limit?: number;
}): Promise<AtlasMemory[]> {
  const supabase = createClient();
  const { query, domain, limit = 5 } = params;

  const queryEmbedding = await embedText(query);

  // Use Supabase RPC for vector similarity search
  const { data, error } = await supabase.rpc("match_atlas_memories", {
    query_embedding: JSON.stringify(queryEmbedding),
    match_domain: domain ?? null,
    match_limit: limit,
    min_importance: 0.3,
  });

  if (error || !data) return [];

  // Update access counts in background
  const ids = (data as AtlasMemory[]).map((m) => m.id);
  if (ids.length > 0) {
    supabase.rpc("touch_atlas_memories", { memory_ids: ids }).then(() => {});
  }

  return data as AtlasMemory[];
}

export async function buildContextWindow(params: {
  currentMessage: string;
  sessionHistory: Message[];
  domain?: string;
}): Promise<string> {
  const supabase = createClient();
  const { currentMessage, domain } = params;

  const [memories, dossierResult, portfolioResult, decisionsResult, tradeResult] =
    await Promise.allSettled([
      recallRelevantMemories({ query: currentMessage, domain, limit: 5 }),
      supabase
        .from("atlas_dossier_full")
        .select("entry_type, content, domain, pattern_strength, created_at")
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("atlas_portfolio_state")
        .select("total_value, monthly_cashflow, annual_return_rate, rebalancing_needed, snapshot_at")
        .order("snapshot_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("atlas_decision_queue")
        .select("decision_type, business_context, recommendation, capital_at_stake, status, created_at")
        .in("decision_type", ["ORANGE", "RED"])
        .eq("status", "PENDING")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("atlas_trade_audit")
        .select("action, instrument, price, regime_at_entry, outcome, timestamp")
        .order("timestamp", { ascending: false })
        .limit(5),
    ]);

  const blocks: string[] = [];

  // Recalled memories
  const recalledMemories =
    memories.status === "fulfilled" && memories.value.length > 0 ? memories.value : [];
  if (recalledMemories.length > 0) {
    blocks.push(
      "RELEVANT MEMORIES:\n" +
        recalledMemories
          .map((m) => `[${m.domain ?? "general"}] ${m.content}`)
          .join("\n")
    );
  }

  // Dossier insights
  const dossierRows =
    dossierResult.status === "fulfilled" && dossierResult.value.data
      ? dossierResult.value.data
      : [];
  if (dossierRows.length > 0) {
    blocks.push(
      "RECENT DOSSIER ENTRIES:\n" +
        dossierRows
          .map(
            (d: Record<string, unknown>) =>
              `[${d.entry_type}] ${JSON.stringify(d.content).slice(0, 200)}`
          )
          .join("\n")
    );
  }

  // Portfolio state
  const portfolio =
    portfolioResult.status === "fulfilled" ? portfolioResult.value.data : null;
  if (portfolio) {
    blocks.push(
      `PORTFOLIO STATE (as of ${portfolio.snapshot_at ?? "unknown"}):\n` +
        `Total Value: $${portfolio.total_value?.toLocaleString() ?? "unknown"}\n` +
        `Monthly Cashflow: $${portfolio.monthly_cashflow?.toLocaleString() ?? "unknown"}\n` +
        `Annual Return: ${portfolio.annual_return_rate ?? "unknown"}%\n` +
        `Rebalancing Needed: ${portfolio.rebalancing_needed ? "YES" : "No"}`
    );
  }

  // Pending decisions
  const decisions =
    decisionsResult.status === "fulfilled" && decisionsResult.value.data
      ? decisionsResult.value.data
      : [];
  if (decisions.length > 0) {
    blocks.push(
      "PENDING DECISIONS REQUIRING ATTENTION:\n" +
        decisions
          .map(
            (d: Record<string, unknown>) =>
              `[${d.decision_type}] ${d.business_context} — $${d.capital_at_stake} at stake`
          )
          .join("\n")
    );
  }

  // Recent trades
  const trades =
    tradeResult.status === "fulfilled" && tradeResult.value.data
      ? tradeResult.value.data
      : [];
  if (trades.length > 0) {
    blocks.push(
      "RECENT TRADES:\n" +
        trades
          .map(
            (t: Record<string, unknown>) =>
              `${t.action} ${t.instrument} @ ${t.price} (${t.regime_at_entry ?? "unknown regime"})`
          )
          .join("\n")
    );
  }

  if (blocks.length === 0) return "";

  return (
    "━━━ ATLAS CONTEXT ━━━\n" + blocks.join("\n\n") + "\n━━━ END CONTEXT ━━━\n\n"
  );
}

export function detectDomain(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(trade|forex|stock|option|position|portfolio|p&l|pnl|equity|futures)\b/.test(lower))
    return "trading";
  if (/\b(property|rent|lease|mortgage|cap rate|noi|real estate|multifamily)\b/.test(lower))
    return "realestate";
  if (/\b(business|revenue|pipeline|client|contractor|invoice|startup)\b/.test(lower))
    return "business";
  if (/\b(jazz|blues|hip.?hop|soul|music|album|artist|song|band)\b/.test(lower))
    return "music";
  if (/\b(history|civilization|empire|war|politics|culture)\b/.test(lower))
    return "history";
  if (/\b(philosophy|stoic|aurelius|nietzsche|meaning|virtue|wisdom)\b/.test(lower))
    return "philosophy";
  if (/\b(invest|capital|money|wealth|savings|budget|financial)\b/.test(lower))
    return "financial";
  return "personal";
}

export function detectEmotionalValence(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  const positive = ["excited", "great", "amazing", "love", "perfect", "winning", "profit", "growth", "proud", "happy", "yes", "absolutely"];
  const negative = ["worried", "afraid", "stressed", "lost", "failed", "bad", "terrible", "scared", "anxious", "confused", "loss", "debt"];
  for (const word of positive) if (lower.includes(word)) score += 0.15;
  for (const word of negative) if (lower.includes(word)) score -= 0.15;
  return Math.max(-1, Math.min(1, score));
}

export function detectImportanceScore(text: string, domain: string): number {
  const lower = text.toLowerCase();
  let score = 0.4;
  if (domain === "trading" || domain === "financial") score += 0.2;
  if (/\$[\d,]+|\d+%/.test(text)) score += 0.15;
  if (/\b(decide|commit|never|always|rule|principle|realize|understand)\b/.test(lower)) score += 0.2;
  if (text.length > 200) score += 0.1;
  return Math.min(1, score);
}
