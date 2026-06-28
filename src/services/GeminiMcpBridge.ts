import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Type } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface BridgeOptions {
  server: any;
  mcpServerPaths?: string[];
  getSystemInstruction: () => string;
  setSystemInstruction: (payload: string) => void;
}

export async function createGeminiLiveMcpBridge({ server, mcpServerPaths = [], getSystemInstruction, setSystemInstruction }: BridgeOptions) {
  const wss = new WebSocketServer({ noServer: true });
  const mcpClients: { client: Client; tools: any[] }[] = [];

  // ======================================================================
  // 1. STARTA OCH LÄS IN ALLA MCP-SERVRAR AUTOMATISKT
  // ======================================================================
  for (const scriptPath of mcpServerPaths) {
    try {
      const transport = new StdioClientTransport({ command: "node", args: [scriptPath] });
      const mcpClient = new Client({ name: "gemini-live-bridge", version: "1.0.0" }, { capabilities: {} });
      await mcpClient.connect(transport);
      
      const toolsResponse = await mcpClient.listTools();
      const tools = toolsResponse.tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as any
      }));
      
      mcpClients.push({ client: mcpClient, tools });
      console.log(`✅ MCP Server ansluten: ${scriptPath} (${tools.length} verktyg inlästa)`);
    } catch (err) {
      console.error(`❌ Kunde inte starta MCP Server ${scriptPath}:`, err);
    }
  }

  // Slå ihop alla MCP-verktyg + våra inbyggda UI-verktyg
  const allMcpTools = mcpClients.flatMap(c => c.tools);
  const uiTools = [
    {
      name: "goToStep",
      description: "Ändra det aktuella steget i guiden visuellt i gränssnittet (0 till 4).",
      parameters: { type: Type.OBJECT, properties: { step: { type: Type.INTEGER } }, required: ["step"] }
    }
  ];

  // ======================================================================
  // 2. SÄTT UPP WEBSOCKET-BRYGGAN FÖR FRONTEND
  // ======================================================================
  server.on("upgrade", (request: any, socket: any, head: any) => {
    const { pathname } = new URL(request.url || "", `http://${request.headers.host}`);
    if (pathname === "/live-ws") {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    }
  });

  wss.on("connection", async (clientWs: WebSocket, request: any) => {
    function safeClientSend(payload: any) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    }

    // Fånga BYOK-nyckeln från webbläsaren!
    const { searchParams } = new URL(request.url || "", `http://${request.headers.host}`);
    const activeApiKey = searchParams.get("apiKey");

    if (!activeApiKey) {
      safeClientSend({ type: "error", error: "Ingen BYOK API-nyckel hittades." });
      clientWs.close();
      return;
    }

    const liveAi = new GoogleGenAI({ apiKey: activeApiKey });
    let session: any = null;
    let latestResumptionHandle = ""; // Sparas för återanslutning

    try {
        session = await liveAi.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
            responseModalities: ["AUDIO"] as any,
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
            systemInstruction: getSystemInstruction(),
            tools: [{ functionDeclarations: [...allMcpTools, ...uiTools] }],
            contextWindowCompression: {
               triggerTokens: 108000,
               slidingWindow: { targetTokens: 64000 }
            } as any,
            outputAudioTranscription: {} as any,
            realtimeInputConfig: {
              automaticActivityDetection: { disabled: true }
            } as any
        },
        callbacks: {
          onmessage: async (message: any) => {
            // Skicka ljud och text till Frontend
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) safeClientSend({ type: "text", text: part.text });
              }
            }
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) safeClientSend({ type: "audio", audio });
            if (message.serverContent?.interrupted) safeClientSend({ type: "interrupted" });

            // Spara återanslutningsnyckeln för buggfri resumption (håller i 2h!)
            if (message.sessionResumptionUpdate?.newHandle) {
              latestResumptionHandle = message.sessionResumptionUpdate.newHandle;
              console.log("🔄 Mottog ny resumption handle för sessionen.");
            }

            // ======================================================================
            // 3. DYNAMISK VERKTYGSHANTERING (MCP ELLER UI)
            // ======================================================================
            if (message.toolCall?.functionCalls) {
              for (const call of message.toolCall.functionCalls) {
                
                // Är detta ett UI-verktyg (som webbläsaren ska utföra)?
                if (uiTools.find(t => t.name === call.name)) {
                  safeClientSend({ type: "toolCall", name: call.name, args: call.args, id: call.id });
                } 
                // Om inte, skicka det automatiskt till våra lokala MCP-servrar!
                else {
                  safeClientSend({ type: "status", status: "processing", message: `Kör verktyg: ${call.name}` });
                  try {
                    // Hitta vilken MCP-klient som äger verktyget
                    const clientData = mcpClients.find(c => c.tools.some(t => t.name === call.name));
                    if (clientData) {
                      const result = await clientData.client.callTool({ name: call.name, arguments: call.args });
                      // Skicka svaret direkt tillbaka till Gemini Live
                      session.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response: result }] });
                    }
                  } catch (err: any) {
                    session.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response: { error: err.message } }] });
                  }
                }
              }
            }
          },
          onclose: () => clientWs.close(),
          onerror: (err: any) => safeClientSend({ type: "error", error: err.message })
        }
      });

      // Hantera inkommande ström från Frontend
      clientWs.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          
          // --- DESSA TVÅ SAKNADES (Push-to-talk) ---
          if (msg.event === "activityStart" && session) {
              await session.sendRealtimeInput({ activityStart: {} });
          } 
          else if (msg.event === "activityEnd" && session) {
              await session.sendRealtimeInput({ activityEnd: {} });
              safeClientSend({ type: "status", status: "processing" });
          } 
          // -----------------------------------------
          
          else if (msg.audio && session) {
              await session.sendRealtimeInput({ audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" } });
          } 
          else if (msg.text && session) {
              await session.sendRealtimeInput({ text: msg.text });
          } 
          else if (msg.type === "toolResponse" && session) {
              await session.sendToolResponse({ functionResponses: [{ response: msg.response, id: msg.id }] });
          } 
          else if (msg.type === "set_payload") {
              setSystemInstruction(msg.payload);
          }
          
        } catch (e: any) { 
          console.error("Error processing input:", e); 
        }
      });

      clientWs.on("close", () => {
        if (session) session.close();
      });

    } catch (err: any) {
      safeClientSend({ type: "error", error: `Kunde inte starta Gemini Live-session: ${err.message}` });
    }
  });
}