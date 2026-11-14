import type { Router } from "express";
import { log, maskPhone } from "../log.js";
import { ask, callInfo, parseUsDate, redirect, send, svcUrl, VoiceResponse, type SvcDeps, type Twiml } from "./helpers.js";

const MAX_CALL_FAILURES = 3; // wrong verifications allowed in ONE call
const MAX_FORMAT_RETRIES = 2; // "that is not 8 digits" re-asks before giving up

const numKey = (from: string) => `num:${from}`;
const polKey = (policy: string) => `pol:${policy}`;

/**
 * Who is calling? Two different questions:
 *  - recognition: caller ID matches a policy. Caller ID is trivially spoofed, so this only SAVES A STEP.
 *  - authentication: they know a secret only the customer should know (date of birth here).
 * Nothing sensitive is spoken until authentication succeeds, and we never log what was typed.
 */
export function mountAuth(r: Router, d: SvcDeps) {
  const isLocked = (from: string, callSid: string) => {
    const s = d.state.get(callSid);
    return (
      s.authFailures >= MAX_CALL_FAILURES ||
      d.limiter.isLocked(numKey(from)) ||
      (!!s.pendingPolicy && d.limiter.isLocked(polKey(s.pendingPolicy)))
    );
  };

  /** Same words for "locked" whether or not the policy exists, so the lockout can't be used to probe. */
  const locked = (t: Twiml, back: string) => {
    t.say("For your security, we cannot verify you right now. Please try again later, or speak with an agent during business hours.");
    redirect(t, `/ivr/${back}`);
    return t;
  };

  const askDob = (t: Twiml, next: string, back: string) =>
    ask(t, {
      action: svcUrl("auth/dob", { next, back }),
      numDigits: 8,
      finishOnKey: "",
      prompt: "Please enter your date of birth as eight digits: two digit month, two digit day, then four digit year.",
    });

  const askPolicy = (t: Twiml, next: string, back: string) =>
    ask(t, {
      action: svcUrl("auth/policy", { next, back }),
      finishOnKey: "#",
      timeout: 8,
      prompt: "To verify your identity, please enter your eight digit policy number, then press pound.",
    });

  r.post("/auth", (req, res) => {
    const { callSid, from, next, back } = callInfo(req);
    const t = new VoiceResponse();
    if (d.state.get(callSid).authedPolicy) {
      redirect(t, svcUrl(next, { back }));
      return send(res, t);
    }
    if (isLocked(from, callSid)) return send(res, locked(t, back));

    const matches = d.repo.findByPhone(from);
    if (matches.length === 1) {
      // Recognised. We still ask for the date of birth: caller ID alone proves nothing.
      d.state.update(callSid, { pendingPolicy: matches[0].policyNumber, viaCallerId: true });
      log("info", "auth_started", { callSid, mode: "caller_id", from: maskPhone(from) });
      askDob(t, next, back);
    } else {
      // Unknown number, withheld number, or one number on several policies: ask for the policy number.
      d.state.update(callSid, { pendingPolicy: undefined, viaCallerId: false });
      log("info", "auth_started", { callSid, mode: "policy_number", from: maskPhone(from) });
      askPolicy(t, next, back);
    }
    send(res, t);
  });

  r.post("/auth/policy", (req, res) => {
    const { callSid, from, digits, next, back } = callInfo(req);
    const t = new VoiceResponse();
    if (!digits || !/^\d{8}$/.test(digits)) {
      if (d.state.bump(callSid, "auth:policy") > MAX_FORMAT_RETRIES) {
        d.state.reset(callSid, "auth:policy");
        t.say("I am having trouble getting that.");
        redirect(t, `/ivr/${back}`);
      } else {
        t.say("Sorry, a policy number has eight digits.");
        askPolicy(t, next, back);
      }
      return send(res, t);
    }
    d.state.reset(callSid, "auth:policy");
    // We accept any well-formed number WITHOUT checking it exists, so the next step is the same
    // for real and made-up policies (no way to learn which numbers are valid).
    d.state.update(callSid, { pendingPolicy: digits, viaCallerId: false });
    if (isLocked(from, callSid)) return send(res, locked(t, back));
    askDob(t, next, back);
    send(res, t);
  });

  r.post("/auth/dob", (req, res) => {
    const { callSid, from, digits, next, back } = callInfo(req);
    const t = new VoiceResponse();
    const s = d.state.get(callSid);
    if (!s.pendingPolicy) {
      redirect(t, svcUrl("auth", { next, back })); // lost our place: start over
      return send(res, t);
    }
    if (isLocked(from, callSid)) return send(res, locked(t, back));

    const policy = d.repo.findByPolicyNumber(s.pendingPolicy);
    const dob = parseUsDate(digits);
    if (policy && dob && policy.dob === dob) {
      d.state.update(callSid, { authedPolicy: policy.policyNumber, pendingPolicy: undefined, authFailures: 0 });
      log("info", "auth_success", { callSid });
      redirect(t, svcUrl(next, { back }));
      return send(res, t);
    }

    // Wrong, malformed or silent: all count. Recorded against the number AND the policy.
    d.limiter.recordFailure(numKey(from));
    d.limiter.recordFailure(polKey(s.pendingPolicy));
    d.state.update(callSid, { authFailures: s.authFailures + 1 });
    log("warn", "auth_failed", { callSid, failuresThisCall: s.authFailures + 1 });
    if (isLocked(from, callSid)) {
      log("warn", "auth_locked", { callSid, from: maskPhone(from) });
      return send(res, locked(t, back));
    }
    t.say("We could not verify that information.");
    if (s.viaCallerId) askDob(t, next, back);
    else {
      d.state.update(callSid, { pendingPolicy: undefined });
      askPolicy(t, next, back);
    }
    send(res, t);
  });
}
