import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import open from "open";
import fs from "fs";

const server = new Server({ name: "h-guide-server", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "read_web_url",
                description: "Fetches and reads the raw text content from a live URL.",
                inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
            },
            {
                name: "read_external_file",
                description: "Reads a file from the user's computer outside the workspace using an absolute path.",
                inputSchema: { type: "object", properties: { absolute_filepath: { type: "string" } }, required: ["absolute_filepath"] }
            },
            {
                name: "fetch_live_input",
                description: "Fetches the current text the user just pasted into their Input/Payload tab in the UI.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "open_webpage",
                description: "Opens a specific URL in the user's local browser.",
                inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "read_web_url") {
        try {
            const response = await fetch(args.url);
            const text = await response.text();
            // Klipper av vid 15000 tecken så att en massiv webbsida inte kraschar max-tokens för ett enskilt anrop
            return { content: [{ type: "text", text: text.substring(0, 15000) }] }; 
        } catch (err) {
            return { content: [{ type: "text", text: `[ERROR] Kunde inte läsa URL: ${err.message}` }] };
        }
    }

    if (name === "read_external_file") {
        try {
            const content = fs.readFileSync(args.absolute_filepath, "utf-8");
            return { content: [{ type: "text", text: content }] };
        } catch (err) {
            return { content: [{ type: "text", text: `[ERROR] Kunde inte läsa filen: ${err.message}` }] };
        }
    }

    if (name === "fetch_live_input") {
        try {
            // Hämtar den aktuella payloaden från din Express-server
            const response = await fetch("http://localhost:3000/api/payload");
            const data = await response.json();
            return { content: [{ type: "text", text: data.payload || "[Tomt i Input-fliken]" }] };
        } catch (err) {
            return { content: [{ type: "text", text: `[ERROR] Kunde inte hämta live-input. Har du sparat den till servern?` }] };
        }
    }

    if (name === "open_webpage") {
        try {
            await open(args.url);
            return { content: [{ type: "text", text: `[SUCCESS] Öppnade ${args.url} i webbläsaren.` }] };
        } catch (err) {
            return { content: [{ type: "text", text: `[ERROR] Kunde inte öppna URL: ${err.message}` }] };
        }
    }

    throw new Error("Tool not found");
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("H-MCP Server running (ESM)");
}
main().catch(console.error);