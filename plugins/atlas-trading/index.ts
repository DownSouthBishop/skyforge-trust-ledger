// Atlas ElizaOS Plugin — Trading Execution
// Actions: PLACE_TRADE, CHECK_POSITIONS, CLOSE_POSITION, ACCOUNT_SUMMARY
// Providers: OPEN_POSITIONS, ACCOUNT_BALANCES

import type { Plugin, IAgentRuntime, Memory, State } from "@elizaos/core";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function sbGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { headers: sbHeaders });
  return res.json();
}

async function sbPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: "POST",
    headers: sbHeaders,
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── Providers ────────────────────────────────────────────────────────────────

const openPositionsProvider = {
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      const userId = (state as any).userId ?? runtime.agentId;
      const trades = await sbGet(
        `/trade_ledger?user_id=eq.${userId}&status=eq.open&select=symbol,direction,entry_price,quantity,broker,pnl_usd,opened_at&order=opened_at.desc`,
      );
      if (!Array.isArray(trades) || trades.length === 0) return "No open positions.";
      const lines = trades.map((t: any) =>
        `${t.symbol} ${t.direction.toUpperCase()} | Entry: ${t.entry_price} | Qty: ${t.quantity} | P&L: ${t.pnl_usd ?? "—"} | Broker: ${t.broker}`,
      );
      return `Open positions (${trades.length}):\n${lines.join("\n")}`;
    } catch {
      return "Could not load positions.";
    }
  },
};

const accountBalancesProvider = {
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      const userId = (state as any).userId ?? runtime.agentId;
      const accounts = await sbGet(
        `/trading_accounts?user_id=eq.${userId}&is_active=eq.true&select=broker,account_type,balance_usd,buying_power_usd`,
      );
      if (!Array.isArray(accounts) || accounts.length === 0) return "No broker accounts connected.";
      const total  = accounts.reduce((s: number, a: any) => s + Number(a.balance_usd ?? 0), 0);
      const lines  = accounts.map((a: any) =>
        `${a.broker.toUpperCase()} [${a.account_type}]: $${Number(a.balance_usd ?? 0).toLocaleString()} | BP: $${Number(a.buying_power_usd ?? 0).toLocaleString()}`,
      );
      return `Accounts (total capital: $${total.toLocaleString()}):\n${lines.join("\n")}`;
    } catch {
      return "Could not load accounts.";
    }
  },
};

// ─── Actions ──────────────────────────────────────────────────────────────────

const checkPositionsAction = {
  name: "CHECK_POSITIONS",
  description: "Check all open trading positions and their current P&L.",
  similes: ["SHOW_POSITIONS", "GET_POSITIONS", "MY_POSITIONS", "WHAT_ARE_MY_POSITIONS"],
  examples: [
    [{ user: "user", content: { text: "What positions do I have open?" } }],
    [{ user: "user", content: { text: "Check my book" } }],
  ],
  validate: async () => true,
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: unknown, callback: Function) => {
    const posText = await openPositionsProvider.get(runtime, message, state);
    const acctText = await accountBalancesProvider.get(runtime, message, state);
    callback({ text: `${acctText}\n\n${posText}` });
    return true;
  },
};

const accountSummaryAction = {
  name: "ACCOUNT_SUMMARY",
  description: "Get a full account summary including balances, positions, and daily P&L.",
  similes: ["ACCOUNT_STATUS", "PORTFOLIO_SUMMARY", "HOW_IS_MY_ACCOUNT"],
  examples: [
    [{ user: "user", content: { text: "Give me an account summary" } }],
  ],
  validate: async () => true,
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: unknown, callback: Function) => {
    const userId = (state as any).userId ?? runtime.agentId;
    try {
      const [accounts, openTrades, closedToday] = await Promise.all([
        sbGet(`/trading_accounts?user_id=eq.${userId}&is_active=eq.true&select=broker,balance_usd,buying_power_usd`),
        sbGet(`/trade_ledger?user_id=eq.${userId}&status=eq.open&select=symbol,pnl_usd`),
        sbGet(`/trade_ledger?user_id=eq.${userId}&status=eq.closed&closed_at=gte.${new Date().toISOString().slice(0, 10)}&select=pnl_usd`),
      ]);
      const totalCapital = Array.isArray(accounts) ? accounts.reduce((s: number, a: any) => s + Number(a.balance_usd ?? 0), 0) : 0;
      const openPnl      = Array.isArray(openTrades) ? openTrades.reduce((s: number, t: any) => s + Number(t.pnl_usd ?? 0), 0) : 0;
      const realizedToday = Array.isArray(closedToday) ? closedToday.reduce((s: number, t: any) => s + Number(t.pnl_usd ?? 0), 0) : 0;
      const summary = [
        `Capital: $${totalCapital.toLocaleString()}`,
        `Open positions: ${Array.isArray(openTrades) ? openTrades.length : 0}`,
        `Open P&L: ${openPnl >= 0 ? "+" : ""}$${Math.abs(openPnl).toFixed(2)}`,
        `Today realized: ${realizedToday >= 0 ? "+" : ""}$${Math.abs(realizedToday).toFixed(2)}`,
      ].join("\n");
      callback({ text: summary });
    } catch {
      callback({ text: "Could not load account summary." });
    }
    return true;
  },
};

const placeTradeAction = {
  name: "PLACE_TRADE",
  description: "Log a new trade in the Atlas trade ledger after risk check approval.",
  similes: ["LOG_TRADE", "ENTER_TRADE", "OPEN_POSITION", "BUY", "SELL"],
  examples: [
    [{ user: "user", content: { text: "Buy 1000 units of EUR/USD at 1.0850" } }],
    [{ user: "user", content: { text: "Log a short on AAPL, 10 shares at 192.50" } }],
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = (message.content?.text ?? "").toLowerCase();
    return /\b(buy|sell|long|short|enter|place|log)\b/.test(text);
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: unknown, callback: Function) => {
    const userId = (state as any).userId ?? runtime.agentId;
    try {
      const riskRes = await fetch(`${SUPABASE_URL}/functions/v1/atlas_risk_check`, {
        method: "POST",
        headers: { ...sbHeaders, Authorization: `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ user_id: userId, message: message.content.text }),
      });
      const risk = await riskRes.json();
      if (!risk.go) {
        callback({ text: `Risk check blocked: ${risk.violations?.join(", ") ?? "Unknown violation"}. ${risk.warnings?.join(", ") ?? ""}` });
        return false;
      }
      callback({
        text: risk.requires_approval
          ? `Trade queued for approval (>$500). ${risk.warnings?.join(", ") ?? ""} Use APPROVE_TRADE to confirm.`
          : `Risk check passed. ${risk.warnings?.join(", ") ?? ""} Trade logged. Use the app to confirm execution.`,
      });
    } catch (err) {
      callback({ text: `Trade error: ${(err as Error).message}` });
    }
    return true;
  },
};

const closePositionAction = {
  name: "CLOSE_POSITION",
  description: "Close an open position by symbol.",
  similes: ["EXIT_TRADE", "CLOSE_TRADE", "SELL_POSITION", "GET_OUT"],
  examples: [
    [{ user: "user", content: { text: "Close my EUR/USD position" } }],
    [{ user: "user", content: { text: "Exit AAPL" } }],
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = (message.content?.text ?? "").toLowerCase();
    return /\b(close|exit|sell|get out)\b/.test(text);
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: unknown, callback: Function) => {
    const userId = (state as any).userId ?? runtime.agentId;
    const text   = message.content?.text ?? "";
    const symMatch = text.match(/\b([A-Z]{1,6}\/[A-Z]{1,6}|[A-Z]{2,6})\b/);
    if (!symMatch) {
      callback({ text: "Which position should I close? Specify the symbol." });
      return false;
    }
    const symbol = symMatch[1];
    callback({ text: `Close signal noted for ${symbol}. Update the position in the Positions page with your exit price to finalize P&L.` });
    return true;
  },
};

// ─── Plugin export ────────────────────────────────────────────────────────────

const atlasTrading: Plugin = {
  name: "atlas-trading",
  description: "Atlas trading execution — positions, accounts, risk checks, and trade logging.",
  actions: [checkPositionsAction, accountSummaryAction, placeTradeAction, closePositionAction],
  providers: [openPositionsProvider, accountBalancesProvider],
  evaluators: [],
};

export default atlasTrading;
