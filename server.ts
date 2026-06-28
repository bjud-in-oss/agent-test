import express from "express";
import http from "http";
import path from "path";
import fs from "fs/promises";
import { createServer as createViteServer } from "vite";
import { createGeminiLiveMcpBridge } from "./src/services/GeminiMcpBridge.js";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // ==========================================
  // API: PAYLOAD
  // ==========================================
  let activePayload = "";

  app.get("/api/payload", (req, res) => {
    res.json({ payload: activePayload });
  });

  app.post("/api/payload", (req, res) => {
    activePayload = req.body.payload || "";
    res.json({ success: true });
  });

  // ==========================================
  // API: WORKSPACE EXPLORER
  // ==========================================
  app.get("/api/workspace/list", async (req, res) => {
    try {
      const dirPath = (req.query.dir as string) || "";
      const cwd = process.cwd();
      const targetPath = path.join(cwd, dirPath);
      
      // Prevent directory traversal attacks
      if (!targetPath.startsWith(cwd)) return res.status(403).json({ error: "Access denied" });
      
      const items = await fs.readdir(targetPath, { withFileTypes: true });
      const ignored = ['node_modules', '.git', 'dist'];
      const files = items
          .filter((item) => !ignored.includes(item.name) && !item.name.startsWith('.'))
          .map((item) => ({ 
             name: item.name, 
             path: path.join(dirPath, item.name).replace(/\\/g, '/'), 
             isDirectory: item.isDirectory() 
          }));
      res.json({ files });
    } catch (err: any) { 
      res.status(500).json({ error: err.message }); 
    }
  });

  app.get("/api/workspace/download", (req, res) => {
     const filename = req.query.path as string;
     if (!filename) return res.status(400).json({ error: "No path" });
     const filePath = path.join(process.cwd(), filename);
     res.download(filePath);
  });

  app.get("/api/workspace/read", async (req, res) => {
    try {
      const filepath = req.query.path as string;
      if (!filepath) return res.status(400).json({ error: "No path provided" });
      
      const cwd = process.cwd();
      const targetPath = path.join(cwd, filepath);
      
      if (!targetPath.startsWith(cwd)) return res.status(403).json({ error: "Access denied" });
      
      const content = await fs.readFile(targetPath, "utf-8");
      res.json({ content });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================
  // FRONTEND & VITE
  // ==========================================
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  const server = http.createServer(app);

  // ==========================================
  // GEMINI LIVE MCP BRIDGE
  // ==========================================
  
  // Sätt ett standardvärde (det användaren ser första gången)
let activePayload = "Detta är standardinstruktionerna om inget har sparats.";

  // Detta är personligheten. Den ändras aldrig och injiceras vid start.
  const BASE_SYSTEM_INSTRUCTION = `Du är H, en engagerande, pedagogisk och strukturerad interaktiv guide. 
Börja samtalet genom att trevligt hälsa på användaren. 
Vänta sedan på att användaren ber dig läsa in instruktioner eller input. 
När de gör det, anropa ALLTID verktyget 'fetch_live_input' för att läsa in arbetsbeskrivningen, och bekräfta sedan att du har förstått den.`;

  await createGeminiLiveMcpBridge({
    server,
    mcpServerPaths: ["./h-mcp-server.js", "./workspace-mcp-server.js"],
    getSystemInstruction: () => BASE_SYSTEM_INSTRUCTION, // Sätter personligheten
    setSystemInstruction: (newPayload: string) => { activePayload = newPayload; } // Sparar bara payloaden i bakgrunden
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

startServer();