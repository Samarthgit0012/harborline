import { Router, type Request } from "express";
import twilio from "twilio";
import type { StateStore } from "../engine/state.js";
import { log, maskPhone } from "../log.js";
import { speakDigits } from "../services/speak.js";
import type { Attempt, OutboundStore } from "./store.js";

const { VoiceResponse } = twilio.twiml;

export interface OutboundDeps {
  store: OutboundStore;
  state: StateStore;
  clock: () => Date;
  mode: "off" | "dry-run" | "live";
  /** E.164 number recipients can call to ask us to stop. */
  callback?: string;
}

type Twiml = InstanceType<typeof VoiceResponse>;

/** +15555550177 -> "5 5 5, 5 5 5, 0 1 7 7": area code, exchange, line number, so it can be written down. */
export function spokenPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6)].map((g) => speakDigits(g, 4)).join(", ");
}
const send = (res: import("express").Response, t: Twiml) => res.type("text/xml").send(t.toString());
const goodbye = (text?: string): Twiml => {
  const t = new VoiceResponse();
  if (text) t.say(text);
  t.hangup();
  return t;
};

/**
 * The calls WE place. Twilio fetches these URLs after it dials a contact: when someone answers (/answer), when they
 * press a key (/key), and as the call progresses (/status). Every one of them is signed by Twilio (checked before we
 * get here), and every one looks the person up from OUR record of the attempt, never from the request.
 */
export function outboundRouter(d: OutboundDeps): Router {
  const r = Router();

  /** The attempt this URL is for, if the request really belongs to it. */
  function attemptFor(req: Request): Attempt | undefined {
    if (d.mode === "off") return undefined;
    const attempt = d.store.getAttempt(Number(req.params.id));
    const sid = String(req.body?.CallSid ?? "");
    if (!attempt || !/^CA[0-9a-fA-F]{32}$/.test(sid)) return undefined;
    // Twilio can reach us before our own create-call request has returned, so the first sight of the sid is adopted.
    if (!attempt.callSid) d.store.setCallSid(attempt.id, sid, d.clock());
    else if (attempt.callSid !== sid) return undefined;
    return attempt;
  }

  /** Someone answered. Speak only to a person who is still allowed to be called. */
  r.post("/:id/answer", (req, res) => {
    const attempt = attemptFor(req);
    const campaign = attempt && d.store.getCampaign(attempt.campaignId);
    if (!attempt || !campaign) return send(res, goodbye());

    // Re-check at the moment of answer: a stop request, or withdrawn consent, may have come in since we dialled.
    if (d.store.isOnInternalDnc(attempt.phone) || d.store.consentStatus(attempt.phone, campaign.consentScope).status !== "valid") {
      d.store.setAttempt(attempt.id, "done", "stopped_before_answer", d.clock());
      log("info", "outbound_stopped_at_answer", { attemptId: attempt.id, to: maskPhone(attempt.phone) });
      return send(res, goodbye());
    }

    // Only a confirmed human hears the message. Voicemail, fax and "could not tell" all hang up: we leave NO recorded
    // messages (a prerecorded message on an answering machine has extra rules we have not built).
    const answeredBy = String(req.body?.AnsweredBy ?? "");
    if (answeredBy !== "human") {
      d.store.setAttempt(attempt.id, "done", "machine", d.clock());
      log("info", "outbound_not_human", { attemptId: attempt.id, answeredBy: answeredBy.slice(0, 30) || "missing" });
      return send(res, goodbye());
    }

    d.state.update(String(req.body.CallSid), { contactPhone: attempt.phone });
    d.store.setAttempt(attempt.id, "in_progress", "human_answered", d.clock());

    // Who we are and how to stop come FIRST, before the message. The message never contains account details: we
    // do not yet know the person who answered is the account holder.
    const callback = d.callback ? ` You can also call us at ${spokenPhone(d.callback)} to be removed from our list.` : "";
    const t = new VoiceResponse();
    const g = t.gather({ numDigits: 1, timeout: 8, action: `/outbound/${attempt.id}/key`, method: "POST" });
    g.say(
      "Hello, this is Harborline Insurance. To stop receiving these calls at any time, press 9. " +
        `${campaign.scriptText} To speak with an agent, press 1. To stop these calls, press 9.${callback}`,
    );
    t.say("Goodbye.");
    t.hangup();
    send(res, t);
  });

  /** A key press during the message. 9 stops calls immediately, before anything else happens. */
  r.post("/:id/key", (req, res) => {
    const attempt = attemptFor(req);
    if (!attempt) return send(res, goodbye());
    const digits = String(req.body?.Digits ?? "");
    const now = d.clock();

    if (digits === "9") {
      // Recorded BEFORE we say anything back, and for every campaign, not just this one.
      d.store.addDnc(attempt.phone, "keypress_opt_out", now);
      d.store.revoke(attempt.phone, "all", "keypress_opt_out", now);
      const cancelled = d.store.cancelQueued(attempt.phone, now);
      d.store.setAttempt(attempt.id, "done", "opted_out", now);
      log("info", "outbound_opt_out", { attemptId: attempt.id, to: maskPhone(attempt.phone), cancelledQueued: cancelled });
      return send(res, goodbye("You will not receive any more calls from us. Goodbye."));
    }
    if (digits === "1") {
      d.store.setAttempt(attempt.id, "done", "transferred", now);
      const t = new VoiceResponse();
      t.redirect({ method: "POST" }, "/svc/handoff?reason=campaign_response&back=main");
      return send(res, t);
    }
    send(res, goodbye("Goodbye."));
  });

  /** Twilio's progress reports. They never control the call, and they never overwrite what the person chose. */
  r.post("/:id/status", (req, res) => {
    const attempt = attemptFor(req);
    if (attempt) {
      const status = String(req.body?.CallStatus ?? "");
      const finished: Record<string, [Attempt["status"], string]> = {
        completed: ["done", "completed"],
        busy: ["done", "busy"],
        "no-answer": ["done", "no-answer"],
        failed: ["failed", "failed"],
        canceled: ["cancelled", "canceled"],
      };
      const f = finished[status];
      if (f) d.store.setAttempt(attempt.id, f[0], attempt.outcome ? null : f[1], d.clock());
    }
    res.status(204).end();
  });

  return r;
}
