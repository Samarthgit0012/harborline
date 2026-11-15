// The two ordinary (signed) web requests around the AI line. The conversation itself runs over a WebSocket (relay.ts).
//   POST /ai/quote       the call enters the AI line: reply with TwiML that connects Twilio's voice layer to our WebSocket.
//   POST /ai/quote/done  the AI part ended (we sent "end", or the caller hung up, or the link failed): decide what happens next.
import { Router } from "express";
import type { StateStore } from "../engine/state.js";
import { log } from "../log.js";
import { POST, VoiceResponse, callInfo, redirect, send } from "../svc/helpers.js";
import { GREETING } from "./agent.js";

export const RELAY_PATH = "/ai/relay";

/** https://host -> wss://host/ai/relay. Twilio requires the secure form. */
export function relayUrl(publicBaseUrl: string): string {
  return publicBaseUrl.replace(/^http/i, "ws").replace(/\/+$/, "") + RELAY_PATH;
}

export function aiRouter(d: { state: StateStore; publicBaseUrl: string }): Router {
  const r = Router();

  r.post("/quote", (req, res) => {
    const { callSid } = callInfo(req);
    const t = new VoiceResponse();
    // dtmfDetection lets a caller press 0 for a person. Voice, language and speech-to-text are left at Twilio's defaults on purpose:
    // each provider is billed differently, and the defaults are the ones its documentation promises work.
    t.connect({ action: "/ai/quote/done", method: POST }).conversationRelay({
      url: relayUrl(d.publicBaseUrl),
      welcomeGreeting: GREETING,
      language: "en-US",
      dtmfDetection: true,
      interruptible: "any",
    });
    log("info", "ai_line_entered", { callSid });
    send(res, t);
  });

  r.post("/quote/done", (req, res) => {
    const { callSid } = callInfo(req);
    const outcome = d.state.get(callSid).aiOutcome;
    const t = new VoiceResponse();
    if (outcome?.end === "done") {
      t.say(outcome.say);
      t.hangup();
    } else if (outcome?.end === "transfer") {
      t.say(outcome.say);
      redirect(t, "/svc/handoff?reason=quote_request&back=main");
    } else {
      // No outcome: the AI link never worked or dropped. A person is better than silence. (If the caller hung up, none of this plays.)
      log("warn", "ai_line_no_outcome", { callSid, status: String(req.body?.SessionStatus ?? "") });
      t.say("Sorry, our automated assistant is not available right now. Let me connect you to an agent.");
      redirect(t, "/svc/handoff?reason=quote_request&back=main");
    }
    send(res, t);
  });

  return r;
}
