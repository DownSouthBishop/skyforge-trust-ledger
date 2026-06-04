// mcp-oanda — OANDA as remote MCP server
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
function env(k) { const v = Deno.env.get(k); if (!v) throw new Error(`Missing: ${k}`); return v; }
const TOOLS = [
  { name: "oanda_account", description: "OANDA account balance, NAV, margin, P&L.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "oanda_positions", description: "All open OANDA positions with P&L.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "oanda_price", description: "Live bid/ask for forex pairs.", input_schema: { type: "object", properties: { instruments: { type: "string" } }, required: ["instruments"] } },
  { name: "oanda_candles", description: "OHLC candles.", input_schema: { type: "object", properties: { instrument: { type: "string" }, granularity: { type: "string", default: "H1" }, count: { type: "number", default: 100 } }, required: ["instrument"] } },
  { name: "oanda_place_order", description: "Place order. Positive units=long, negative=short.", input_schema: { type: "object", properties: { instrument: { type: "string" }, units: { type: "number" }, type: { type: "string", default: "MARKET" }, stop_loss: { type: "number" }, take_profit: { type: "number" } }, required: ["instrument","units"] } },
  { name: "oanda_close_trade", description: "Close trade by ID.", input_schema: { type: "object", properties: { trade_id: { type: "string" }, units: { type: "string", default: "ALL" } }, required: ["trade_id"] } },
];
async function g(path) { const base = Deno.env.get("OANDA_ENV")==="live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com"; const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${env("OANDA_API_KEY")}`, Accept: "application/json" } }); if (!r.ok) throw new Error(`OANDA ${r.status}: ${await r.text()}`); return r.json(); }
async function p(path, body) { const base = Deno.env.get("OANDA_ENV")==="live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com"; const r = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${env("OANDA_API_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`OANDA ${r.status}: ${await r.text()}`); return r.json(); }
async function call(name, args) {
  const acct = env("OANDA_ACCOUNT_ID");
  if (name==="oanda_account")   return JSON.stringify((await g(`/v3/accounts/${acct}/summary`)).account, null, 2);
  if (name==="oanda_positions") return JSON.stringify((await g(`/v3/accounts/${acct}/openPositions`)).positions, null, 2);
  if (name==="oanda_price")     return JSON.stringify((await g(`/v3/accounts/${acct}/pricing?instruments=${encodeURIComponent(args.instruments)}`)).prices, null, 2);
  if (name==="oanda_candles")   return JSON.stringify((await g(`/v3/instruments/${args.instrument}/candles?granularity=${args.granularity??"H1"}&count=${args.count??100}&price=MBA`)).candles, null, 2);
  if (name==="oanda_place_order") { const order = { type: args.type??"MARKET", instrument: args.instrument, units: String(args.units) }; if (args.stop_loss) order.stopLossOnFill={price:String(args.stop_loss),timeInForce:"GTC"}; if (args.take_profit) order.takeProfitOnFill={price:String(args.take_profit),timeInForce:"GTC"}; return JSON.stringify(await p(`/v3/accounts/${acct}/orders`,{order}),null,2); }
  if (name==="oanda_close_trade") { const base=Deno.env.get("OANDA_ENV")==="live"?"https://api-fxtrade.oanda.com":"https://api-fxpractice.oanda.com"; const r=await fetch(`${base}/v3/accounts/${acct}/trades/${args.trade_id}/close`,{method:"PUT",headers:{Authorization:`Bearer ${env("OANDA_API_KEY")}`,"Content-Type":"application/json"},body:JSON.stringify(args.units==="ALL"?{}:{units:String(args.units??"ALL")})}); return JSON.stringify(await r.json(),null,2); }
  throw new Error(`Unknown: ${name}`);
}
Deno.serve(async (req) => {
  if (req.method==="OPTIONS") return new Response(null,{headers:corsHeaders});
  try {
    if (req.method==="GET") return new Response(JSON.stringify({tools:TOOLS}),{headers:{...corsHeaders,"content-type":"application/json"}});
    const body=await req.json(); const text=await call(body.name??body.tool, body.arguments??body.input??{});
    return new Response(JSON.stringify({content:[{type:"text",text}]}),{headers:{...corsHeaders,"content-type":"application/json"}});
  } catch(e) { return new Response(JSON.stringify({content:[{type:"text",text:`Error: ${e.message}`}],isError:true}),{headers:{...corsHeaders,"content-type":"application/json"}}); }
});
