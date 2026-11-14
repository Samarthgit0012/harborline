import type { Request, Response, Router } from "express";
import { log, maskPhone } from "../log.js";
import { localDate } from "../services/businessHours.js";
import type { Claim, Policy } from "../services/policyRepo.js";
import { speakCurrency, speakDate, speakDigits } from "../services/speak.js";
import { ask, callInfo, redirect, send, svcUrl, VoiceResponse, type SvcDeps } from "./helpers.js";

const MAX_MENU_RETRIES = 2;
const last4 = (policyNumber: string) => policyNumber.slice(-4);

export function policySummary(p: Policy): string {
  return (
    `Your ${p.product} policy ending in ${speakDigits(last4(p.policyNumber), 4)} is ${p.status}. ` +
    `Your premium is ${speakCurrency(p.premiumCents)} per month.`
  );
}

export function billingSummary(p: Policy, today: string): string {
  if (p.balanceCents <= 0) {
    return `You have no balance due. Your next payment of ${speakCurrency(p.premiumCents)} is due on ${speakDate(p.nextDue)}.`;
  }
  const late = p.nextDue < today; // ISO dates compare correctly as strings
  return (
    `Your balance is ${speakCurrency(p.balanceCents)}. ` +
    (late ? `Your payment was due on ${speakDate(p.nextDue)} and is past due.` : `It is due on ${speakDate(p.nextDue)}.`)
  );
}

export function claimSummary(claims: Claim[]): string {
  if (!claims.length) return "We do not have any claims on file for your policy.";
  const c = claims[0];
  const reported = speakDate(c.createdAt.slice(0, 10));
  return (
    `You have ${claims.length === 1 ? "one claim" : `${claims.length} claims`} on file. ` +
    `The most recent, claim number ${speakDigits(c.claimNumber)}, was reported on ${reported} and is ${c.status}.`
  );
}

/**
 * Self-service that needs a verified caller. Each screen reads data back, then offers a small menu
 * INSIDE the same <Gather>, so a caller who has heard enough can press a key and skip the rest.
 */
export function mountAccount(r: Router, d: SvcDeps) {
  /** Not verified yet (or the session was lost): go through the login first, then come back here. */
  const needsAuth = (kind: string) => (req: Request, res: Response) => {
    const t = new VoiceResponse();
    redirect(t, svcUrl("auth", { next: kind, back: callInfo(req).back }));
    send(res, t);
  };

  for (const kind of ["policy", "billing"] as const) {
    r.post(`/${kind}`, (req, res) => {
      const { callSid, back } = callInfo(req);
      const s = d.state.get(callSid);
      const policy = s.authedPolicy ? d.repo.findByPolicyNumber(s.authedPolicy) : undefined;
      if (!policy) return needsAuth(kind)(req, res);

      const today = localDate(d.clock(), d.schedule.timeZone);
      const summary = kind === "policy" ? policySummary(policy) : billingSummary(policy, today);
      const menu =
        kind === "policy"
          ? " To hear that again, press 1. To get your ID card by text message, press 2. To return to the main menu, press 9."
          : " To hear that again, press 1. To return to the main menu, press 9.";
      const t = new VoiceResponse();
      ask(t, { action: svcUrl(`${kind}/input`, { back }), numDigits: 1, prompt: summary + menu });
      send(res, t);
    });

    r.post(`/${kind}/input`, async (req, res) => {
      const { callSid, digits, back } = callInfo(req);
      const t = new VoiceResponse();
      const s = d.state.get(callSid);
      const policy = s.authedPolicy ? d.repo.findByPolicyNumber(s.authedPolicy) : undefined;
      if (!policy) return needsAuth(kind)(req, res); // never answer an unauthenticated menu press

      log("info", "account_input", { callSid, service: kind, pressed: !!digits });
      if (digits === "1") {
        d.state.reset(callSid, `${kind}:menu`);
        redirect(t, svcUrl(kind, { back }));
      } else if (digits === "9") {
        redirect(t, `/ivr/${back}`);
      } else if (digits === "2" && kind === "policy") {
        // Always to the number ON FILE, never to the number calling in: caller ID can be spoofed.
        try {
          await d.sms.send(
            policy.phone,
            `Harborline Insurance: your ID card for policy ending ${last4(policy.policyNumber)} is at https://harborline.example/id-card`,
          );
          t.say(`I have texted your ID card to the phone number we have on file, ending in ${speakDigits(policy.phone.slice(-4), 4)}.`);
        } catch (err) {
          log("error", "sms_failed", { callSid, to: maskPhone(policy.phone), error: (err as Error).message });
          t.say("Sorry, I could not send the text message right now.");
        }
        redirect(t, `/ivr/${back}`);
      } else if (d.state.bump(callSid, `${kind}:menu`) > MAX_MENU_RETRIES) {
        d.state.reset(callSid, `${kind}:menu`);
        t.say("Returning to the main menu.");
        redirect(t, `/ivr/${back}`);
      } else {
        if (digits) t.say("Sorry, that is not a valid choice.");
        redirect(t, svcUrl(kind, { back }));
      }
      send(res, t);
    });
  }

  r.post("/claimstatus", (req, res) => {
    const { callSid, back } = callInfo(req);
    const s = d.state.get(callSid);
    const t = new VoiceResponse();
    if (!s.authedPolicy) return needsAuth("claimstatus")(req, res);
    t.say(claimSummary(d.repo.claimsFor(s.authedPolicy)));
    redirect(t, `/ivr/${back}`);
    send(res, t);
  });
}
