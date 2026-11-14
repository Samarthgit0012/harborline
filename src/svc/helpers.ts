import type { Request, Response } from "express";
import twilio from "twilio";
import type { StateStore } from "../engine/state.js";
import type { AttemptLimiter } from "../services/rateLimiter.js";
import type { PolicyRepo } from "../services/policyRepo.js";
import type { SmsSender } from "../services/sms.js";
import type { Schedule } from "../services/businessHours.js";
import type { CallQueue } from "../services/queue.js";
import type { OutboundStore } from "../outbound/store.js";

export const { VoiceResponse } = twilio.twiml;
export type Twiml = InstanceType<typeof VoiceResponse>;
export const POST = "POST";

export interface SvcDeps {
  repo: PolicyRepo;
  state: StateStore;
  limiter: AttemptLimiter;
  sms: SmsSender;
  clock: () => Date;
  schedule: Schedule;
  agentNumber?: string;
  /** The waiting line for the agent. */
  queue: CallQueue;
  /** Caps call-back and voicemail requests per number (stops a prank or a loop from flooding the agents). */
  ticketLimiter: AttemptLimiter;
  /** Optional https URL of an audio file to play while callers wait. Without it they hear short pauses. */
  holdMusicUrl?: string;
  /** Is card payment switched on? Off unless a Pay Connector is set up. */
  payEnabled: boolean;
  payConnector?: string;
  /** Needed to build the absolute https URLs <Pay> requires for its callbacks. */
  publicBaseUrl: string;
  /** Caps card payment attempts per policy and per calling number (stops card-testing). */
  payLimiter: AttemptLimiter;
  /** Consent, do-not-call and campaign records (used here for the inbound "stop calling me" request). */
  outbound: OutboundStore;
}

export const send = (res: Response, t: Twiml) => res.type("text/xml").send(t.toString());

/** Facts about this webhook. Digits never leave this function except as the return value. */
export function callInfo(req: Request) {
  const q = (name: string, fallback: string) => {
    const v = req.query[name];
    return typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : fallback;
  };
  return {
    callSid: String(req.body?.CallSid ?? ""),
    from: String(req.body?.From ?? ""),
    /** Undefined means the caller was silent ("" and missing both mean no input). */
    digits: (req.body?.Digits as string | undefined) || undefined,
    back: q("back", "main"),
    next: q("next", "policy"),
  };
}

export const svcUrl = (path: string, q: Record<string, string> = {}) => {
  const qs = new URLSearchParams(q).toString();
  return `/svc/${path}${qs ? `?${qs}` : ""}`;
};

/** Ask for input. Silence falls through to the Redirect, which lands on the answer route with no Digits. */
export function ask(
  t: Twiml,
  o: { action: string; prompt: string; numDigits?: number; finishOnKey?: string; timeout?: number },
) {
  const g = t.gather({
    action: o.action,
    method: POST,
    timeout: o.timeout ?? 6,
    ...(o.numDigits ? { numDigits: o.numDigits } : {}),
    ...(o.finishOnKey !== undefined ? { finishOnKey: o.finishOnKey } : {}),
  });
  g.say(o.prompt);
  t.redirect({ method: POST }, o.action);
}

export const redirect = (t: Twiml, to: string) => t.redirect({ method: POST }, to);

/** "03142026" -> "2026-03-14", or undefined if it is not a real calendar date. */
export function parseUsDate(digits: string | undefined): string | undefined {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(digits ?? "");
  if (!m) return undefined;
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  return `${m[3]}-${m[1]}-${m[2]}`;
}
