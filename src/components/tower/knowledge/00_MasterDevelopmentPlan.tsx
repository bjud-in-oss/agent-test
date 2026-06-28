export const MasterDevelopmentPlan = `
# Master System Documentation - Ouroboros 3.0: Phase 2 (Connection Pooling)

## Architecture & Goals
- Transition from a single-agent system to a robust three-agent triad:
  1. **forlikas** (Orkestratören/Stammen): Main voice and text gateway, meditates the conversation.
  2. **forandra** (Handling): Background developer, executes code, mutates files, strictly muted (MUTE).
  3. **vanda** (Omvärdering): Background evaluator, runs tests, analyzes errors, strictly muted (MUTE).
- Solve the "Session Resumption" amnesia bug by keeping a permanent pool of exactly three connections (WebSockets to Gemini Live API) open and persistent on the backend.
- Route incoming client audio/text dynamically based on the \`?agent=forlikas|forandra|vanda\` query parameter without closing the persistent upstream connection when the frontend disconnects.

## Connection Pooling (Technical Architecture)
1. **Upstream Session Pool:**
   - Map holding 3 live sessions: \`forlikas\`, \`forandra\`, \`vanda\`.
   - Initialized at Express-server boot or dynamically ensured using the provided API Key.
   - Kept alive permanently.
2. **Dynamic Client Routing:**
   - Clients connect via \`/live-ws?agent=<agent_name>&apiKey=<key>\`.
   - The bridge maps the client's socket inputs (microphone PCM stream, text messages) to the active agent session's stream input.
   - Upstream model events (transcriptions, audio chunks, status updates, tool calls) are forwarded back to the connected client socket.
   - When a client disconnects, the upstream Gemini sessions are NOT closed; they go back into idle listening.

## Agent System Instructions (The Triad DNA)
- **forlikas:** Voice and text gateway. Speaks to the user, acts as mediator.
- **forandra:** Muted background worker. Manipulates workspace files and code via MCP. Never produces audio or speech.
- **vanda:** Muted background worker. Analyzes errors, executes tests, and verifies system stability. Never produces audio or speech.
`;
