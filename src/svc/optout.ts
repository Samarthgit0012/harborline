import type { Router } from "express";
import { log, maskPhone } from "../log.js";
import { normalizeUsPhone } from "../outbound/phone.js";
import { ask, callInfo, redirect, send, VoiceResponse, type SvcDeps } from "./helpers.js";

/**
 * "Stop calling me", asked of our inbound line. Anyone can ask (the FCC text lets people revoke consent "by using
 * any reasonable method"), and it works on the number they are calling from. Caller ID can be faked, so the worst
 * a faker can do is stop OUR calls to someone else's number: annoying, but the safe direction to be wrong in.
 */
export function mountOptOut(r: Router, d: SvcDeps) {
  r.post("/optout", (req, res) => {
    const { back } = callInfo(req);
    const t = new VoiceResponse();
    ask(t, {
      action: `/svc/optout/in?back=${encodeURIComponent(back)}`,
      numDigits: 1,
      prompt: "To stop receiving calls from Harborline Insurance on the number you are calling from, press 1. To go back, press 9.",
    });
    send(res, t);
  });

  r.post("/optout/in", (req, res) => {
    const { callSid, from, digits, back } = callInfo(req);
    const t = new VoiceResponse();
    const phone = normalizeUsPhone(from);
    if (digits === "1") {
      if (!phone) {
        t.say("Sorry, we could not read your phone number. Please speak with an agent and ask to be removed.");
      } else {
        const now = d.clock();
        d.outbound.addDnc(phone, "inbound_request", now);
        d.outbound.revoke(phone, "all", "inbound_request", now);
        d.outbound.cancelQueued(phone, now);
        log("info", "inbound_opt_out", { callSid, from: maskPhone(phone) });
        t.say("Done. You will not receive any more calls from us.");
      }
      redirect(t, `/ivr/${back}`);
    } else if (digits === "9" || d.state.bump(callSid, "optout") > 2) {
      redirect(t, `/ivr/${back}`);
    } else {
      if (digits) t.say("Sorry, that is not a valid choice.");
      redirect(t, `/svc/optout?back=${encodeURIComponent(back)}`);
    }
    send(res, t);
  });
}
