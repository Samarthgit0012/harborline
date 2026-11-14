import type { Request, Router } from "express";
import { log, maskPhone } from "../log.js";
import type { PaymentOutcome } from "../services/policyRepo.js";
import { speakCurrency, speakDigits } from "../services/speak.js";
import { ask, callInfo, redirect, send, svcUrl, VoiceResponse, type SvcDeps } from "./helpers.js";

const MAX_RETRIES = 2;
const PAYMENT_NUMBER = /^\d{6}$/;
/** Processor confirmation codes look like "ch_3Nx..." or "AB12CD". Anything else is not stored. */
const CONFIRMATION = /^[A-Za-z0-9_-]{1,100}$/;

/** 120450 cents -> "1204.50" using whole-number maths, never floating point. */
export function centsToDecimal(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/**
 * What each Twilio <Pay> Result means for us. Only "success" moves money in OUR books.
 * The Results are from Twilio's Pay page. "unconfirmed" means: do not tell the caller it worked, do not
 * tell them it failed, and put it on the reconciliation list for a human to check with the processor.
 */
function outcomeFor(result: string, confirmation: string | undefined): { outcome: PaymentOutcome; say: string } {
  switch (result) {
    case "success":
      return { outcome: { status: "succeeded", result, confirmation }, say: "" };
    case "caller-interrupted-with-star":
      return { outcome: { status: "failed", result }, say: "Your payment was cancelled and your card was not charged." };
    case "too-many-failed-attempts":
    case "validation-error":
      return {
        outcome: { status: "failed", result },
        say: "Sorry, we could not accept that card. You can try again later, or speak with an agent.",
      };
    default:
      // payment-connector-error, internal-error, caller-hung-up, or anything Twilio adds later.
      return {
        outcome: { status: "unconfirmed", result: result.slice(0, 60) },
        say: "Sorry, we could not confirm your payment. Please do not pay again. We will check it and contact you if anything is needed.",
      };
  }
}

/**
 * Paying a bill by card.
 *
 * THE RULE: card digits never reach this server. The caller types them into Twilio's <Pay>, which sends them to
 * the payment processor. Our code sees only a result ("success", "caller-interrupted-with-star", ...). So this
 * file never reads PaymentCardNumber, SecurityCode, ExpirationDate, PaymentToken or any other card field from the
 * request, and a test proves none of them reaches our logs, database or session.
 */
export function mountPay(r: Router, d: SvcDeps) {
  const absolute = (path: string, q: Record<string, string>) => `${d.publicBaseUrl}${svcUrl(path, q)}`;

  /** The caller proved who they are this call, and the policy still exists. */
  const verified = (req: Request) => {
    const { callSid } = callInfo(req);
    const s = d.state.get(callSid);
    const policy = s.authedPolicy ? d.repo.findByPolicyNumber(s.authedPolicy) : undefined;
    return { callSid, s, policy };
  };

  /** Offer to pay the full balance. The amount is read from the database now, never from the caller. */
  r.post("/pay", (req, res) => {
    const { back } = callInfo(req);
    const { s, policy } = verified(req);
    const t = new VoiceResponse();

    if (!d.payEnabled) {
      t.say("Card payment is not available by phone right now. Please speak with an agent.");
      redirect(t, svcUrl("billing", { back }));
    } else if (!policy) {
      redirect(t, svcUrl("auth", { next: "billing", back })); // log in first, then back to billing
    } else if (policy.balanceCents <= 0) {
      t.say("You have no balance due.");
      redirect(t, svcUrl("billing", { back }));
    } else if (d.repo.blockingPayments(policy.policyNumber, s.paymentNumber).length) {
      t.say("We are still checking on a recent payment for this policy. Please do not pay again right now. An agent can help.");
      redirect(t, svcUrl("billing", { back }));
    } else if (d.payLimiter.isLocked(`pay:pol:${policy.policyNumber}`)) {
      t.say("There have been too many payment attempts. Please try again later, or speak with an agent.");
      redirect(t, `/ivr/${back}`);
    } else {
      ask(t, {
        action: svcUrl("pay/confirm", { back }),
        numDigits: 1,
        prompt:
          `Your balance is ${speakCurrency(policy.balanceCents)}. ` +
          "To pay the full amount now with a debit or credit card, press 1. To go back, press 9.",
      });
    }
    send(res, t);
  });

  r.post("/pay/confirm", (req, res) => {
    const { callSid, digits, from, back } = callInfo(req);
    const { s, policy } = verified(req);
    const t = new VoiceResponse();

    if (!d.payEnabled || !policy) {
      redirect(t, svcUrl("pay", { back }));
    } else if (digits === "9") {
      redirect(t, svcUrl("billing", { back }));
    } else if (digits !== "1") {
      if (d.state.bump(callSid, "pay:confirm") > MAX_RETRIES) redirect(t, svcUrl("billing", { back }));
      else {
        if (digits) t.say("Sorry, that is not a valid choice.");
        redirect(t, svcUrl("pay", { back }));
      }
    } else if (policy.balanceCents <= 0) {
      t.say("You have no balance due.");
      redirect(t, svcUrl("billing", { back }));
    } else {
      // Reuse an attempt that is still open (a repeated request must not start a second charge).
      const open = s.paymentNumber ? d.repo.getPayment(s.paymentNumber) : undefined;
      let payment = open && open.status === "started" && open.policyNumber === policy.policyNumber ? open : undefined;

      if (!payment && d.repo.blockingPayments(policy.policyNumber, s.paymentNumber).length) {
        t.say("We are still checking on a recent payment for this policy. Please do not pay again right now. An agent can help.");
        redirect(t, svcUrl("billing", { back }));
        return send(res, t);
      }
      if (!payment) {
        const keys = [`pay:pol:${policy.policyNumber}`, `pay:num:${from || callSid}`];
        if (keys.some((k) => d.payLimiter.isLocked(k))) {
          t.say("There have been too many payment attempts. Please try again later, or speak with an agent.");
          redirect(t, `/ivr/${back}`);
          return send(res, t);
        }
        keys.forEach((k) => d.payLimiter.recordFailure(k)); // each attempt uses one of the three allowed per hour
        // The amount is the CURRENT balance from our records. It is saved BEFORE the caller types a card,
        // so even if the call dies mid-payment we know an attempt existed and for how much.
        payment = d.repo.startPayment(policy.policyNumber, policy.balanceCents, d.clock());
        d.state.update(callSid, { paymentNumber: payment.paymentNumber });
        log("info", "payment_started", { callSid, paymentNumber: payment.paymentNumber, amountCents: payment.amountCents, from: maskPhone(from) });
      }

      t.say(
        "You will now enter your card on your phone keypad. Your card details go straight to our payment processor and are not heard or stored by this phone system. " +
          "Press star at any time to cancel.",
      );
      t.pay({
        // These are the only things we decide. Everything the caller types goes to the processor.
        chargeAmount: centsToDecimal(payment.amountCents),
        currency: "usd",
        paymentMethod: "credit-card",
        input: "dtmf",
        maxAttempts: 2,
        timeout: 10,
        securityCode: true,
        postalCode: "true",
        validCardTypes: ["visa", "mastercard", "amex"],
        description: `Harborline policy ending ${policy.policyNumber.slice(-4)}`,
        action: absolute("pay/result", { p: payment.paymentNumber, back }),
        statusCallback: absolute("pay/status", { p: payment.paymentNumber }),
        ...(d.payConnector ? { paymentConnector: d.payConnector } : {}),
      });
    }
    send(res, t);
  });

  /** Twilio reports how <Pay> ended. We read ONE field, Result, and the confirmation code. Nothing else. */
  r.post("/pay/result", (req, res) => {
    const { callSid, back } = callInfo(req);
    const s = d.state.get(callSid);
    const t = new VoiceResponse();
    const p = typeof req.query.p === "string" && PAYMENT_NUMBER.test(req.query.p) ? req.query.p : undefined;

    // Only the attempt THIS call started can be settled by THIS call.
    if (!p || s.paymentNumber !== p || !d.repo.getPayment(p)) {
      log("warn", "payment_result_unmatched", { callSid });
      redirect(t, `/ivr/${back}`);
      return send(res, t);
    }

    const result = String(req.body?.Result ?? "");
    const code = String(req.body?.PaymentConfirmationCode ?? "");
    const { outcome, say } = outcomeFor(result, CONFIRMATION.test(code) ? code : undefined);

    let saved;
    try {
      saved = d.repo.completePayment(p, outcome, d.clock());
    } catch (err) {
      // e.g. the processor's confirmation code was already used by another payment: do not trust, do not guess.
      log("error", "payment_complete_failed", { callSid, paymentNumber: p, error: (err as Error).message });
      saved = d.repo.completePayment(p, { status: "unconfirmed", result: "complete-failed" }, d.clock());
    }
    log("info", "payment_result", { callSid, paymentNumber: p, result: outcome.result, status: saved?.status, needsReview: saved?.needsReview });

    if (saved?.status === "succeeded") {
      t.say(
        `Thank you. Your payment of ${speakCurrency(saved.amountCents)} was successful. ` +
          `Your confirmation number is ${speakDigits(saved.paymentNumber)}. Please write it down.`,
      );
    } else {
      t.say(say || "Sorry, we could not confirm your payment. Please do not pay again. We will check it and contact you if anything is needed.");
    }
    redirect(t, svcUrl("billing", { back }));
    send(res, t);
  });

  /**
   * Progress reports while the caller types (for example "invalid-card-number"). Twilio sends masked card fields
   * here too. We log ONLY which step failed and why, from a short allow-list, and ignore the rest of the body.
   */
  const FOR = new Set(["payment-card-number", "expiration-date", "security-code", "postal-code", "payment-processing"]);
  const ERROR = new Set([
    "input-timeout", "invalid-card-number", "invalid-card-type", "invalid-date", "invalid-security-code",
    "invalid-postal-code", "internal-error", "session-in-progress",
  ]);
  r.post("/pay/status", (req, res) => {
    const { callSid } = callInfo(req);
    const f = String(req.body?.For ?? "");
    const e = String(req.body?.ErrorType ?? "");
    log("info", "payment_step", { callSid, step: FOR.has(f) ? f : "other", error: e ? (ERROR.has(e) ? e : "other") : undefined });
    res.status(204).end(); // statusCallback responses are ignored by Twilio
  });
}
