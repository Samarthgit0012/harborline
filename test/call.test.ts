import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import twilio from "twilio";
import { createApp } from "../src/app.js";
import { MemoryStateStore } from "../src/engine/state.js";
import { parseTwiml } from "../sim/twiml.js";

const AGENT = "+15555550123";
const config = { authToken: "test_token_123", publicBaseUrl: "https://ivr.example.com", port: 0, agentNumber: AGENT };

// Tuesday 10:00 New York = open. Saturday 20:00 New York (Sun 01:00Z) = closed.
const OPEN = new Date("2026-11-17T15:00:00Z");
const CLOSED = new Date("2026-11-15T01:00:00Z");

let server: Server;
let base: string;
let now = OPEN;

beforeEach(async () => {
  server = createApp(config, { clock: () => now, state: new MemoryStateStore() }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise((r) => server.close(r)));

let n = 0;
/** A simulated caller: signs every request, follows the engine's own redirects. */
class Caller {
  callSid = `CA${String(++n).padStart(32, "0")}`;
  heard: string[] = [];
  last = parseTwiml("");

  private async post(path: string, extra: Record<string, string> = {}) {
    const params = { CallSid: this.callSid, From: "+15555550100", ...extra };
    const sig = twilio.getExpectedTwilioSignature(config.authToken, config.publicBaseUrl + path, params);
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
      body: new URLSearchParams(params).toString(),
    });
    expect(res.status).toBe(200);
    this.last = parseTwiml(await res.text());
    this.heard.push(...this.last.says);
    return this;
  }

  /** Follow automatic redirects (no Gather) until the call needs the caller or ends. */
  private async settle() {
    for (let i = 0; i < 20 && !this.last.gatherAction && this.last.redirect; i++) await this.post(this.last.redirect);
    return this;
  }

  async dial() {
    await this.post("/voice");
    return this.settle();
  }
  async press(digit: string) {
    await this.post(this.last.gatherAction!, { Digits: digit });
    return this.settle();
  }
  async silence() {
    await this.post(this.last.redirect!); // what the platform does when the Gather times out
    return this.settle();
  }
  get hearsAll() {
    return this.heard.join(" | ");
  }
}

describe("business hours routing", () => {
  it("open: greets then offers the main menu", async () => {
    now = OPEN;
    const c = await new Caller().dial();
    expect(c.hearsAll).toContain("Thank you for calling Harborline Insurance.");
    expect(c.last.gatherAction).toBe("/ivr/main/input");
    expect(c.last.says[0]).toContain("For policy questions, press 1");
  });

  it("closed: says it is closed and offers only a message and the claims option (no agent)", async () => {
    now = CLOSED;
    const c = await new Caller().dial();
    expect(c.hearsAll).toContain("closed right now");
    expect(c.hearsAll).toContain("dial 9 1 1");
    expect(c.last.gatherAction).toBe("/ivr/closed/input");
    await c.press("2");
    expect(c.hearsAll).toContain("I can take your claim report now");
    expect(c.hearsAll).not.toContain("To speak with an agent");
  });

  it("closed: two failures hang up politely instead of looping", async () => {
    now = CLOSED;
    const c = await new Caller().dial();
    await c.silence(); // failure 1 -> maxRetries is 1, so we re-prompt
    expect(c.last.gatherAction).toBe("/ivr/closed/input");
    await c.silence(); // failure 2 -> give up
    expect(c.last.hangup).toBe(true);
    expect(c.hearsAll).toContain("call back during business hours");
  });
});

describe("main menu", () => {
  it("valid key goes to the placeholder and returns to the menu", async () => {
    now = OPEN;
    const c = await new Caller().dial();
    await c.press("4");
    expect(c.hearsAll).toContain("Quote service will be available soon");
    expect(c.last.gatherAction).toBe("/ivr/main/input"); // back at the menu
  });

  it("0 transfers to the agent number", async () => {
    now = OPEN;
    const c = await new Caller().dial();
    await c.press("0");
    expect(c.hearsAll).toContain("Please hold");
    expect(c.last.dial).toBe(AGENT);
  });

  it("invalid key apologises and replays the menu", async () => {
    now = OPEN;
    const c = await new Caller().dial();
    await c.press("9");
    expect(c.hearsAll).toContain("not a valid choice");
    expect(c.last.gatherAction).toBe("/ivr/main/input");
    expect(c.last.says[0]).toContain("For policy questions"); // menu again, without the greeting
  });

  it("silence three times gives up and connects to an agent (retry cap = 2)", async () => {
    now = OPEN;
    const c = await new Caller().dial();
    await c.silence();
    await c.silence();
    expect(c.last.dial).toBeUndefined(); // still re-prompting after 2 failures
    await c.silence();
    expect(c.hearsAll).toContain("trouble hearing you");
    expect(c.last.dial).toBe(AGENT);
  });

  it("a valid choice resets the failure count", async () => {
    now = OPEN;
    const c = await new Caller().dial();
    await c.silence();
    await c.silence(); // 2 failures
    await c.press("4"); // valid -> counter resets, back at the menu
    await c.silence();
    await c.silence(); // 2 fresh failures: must NOT give up yet
    expect(c.last.dial).toBeUndefined();
    expect(c.last.gatherAction).toBe("/ivr/main/input");
  });

  it("mixed bad input counts toward the same cap", async () => {
    now = OPEN;
    const c = await new Caller().dial();
    await c.press("9");
    await c.silence();
    await c.press("8");
    expect(c.last.dial).toBe(AGENT);
  });

  it("two callers do not share retry counts", async () => {
    now = OPEN;
    const a = await new Caller().dial();
    const b = await new Caller().dial();
    await a.silence();
    await a.silence();
    await b.silence();
    expect(b.last.gatherAction).toBe("/ivr/main/input"); // b has only 1 failure
  });
});

describe("robustness", () => {
  it("an unknown node ends the call politely instead of crashing", async () => {
    const c = new Caller();
    await (c as any).post("/ivr/does-not-exist");
    expect(c.last.hangup).toBe(true);
    expect(c.hearsAll).toContain("something went wrong");
  });

  it("refuses to boot with a broken flow", () => {
    const broken = { start: "x", closedStart: "x", nodes: {} } as any;
    expect(() => createApp(config, { flow: broken })).toThrow("Invalid call flow");
  });

  it("still rejects unsigned requests on the new routes", async () => {
    const res = await fetch(`${base}/ivr/main/input`, { method: "POST" });
    expect(res.status).toBe(403);
  });
});
