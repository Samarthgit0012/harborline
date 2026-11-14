import { afterEach, describe, expect, it } from "vitest";
import { AGENT, CLOSED, OPEN, Caller, baseConfig, startApp, type TestServer } from "./caller.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import { CallQueue, QueueStats, whisperText, type HandoffContext } from "../src/services/queue.js";
import { loadConfig } from "../src/config.js";
import { buildHarborlineFlow, SERVICE_NAMES } from "../src/flows/harborline.js";
import { validateFlow } from "../src/flows/validate.js";

const ALEX = "+15555550100"; // recognised, dob 03/14/1985, policy 10000001
const OTHER = "+15555550199";
const SEC = 1000;
const MIN = 60 * SEC;

let srv: TestServer;
let repo: SqliteRepo;
let queue: CallQueue;
let t0 = OPEN.getTime();
const tick = (ms: number) => void (t0 += ms);

async function boot(opts: { at?: Date; config?: Partial<typeof baseConfig> & { holdMusicUrl?: string } } = {}) {
  t0 = (opts.at ?? OPEN).getTime();
  repo = new SqliteRepo(":memory:");
  const clock = () => new Date(t0);
  queue = new CallQueue(() => t0);
  srv = await startApp({ clock, repo, queue }, { ...baseConfig, ...opts.config });
}
afterEach(() => srv?.close());

/** Dial in and ask for a person (key 0 at the main menu). */
const askForAgent = async (from = OTHER) => {
  const c = await new Caller(srv, from).dial();
  await c.press("0");
  return c;
};

describe("the waiting line (unit)", () => {
  const ctx = (o: Partial<HandoffContext> = {}): HandoffContext => ({ reason: "general", urgent: false, verified: false, queuedAt: 0, ...o });

  it("serves callers first come, first served", () => {
    let now = 0;
    const q = new CallQueue(() => now);
    q.join("A", ctx({ queuedAt: 0 }));
    now = 1000;
    q.join("B", ctx({ queuedAt: 1000 }));
    expect([q.position("A"), q.position("B")]).toEqual([1, 2]);
    expect(q.tryConnect("B")).toBe(false); // B is not first
    expect(q.tryConnect("A")).toBe(true);
    expect(q.tryConnect("B")).toBe(false); // the agent is now busy
    q.releaseAgent("A");
    expect(q.tryConnect("B")).toBe(true);
  });
  it("lets urgent callers jump the line, FIFO among equals", () => {
    const q = new CallQueue(() => 0);
    q.join("A", ctx({ queuedAt: 0 }));
    q.join("B", ctx({ queuedAt: 1 }));
    q.join("U1", ctx({ queuedAt: 2, urgent: true }));
    q.join("U2", ctx({ queuedAt: 3, urgent: true }));
    expect(["U1", "U2", "A", "B"].map((c) => q.position(c))).toEqual([1, 2, 3, 4]);
  });
  it("joining twice does nothing", () => {
    const q = new CallQueue(() => 0);
    q.join("A", ctx());
    q.join("A", ctx());
    expect(q.size()).toBe(1);
    expect(q.stats.offered).toBe(1);
  });
  it("sweeps callers who stopped checking in and counts them as abandoned", () => {
    let now = 0;
    const q = new CallQueue(() => now, { staleMs: 90_000 });
    q.join("A", ctx());
    q.join("B", ctx({ queuedAt: 1 }));
    now = 60_000;
    q.touch("B");
    now = 100_000; // A silent for 100 s, B for 40 s
    q.touch("B");
    expect(q.has("A")).toBe(false);
    expect(q.has("B")).toBe(true);
    expect(q.stats.abandoned).toBe(1);
  });
  it("a caller checking in can never sweep themselves", () => {
    let now = 0;
    const q = new CallQueue(() => now, { staleMs: 90_000 });
    q.join("A", ctx());
    now = 500_000;
    expect(q.touch("A")).toBe(true);
  });
  it("a swept caller who turns out to be alive gets their place back and the abandonment is taken back", () => {
    let now = 0;
    const q = new CallQueue(() => now, { staleMs: 90_000 });
    const a = ctx({ queuedAt: 0 });
    q.join("A", a);
    q.join("B", ctx({ queuedAt: 5 }));
    now = 100_000;
    q.touch("B"); // sweeps A
    expect(q.stats.abandoned).toBe(1);
    q.rejoin("A", a);
    expect(q.position("A")).toBe(1); // original place, not the back
    expect(q.stats.abandoned).toBe(0);
    expect(q.stats.offered).toBe(2); // not counted as a new arrival
  });
  it("frees an agent line whose 'call ended' report never arrived", () => {
    let now = 0;
    const q = new CallQueue(() => now, { agentLeaseMs: 30 * MIN });
    q.join("A", ctx());
    q.tryConnect("A");
    expect(q.agentFree()).toBe(false);
    now = 31 * MIN;
    expect(q.agentFree()).toBe(true);
  });
  it("only the call that holds the agent line can release it", () => {
    const q = new CallQueue(() => 0);
    q.join("A", ctx());
    q.tryConnect("A");
    q.releaseAgent("someone-else");
    expect(q.agentFree()).toBe(false);
  });
});

describe("the numbers a manager asks for", () => {
  it("computes ASA, AHT, abandonment rate and service level from known events", () => {
    const s = new QueueStats();
    s.offered = 10;
    s.abandoned = 2;
    for (const w of [5, 10, 20, 40]) s.recordConnected(w); // 3 of the 4 within 30 s
    for (const h of [100, 200, 300]) s.recordHandled(h);
    const x = s.summary(30);
    expect(x.abandonRate).toBeCloseTo(0.2);
    expect(x.asaSec).toBeCloseTo(18.75);
    expect(x.ahtSec).toBe(200);
    expect(x.serviceLevel).toBeCloseTo(0.3); // 3 within 30 s out of 10 OFFERED (not out of 4 connected)
  });
  it("never divides by zero", () => {
    expect(new QueueStats().summary()).toMatchObject({ abandonRate: 0, asaSec: 0, ahtSec: 0, serviceLevel: 0 });
  });
});

describe("what the agent hears", () => {
  it("unverified caller with nothing known", () => {
    expect(whisperText({ reason: "general", urgent: false, verified: false, queuedAt: 0 })).toBe("Harborline call. Caller not verified.");
  });
  it("verified caller gives the policy ending, never the whole number", () => {
    const w = whisperText({ reason: "general", urgent: false, verified: true, policyLast4: "0001", queuedAt: 0 });
    expect(w).toContain("Verified caller, policy ending 0 0 0 1.");
    expect(w).not.toContain("10000001");
  });
  it("a claimed (unverified) policy is labelled as such, and an injury claim is announced first", () => {
    const w = whisperText({ reason: "claim_injury", urgent: true, verified: false, policyLast4: "0002", claimNumber: "100002", queuedAt: 0 });
    expect(w).toBe("Harborline call. Urgent. Injury claim. Caller not verified. They gave a policy ending 0 0 0 2. Claim 1 0 0, 0 0 2 was just reported on this call.");
  });
  it("copes with no context at all", () => {
    expect(whisperText(undefined)).toContain("No details");
  });
});

describe("asking for a person", () => {
  it("empty line and a free agent: rings the agent at once, with a whisper and a report-back URL", async () => {
    await boot();
    const c = await askForAgent();
    expect(c.hearsAll).toContain("Please hold while I connect you.");
    expect(c.last.dial).toBe(AGENT);
    expect(c.last.whisperUrl).toContain("/svc/handoff/whisper?c=");
    expect(c.last.dialAction).toBe("/svc/handoff/dialdone");
  });
  it("the whisper tells the agent what the IVR already knows (a caller who logged in)", async () => {
    await boot();
    const c = await new Caller(srv, ALEX).dial();
    await c.press("3");
    await c.press("03141985"); // log in via billing
    await c.press("9"); // back to the main menu
    await c.press("0");
    expect(c.last.dial).toBe(AGENT);
    const heard = await c.whisper();
    expect(heard).toContain("Verified caller, policy ending 0 0 0 1");
    expect(heard).not.toContain("Caller not verified");
  });
  it("the whisper for a stranger says not verified", async () => {
    await boot();
    const c = await askForAgent();
    expect(await c.whisper()).toBe("Harborline call. Caller not verified.");
  });
  it("a forged or malformed whisper request gets the generic whisper, not an error", async () => {
    await boot();
    const c = await new Caller(srv).dial();
    await c.post("/svc/handoff/whisper?c=not-a-sid");
    expect(c.last.says.join(" ")).toContain("No details are available");
    await c.post("/svc/handoff/whisper");
    expect(c.last.says.join(" ")).toContain("No details are available");
  });
  it("the Dial report-back ends the call politely when the agent answered and finished", async () => {
    await boot();
    const c = await askForAgent();
    await c.dialDone("completed", 240);
    expect(c.hearsAll).toContain("Thank you for calling Harborline Insurance");
    expect(c.last.hangup).toBe(true);
    expect(queue.stats.summary().ahtSec).toBe(240);
  });
  it("an unanswered agent line frees the agent and offers a call back or voicemail", async () => {
    await boot();
    const c = await askForAgent();
    await c.dialDone("no-answer");
    expect(c.hearsAll).toContain("no agent could take your call");
    expect(c.last.says.join(" ")).toContain("To request a call back, press 1. To leave a voicemail, press 2.");
    expect(queue.agentFree()).toBe(true);
    expect(queue.stats.noAnswer).toBe(1);
  });
  it("with no agent number configured, says so and hangs up (no line to wait in)", async () => {
    await boot({ config: { agentNumber: undefined } });
    const c = await new Caller(srv).dial();
    await c.press("0");
    expect(c.hearsAll).toContain("no agents are available");
    expect(c.last.hangup).toBe(true);
    expect(queue.size()).toBe(0);
  });
});

describe("waiting in line", () => {
  it("a second caller waits, hears their place, and is offered a call back", async () => {
    await boot();
    await askForAgent(); // takes the agent
    const b = await askForAgent();
    expect(b.last.dial).toBeUndefined();
    expect(b.hearsAll).toContain("You are next in line.");
    expect(b.last.says.join(" ")).toContain("To get a call back instead of waiting, press 1");
    expect(b.last.gatherAction).toBe("/svc/handoff/hold/in");
    const c = await askForAgent();
    expect(c.hearsAll).toContain("You are number 2 in line.");
  });
  it("plays hold music when HOLD_MUSIC_URL is set, and pauses otherwise", async () => {
    await boot({ config: { holdMusicUrl: "https://example.com/hold.mp3" } });
    await askForAgent();
    const b = await askForAgent();
    expect(b.last.playUrl).toBe("https://example.com/hold.mp3");
    await srv.close();
    await boot();
    await askForAgent();
    const b2 = await askForAgent();
    expect(b2.last.playUrl).toBeUndefined();
  });
  it("rejects hold music that is not https", () => {
    expect(() => loadConfig({ TWILIO_AUTH_TOKEN: "x", HOLD_MUSIC_URL: "http://example.com/a.mp3" })).toThrow(/https/);
    expect(() => loadConfig({ TWILIO_AUTH_TOKEN: "x", HOLD_MUSIC_URL: "not a url" })).toThrow(/https/);
    expect(loadConfig({ TWILIO_AUTH_TOKEN: "x", HOLD_MUSIC_URL: "https://example.com/a.mp3" }).holdMusicUrl).toBe("https://example.com/a.mp3");
  });
  it("the next caller is connected when the agent frees up, and others keep waiting", async () => {
    await boot();
    const a = await askForAgent();
    const b = await askForAgent();
    const c = await askForAgent();
    tick(20 * SEC);
    await b.holdAgain();
    expect(b.last.dial).toBeUndefined(); // agent still busy
    await a.dialDone("completed", 60);
    tick(20 * SEC);
    await c.holdAgain();
    expect(c.last.dial).toBeUndefined(); // C is not first: B is
    await b.holdAgain();
    expect(b.last.dial).toBe(AGENT);
    await c.holdAgain();
    expect(c.hearsAll).toContain("You are next in line.");
  });
  it("an injury claim jumps the line", async () => {
    await boot();
    await askForAgent(); // agent busy
    const waiting = await askForAgent();
    const urgent = await new Caller(srv).dial();
    await urgent.post("/svc/handoff?reason=claim_injury");
    await urgent.settle();
    expect(urgent.hearsAll).toContain("You are next in line."); // ahead of `waiting`
    await waiting.holdAgain();
    expect(waiting.hearsAll).toContain("You are number 2 in line.");
  });
  it("a caller who hangs up is dropped from the line and counted as abandoned", async () => {
    await boot();
    await askForAgent();
    await askForAgent(); // B, then hangs up (never polls again)
    tick(2 * MIN);
    const c = await askForAgent();
    expect(c.hearsAll).toContain("You are next in line."); // B is gone
    expect(queue.stats.abandoned).toBe(1);
  });
  it("after the maximum wait, stops offering the line and offers call back or voicemail", async () => {
    await boot();
    await askForAgent();
    const b = await askForAgent();
    for (let i = 0; i < 31; i++) {
      tick(20 * SEC);
      await b.holdAgain();
      if (b.last.gatherAction === "/svc/handoff/fallback/in") break;
    }
    expect(b.hearsAll).toContain("Our wait is longer than expected.");
    expect(b.last.says.join(" ")).toContain("To request a call back, press 1");
    expect(queue.has(b.callSid)).toBe(false);
    expect(queue.stats.timedOut).toBe(1);
  });
  it("if the office closes while someone waits, they are moved to voicemail", async () => {
    await boot({ at: new Date("2026-11-17T22:55:00Z") }); // Tue 5:55 pm New York
    await askForAgent();
    const b = await askForAgent();
    tick(10 * MIN); // 6:05 pm
    await b.holdAgain();
    expect(b.hearsAll).toContain("Our office has just closed.");
    expect(b.last.recordAction).toBeDefined();
  });
  it("a forged hold request from a call that never asked for a person goes back to the menu", async () => {
    await boot();
    const c = await new Caller(srv).dial();
    await c.post("/svc/handoff/hold");
    expect(c.last.redirect).toBe("/ivr/main");
    expect(queue.size()).toBe(0);
  });
  it("a replayed hold request cannot put a connected caller back in the line", async () => {
    await boot();
    const a = await askForAgent(); // connected to the agent
    await a.post("/svc/handoff/hold");
    expect(a.last.redirect).toBe("/ivr/main");
    expect(queue.size()).toBe(0);
  });
  it("a replayed hold request cannot put a caller who chose a call back back in the line", async () => {
    await boot();
    await askForAgent("+15555550177");
    const b = await askForAgent(ALEX);
    await b.press("1");
    await b.press("1"); // ticket made, left the line
    await b.post("/svc/handoff/hold");
    expect(b.last.redirect).toBe("/ivr/main");
    expect(queue.size()).toBe(0);
  });
  it("asking twice keeps one place in line", async () => {
    await boot();
    await askForAgent();
    const b = await askForAgent();
    await b.post("/svc/handoff");
    await b.settle();
    expect(queue.size()).toBe(1);
    expect(queue.stats.offered).toBe(2);
  });
});

describe("call back instead of waiting", () => {
  async function waitingCaller(from = OTHER) {
    await askForAgent("+15555550177"); // someone else holds the agent
    const b = await askForAgent(from);
    return b;
  }
  it("press 1 while waiting, confirm the number you are calling from: ticket created, left the line", async () => {
    await boot();
    const b = await waitingCaller(ALEX);
    await b.press("1");
    expect(b.last.says.join(" ")).toContain("ending in 0 1 0 0");
    await b.press("1");
    expect(b.hearsAll).toContain("Your reference number is 2 0 0, 0 0 1.");
    expect(b.last.hangup).toBe(true);
    expect(queue.has(b.callSid)).toBe(false);
    expect(queue.stats.callbacks).toBe(1);
    expect(repo.openTickets()).toEqual([
      expect.objectContaining({ kind: "callback", phone: ALEX, reason: "general", policyNumber: null, policyVerified: false, urgent: false }),
    ]);
  });
  it("a logged-in caller's ticket carries the verified policy; an anonymous one never does", async () => {
    await boot();
    const c = await new Caller(srv, ALEX).dial();
    await c.press("3");
    await c.press("03141985");
    await c.press("9");
    await askForAgent("+15555550177"); // hold the agent
    await c.press("0");
    await c.press("1");
    await c.press("1");
    expect(repo.openTickets()[0]).toMatchObject({ policyNumber: "10000001", policyVerified: true });
  });
  it("a different number can be typed (ten digits, US area code)", async () => {
    await boot();
    const b = await waitingCaller();
    await b.press("1");
    await b.press("2");
    await b.press("5555550188");
    expect(b.hearsAll).toContain("number ending in 0 1 8 8");
    expect(repo.openTickets()[0].phone).toBe("+15555550188");
  });
  it("a bad typed number is re-asked twice, then we take a voicemail instead (never a dead end)", async () => {
    await boot();
    const b = await waitingCaller();
    await b.press("1");
    await b.press("2");
    await b.press("0123456789"); // area code cannot start with 0
    expect(b.hearsAll).toContain("not a valid phone number");
    await b.press("1234567890");
    await b.press("0000000000");
    expect(b.last.recordAction).toBeDefined();
    expect(repo.openTickets()[0].kind).toBe("voicemail");
  });
  it("a withheld caller ID goes straight to asking for a number", async () => {
    await boot();
    const b = await waitingCaller("anonymous");
    await b.press("1");
    expect(b.last.says.join(" ")).toContain("enter the ten digit phone number");
  });
  it("a replayed confirmation does not create a second ticket", async () => {
    await boot();
    const b = await waitingCaller(ALEX);
    await b.press("1");
    const action = b.last.gatherAction!;
    await b.press("1");
    await b.post(action, { Digits: "1" });
    expect(repo.openTickets()).toHaveLength(1);
  });
  it("limits requests per number: the fourth in an hour is not queued", async () => {
    await boot();
    for (let i = 0; i < 3; i++) {
      const c = await new Caller(srv, ALEX).dial();
      await c.post("/svc/handoff/callback");
      await c.settle();
      await c.press("1");
    }
    expect(repo.openTickets()).toHaveLength(3);
    const d = await new Caller(srv, ALEX).dial();
    await d.post("/svc/handoff/callback");
    await d.settle();
    await d.press("1");
    expect(d.hearsAll).toContain("already have several call back requests");
    expect(repo.openTickets()).toHaveLength(3);
  });
  it("cannot be used to flood one victim's number from many callers", async () => {
    await boot();
    for (let i = 0; i < 4; i++) {
      const c = await new Caller(srv, `+1555555020${i}`).dial();
      await c.post("/svc/handoff/callback");
      await c.settle();
      await c.press("2");
      await c.press("5555550777");
    }
    expect(repo.openTickets().filter((t) => t.phone === "+15555550777")).toHaveLength(3);
  });
});

describe("after hours", () => {
  it("key 1 on the closed menu takes a message, and the ticket exists before the recording starts", async () => {
    await boot({ at: CLOSED });
    const c = await new Caller(srv, ALEX).dial();
    expect(c.hearsAll).toContain("To leave a message for a call back, press 1");
    await c.press("1");
    expect(c.hearsAll).toContain("Your reference number is 2 0 0, 0 0 1.");
    expect(c.last.recordAction).toBe("/svc/voicemail/done");
    expect(repo.openTickets()[0]).toMatchObject({ kind: "voicemail", phone: ALEX, recordingSid: null }); // saved BEFORE they speak
    await c.record("RE" + "b".repeat(32));
    expect(repo.openTickets()[0].recordingSid).toBe("RE" + "b".repeat(32));
    expect(c.last.hangup).toBe(true);
  });
  it("a forged RecordingSid is ignored", async () => {
    await boot({ at: CLOSED });
    const c = await new Caller(srv, ALEX).dial();
    await c.press("1");
    await c.record("../../etc/passwd");
    expect(repo.openTickets()[0].recordingSid).toBeNull();
  });
  it("silence during the recording still leaves a callback request", async () => {
    await boot({ at: CLOSED });
    const c = await new Caller(srv, ALEX).dial();
    await c.press("1");
    await c.silence();
    expect(repo.openTickets()).toHaveLength(1);
    expect(c.last.hangup).toBe(true);
  });
  it("asking for an agent after hours goes to voicemail, not the line", async () => {
    await boot({ at: CLOSED });
    const c = await new Caller(srv, ALEX).dial();
    await c.post("/svc/handoff");
    await c.settle();
    expect(c.hearsAll).toContain("Our agents are not available right now.");
    expect(c.last.recordAction).toBeDefined();
    expect(queue.size()).toBe(0);
  });
});

describe("injury claims reach a person first", () => {
  it("after the recording the caller goes ahead of the line, and the whisper carries the claim", async () => {
    await boot();
    const first = await askForAgent("+15555550177"); // someone is already on the agent line
    const waiting = await askForAgent("+15555550178");
    const c = await new Caller(srv, OTHER).dial();
    await c.press("2");
    await c.press("1");
    await c.press("10000002");
    await c.press("11102026");
    await c.press("1");
    await c.press("1"); // injured
    await c.record();
    expect(c.hearsAll).toContain("I am connecting you to an agent now");
    expect(c.hearsAll).toContain("You are next in line."); // ahead of `waiting`
    expect(queue.position(waiting.callSid)).toBe(2);

    await first.dialDone("completed", 30);
    tick(20 * SEC);
    await c.holdAgain();
    expect(c.last.dial).toBe(AGENT);
    const heard = await c.whisper();
    expect(heard).toContain("Urgent. Injury claim.");
    expect(heard).toContain("Caller not verified. They gave a policy ending 0 0 0 2.");
    expect(heard).toMatch(/Claim 1 0 0, 0 0 \d was just reported on this call/);
  });
});

describe("safety and privacy", () => {
  it("never logs a full phone number", async () => {
    await boot();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      const b = await askForAgent(ALEX);
      await b.dialDone("no-answer");
      await b.press("1");
      await b.press("1");
    } finally {
      console.log = orig;
    }
    const all = lines.join("\n");
    expect(all).toContain("ticket_created");
    expect(all).not.toContain("5555550100");
  });
  it("the Harborline flow still validates, and the agent and voicemail steps count as ways to end a call", () => {
    expect(validateFlow(buildHarborlineFlow({ agentNumber: AGENT }), SERVICE_NAMES)).toEqual([]);
    const f = buildHarborlineFlow({ agentNumber: AGENT });
    // an onGiveUp that returned to a menu through a normal service would still be rejected
    const bad = structuredClone(f);
    (bad.nodes.main as any).onGiveUp = { type: "service", name: "policy", back: "main" };
    expect(validateFlow(bad, SERVICE_NAMES).join()).toContain("onGiveUp must end the call");
  });
});
