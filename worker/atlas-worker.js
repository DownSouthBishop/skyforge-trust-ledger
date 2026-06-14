// Atlas Local Browser Worker
// Polls the atlas-browser edge function and executes commands via a local
// Chromium instance driven by Playwright.
//
// Setup:
//   1. cd worker && npm install && npx playwright install chromium
//   2. Copy .env.example to .env and fill in values.
//   3. npm start
//
// Required env:
//   ATLAS_FUNCTIONS_URL   e.g. https://<project>.supabase.co/functions/v1
//   ATLAS_WORKER_TOKEN    shared secret (must match the Lovable Cloud secret)
//   ATLAS_USER_ID         the operator's auth.users.id
//   POLL_MS               (optional) default 3000
//   HEADFUL               (optional) "1" to show the browser window

import "dotenv/config";
import { chromium } from "playwright";

const BASE   = process.env.ATLAS_FUNCTIONS_URL?.replace(/\/+$/, "");
const TOKEN  = process.env.ATLAS_WORKER_TOKEN;
const USER   = process.env.ATLAS_USER_ID;
const POLL   = Number(process.env.POLL_MS ?? 3000);
const HEAD   = process.env.HEADFUL === "1";

if (!BASE || !TOKEN || !USER) {
  console.error("Missing ATLAS_FUNCTIONS_URL / ATLAS_WORKER_TOKEN / ATLAS_USER_ID");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  "x-atlas-worker-token": TOKEN,
  "x-atlas-user": USER,
};

async function api(action, extra = {}) {
  const r = await fetch(`${BASE}/atlas-browser`, {
    method: "POST", headers, body: JSON.stringify({ action, ...extra }),
  });
  if (!r.ok) throw new Error(`api ${action} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function execute(page, cmd) {
  const { command, args = {} } = cmd;
  switch (command) {
    case "navigate":   await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 }); return { url: page.url(), title: await page.title() };
    case "search":     await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(args.query)}`, { waitUntil: "domcontentloaded" }); return { url: page.url() };
    case "extract":
    case "scrape":
    case "read":       return { text: (await page.innerText("body")).slice(0, 50000), title: await page.title(), url: page.url() };
    case "screenshot": { const buf = await page.screenshot({ fullPage: !!args.full }); return { png_base64: buf.toString("base64") }; }
    case "click":      await page.click(args.selector, { timeout: 15000 }); return { clicked: args.selector };
    case "type":
    case "fill":       await page.fill(args.selector, String(args.text ?? "")); return { filled: args.selector };
    case "upload":     await page.setInputFiles(args.selector, args.path); return { uploaded: args.path };
    case "download": {
      const [dl] = await Promise.all([ page.waitForEvent("download", { timeout: 30000 }), page.click(args.selector) ]);
      const path = await dl.path(); return { saved_to: path, suggested: dl.suggestedFilename() };
    }
    case "login":      await page.fill(args.user_selector, args.username); await page.fill(args.pass_selector, args.password); await page.click(args.submit_selector); return { ok: true };
    default: throw new Error(`unsupported command ${command}`);
  }
}

async function main() {
  console.log(`[atlas-worker] starting — polling ${BASE}/atlas-browser every ${POLL}ms`);
  const browser = await chromium.launch({ headless: !HEAD });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  process.on("SIGINT", async () => { await browser.close(); process.exit(0); });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const { commands = [] } = await api("claim", { limit: 3 });
      for (const cmd of commands) {
        console.log(`[atlas-worker] ${cmd.command}`, cmd.args ?? {});
        try {
          const result = await execute(page, cmd);
          await api("complete", { id: cmd.id, result });
        } catch (e) {
          console.error(`[atlas-worker] failed`, e?.message);
          await api("complete", { id: cmd.id, error: String(e?.message ?? e) });
        }
      }
    } catch (e) {
      console.error("[atlas-worker] poll error:", e?.message);
    }
    await new Promise(r => setTimeout(r, POLL));
  }
}
main();
