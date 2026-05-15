// Atlas MCP Server — OANDA v20 REST
// Gives Claude direct access to OANDA account, positions, orders, and live prices.
// Config via env: OANDA_API_KEY, OANDA_ACCOUNT_ID, OANDA_ENV (practice|live)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const OANDA_API_KEY  = process.env.OANDA_API_KEY  ?? "";
const OANDA_ACCOUNT  = process.env.OANDA_ACCOUNT_ID ?? "";
const OANDA_ENV      = process.env.OANDA_ENV ?? "practice";
const BASE_URL       = OANDA_ENV === "live"
  ? "https://api-fxtrade.oanda.com"
  : "https://api-fxpractice.oanda.com";

const headers = () => ({
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});

async function oandaGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`OANDA ${res.status}: ${await res.text()}`);
  return res.json();
}

async function oandaPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OANDA ${res.status}: ${await res.text()}`);
  return res.json();
}

const server = new Server(
  { name: "atlas-oanda", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "oanda_get_account",
      description: "Get OANDA account summary: balance, NAV, margin used, open trade count, unrealized P&L.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "oanda_get_positions",
      description: "List all open positions with unrealized P&L, units, and average price.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "oanda_get_open_trades",
      description: "List all open trades with entry price, current units, unrealized P&L, and instrument.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "oanda_get_price",
      description: "Get the current bid/ask price for one or more forex instruments.",
      inputSchema: {
        type: "object",
        properties: {
          instruments: {
            type: "string",
            description: "Comma-separated OANDA instrument codes, e.g. EUR_USD,GBP_USD",
          },
        },
        required: ["instruments"],
      },
    },
    {
      name: "oanda_get_candles",
      description: "Get OHLC candlestick data for a forex instrument.",
      inputSchema: {
        type: "object",
        properties: {
          instrument: { type: "string", description: "e.g. EUR_USD" },
          granularity: { type: "string", description: "S5 S10 S15 S30 M1 M5 M15 M30 H1 H4 D W M", default: "H1" },
          count: { type: "number", description: "Number of candles (max 500)", default: 100 },
        },
        required: ["instrument"],
      },
    },
    {
      name: "oanda_place_order",
      description: "Place a market or limit order on OANDA. Requires OANDA_API_KEY and OANDA_ACCOUNT_ID.",
      inputSchema: {
        type: "object",
        properties: {
          instrument: { type: "string", description: "e.g. EUR_USD" },
          units: { type: "number", description: "Positive = buy (long), negative = sell (short). In units of the base currency." },
          type: { type: "string", enum: ["MARKET", "LIMIT"], default: "MARKET" },
          price: { type: "number", description: "Required for LIMIT orders." },
          stop_loss: { type: "number", description: "Stop loss price (optional)." },
          take_profit: { type: "number", description: "Take profit price (optional)." },
        },
        required: ["instrument", "units"],
      },
    },
    {
      name: "oanda_close_trade",
      description: "Close an open OANDA trade by trade ID.",
      inputSchema: {
        type: "object",
        properties: {
          trade_id: { type: "string", description: "The OANDA trade ID to close." },
          units: { type: "string", description: "Units to close. Use 'ALL' to close the entire position.", default: "ALL" },
        },
        required: ["trade_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "oanda_get_account") {
      const data = await oandaGet(`/v3/accounts/${OANDA_ACCOUNT}/summary`);
      return { content: [{ type: "text", text: JSON.stringify(data.account, null, 2) }] };
    }

    if (name === "oanda_get_positions") {
      const data = await oandaGet(`/v3/accounts/${OANDA_ACCOUNT}/openPositions`);
      return { content: [{ type: "text", text: JSON.stringify(data.positions, null, 2) }] };
    }

    if (name === "oanda_get_open_trades") {
      const data = await oandaGet(`/v3/accounts/${OANDA_ACCOUNT}/openTrades`);
      return { content: [{ type: "text", text: JSON.stringify(data.trades, null, 2) }] };
    }

    if (name === "oanda_get_price") {
      const data = await oandaGet(
        `/v3/accounts/${OANDA_ACCOUNT}/pricing?instruments=${encodeURIComponent(args.instruments)}`,
      );
      return { content: [{ type: "text", text: JSON.stringify(data.prices, null, 2) }] };
    }

    if (name === "oanda_get_candles") {
      const gran  = args.granularity ?? "H1";
      const count = args.count ?? 100;
      const data  = await oandaGet(
        `/v3/instruments/${args.instrument}/candles?granularity=${gran}&count=${count}&price=MBA`,
      );
      return { content: [{ type: "text", text: JSON.stringify(data.candles, null, 2) }] };
    }

    if (name === "oanda_place_order") {
      const order = {
        type: args.type ?? "MARKET",
        instrument: args.instrument,
        units: String(args.units),
        ...(args.price && { price: String(args.price) }),
        ...(args.stop_loss && {
          stopLossOnFill: { price: String(args.stop_loss), timeInForce: "GTC" },
        }),
        ...(args.take_profit && {
          takeProfitOnFill: { price: String(args.take_profit), timeInForce: "GTC" },
        }),
      };
      const data = await oandaPost(`/v3/accounts/${OANDA_ACCOUNT}/orders`, { order });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "oanda_close_trade") {
      const units = args.units ?? "ALL";
      const res = await fetch(
        `${BASE_URL}/v3/accounts/${OANDA_ACCOUNT}/trades/${args.trade_id}/close`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify(units === "ALL" ? {} : { units: String(units) }),
        },
      );
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
