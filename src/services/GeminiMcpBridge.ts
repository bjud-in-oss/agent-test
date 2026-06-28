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
    },
    {
      name: "open_webpage",
      description: "Opens a specific URL (like NotebookLM) in the user's browser.",
      parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING } }, required: ["url"] }
    }
  ];

  // ======================================================================
  // 2. POOL KONSTRUKTION OCH HANTERING (OUROBOROS TRIAD)
  // ======================================================================
  interface SessionEntry {
    session: any;
    activeClientWs: WebSocket | null;
    resumptionHandle?: string;
  }

  const sessionPool = new Map<string, SessionEntry>();
  let poolInitialized = false;

  async function startAgentSession(agentKey: string, apiKey: string): Promise<any> {
    console.log(`⚡ [Ouroboros Bridge] Initializing persistent upstream connection for agent: ${agentKey}`);
    
    let instruction = "";
    let modalities: any[] = ["AUDIO"];

    if (agentKey === "forlikas") {
      instruction = `Du är Förlikas (Orkestratören/Stammen), röst-gatewayen och medlaren i triaden Ouroboros 3.0. 
Din roll är att vara den primära kontakten med användaren. Du pratar i både text och röst, välkomnar användaren och samordnar arbetet. 
Du samarbetar med dina stumma triad-kollegor Förändra (handling) och Vända (omvärdering). 
Börja samtalet genom att trevligt hälsa på användaren.
Vänta sedan på att användaren ber dig läsa in instruktioner eller input. 
När de gör det, anropa ALLTID verktyget 'fetch_live_input' för att läsa in arbetsbeskrivningen, och bekräfta sedan att du har förstått den. 
Du kan vid behov anropa dina MCP-verktyg.`;
      modalities = ["AUDIO"];
    } else if (agentKey === "forandra") {
      instruction = `Du är Förändra (Handling), en stum triad-medlem (MUTE) i Ouroboros 3.0. 
Din uppgift är att skriva kod, modifiera filer och exekvera kommandon i utvecklingsmiljön. 
Du får ALDRIG producera röst eller tal (AUDIO) – din röstmodul är permanent avaktiverad. 
Du kommunicerar uteslutande via text och genom att anropa lokala MCP-verktyg för att läsa/skriva filer eller köra kommandon. 
All din feedback till användaren eller Förlikas ska ske i ren, saklig text.`;
      modalities = ["TEXT"];
    } else if (agentKey === "vanda") {
      instruction = `Du är Vända (Omvärdering), en stum triad-medlem (MUTE) i Ouroboros 3.0. 
Din uppgift är att analysera fel, köra tester, verifiera kodkvalitet och utvärdera systemstabilitet. 
Du får ALDRIG producera röst eller tal (AUDIO) – din röstmodul är permanent avaktiverad. 
Du kommunicerar uteslutande via text och genom att köra terminalkommandon eller tester via MCP-verktyg.`;
      modalities = ["TEXT"];
    }

    const liveAi = new GoogleGenAI({ apiKey });

    const session = await liveAi.live.connect({
      model: "gemini-3.1-flash-live-preview",
      config: {
          responseModalities: modalities as any,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
          systemInstruction: instruction,
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
          const entry = sessionPool.get(agentKey);
          
          const safeClientSend = (payload: any) => {
            if (entry && entry.activeClientWs && entry.activeClientWs.readyState === WebSocket.OPEN) {
              try {
                entry.activeClientWs.send(JSON.stringify(payload));
              } catch (e) {
                console.error(`[Ouroboros Bridge] Error sending payload to client for ${agentKey}:`, e);
              }
            }
          };

          // 1. Text och Transkriptioner
          const agentText = message.serverContent?.outputTranscription?.text;
          if (agentText) {
            safeClientSend({ type: "transcription", text: agentText, role: "agent" });
          }
          const userText = message.serverContent?.inputTranscription?.text;
          if (userText) {
            safeClientSend({ type: "transcription", text: userText, role: "user" });
          }

          if (message.serverContent?.modelTurn?.parts) {
            for (const part of message.serverContent.modelTurn.parts) {
              if (part.text) safeClientSend({ type: "text", text: part.text });
            }
          }

          // 2. Audio-ström
          const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audio) {
            safeClientSend({ type: "audio", audio });
          }

          if (message.serverContent?.interrupted) {
            safeClientSend({ type: "interrupted" });
          }

          // Resumption handle
          if (message.sessionResumptionUpdate?.newHandle) {
            if (entry) {
              entry.resumptionHandle = message.sessionResumptionUpdate.newHandle;
            }
          }

          // 3. Verktygsanrop (MCP)
          if (message.toolCall?.functionCalls) {
            for (const call of message.toolCall.functionCalls) {
              if (uiTools.find(t => t.name === call.name)) {
                safeClientSend({ type: "toolCall", name: call.name, args: call.args, id: call.id });
              } else {
                safeClientSend({ type: "status", status: "processing", message: `Executing tool: ${call.name}` });
                safeClientSend({ type: "log", message: `Agent [${agentKey}] is invoking tool: ${call.name} with arguments: ${JSON.stringify(call.args)}` });
                try {
                  const clientData = mcpClients.find(c => c.tools.some(t => t.name === call.name));
                  if (clientData) {
                    const result = await clientData.client.callTool({ name: call.name, arguments: call.args });
                    safeClientSend({ type: "log", message: `Tool [${call.name}] returned successfully.` });
                    
                    const activeSession = entry?.session;
                    if (activeSession) {
                      await activeSession.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response: result }] });
                    }
                  } else {
                    safeClientSend({ type: "log", message: `[ERROR] Tool ${call.name} not found among loaded MCP servers.` });
                    const activeSession = entry?.session;
                    if (activeSession) {
                      await activeSession.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response: { error: "Tool not found" } }] });
                    }
                  }
                } catch (err: any) {
                  safeClientSend({ type: "log", message: `[ERROR] Failed to execute tool [${call.name}]: ${err.message}` });
                  const activeSession = entry?.session;
                  if (activeSession) {
                    await activeSession.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response: { error: err.message } }] });
                  }
                }
              }
            }
          }
        },
        onclose: () => {
          console.warn(`⚠️ [Ouroboros Bridge] Upstream Gemini Live connection closed for agent: ${agentKey}. Attempting re-establishment in 3 seconds...`);
          setTimeout(() => {
            if (sessionPool.has(agentKey)) {
              startAgentSession(agentKey, apiKey).then(newSession => {
                const entry = sessionPool.get(agentKey);
                if (entry) {
                  entry.session = newSession;
                  console.log(`✅ [Ouroboros Bridge] Persistent connection re-established for agent: ${agentKey}`);
                }
              }).catch(err => {
                console.error(`❌ [Ouroboros Bridge] Failed to re-establish connection for agent: ${agentKey}:`, err);
              });
            }
          }, 3000);
        },
        onerror: (err: any) => {
          console.error(`❌ [Ouroboros Bridge] Error in upstream Gemini Live connection for agent ${agentKey}:`, err);
        }
      }
    });

    return session;
  }

  async function ensurePoolInitialized(apiKey: string) {
    if (poolInitialized) return;
    poolInitialized = true;
    console.log("⚡ [Ouroboros Bridge] Creating persistent session pool for the Triad...");
    try {
      for (const key of ["forlikas", "forandra", "vanda"]) {
        const sess = await startAgentSession(key, apiKey);
        sessionPool.set(key, {
          session: sess,
          activeClientWs: null
        });
      }
      console.log("🎯 [Ouroboros Bridge] Triad persistent pool initialized successfully!");
    } catch (err) {
      console.error("❌ [Ouroboros Bridge] Failed to initialize persistent pool:", err);
      poolInitialized = false;
    }
  }

  // Pre-initialize with process.env key if available
  if (process.env.GEMINI_API_KEY) {
    ensurePoolInitialized(process.env.GEMINI_API_KEY).catch(console.error);
  }

  // ======================================================================
  // 3. SE VÄRDEN FRÅN UPGRADE OCH SKICKA TILL DET AKTIVA WEBSOCKET-KOPPLINGEN
  // ======================================================================
  server.on("upgrade", (request: any, socket: any, head: any) => {
    const { pathname } = new URL(request.url || "", `http://${request.headers.host}`);
    if (pathname === "/live-ws") {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    }
  });

  wss.on("connection", async (clientWs: WebSocket, request: any) => {
    const { searchParams } = new URL(request.url || "", `http://${request.headers.host}`);
    const clientApiKey = searchParams.get("apiKey");
    const activeApiKey = clientApiKey || process.env.GEMINI_API_KEY;

    function safeClientSend(payload: any) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    }

    if (!activeApiKey) {
      safeClientSend({ type: "error", error: "Ingen API-nyckel hittades eller tillhandahölls." });
      clientWs.close();
      return;
    }

    // Se till att poolen startas
    await ensurePoolInitialized(activeApiKey);

    const agentName = searchParams.get("agent") || "forlikas";
    if (!["forlikas", "forandra", "vanda"].includes(agentName)) {
      safeClientSend({ type: "error", error: `Okänd agent: ${agentName}` });
      clientWs.close();
      return;
    }

    const entry = sessionPool.get(agentName);
    if (!entry || !entry.session) {
      safeClientSend({ type: "error", error: `Session för ${agentName} har inte initierats ännu. Försök igen.` });
      clientWs.close();
      return;
    }

    // Koppla ihop klientens WS med den stående sessionen i poolen
    if (entry.activeClientWs && entry.activeClientWs !== clientWs) {
      console.log(`[Ouroboros Bridge] Switching active client for agent: ${agentName}`);
      try {
        entry.activeClientWs.close();
      } catch (e) {}
    }
    entry.activeClientWs = clientWs;

    console.log(`🔌 [Ouroboros Bridge] Client connected to persistent agent session: ${agentName}`);
    safeClientSend({ type: "log", message: `Ansluten till persistent session för agent: ${agentName}` });

    clientWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const sess = entry.session;
        if (!sess) return;

        if (msg.event === "activityStart") {
          await sess.sendRealtimeInput({ activityStart: {} });
        } 
        else if (msg.event === "activityEnd") {
          await sess.sendRealtimeInput({ activityEnd: {} });
          safeClientSend({ type: "status", status: "processing" });
        } 
        else if (msg.audio) {
          await sess.sendRealtimeInput({ audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" } });
        } 
        else if (msg.text) {
          await sess.sendRealtimeInput({ text: msg.text });
        } 
        else if (msg.type === "toolResponse") {
          await sess.sendToolResponse({ functionResponses: [{ response: msg.response, id: msg.id }] });
        } 
        else if (msg.type === "set_payload") {
          setSystemInstruction(msg.payload);
          safeClientSend({ type: "log", message: "Systeminstruktion uppdaterad." });
        }
      } catch (e: any) {
        console.error(`[Ouroboros Bridge] Error processing message from client for ${agentName}:`, e);
      }
    });

    clientWs.on("close", () => {
      console.log(`🔌 [Ouroboros Bridge] Client disconnected from agent: ${agentName}. Upstream session remains open and listening.`);
      if (entry.activeClientWs === clientWs) {
        entry.activeClientWs = null;
      }
    });
  });
}
