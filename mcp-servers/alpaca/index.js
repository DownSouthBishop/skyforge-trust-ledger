// Atlas MCP Server — Alpaca REST API
// Equities and crypto via Alpaca paper/live accounts.
// Config via env: ALPACA_API_KEY, ALPACA_SECRET_KEY, ALPACA_BASE_URL

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_KEY    = process.env.ALPACA_API_KEY    ?? "";
const SECRET_KEY = process.env.ALPACA_SECRET_KEY ?? "";
const BASE_URL   = process.env.ALPACA_BASE_URL   ?? "https://paper-api.alpaca.markets";
const DATA_URL   = "https://data.alpaca.markets";

const headers = () => ({
  "APCA-API-KEY-ID": API_KEY,
  "APCA-API-SECRET-KEY": SECRET_KEY,
  "Content-Type": "application/json",
});

async function alpacaGet(base, path) {
  const res = await fetch(`${base}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${await res.text()}`);
  return res.json();
}

async function alpacaPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${await res.text()}`);
  return res.json();
}

async function alpacaDelete(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "DELETE", headers: headers() });
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${await res.text()}`);
  return res.json().catch(() => ({ ok: true }));
}

const server = new Server(
  { name: "atlas-alpaca", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "alpaca_get_account",
      description: "Get Alpaca account: buying power, portfolio value, cash, pattern day trader status.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "alpaca_get_positions",
      description: "List all open Alpaca positions with unrealized P&L, market value, and quantity.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "alpaca_get_orders",
      description: "List recent orders (open or all) from Alpaca.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open", "closed", "all"], default: "open" },
          limit: { type: "number", default: 20 },
        },
        required: [],
      },
    },
    {
      name: "alpaca_get_quote",
      description: "Get the latest bid/ask quote for a symbol.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "e.g. AAPL" },
        },
        required: ["symbol"],
      },
    },
    {
      name: "alpaca_get_bars",
      description: "Get OHLCV bar data for a symbol.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          timeframe: { type: "string", description: "1Min 5Min 15Min 1Hour 1Day", default: "1Day" },
          limit: { type: "number", default: 50 },
        },
        required: ["symbol"],
      },
    },
    {
      name: "alpaca_place_order",
      description: "Place a market or limit order on Alpaca.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          qty: { type: "number", description: "Number of shares. Use notional for dollar-based orders." },
          notional: { type: "number", description: "Dollar amount to buy/sell (fractional shares). Alternative to qty." },
          side: { type: "string", enum: ["buy", "sell"] },
          type: { type: "string", enum: ["market", "limit", "stop", "stop_limit"], default: "market" },
          time_in_force: { type: "string", enum: ["day", "gtc", "ioc", "fok"], default: "day" },
          limit_price: { type: "number", description: "Required for limit/stop_limit orders." },
          stop_price: { type: "number", description: "Required for stop/stop_limit orders." },
        },
        required: ["symbol", "side"],
      },
    },
    {
      name: "alpaca_close_position",
      description: "Close all or part of an Alpaca position by symbol.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          qty: { type: "number", description: "Shares to close. Omit to close all." },
          percentage: { type: "number", description: "Percentage of position to close (0-100). Alternative to qty." },
        },
        required: ["symbol"],
      },
    },
    {
      name: "alpaca_cancel_order",
      description: "Cancel an open Alpaca order by order ID.",
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
        },
        required: ["order_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "alpaca_get_account") {
      const data = await alpacaGet(BASE_URL, "/v2/account");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "alpaca_get_positions") {
      const data = await alpacaGet(BASE_URL, "/v2/positions");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "alpaca_get_orders") {
      const status = args.status ?? "open";
      const limit  = args.limit ?? 20;
      const data   = await alpacaGet(BASE_URL, `/v2/orders?status=${status}&limit=${limit}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "alpaca_get_quote") {
      const data = await alpacaGet(DATA_URL, `/v2/stocks/${args.symbol}/quotes/latest`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "alpaca_get_bars") {
      const tf  = args.timeframe ?? "1Day";
      const lim = args.limit ?? 50;
      const data = await alpacaGet(DATA_URL, `/v2/stocks/${args.symbol}/bars?timeframe=${tf}&limit=${lim}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "alpaca_place_order") {
      const body = {
        symbol:        args.symbol,
        side:          args.side,
        type:          args.type ?? "market",
        time_in_force: args.time_in_force ?? "day",
        ...(args.qty      && { qty: String(args.qty) }),
        ...(args.notional && { notional: String(args.notional) }),
        ...(args.limit_price && { limit_price: String(args.limit_price) }),
        ...(args.stop_price  && { stop_price: String(args.stop_price) }),
      };
      const data = await alpacaPost("/v2/orders", body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "alpaca_close_position") {
      const params = new URLSearchParams();
      if (args.qty)        params.set("qty", String(args.qty));
      if (args.percentage) params.set("percentage", String(args.percentage));
      const qs  = params.toString() ? `?${params}` : "";
      const res = await fetch(`${BASE_URL}/v2/positions/${args.symbol}${qs}`, {
        method: "DELETE",
        headers: headers(),
      });
      const data = await res.json().catch(() => ({ ok: true }));
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "alpaca_cancel_order") {
      const data = await alpacaDelete(`/v2/orders/${args.order_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
