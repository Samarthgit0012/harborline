import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import twilio from "twilio";
import { createApp, type Deps } from "../src/app.js";
import type { Config } from "../src/config.js";
import { parseTwiml } from "../sim/twiml.js";

export const AGENT = "+15555550123";
export const baseConfig: Config = {
  authToken: "test_token_123",
  publicBaseUrl: "https://ivr.example.com",
  port: 0,
  agentNumber: AGENT,
};

// Tuesday 10:00 New York = open. Saturday 20:00 New York (Sun 01:00Z) = closed.
export const OPEN = new Date("2026-11-17T15:00:00Z");
export const CLOSED = new Date("2026-11-15T01:00:00Z");

export interface TestServer {
  base: string;
  close: () => Promise<void>;
}

/** A fresh app (fresh in-memory database, state and lockout counters) on a random port. */
export async function startApp(deps: Deps = {}, config: Config = baseConfig): Promise<TestServer> {
  const server: Server = createApp(config, deps).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let n = 0;
/** A simulated caller: signs every request the way Twilio would, follows the engine's own redirects. */
export class Caller {
  callSid = `CA${String(++n).padStart(32, "0")}`;
  heard: string[] = [];
  last = parseTwiml("");
  /** HTTP status of the most recent response (200 for TwiML, 204 for Twilio status callbacks). */
  status = 0;

  constructor(
    private srv: TestServer,
    public from = "+15555550100",
  ) {}

  async post(path: string, extra: Record<string, string> = {}) {
    const params = { CallSid: this.callSid, From: this.from, ...extra };
    const sig = twilio.getExpectedTwilioSignature(baseConfig.authToken, baseConfig.publicBaseUrl + path, params);
    const res = await fetch(this.srv.base + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
      body: new URLSearchParams(params).toString(),
    });
    expect([200, 204]).toContain(res.status);
    this.status = res.status;
    this.last = parseTwiml(await res.text());
    this.heard.push(...this.last.says);
    return this;
  }

  /** Follow automatic redirects (no Gather/Record) until the call needs the caller or ends. */
  async settle() {
    for (let i = 0; i < 30 && !this.last.gatherAction && !this.last.recordAction && this.last.redirect; i++) {
      await this.post(this.last.redirect);
    }
    return this;
  }

  async dial() {
    await this.post("/voice");
    return this.settle();
  }
  /** Type digits at the current prompt (also what a keypad press looks like). */
  async press(digits: string) {
    await this.post(this.last.gatherAction!, { Digits: digits });
    return this.settle();
  }
  /** Say something at the current prompt. confidence = what the recogniser reports ("" or undefined = none sent). */
  async say(text: string, confidence?: number | string) {
    const extra: Record<string, string> = { SpeechResult: text };
    if (confidence !== undefined) extra.Confidence = String(confidence);
    await this.post(this.last.gatherAction!, extra);
    return this.settle();
  }
  async silence() {
    await this.post(this.last.redirect!); // what Twilio does when the Gather or Record times out
    return this.settle();
  }
  /** What the agent hears privately when they answer: fetched the way Twilio would, on the agent's own call leg. */
  async whisper() {
    const url = this.last.whisperUrl!;
    const before = this.last;
    await this.post(url, { CallSid: "CA" + "e".repeat(32) });
    const heard = this.last.says.join(" ");
    this.last = before; // the caller's own leg is unchanged
    return heard;
  }
  /** Twilio reports the end of the <Dial> to its action URL, on the caller's own call. */
  async dialDone(status: "completed" | "no-answer" | "busy" | "failed" | "canceled", duration = 0) {
    await this.post(this.last.dialAction!, { DialCallStatus: status, DialCallDuration: String(duration) });
    return this.settle();
  }
  /** One more pass of the hold loop (what Twilio does when the Gather times out and the Redirect runs). */
  async holdAgain() {
    await this.post(this.last.redirect!);
    return this.settle();
  }
  /**
   * Twilio finished collecting the card (on ITS side) and reports how it went to the <Pay> action URL.
   * We send only the Result, plus whatever extra fields a test wants to throw at the server.
   */
  async payResult(result: string, extra: Record<string, string> = {}) {
    const action = new URL(this.last.pay!.action);
    await this.post(action.pathname + action.search, { Result: result, ...extra });
    return this.settle();
  }
  /** The caller finished leaving a voice message. */
  async record(recordingSid = "RE" + "a".repeat(32)) {
    await this.post(this.last.recordAction!, { RecordingSid: recordingSid, RecordingDuration: "12" });
    return this.settle();
  }
  get hearsAll() {
    return this.heard.join(" | ");
  }
}
