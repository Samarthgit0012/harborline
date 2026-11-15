// The WebSocket that Twilio's voice layer (ConversationRelay) opens to us. Twilio turns the caller's speech into text and
// reads our replies aloud; we only ever see and send text. One connection = one call.
//
// Twilio -> us:  setup, prompt (what the caller said), dtmf, interrupt, error
// us -> Twilio:  text (say this), end (we are finished; the call continues at the <Connect> action URL)
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import twilio from "twilio";
import { WebSocketServer, type WebSocket } from "ws";
import type { StateStore } from "../engine/state.js";
import { log, maskPhone } from "../log.js";
import type { PolicyRepo } from "../services/policyRepo.js";
import { QuoteAgent, type AgentReply } from "./agent.js";
import { RELAY_PATH, relayUrl } from "./routes.js";
import type { LlmClient } from "./types.js";

export interface RelayDeps {
  authToken: string;
  publicBaseUrl: string;
  state: StateStore;
  repo: PolicyRepo;
  llm: LlmClient;
  clock: () => Date;
  /** Calls the AI line will carry at once. Each one holds a model conversation open, so this is a cost and load cap. */
  maxSessions?: number;
  /** Silence before "are you still there?" (ms). Twilio sends nothing at all when a caller says nothing, so WE must watch. */
  idleMs?: number;
  /** Longest an AI conversation may run (ms). */
  maxCallMs?: number;
  modelTimeoutMs?: number;
}

const SID = /^CA[0-9a-f]{32}$/i;

/**
 * Twilio signs the handshake of the WebSocket like any webhook. The documentation does not say whether the signed address is
 * the wss:// form or the https:// form, so both are accepted, and the one that matched is logged: after the first real call we
 * will know, and can drop the other.
 */
export function relaySignatureScheme(authToken: string, signature: string | undefined, publicBaseUrl: string): "wss" | "https" | undefined {
  if (!signature) return undefined;
  const wss = relayUrl(publicBaseUrl);
  const https = wss.replace(/^ws/i, "http");
  if (twilio.validateRequest(authToken, signature, wss, {})) return "wss";
  if (twilio.validateRequest(authToken, signature, https, {})) return "https";
  return undefined;
}

export function attachRelay(server: Server, d: RelayDeps): { sessions: () => number; close: () => void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const live = new Set<WebSocket>();
  const maxSessions = d.maxSessions ?? 20;

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://placeholder").pathname;
    if (path !== RELAY_PATH) return; // not ours: leave it for whoever else listens (or let the connection time out)
    const header = req.headers["x-twilio-signature"];
    const scheme = relaySignatureScheme(d.authToken, typeof header === "string" ? header : undefined, d.publicBaseUrl);
    if (!scheme) {
      log("warn", "ai_relay_rejected", { reason: "bad_or_missing_signature" });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (live.size >= maxSessions) {
      log("warn", "ai_relay_rejected", { reason: "too_many_sessions", live: live.size });
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      log("info", "ai_relay_connected", { signedAs: scheme });
      live.add(ws);
      ws.on("close", () => live.delete(ws));
      session(ws, d);
    });
  };
  server.on("upgrade", onUpgrade);

  return {
    sessions: () => live.size,
    close: () => {
      server.off("upgrade", onUpgrade);
      for (const ws of live) ws.terminate();
      wss.close();
    },
  };
}

function session(ws: WebSocket, d: RelayDeps): void {
  let agent: QuoteAgent | undefined;
  let callSid = "";
  let finished = false;
  let malformed = 0;
  let idleStage = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let work: Promise<void> = Promise.resolve(); // caller turns are handled one at a time, in order

  const send = (o: Record<string, unknown>) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
  };
  const speak = (token: string) => send({ type: "text", token, last: true });

  const maxTimer = setTimeout(() => {
    if (!finished) finish({ say: "We have been talking for a while. Let me connect you to an agent.", end: "transfer", why: "call_too_long" });
  }, d.maxCallMs ?? 10 * 60 * 1000);

  const arm = () => {
    clearTimeout(idleTimer);
    if (finished) return;
    idleTimer = setTimeout(onIdle, idleStage === 0 ? (d.idleMs ?? 20_000) : Math.max(1000, (d.idleMs ?? 20_000) / 2));
  };
  const onIdle = () => {
    if (finished) return;
    if (idleStage === 0) {
      idleStage = 1;
      speak("Are you still there?");
      arm();
    } else {
      finish({ say: "I did not hear anything, so I will end the call. Please call back any time. Goodbye.", end: "done", why: "silence" });
    }
  };

  /** Our side is done: record what happens next, tell Twilio to end the AI session, and let the action URL carry on. */
  function finish(reply: AgentReply) {
    if (finished || !callSid) return;
    finished = true;
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    d.state.update(callSid, {
      aiOutcome: { end: reply.end ?? "done", say: reply.say, urgent: !!reply.urgent, why: reply.why },
      quoteNote: reply.end === "transfer" && agent?.intake.any() ? agent.intake.spokenSummary() : undefined,
    });
    log("info", "ai_session_end", { callSid, end: reply.end, why: reply.why, urgent: !!reply.urgent });
    send({ type: "end", handoffData: JSON.stringify({ end: reply.end, why: reply.why }) });
    setTimeout(() => ws.close(), 5000).unref(); // Twilio normally closes first
  }

  async function handle(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "setup": {
        if (agent) return; // a second setup is ignored: it would reset the conversation
        const sid = String(msg.callSid ?? "");
        if (!SID.test(sid)) {
          log("warn", "ai_relay_bad_setup");
          ws.close(1008, "bad call id");
          return;
        }
        callSid = sid;
        const phone = String(msg.from ?? "");
        agent = new QuoteAgent({
          llm: d.llm,
          callSid,
          phone: phone || "unknown",
          now: d.clock,
          timeoutMs: d.modelTimeoutMs,
          saveLead: (lead) => {
            const saved = d.repo.createLead(lead, d.clock());
            log("info", "lead_saved", { callSid, leadNumber: saved.leadNumber, status: saved.status, phone: maskPhone(phone) });
            return { leadNumber: saved.leadNumber };
          },
        });
        log("info", "ai_relay_setup", { callSid });
        arm();
        return;
      }
      case "prompt": {
        if (!agent || finished || msg.last === false) return; // partial transcripts are ignored; only the finished sentence counts
        idleStage = 0;
        clearTimeout(idleTimer);
        const reply = await agent.onCallerText(String(msg.voicePrompt ?? ""));
        if (reply.end) finish(reply);
        else if (!finished) {
          speak(reply.say);
          arm();
        }
        return;
      }
      case "dtmf": {
        const reply = agent?.onDtmf(String(msg.digit ?? ""));
        if (reply && !finished) finish(reply);
        return;
      }
      case "interrupt":
        return; // the caller talked over us; Twilio already stopped the speech, and their words arrive as the next prompt
      case "error":
        log("warn", "ai_relay_twilio_error", { callSid, description: String(msg.description ?? "").slice(0, 200) });
        return;
      default:
        return;
    }
  }

  ws.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data.toString());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      msg = parsed;
    } catch {
      if (++malformed >= 10) ws.close(1007, "too many malformed messages");
      return;
    }
    work = work.then(() => handle(msg)).catch((err) => {
      log("error", "ai_relay_handler_error", { callSid, error: err instanceof Error ? err.message : "unknown" });
      if (!finished && callSid) finish({ say: "Sorry, I am having trouble right now. Let me connect you to an agent.", end: "transfer", why: "ai_error" });
    });
  });

  ws.on("close", () => {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    if (!finished) log("info", "ai_session_dropped", { callSid }); // the caller hung up mid-conversation: nothing is saved, by design
  });
  ws.on("error", (err) => log("warn", "ai_relay_socket_error", { callSid, error: err.message }));
}
