// mcp-alpaca — Alpaca as remote MCP server
import { corsHeaders, parseEnv, verifyUser, AuthError } from "../_shared/gateway.ts";
function env(k) { const v = Deno.env.get(k); if (!v) throw new Error(`Missing: ${k}`); return v; }
const TOOLS = [
  { name: "alpaca_account", description: "Alpaca account: buying power, portfolio value, cash.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "alpaca_positions", description: "All open Alpaca positions with P&L.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "alpaca_quote", description: "Latest quote for a symbol.", input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
  { name: "alpaca_bars", description: "OHLCV bars for a symbol.", input_schema: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string", default: "1Day" }, limit: { type: "number", default: 50 } }, required: ["symbol"] } },
  { name: "alpaca_place_order", description: "Place a market or limit order.", input_schema: { type: "object", properties: { symbol: { type: "string" }, qty: { type: "number" }, side: { type: "string", enum: ["buy","sell"] }, type: { type: "string", default: "market" }, limit_price: { type: "number" } }, required: ["symbol","side"] } },
  { name: "alpaca_close_position", description: "Close a position by symbol.", input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
];
const BASE = () => Deno.env.get("ALPACA_BASE_URL")??"https://paper-api.alpaca.markets";
const hdrs = () => ({ "APCA-API-KEY-ID": env("ALPACA_API_KEY"), "APCA-API-SECRET-KEY": env("ALPACA_SECRET_KEY"), "Content-Type": "application/json" });
async function ag(path) { const r=await fetch(`${BASE()}${path}`,{headers:hdrs()}); if(!r.ok) throw new Error(`Alpaca ${r.status}: ${await r.text()}`); return r.json(); }
async function dg(path) { const r=await fetch(`https://data.alpaca.markets${path}`,{headers:hdrs()}); if(!r.ok) throw new Error(`Alpaca data ${r.status}: ${await r.text()}`); return r.json(); }
async function call(name, args) {
  if (name==="alpaca_account")   return JSON.stringify(await ag("/v2/account"),null,2);
  if (name==="alpaca_positions") return JSON.stringify(await ag("/v2/positions"),null,2);
  if (name==="alpaca_quote")     return JSON.stringify(await dg(`/v2/stocks/${args.symbol}/quotes/latest`),null,2);
  if (name==="alpaca_bars")      return JSON.stringify(await dg(`/v2/stocks/${args.symbol}/bars?timeframe=${args.timeframe??"1Day"}&limit=${args.limit??50}`),null,2);
  if (name==="alpaca_place_order") { const body={symbol:args.symbol,side:args.side,type:args.type??"market",time_in_force:"day"}; if(args.qty) body.qty=String(args.qty); if(args.limit_price) body.limit_price=String(args.limit_price); const r=await fetch(`${BASE()}/v2/orders`,{method:"POST",headers:hdrs(),body:JSON.stringify(body)}); if(!r.ok) throw new Error(`Alpaca ${r.status}: ${await r.text()}`); return JSON.stringify(await r.json(),null,2); }
  if (name==="alpaca_close_position") { const r=await fetch(`${BASE()}/v2/positions/${args.symbol}`,{method:"DELETE",headers:hdrs()}); return JSON.stringify(await r.json().catch(()=>({ok:true})),null,2); }
  throw new Error(`Unknown: ${name}`);
}
Deno.serve(async (req) => {
  if (req.method==="OPTIONS") return new Response(null,{headers:corsHeaders});
  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    let userId: string;
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (req.method==="GET") return new Response(JSON.stringify({tools:TOOLS}),{headers:{...corsHeaders,"content-type":"application/json"}});
    const body=await req.json(); const text=await call(body.name??body.tool,body.arguments??body.input??{});
    return new Response(JSON.stringify({content:[{type:"text",text}]}),{headers:{...corsHeaders,"content-type":"application/json"}});
  } catch(e) { return new Response(JSON.stringify({content:[{type:"text",text:`Error: ${e.message}`}],isError:true}),{headers:{...corsHeaders,"content-type":"application/json"}}); }
});
