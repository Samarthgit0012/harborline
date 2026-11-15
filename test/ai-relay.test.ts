import type { AddressInfo } from "node:net";
import twilio from "twilio";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, listen, type Deps } from "../src/app.js";
import { relayUrl } from "../src/ai/routes.js";
import { MemoryStateStore } from "../src/engine/state.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import { RuleBasedLlm, ScriptedLlm, call, calls, say } from "../sim/ai-fakes.js";
import { Caller, OPEN, baseConfig, type TestServer } from "./caller.js";
import { parseTwiml } from "../sim/twiml.js";

const SID = "CA" + "ab".repeat(16);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function start(deps: Deps) {
  const repo = new SqliteRepo(":memory:");
  const state = new MemoryStateStore();
  const server = listen(createApp(baseConfig, { repo, state, clock: () => OPEN, ...deps }), 0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  closers.push(() => {
    server.relay?.close();
    return new Promise<void>((r) => server.close(() => r()));
  });
  const srv: TestServer = { base: `http://127.0.0.1:${port}`, close: async () => {} };
  return { repo, state, port, srv, server };
}

const sign = (url: string) => twilio.getExpectedTwilioSignature(baseConfig.authToken, url, {});
const goodHeaders = () => ({ "x-twilio-signature": sign(relayUrl(baseConfig.publicBaseUrl)) });

/** A phone-side client: collects what we send, lets a test wait for the next message of a kind. */
async function connect(port: number, headers: Record<string, string> = goodHeaders()) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ai/relay`, { headers });
  const got: Record<string, unknown>[] = [];
  const waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    const w = waiters.findIndex((x) => x.type === m.type);
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m);
    else got.push(m);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  closers.push(async () => ws.terminate());
  return {
    ws,
    send: (o: Record<string, unknown>) => ws.send(JSON.stringify(o)),
    next: (type: string, ms = 2000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const i = got.findIndex((m) => m.type === type);
        if (i >= 0) return resolve(got.splice(i, 1)[0]);
        const t = setTimeout(() => reject(new Error(`no ${type} message within ${ms} ms`)), ms);
        waiters.push({ type, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
    setup: (from = "+15555550100") => ws.send(JSON.stringify({ type: "setup", callSid: SID, from, to: "+15555550199" })),
    prompt: (voicePrompt: string, last = true) => ws.send(JSON.stringify({ type: "prompt", voicePrompt, lang: "en-US", last })),
  };
}

describe("who may open the AI line's WebSocket", () => {
  it("is refused without a Twilio signature", async () => {
    const { port } = await start({ llm: new RuleBasedLlm() });
    await expect(connect(port, {})).rejects.toThrow("HTTP 403");
  });
  it("is refused with a wrong signature", async () => {
    const { port } = await start({ llm: new RuleBasedLlm() });
    await expect(connect(port, { "x-twilio-signature": "Zm9yZ2Vk" })).rejects.toThrow("HTTP 403");
    const other = twilio.getExpectedTwilioSignature("a_different_token", relayUrl(baseConfig.publicBaseUrl), {});
    await expect(connect(port, { "x-twilio-signature": other })).rejects.toThrow("HTTP 403");
  });
  it("accepts a signature over the wss address, and over the https address (Twilio's docs do not say which)", async () => {
    const { port } = await start({ llm: new RuleBasedLlm() });
    const wss = await connect(port, { "x-twilio-signature": sign("wss://ivr.example.com/ai/relay") });
    const https = await connect(port, { "x-twilio-signature": sign("https://ivr.example.com/ai/relay") });
    expect(wss.ws.readyState).toBe(WebSocket.OPEN);
    expect(https.ws.readyState).toBe(WebSocket.OPEN);
  });
  it("a signature for a different path does not work", async () => {
    const { port } = await start({ llm: new RuleBasedLlm() });
    await expect(connect(port, { "x-twilio-signature": sign("wss://ivr.example.com/ai/other") })).rejects.toThrow("HTTP 403");
  });
  it("there is no WebSocket at all when the AI line is off", async () => {
    const { port } = await start({});
    await expect(connect(port)).rejects.toThrow();
  });
  it("only a limited number of calls at once", async () => {
    const { port } = await start({ llm: new RuleBasedLlm(), relay: { maxSessions: 1 } });
    await connect(port);
    await expect(connect(port)).rejects.toThrow("HTTP 503");
  });
});

describe("a whole AI quote call", () => {
  it("collects the details, saves one complete lead, and says goodbye with a reference number", async () => {
    const { port, repo, state, srv } = await start({ llm: new RuleBasedLlm() });
    const c = await connect(port);
    c.setup();
    for (const line of ["my name is Pat Example", "one zero zero zero one", "2019 Honda Civic", "two drivers", "yes I am insured"]) {
      c.prompt(line);
      expect(await c.next("text")).toMatchObject({ type: "text", last: true });
    }
    c.prompt("yes that is right");
    const end = await c.next("end");
    expect(JSON.parse(String(end.handoffData))).toMatchObject({ end: "done", why: "finished" });

    const [lead] = repo.leads();
    expect(lead).toMatchObject({ phone: "+15555550100", fullName: "Pat Example", zipCode: "10001", vehicleYear: "2019", vehicleMake: "Honda", vehicleModel: "Civic", driverCount: "2", currentlyInsured: "yes", status: "complete", transferred: false });
    expect(lead.leadNumber).toBe("400001");

    // Twilio now calls the action URL: the closing words are spoken by our own TwiML, then the call ends.
    expect(state.get(SID).aiOutcome).toMatchObject({ end: "done" });
    const done = parseTwiml(await postAs(srv, SID, "/ai/quote/done", { SessionStatus: "ended" }));
    expect(done.says.join(" ")).toContain("reference number is 4 0 0, 0 0 1");
    expect(done.hangup).toBe(true);
  });

  it("the details collected are available to a person: a transfer whispers them to the agent", async () => {
    const { port, repo, state, srv } = await start({ llm: new RuleBasedLlm() });
    const c = await connect(port);
    c.setup();
    c.prompt("my name is Pat Example");
    await c.next("text");
    c.prompt("one zero zero zero one");
    await c.next("text");
    c.prompt("can I talk to a real person");
    const end = await c.next("end");
    expect(JSON.parse(String(end.handoffData))).toMatchObject({ end: "transfer", why: "caller_asked" });
    expect(repo.leads()[0]).toMatchObject({ fullName: "Pat Example", zipCode: "10001", status: "partial", transferred: true });

    // The action URL sends the caller on to the existing agent line, which reads the note out to the agent.
    const next = parseTwiml(await postAs(srv, SID, "/ai/quote/done"));
    expect(next.says.join(" ")).toContain("Connecting you to an agent");
    expect(next.redirect).toBe("/svc/handoff?reason=quote_request&back=main");
    const hand = parseTwiml(await postAs(srv, SID, "/svc/handoff?reason=quote_request&back=main"));
    expect(hand.redirect).toBe("/svc/handoff/hold");
    expect(state.get(SID).handoff).toMatchObject({ reason: "quote_request", urgent: false });
    const whisper = parseTwiml(await postAs(srv, SID, `/svc/handoff/whisper?c=${SID}`)).says.join(" ");
    expect(whisper).toContain("They were using the automated quote line.");
    expect(whisper).toContain("Name Pat Example. Zip 1 0 0, 0 1.");
    expect(whisper).toContain("Still missing: vehicle year");
  });

  it("an emergency is urgent all the way to the agent's whisper", async () => {
    const { port, state, srv } = await start({ llm: new ScriptedLlm([]) });
    const c = await connect(port);
    c.setup();
    c.prompt("there was a crash and my son is hurt");
    await c.next("end");
    expect(state.get(SID).aiOutcome).toMatchObject({ end: "transfer", urgent: true, why: "emergency" });
    const next = parseTwiml(await postAs(srv, SID, "/ai/quote/done"));
    expect(next.says.join(" ")).toContain("9 1 1");
    await postAs(srv, SID, "/svc/handoff?reason=quote_request&back=main");
    expect(state.get(SID).handoff).toMatchObject({ reason: "quote_request", urgent: true });
    const whisper = parseTwiml(await postAs(srv, SID, `/svc/handoff/whisper?c=${SID}`)).says.join(" ");
    expect(whisper).toContain("Urgent. The caller said someone may be hurt.");
  });

  it("pressing 0 goes to a person", async () => {
    const { port, state } = await start({ llm: new ScriptedLlm([]) });
    const c = await connect(port);
    c.setup();
    c.send({ type: "dtmf", digit: "0" });
    await c.next("end");
    expect(state.get(SID).aiOutcome).toMatchObject({ end: "transfer", why: "caller_asked" });
  });

  it("a model failure hands the caller to a person instead of dropping the call", async () => {
    const { port, state } = await start({ llm: new ScriptedLlm([new Error("Gemini HTTP 429")]) });
    const c = await connect(port);
    c.setup();
    c.prompt("I want a quote");
    await c.next("end");
    expect(state.get(SID).aiOutcome).toMatchObject({ end: "transfer", why: "ai_error" });
  });

  it("a model that says something forbidden is never heard", async () => {
    const { port } = await start({ llm: new ScriptedLlm([say("Great news, your claim will be paid in full!")]) });
    const c = await connect(port);
    c.setup();
    c.prompt("will my claim be paid");
    const t = await c.next("text");
    expect(String(t.token)).toContain("not able to promise");
    expect(String(t.token)).not.toContain("paid in full");
  });

  it("the model's words go out only as plain text messages, never as anything else", async () => {
    const { port } = await start({ llm: new ScriptedLlm([calls(call("save_detail", { field: "full_name", value: "Pat Example" })), say("What is your zip code?")]) });
    const c = await connect(port);
    c.setup();
    c.prompt("Pat Example");
    expect(await c.next("text")).toEqual({ type: "text", token: "What is your zip code?", last: true });
  });
});

describe("silence and bad input", () => {
  it("a silent caller is asked once, then the call is ended politely", async () => {
    const { port, state } = await start({ llm: new RuleBasedLlm(), relay: { idleMs: 60 } });
    const c = await connect(port);
    c.setup();
    expect(await c.next("text")).toMatchObject({ token: "Are you still there?" });
    await c.next("end");
    expect(state.get(SID).aiOutcome).toMatchObject({ end: "done", why: "silence" });
  });

  it("speaking resets the silence timer", async () => {
    const { port, state } = await start({ llm: new RuleBasedLlm(), relay: { idleMs: 200 } });
    const c = await connect(port);
    c.setup();
    c.prompt("my name is Pat Example");
    await c.next("text");
    expect(state.get(SID).aiOutcome).toBeUndefined();
  });

  it("a conversation that goes on too long is passed to a person", async () => {
    const { port, state } = await start({ llm: new RuleBasedLlm(), relay: { maxCallMs: 50 } });
    const c = await connect(port);
    c.setup();
    await c.next("end");
    expect(state.get(SID).aiOutcome).toMatchObject({ end: "transfer", why: "call_too_long" });
  });

  it("partial transcripts are ignored; only the finished sentence is answered", async () => {
    const llm = new ScriptedLlm([say("What year is the car?")]);
    const { port } = await start({ llm });
    const c = await connect(port);
    c.setup();
    c.prompt("my na", false);
    c.prompt("my name is Pat");
    await c.next("text");
    expect(llm.requests).toHaveLength(1);
  });

  it("a setup with a bad call id closes the connection", async () => {
    const { port } = await start({ llm: new RuleBasedLlm() });
    const c = await connect(port);
    c.send({ type: "setup", callSid: "not-a-call-id", from: "+15555550100" });
    await new Promise((r) => c.ws.once("close", r));
  });

  it("messages before setup are ignored, garbage is survived, and too much garbage ends the session", async () => {
    const llm = new ScriptedLlm([]);
    const { port } = await start({ llm });
    const c = await connect(port);
    c.prompt("hello before setup");
    c.ws.send("not json");
    c.ws.send("[1,2,3]");
    c.ws.send(JSON.stringify({ type: "mystery" }));
    c.send({ type: "interrupt", utteranceUntilInterrupt: "x", durationUntilInterruptMs: 5 });
    c.send({ type: "error", description: "something" });
    await new Promise((r) => setTimeout(r, 50));
    expect(llm.requests).toHaveLength(0);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    for (let i = 0; i < 10; i++) c.ws.send("garbage");
    await new Promise((r) => c.ws.once("close", r));
  });

  it("a hang-up mid-conversation saves nothing", async () => {
    const { port, repo } = await start({ llm: new RuleBasedLlm() });
    const c = await connect(port);
    c.setup();
    c.prompt("my name is Pat Example");
    await c.next("text");
    c.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(repo.leads()).toHaveLength(0);
  });
});

describe("the AI line in the call flow", () => {
  it("with the AI on, pressing 4 goes to the AI line, which connects Twilio's voice layer to our WebSocket", async () => {
    const { srv } = await start({ llm: new RuleBasedLlm() });
    const c = new Caller(srv);
    await c.dial();
    await c.press("4"); // the caller helper follows the redirect to /ai/quote by itself
    const xml = c.last.raw;
    expect(xml).toContain("<Connect");
    expect(xml).toContain('url="wss://ivr.example.com/ai/relay"');
    expect(xml).toContain('action="/ai/quote/done"');
    expect(xml).toContain("automated assistant");
    expect(xml).toContain('dtmfDetection="true"');
  });

  it("with the AI off, pressing 4 still says coming soon", async () => {
    const { srv } = await start({});
    const c = new Caller(srv);
    await c.dial();
    await c.press("4");
    expect(c.hearsAll).toContain("Quote service will be available soon");
  });

  it("the AI routes need Twilio's signature like everything else", async () => {
    const { srv } = await start({ llm: new RuleBasedLlm() });
    const res = await fetch(`${srv.base}/ai/quote`, { method: "POST", body: "CallSid=x" });
    expect(res.status).toBe(403);
  });

  it("when the AI link never worked, the caller goes to a person rather than silence", async () => {
    const { srv } = await start({ llm: new RuleBasedLlm() });
    const next = parseTwiml(await postAs(srv, "CA" + "cd".repeat(16), "/ai/quote/done", { SessionStatus: "failed" }));
    expect(next.says.join(" ")).toContain("not available right now");
    expect(next.redirect).toBe("/svc/handoff?reason=quote_request&back=main");
  });
});

/** POST to our server signed as Twilio, as a particular call. Returns the TwiML. */
async function postAs(srv: TestServer, callSid: string, path: string, extra: Record<string, string> = {}) {
  const params = { CallSid: callSid, From: "+15555550100", ...extra };
  const sig = twilio.getExpectedTwilioSignature(baseConfig.authToken, baseConfig.publicBaseUrl + path, params);
  const res = await fetch(srv.base + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    body: new URLSearchParams(params).toString(),
  });
  expect(res.status).toBe(200);
  return res.text();
}
