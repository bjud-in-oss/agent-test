const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

// Sätt upp en "sandlåda" (här tvingar vi den till en specifik mapp för säkerhet)
// Ändra denna till den mapp du vill att AI:n ska ha som rot.
const WORKSPACE_DIR = path.join(process.cwd(), "agent_workspace");

// Skapa mappen om den inte finns
if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

const server = new Server({
    name: "workspace-server",
    version: "1.0.0"
}, {
    capabilities: { tools: {} }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "execute_code",
                description: "Executes terminal commands on the host machine inside the designated workspace folder.",
                inputSchema: {
                    type: "object",
                    properties: {
                        command: {
                            type: "string",
                            description: "The shell command to execute (e.g., 'npm install', 'node script.js')."
                        }
                    },
                    required: ["command"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "execute_code") {
        const command = request.params.arguments.command;
        
        return new Promise((resolve) => {
            // Kör koden inlåst i WORKSPACE_DIR
            exec(command, { cwd: WORKSPACE_DIR }, (error, stdout, stderr) => {
                let output = "";
                if (stdout) output += `[STDOUT]\n${stdout}\n`;
                if (stderr) output += `[STDERR]\n${stderr}\n`;
                if (error) output += `[ERROR]\n${error.message}\n`;
                
                if (!output) output = "[SUCCESS] Command executed with no output.";

                resolve({
                    content: [{ type: "text", text: output }]
                });
            });
        });
    }
    throw new Error("Tool not found");
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Workspace MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});