// Atlas MCP Server — IBKR TWS Bridge
// Connects to Interactive Brokers Trader Workstation via the TWS API.
// Requires TWS or IB Gateway running locally with API enabled.
// Config via env: TWS_HOST (default 127.0.0.1), TWS_PORT (default 7497), TWS_CLIENT_ID (default 1)
//
// Setup: Enable "Enable ActiveX and Socket Clients" in TWS Global Configuration > API > Settings.
// Paper trading port: 7497 | Live trading port: 7496

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TWS_HOST      = process.env.TWS_HOST      ?? "127.0.0.1";
const TWS_PORT      = parseInt(process.env.TWS_PORT ?? "7497", 10);
const TWS_CLIENT_ID = parseInt(process.env.TWS_CLIENT_ID ?? "1", 10);

// Lazy-load IB connection only when a tool is called
let ib = null;
async function getIB() {
  if (ib) return ib;
  try {
    const { IBApiNext } = await import("@stoqey/ib");
    ib = new IBApiNext({ host: TWS_HOST, port: TWS_PORT, clientId: TWS_CLIENT_ID });
    await ib.connect();
    return ib;
  } catch (err) {
    throw new Error(`TWS connection failed: ${err.message}. Ensure TWS is running on ${TWS_HOST}:${TWS_PORT}.`);
  }
}

const server = new Server(
  { name: "atlas-ibkr", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ibkr_get_account_summary",
      description: "Get IBKR account summary: net liquidation, cash, available funds, margin, buying power.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "ibkr_get_positions",
      description: "List all IBKR open positions: symbol, quantity, avg cost, market value, unrealized P&L.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "ibkr_get_market_data",
      description: "Get real-time market data for a symbol from IBKR.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "e.g. AAPL" },
          sec_type: { type: "string", enum: ["STK", "OPT", "FUT", "FOREX", "CFD"], default: "STK" },
          currency: { type: "string", default: "USD" },
          exchange: { type: "string", default: "SMART" },
        },
        required: ["symbol"],
      },
    },
    {
      name: "ibkr_place_order",
      description: "Place an order via IBKR TWS. Supports stocks, options, futures, and forex.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          sec_type: { type: "string", enum: ["STK", "OPT", "FUT", "FOREX"], default: "STK" },
          action: { type: "string", enum: ["BUY", "SELL"] },
          quantity: { type: "number" },
          order_type: { type: "string", enum: ["MKT", "LMT", "STP", "STP LMT"], default: "MKT" },
          limit_price: { type: "number", description: "Required for LMT/STP LMT orders." },
          stop_price: { type: "number", description: "Required for STP/STP LMT orders." },
          time_in_force: { type: "string", enum: ["DAY", "GTC", "IOC", "GTD"], default: "DAY" },
          currency: { type: "string", default: "USD" },
          exchange: { type: "string", default: "SMART" },
        },
        required: ["symbol", "action", "quantity"],
      },
    },
    {
      name: "ibkr_get_pnl",
      description: "Get daily and unrealized P&L across all IBKR positions.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "ibkr_connection_status",
      description: "Check if the IBKR TWS connection is active.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "ibkr_connection_status") {
      try {
        const client = await getIB();
        return { content: [{ type: "text", text: `Connected to IBKR TWS at ${TWS_HOST}:${TWS_PORT}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Not connected: ${e.message}` }], isError: true };
      }
    }

    if (name === "ibkr_get_account_summary") {
      const client = await getIB();
      return new Promise((resolve) => {
        const summary = {};
        const tags = "NetLiquidation,TotalCashValue,AvailableFunds,BuyingPower,GrossPositionValue,MaintMarginReq";
        client.getAccountSummary("All", tags).subscribe({
          next: ({ account, tag, value, currency }) => {
            summary[tag] = { value, currency };
          },
          complete: () => {
            resolve({ content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] });
          },
          error: (err) => {
            resolve({ content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
          },
        });
      });
    }

    if (name === "ibkr_get_positions") {
      const client = await getIB();
      return new Promise((resolve) => {
        const positions = [];
        client.getPositions().subscribe({
          next: (pos) => positions.push(pos),
          complete: () => {
            resolve({ content: [{ type: "text", text: JSON.stringify(positions, null, 2) }] });
          },
          error: (err) => {
            resolve({ content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
          },
        });
      });
    }

    if (name === "ibkr_get_pnl") {
      const client = await getIB();
      return new Promise((resolve) => {
        const pnlData = {};
        client.getPnL("All").subscribe({
          next: (pnl) => Object.assign(pnlData, pnl),
          complete: () => {
            resolve({ content: [{ type: "text", text: JSON.stringify(pnlData, null, 2) }] });
          },
          error: (err) => {
            resolve({ content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
          },
        });
      });
    }

    if (name === "ibkr_get_market_data") {
      const client = await getIB();
      const contract = {
        symbol:   args.symbol,
        secType:  args.sec_type ?? "STK",
        currency: args.currency ?? "USD",
        exchange: args.exchange ?? "SMART",
      };
      return new Promise((resolve) => {
        const ticks = {};
        const sub = client.getMarketData(contract, "", false, false).subscribe({
          next: (tick) => Object.assign(ticks, tick),
        });
        setTimeout(() => {
          sub.unsubscribe();
          resolve({ content: [{ type: "text", text: JSON.stringify(ticks, null, 2) }] });
        }, 3000);
      });
    }

    if (name === "ibkr_place_order") {
      const client = await getIB();
      const contract = {
        symbol:   args.symbol,
        secType:  args.sec_type ?? "STK",
        currency: args.currency ?? "USD",
        exchange: args.exchange ?? "SMART",
      };
      const order = {
        action:      args.action,
        totalQuantity: args.quantity,
        orderType:   args.order_type ?? "MKT",
        tif:         args.time_in_force ?? "DAY",
        ...(args.limit_price && { lmtPrice: args.limit_price }),
        ...(args.stop_price  && { auxPrice: args.stop_price }),
      };
      return new Promise((resolve) => {
        client.placeOrder(contract, order).subscribe({
          next: (result) => {
            resolve({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
          },
          error: (err) => {
            resolve({ content: [{ type: "text", text: `Order error: ${err.message}` }], isError: true });
          },
        });
      });
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
