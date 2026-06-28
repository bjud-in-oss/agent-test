import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import path from "path";
import fs from "fs";

const WORKSPACE_DIR = path.join(process.cwd(), "agent_workspace");

if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

const server = new Server({ name: "workspace-server", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "execute_code",
                description: "Executes terminal commands inside the workspace folder.",
                inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
            },
            {
                name: "read_file",
                description: "Reads the contents of a file in the workspace.",
                inputSchema: { type: "object", properties: { filepath: { type: "string", description: "Path relative to workspace (e.g. 'index.html')" } }, required: ["filepath"] }
            },
            {
                name: "write_file",
                description: "Creates or overwrites a file in the workspace with new content.",
                inputSchema: { type: "object", properties: { filepath: { type: "string" }, content: { type: "string" } }, required: ["filepath", "content"] }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    if (name === "execute_code") {
        return new Promise((resolve) => {
            exec(args.command, { cwd: WORKSPACE_DIR }, (error, stdout, stderr) => {
                let output = stdout ? `[STDOUT]\n${stdout}\n` : "";
                output += stderr ? `[STDERR]\n${stderr}\n` : "";
                output += error ? `[ERROR]\n${error.message}\n` : "";
                resolve({ content: [{ type: "text", text: output || "[SUCCESS] Command executed." }] });
            });
        });
    } 
    
    if (name === "read_file") {
        const targetPath = path.join(WORKSPACE_DIR, args.filepath);
        if (!targetPath.startsWith(WORKSPACE_DIR)) throw new Error("Access denied: Outside workspace");
        try {
            const content = fs.readFileSync(targetPath, "utf-8");
            return { content: [{ type: "text", text: content }] };
        } catch (err) {
            return { content: [{ type: "text", text: `[ERROR] Could not read file: ${err.message}` }] };
        }
    }

    if (name === "write_file") {
        const targetPath = path.join(WORKSPACE_DIR, args.filepath);
        if (!targetPath.startsWith(WORKSPACE_DIR)) throw new Error("Access denied: Outside workspace");
        try {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, args.content, "utf-8");
            return { content: [{ type: "text", text: `[SUCCESS] Wrote to ${args.filepath}` }] };
        } catch (err) {
            return { content: [{ type: "text", text: `[ERROR] Could not write file: ${err.message}` }] };
        }
    }
    
    throw new Error("Tool not found");
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Workspace MCP Server running (ESM)");
}
main().catch(console.error);