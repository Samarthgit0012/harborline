import type { Request, Router } from "express";
import { isOpen } from "../services/businessHours.js";
import { whisperText, type HandoffContext } from "../services/queue.js";
import { speakDigits } from "../services/speak.js";
import type { Ticket } from "../services/policyRepo.js";
import { log, maskPhone } from "../log.js";
import { POST, VoiceResponse, ask, callInfo, redirect, send, svcUrl, type SvcDeps } from "./helpers.js";

/** Seconds each pass of the hold loop waits for a key. Each pass also announces the caller's place. */
const HOLD_SECONDS = 20;
const MAX_RETRIES = 2;
const SID = /^CA[0-9a-f]{32}$/i;
const US_MOBILE_OR_LANDLINE = /^\+1[2-9]\d{9}$/;

const h = (path: string, q: Record<string, string> = {}) => svcUrl(`handoff/${path}`, q);

/**
 * Human handoff: a waiting line for the agent, a private whisper to the agent, and two ways out of
 * waiting (call back, voicemail). Every path ends with the caller connected, called back, or recorded.
 */
export function mountHandoff(r: Router, d: SvcDeps) {
  const open = () => isOpen(d.clock(), d.schedule);
  const back = (req: Request) => callInfo(req).back;
  /** Like callInfo, but on an OUTBOUND call "from" is the person we rang (our own number is the call's From). */
  const who = (req: Request) => {
    const info = callInfo(req);
    return { ...info, from: d.state.get(info.callSid).contactPhone ?? info.from };
  };

  /** The caller wants a person. Decide: no agent line, after hours, or into the line. */
  r.post("/handoff", (req, res) => {
    const { callSid } = callInfo(req);
    const t = new VoiceResponse();

    if (!d.agentNumber) {
      t.say("Sorry, no agents are available right now. Please call back during business hours. Goodbye.");
      t.hangup();
    } else if (!open()) {
      t.say("Our agents are not available right now.");
      redirect(t, svcUrl("voicemail", { back: back(req) }));
    } else {
      const s = d.state.get(callSid);
      const injury = req.query.reason === "claim_injury";
      const reason = injury ? "claim_injury" : req.query.reason === "campaign_response" ? "campaign_response" : "general";
      const policy = s.authedPolicy ?? s.fnol?.policyNumber;
      const ctx: HandoffContext = {
        reason,
        urgent: injury,
        verified: !!s.authedPolicy,
        policyLast4: policy?.slice(-4),
        claimNumber: s.claimNumber,
        queuedAt: d.clock().getTime(),
      };
      // Joining twice (a replayed request) keeps the first place and the first context.
      if (!d.queue.has(callSid)) {
        d.state.update(callSid, { handoff: ctx, handoffState: "waiting" });
        d.queue.join(callSid, ctx);
        log("info", "queue_joined", { callSid, urgent: ctx.urgent, verified: ctx.verified, position: d.queue.position(callSid), size: d.queue.size() });
      }
      redirect(t, h("hold"));
    }
    send(res, t);
  });

  /** One pass of the hold loop: connect if it is our turn, otherwise say where we are and wait. */
  r.post("/handoff/hold", (req, res) => {
    const { callSid } = callInfo(req);
    const t = new VoiceResponse();
    const { handoff: ctx, handoffState } = d.state.get(callSid);

    if (!ctx || handoffState !== "waiting") {
      // Nobody put this call in the line, or it already left (connected, called back, timed out): a replayed or forged request.
      redirect(t, "/ivr/main");
      return send(res, t);
    }
    // We were polled, so this caller is alive. If we had swept them as gone, put them back in their old place.
    if (!d.queue.touch(callSid)) d.queue.rejoin(callSid, ctx);

    if (!open()) {
      d.queue.leave(callSid, "voicemail");
      d.state.update(callSid, { handoffState: "left" });
      t.say("Our office has just closed.");
      redirect(t, svcUrl("voicemail", { back: "main" }));
    } else if (d.queue.waitedMs(callSid) > d.queue.maxWaitMs) {
      d.queue.leave(callSid, "timeout");
      d.state.update(callSid, { handoffState: "left" });
      log("info", "queue_timeout", { callSid });
      t.say("Our wait is longer than expected.");
      redirect(t, h("fallback"));
    } else if (d.queue.tryConnect(callSid)) {
      d.state.update(callSid, { handoffState: "connected" });
      log("info", "queue_connect", { callSid, ...d.queue.stats.summary() });
      t.say("Please hold while I connect you.");
      // answerOnBridge: the caller keeps hearing ringing, not silence, while the agent's phone rings and the whisper plays.
      const dial = t.dial({ timeout: 25, action: h("dialdone"), method: POST, answerOnBridge: true });
      dial.number({ url: h("whisper", { c: callSid }), method: POST }, d.agentNumber!);
    } else {
      const pos = d.queue.position(callSid);
      t.say(pos <= 1 ? "You are next in line." : `You are number ${pos} in line.`);
      const g = t.gather({ numDigits: 1, timeout: HOLD_SECONDS, action: h("hold/in"), method: POST });
      g.say("To get a call back instead of waiting, press 1. Otherwise, please stay on the line.");
      if (d.holdMusicUrl) g.play(d.holdMusicUrl);
      else g.pause({ length: 8 });
      redirect(t, h("hold"));
    }
    send(res, t);
  });

  r.post("/handoff/hold/in", (req, res) => {
    const { callSid, digits } = callInfo(req);
    const t = new VoiceResponse();
    if (digits === "1" && d.queue.has(callSid)) {
      d.queue.leave(callSid, "callback");
      d.state.update(callSid, { handoffState: "left" });
      redirect(t, h("callback"));
    } else {
      redirect(t, h("hold"));
    }
    send(res, t);
  });

  /** Plays to the AGENT only, after they answer and before the caller is bridged. Twilio allows Say, Play, Gather and Hangup here. */
  r.post("/handoff/whisper", (req, res) => {
    const c = typeof req.query.c === "string" && SID.test(req.query.c) ? req.query.c : undefined;
    const t = new VoiceResponse();
    t.say(whisperText(c ? d.state.get(c).handoff : undefined));
    send(res, t);
  });

  /** The agent line finished ringing or talking. */
  r.post("/handoff/dialdone", (req, res) => {
    const { callSid } = callInfo(req);
    const status = String(req.body?.DialCallStatus ?? "");
    const t = new VoiceResponse();
    d.queue.releaseAgent(callSid);

    if (status === "completed") {
      const secs = Number(req.body?.DialCallDuration);
      if (Number.isFinite(secs) && secs >= 0) d.queue.stats.recordHandled(secs);
      log("info", "agent_call_done", { callSid, ...d.queue.stats.summary() });
      t.say("Thank you for calling Harborline Insurance. Goodbye.");
      t.hangup();
    } else {
      d.queue.stats.noAnswer++;
      log("warn", "agent_no_answer", { callSid, status });
      t.say("Sorry, no agent could take your call.");
      redirect(t, h("fallback"));
    }
    send(res, t);
  });

  /** Waiting did not work out. Offer the two ways of not waiting. */
  r.post("/handoff/fallback", (req, res) => {
    const t = new VoiceResponse();
    if (!open()) {
      redirect(t, svcUrl("voicemail", { back: "main" }));
    } else {
      ask(t, {
        action: h("fallback/in"),
        numDigits: 1,
        prompt: "To request a call back, press 1. To leave a voicemail, press 2.",
      });
    }
    send(res, t);
  });

  r.post("/handoff/fallback/in", (req, res) => {
    const { callSid, digits } = callInfo(req);
    const t = new VoiceResponse();
    if (digits === "1") redirect(t, h("callback"));
    else if (digits === "2") redirect(t, svcUrl("voicemail", { back: "main" }));
    else if (d.state.bump(callSid, "handoff:fallback") > MAX_RETRIES) redirect(t, svcUrl("voicemail", { back: "main" })); // voicemail always works
    else {
      t.say("Sorry, that is not a valid choice.");
      redirect(t, h("fallback"));
    }
    send(res, t);
  });

  // ---- call back instead of waiting -------------------------------------------------------------

  /** Make the ticket once per call. Returns undefined if this number has asked too often. */
  function makeTicket(callSid: string, kind: Ticket["kind"], phone: string, limitKey: string): Ticket | "limited" | { ticketNumber: string; existing: true } {
    const s = d.state.get(callSid);
    if (s.ticketNumber) return { ticketNumber: s.ticketNumber, existing: true };
    if (d.ticketLimiter.isLocked(limitKey) || d.ticketLimiter.isLocked(`cbnum:${phone}`)) return "limited";
    d.ticketLimiter.recordFailure(limitKey); // each request counts as one use of the allowance
    d.ticketLimiter.recordFailure(`cbnum:${phone}`);
    const ticket = d.repo.createTicket(
      {
        kind,
        phone,
        reason: s.handoff?.reason ?? "general",
        policyNumber: s.authedPolicy ?? null, // only a verified policy is recorded
        policyVerified: !!s.authedPolicy,
        claimNumber: s.claimNumber ?? null,
        urgent: s.handoff?.urgent ?? false,
      },
      d.clock(),
    );
    d.state.update(callSid, { ticketNumber: ticket.ticketNumber });
    log("info", "ticket_created", { callSid, ticketNumber: ticket.ticketNumber, kind, urgent: ticket.urgent, phone: maskPhone(phone) });
    return ticket;
  }

  function finishCallback(t: InstanceType<typeof VoiceResponse>, callSid: string, phone: string, limitKey: string) {
    const made = makeTicket(callSid, "callback", phone, limitKey);
    if (made === "limited") {
      t.say("We already have several call back requests from this number. An agent will contact you. Goodbye.");
    } else {
      t.say(
        `Thank you. Your reference number is ${speakDigits(made.ticketNumber)}. ` +
          `An agent will call you back at the number ending in ${speakDigits(phone.slice(-4), 4)} during business hours. Goodbye.`,
      );
    }
    t.hangup();
  }

  r.post("/handoff/callback", (req, res) => {
    const { from } = who(req);
    const t = new VoiceResponse();
    if (US_MOBILE_OR_LANDLINE.test(from)) {
      ask(t, {
        action: h("callback/in"),
        numDigits: 1,
        prompt:
          `We can call you back at the number you are calling from, ending in ${speakDigits(from.slice(-4), 4)}. ` +
          "To use it, press 1. To enter a different number, press 2.",
      });
    } else {
      redirect(t, h("callback/number")); // withheld or non-US caller ID: we need a number from them
    }
    send(res, t);
  });

  r.post("/handoff/callback/in", (req, res) => {
    const { callSid, from, digits } = who(req);
    const t = new VoiceResponse();
    const usable = US_MOBILE_OR_LANDLINE.test(from);
    if (digits === "1" && usable) finishCallback(t, callSid, from, `cb:${from}`);
    else if (digits === "2" || !usable) redirect(t, h("callback/number"));
    else if (d.state.bump(callSid, "handoff:callback") > MAX_RETRIES) finishCallback(t, callSid, from, `cb:${from}`); // the number we have beats no callback
    else {
      t.say("Sorry, that is not a valid choice.");
      redirect(t, h("callback"));
    }
    send(res, t);
  });

  r.post("/handoff/callback/number", (req, res) => {
    const t = new VoiceResponse();
    ask(t, {
      action: h("callback/number/in"),
      numDigits: 10,
      timeout: 10,
      prompt: "Please enter the ten digit phone number to call you back on, area code first.",
    });
    send(res, t);
  });

  r.post("/handoff/callback/number/in", (req, res) => {
    const { callSid, from, digits } = who(req);
    const t = new VoiceResponse();
    if (digits && /^[2-9]\d{9}$/.test(digits)) {
      finishCallback(t, callSid, `+1${digits}`, `cb:${from || callSid}`);
    } else if (d.state.bump(callSid, "handoff:number") > MAX_RETRIES) {
      redirect(t, svcUrl("voicemail", { back: "main" })); // cannot get a number: take a message instead
    } else {
      t.say("Sorry, that is not a valid phone number.");
      redirect(t, h("callback/number"));
    }
    send(res, t);
  });

  // ---- voicemail --------------------------------------------------------------------------------

  /** The ticket exists BEFORE the recording starts, so a hang-up mid-message still leaves a callback request. */
  r.post("/voicemail", (req, res) => {
    const { callSid, from } = who(req);
    const t = new VoiceResponse();
    const made = makeTicket(callSid, "voicemail", from || "unknown", `cb:${from || callSid}`);
    if (made === "limited") {
      t.say("We already have several requests from this number. An agent will contact you. Goodbye.");
      t.hangup();
    } else {
      t.say(
        `Please leave your name, your phone number and a short message after the beep. Your reference number is ${speakDigits(made.ticketNumber)}. ` +
          "Please do not say any card numbers. Press pound when you are finished.",
      );
      t.record({ action: svcUrl("voicemail/done"), method: POST, maxLength: 120, finishOnKey: "#", playBeep: true });
      redirect(t, svcUrl("voicemail/done")); // reached only if nothing was recorded
    }
    send(res, t);
  });

  r.post("/voicemail/done", (req, res) => {
    const { callSid } = callInfo(req);
    const s = d.state.get(callSid);
    const sid = String(req.body?.RecordingSid ?? "");
    const t = new VoiceResponse();
    if (s.ticketNumber && /^RE\w{10,40}$/.test(sid)) {
      d.repo.attachTicketRecording(s.ticketNumber, sid);
      log("info", "voicemail_attached", { callSid, ticketNumber: s.ticketNumber });
    }
    t.say("Thank you. Your message has been saved and an agent will call you back during business hours. Goodbye.");
    t.hangup();
    send(res, t);
  });
}
