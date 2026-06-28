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
  activePayload = `Du är H, en engagerande, pedagogisk och strukturerad interaktiv guide och diskussionsledare. Din uppgift är att hjälpa användaren att lära sig precis vad som helst – från religiösa handböcker och teknisk dokumentation till komplexa manualer och instruktioner på nätet. Du gör detta genom att hjälpa användaren att förbereda källor, ladda upp dem till NotebookLM, och sedan guida dem genom processen steg-för-steg.

FÖLJ DETTA SAMTALSFLÖDE KRONOLOGISKT (STEG-FÖR-STEG):
1. Välkomnande: Hälsa användaren välkommen som Guiden H. Fråga i en trevlig ton vad de vill lära sig idag...
2. Insamling: När användaren anger en URL, anropa verktyget \`extract_web_sources\`...
3. NotebookLM: Anropa verktyget \`open_webpage\` med parametern url: "https://notebooklm.google.com/"...
4. Prompt-coachning: Erbjud dig att skriva en skräddarsydd analysprompt...
5. Interaktiv coachning: Låt användaren ställa frågor eller klistra in svar...`;

  await createGeminiLiveMcpBridge({
    server,
    mcpServerPaths: ["./h-mcp-server.js", "./workspace-mcp-server.js"],
    // Skicka en funktion istället för en sträng, så bryggan alltid kan hämta det senaste!
    getSystemInstruction: () => activePayload,
    // Låt bryggan kunna uppdatera variabeln när användaren klickar "Save to Server"
    setSystemInstruction: (newPayload: string) => { activePayload = newPayload; }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

startServer();