// Local MCP server — page scraping and site crawling.
// Node/jsdom equivalent of the operator's scrapy fork: no local Python
// interpreter was available to run Scrapy itself, so this reimplements
// single-page extraction and same-domain crawling with fetch + jsdom.
// Swap this out for a real Scrapy-backed server once Python is installed.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { JSDOM } from "jsdom";

const USER_AGENT = "Mozilla/5.0 (compatible; AtlasScraper/1.0)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const html = await res.text();
  const dom = new JSDOM(html, { url });
  return dom.window.document;
}

function extractText(doc, selector) {
  if (selector) {
    return Array.from(doc.querySelectorAll(selector))
      .map((el) => el.textContent.trim())
      .filter(Boolean);
  }
  return [doc.body?.textContent.replace(/\s+/g, " ").trim() ?? ""];
}

function extractLinks(doc, baseUrl) {
  const seen = new Set();
  const links = [];
  for (const a of doc.querySelectorAll("a[href]")) {
    try {
      const href = new URL(a.getAttribute("href"), baseUrl).href;
      if (seen.has(href)) continue;
      seen.add(href);
      links.push({ href, text: a.textContent.trim().slice(0, 120) });
    } catch {
      // skip unparseable hrefs (mailto:, javascript:, etc.)
    }
  }
  return links;
}

const server = new Server(
  { name: "atlas-scraper", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "scrape_page",
      description: "Fetch a single URL and extract its title, meta description, links, and text (optionally scoped to a CSS selector).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The page URL to fetch." },
          selector: { type: "string", description: "Optional CSS selector — if given, returns text of matching elements instead of the whole page." },
        },
        required: ["url"],
      },
    },
    {
      name: "crawl_site",
      description: "Breadth-first crawl starting from a URL, following links, returning title + text excerpt per page visited.",
      inputSchema: {
        type: "object",
        properties: {
          start_url: { type: "string", description: "URL to start crawling from." },
          max_pages: { type: "number", description: "Max pages to visit (default 10, capped at 50).", default: 10 },
          same_domain_only: { type: "boolean", description: "Only follow links on the same domain as start_url.", default: true },
        },
        required: ["start_url"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "scrape_page") {
      const doc = await fetchPage(args.url);
      const result = {
        title: doc.title,
        description: doc.querySelector('meta[name="description"]')?.getAttribute("content") ?? null,
        text: extractText(doc, args.selector),
        links: extractLinks(doc, args.url).slice(0, 100),
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "crawl_site") {
      const maxPages = Math.min(args.max_pages ?? 10, 50);
      const sameDomainOnly = args.same_domain_only ?? true;
      const startHost = new URL(args.start_url).host;

      const visited = new Set();
      const queue = [args.start_url];
      const pages = [];

      while (queue.length > 0 && pages.length < maxPages) {
        const url = queue.shift();
        if (visited.has(url)) continue;
        visited.add(url);

        try {
          const doc = await fetchPage(url);
          const text = extractText(doc)[0];
          pages.push({ url, title: doc.title, text_excerpt: text.slice(0, 300) });

          for (const link of extractLinks(doc, url)) {
            if (visited.has(link.href)) continue;
            if (sameDomainOnly && new URL(link.href).host !== startHost) continue;
            queue.push(link.href);
          }
        } catch (err) {
          pages.push({ url, error: err.message });
        }

        await sleep(300); // politeness delay between requests
      }

      return { content: [{ type: "text", text: JSON.stringify(pages, null, 2) }] };
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
