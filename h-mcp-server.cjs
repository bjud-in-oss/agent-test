#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const open = require("open");
const https = require("https");
const http = require("http");
const url = require("url");

function fetchHtmlAndExtractLinks(targetUrl) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = url.parse(targetUrl);
      const isHttps = parsedUrl.protocol === "https:";
      const client = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.path || "/",
        port: parsedUrl.port || (isHttps ? 443 : 80),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        },
        timeout: 10000
      };

      const req = client.get(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = url.resolve(targetUrl, res.headers.location);
          return fetchHtmlAndExtractLinks(redirectUrl).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Website returned status code: ${res.statusCode}`));
        }

        let html = "";
        res.on("data", chunk => html += chunk);
        res.on("end", () => {
          const links = [];
          const regex = /<a\s+(?:[^>]*?\s+)?href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
          let match;
          while ((match = regex.exec(html)) !== null) {
            let href = match[1].trim();
            let text = match[2].replace(/<[^>]*>/g, "").trim();
            if (href && !href.startsWith("http://") && !href.startsWith("https://")) {
              href = url.resolve(targetUrl, href);
            }
            if (href.startsWith("http")) {
              const cleanUrl = href.split("#")[0];
              links.push({ text: text || cleanUrl, url: cleanUrl });
            }
          }
          const uniqueLinks = [];
          const seen = new Set();
          for (const item of links) {
            if (!seen.has(item.url)) {
              seen.add(item.url);
              uniqueLinks.push(item);
            }
          }
          resolve(uniqueLinks);
        });
      });
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout (10s)")); });
      req.on("error", err => reject(err));
    } catch (err) { reject(err); }
  });
}

const server = new Server({ name: "h-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "extract_web_sources",
        description: "Scrapes a webpage and extracts unique HTTP/HTTPS links.",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string", description: "The URL of the webpage to scrape." } },
          required: ["url"],
        },
      },
      {
        name: "open_webpage",
        description: "Opens a URL in the default system web browser.",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string", description: "The URL to open." } },
          required: ["url"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "extract_web_sources") {
    const links = await fetchHtmlAndExtractLinks(args.url);
    return { content: [{ type: "text", text: JSON.stringify(links, null, 2) }] };
  }
  if (name === "open_webpage") {
    await open(args.url);
    return { content: [{ type: "text", text: `Success: Opening ${args.url}` }] };
  }
  throw new Error(`Unknown tool: ${name}`);
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
run().catch(console.error);