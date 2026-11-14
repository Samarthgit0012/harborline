import { describe, it, expect, afterEach } from "vitest";
import { AGENT, CLOSED, OPEN, Caller, startApp, type TestServer } from "./caller.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import type { SmsSender } from "../src/services/sms.js";

let srv: TestServer;
let repo: SqliteRepo;
let now = OPEN;
const sent: { to: string; body: string }[] = [];
const fakeSms: SmsSender = { send: async (to, body) => void sent.push({ to, body }) };

async function boot(at = OPEN, sms: SmsSender = fakeSms) {
  now = at;
  sent.length = 0;
  repo = new SqliteRepo(":memory:");
  srv = await startApp({ clock: () => now, sms, repo });
}
afterEach(() => srv?.close());

const ALEX = "+15555550100"; // recognised caller ID, dob 03/14/1985
const JORDAN_PHONE = "+15555550101";
const UNKNOWN = "+15555550199";

async function login(c: Caller, key: string) {
  await c.press(key); // main menu key
  await c.press("03141985");
  return c;
}

describe("account read-backs (after login)", () => {
  it("billing reads the balance and the past-due date naturally", async () => {
    await boot();
    const c = await login(await new Caller(srv, ALEX).dial(), "3");
    expect(c.hearsAll).toContain("Your balance is one thousand two hundred four dollars and fifty cents.");
    expect(c.hearsAll).toContain("due on November first, twenty twenty-six and is past due");
  });

  it("billing says 'no balance due' when the balance is zero", async () => {
    await boot();
    const c = await new Caller(srv, JORDAN_PHONE).dial();
    await c.press("3");
    await c.press("07021990");
    expect(c.hearsAll).toContain("You have no balance due.");
    expect(c.hearsAll).toContain("eighty-nine dollars is due on December fifteenth, twenty twenty-six");
  });

  it("pressing 1 repeats, 9 returns to the main menu, and the caller is not asked to log in again", async () => {
    await boot();
    const c = await login(await new Caller(srv, ALEX).dial(), "3");
    await c.press("1");
    expect(c.hearsAll.match(/Your balance is/g)!.length).toBe(2);
    expect(c.hearsAll.match(/verify your identity|date of birth/g)!.length).toBe(1);
    await c.press("9");
    expect(c.last.gatherAction).toBe("/ivr/main/input");
  });

  it("silence on the read-back menu eventually returns to the main menu", async () => {
    await boot();
    const c = await login(await new Caller(srv, ALEX).dial(), "3");
    await c.silence();
    await c.silence();
    await c.silence();
    expect(c.hearsAll).toContain("Returning to the main menu");
    expect(c.last.gatherAction).toBe("/ivr/main/input");
  });

  it("logging in once covers the other protected screens in the same call", async () => {
    await boot();
    const c = await login(await new Caller(srv, ALEX).dial(), "3");
    await c.press("9");
    await c.press("1"); // policy summary: must NOT ask to log in again
    expect(c.hearsAll).toContain("Your auto policy ending in 0 0 0 1 is active.");
    expect(c.hearsAll.match(/date of birth/g)!.length).toBe(1);
  });

  it("claim status reads the latest claim", async () => {
    await boot();
    const c = await new Caller(srv, ALEX).dial();
    await c.press("2"); // claims menu
    await c.press("2"); // claim status
    await c.press("03141985");
    expect(c.hearsAll).toContain("one claim on file");
    expect(c.hearsAll).toContain("claim number 1 0 0, 0 0 1, was reported on October twenty-first, twenty twenty-six and is in review");
    expect(c.last.gatherAction).toBe("/ivr/main/input");
  });

  it("claim status with no claims says so", async () => {
    await boot();
    const c = await new Caller(srv, JORDAN_PHONE).dial();
    await c.press("2");
    await c.press("2");
    await c.press("07021990");
    expect(c.hearsAll).toContain("We do not have any claims on file");
  });
});

describe("text me my ID card", () => {
  it("texts the number ON FILE, not the number calling in", async () => {
    await boot();
    const c = await new Caller(srv, UNKNOWN).dial(); // caller ID is NOT Jordan's
    await c.press("1");
    await c.press("10000002");
    await c.press("07021990");
    await c.press("2");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(JORDAN_PHONE);
    expect(sent[0].body).toContain("policy ending 0002");
    expect(sent[0].body).not.toContain("10000002"); // the full policy number is not put in a text
    expect(c.hearsAll).toContain("texted your ID card to the phone number we have on file, ending in 0 1 0 1");
    expect(c.hearsAll).not.toContain("9 9"); // never reads back the caller's own number as the destination
  });

  it("if the text fails, the caller is told and the call carries on", async () => {
    await boot(OPEN, {
      send: async () => {
        throw new Error("boom");
      },
    });
    const c = await login(await new Caller(srv, ALEX).dial(), "1");
    await c.press("2");
    expect(c.hearsAll).toContain("could not send the text message");
    expect(c.last.gatherAction).toBe("/ivr/main/input");
  });
});

describe("claims menu", () => {
  it("offers report, status and back, and 9 returns to the main menu", async () => {
    await boot();
    const c = await new Caller(srv, ALEX).dial();
    await c.press("2");
    expect(c.last.says[0]).toContain("To report a new claim, press 1");
    await c.press("9");
    expect(c.last.gatherAction).toBe("/ivr/main/input");
  });
});

/** Walk the whole claim-intake path from the claims menu. */
async function reportClaim(c: Caller, answers: { policy?: string; date: string; type: string; injured: string }) {
  await c.press("2"); // claims menu
  await c.press("1"); // report a claim
  if (c.last.gatherAction?.includes("fnol/policy")) await c.press(answers.policy ?? "");
  await c.press(answers.date);
  await c.press(answers.type);
  await c.press(answers.injured);
  return c;
}

describe("first notice of loss", () => {
  it("opens with the safety message", async () => {
    await boot();
    const c = await new Caller(srv, UNKNOWN).dial();
    await c.press("2");
    await c.press("1");
    expect(c.heard.at(-2)).toContain("dial 9 1 1");
    expect(c.hearsAll).toContain("will be recorded");
  });

  it("an unauthenticated caller can report a claim, which lands in the database as unverified", async () => {
    await boot();
    const c = await reportClaim(await new Caller(srv, UNKNOWN).dial(), {
      policy: "10000002",
      date: "11102026",
      type: "3",
      injured: "2",
    });
    expect(c.hearsAll).toContain("Your claim reference number is 1 0 0, 0 0 2.");
    expect(c.last.recordAction).toContain("/svc/fnol/recorded");

    const claim = repo.claimsFor("10000002")[0];
    expect(claim).toMatchObject({
      claimNumber: "100002",
      policyNumber: "10000002",
      policyVerified: false,
      lossDate: "2026-11-10",
      lossType: "theft",
      injuries: "no",
      urgent: false,
      callbackPhone: UNKNOWN,
      status: "received",
      recordingSid: null,
    });
  });

  it("an authenticated caller skips the policy question and the claim is marked verified", async () => {
    await boot();
    const c = await new Caller(srv, ALEX).dial();
    await c.press("3"); // log in through billing first
    await c.press("03141985");
    await c.press("9");
    await c.press("2");
    await c.press("1");
    expect(c.last.gatherAction).toContain("/svc/fnol/date"); // no policy-number prompt
    await c.press("11152026");
    await c.press("1");
    await c.press("2");
    expect(repo.claimsFor("10000001")[0]).toMatchObject({ policyVerified: true, lossType: "auto" });
  });

  it("the voice description is attached to the claim after the recording", async () => {
    await boot();
    const c = await reportClaim(await new Caller(srv, UNKNOWN).dial(), { policy: "10000002", date: "11102026", type: "1", injured: "2" });
    expect(repo.claimsFor("10000002")[0].recordingSid).toBeNull();
    await c.record("RE" + "b".repeat(32));
    expect(repo.claimsFor("10000002")[0].recordingSid).toBe("RE" + "b".repeat(32));
    expect(c.hearsAll).toContain("Your claim has been recorded");
    expect(c.last.gatherAction).toBe("/ivr/main/input");
  });

  it("a caller who hangs up before the recording still has a claim and a reference number", async () => {
    await boot();
    await reportClaim(await new Caller(srv, UNKNOWN).dial(), { policy: "10000002", date: "11102026", type: "1", injured: "2" });
    // ...caller hangs up here: no recording request is ever made.
    expect(repo.claimsFor("10000002")).toHaveLength(1);
  });

  it("silence during the recording still ends politely", async () => {
    await boot();
    const c = await reportClaim(await new Caller(srv, UNKNOWN).dial(), { policy: "", date: "11102026", type: "1", injured: "2" });
    await c.silence();
    expect(c.hearsAll).toContain("Your claim has been recorded");
  });

  it("injuries: tells them to call 911, flags the claim urgent, and (open) connects an agent after the recording", async () => {
    await boot(OPEN);
    const c = await reportClaim(await new Caller(srv, UNKNOWN).dial(), {
      policy: "10000002",
      date: "11102026",
      type: "1",
      injured: "1",
    });
    expect(c.hearsAll).toContain("hang up and do that now");
    expect(c.hearsAll).toContain("marking your claim as urgent");
    expect(repo.claimsFor("10000002")[0]).toMatchObject({ urgent: true, injuries: "yes" });
    await c.record();
    expect(c.hearsAll).toContain("connecting you to an agent now");
    expect(c.last.dial).toBe(AGENT);
  });

  it("injuries after hours: urgent flag is set but nobody is dialled", async () => {
    await boot(CLOSED);
    const c = await new Caller(srv, UNKNOWN).dial();
    await c.press("2"); // closed menu: report a claim
    await c.press("10000002");
    await c.press("11102026");
    await c.press("1");
    await c.press("1");
    expect(repo.claimsFor("10000002")[0].urgent).toBe(true);
    await c.record();
    expect(c.last.dial).toBeUndefined();
    expect(c.last.gatherAction).toBe("/ivr/closed/input"); // back to the after-hours menu
  });

  it("rejects a date in the future", async () => {
    await boot();
    const c = await new Caller(srv, UNKNOWN).dial();
    await c.press("2");
    await c.press("1");
    await c.press("");
    await c.press("12252026"); // after the test clock (2026-11-17)
    expect(c.hearsAll).toContain("not a valid date in the past");
    expect(c.last.gatherAction).toContain("/svc/fnol/date/in");
  });

  it("bad answers fall back to safe defaults and the claim is still created", async () => {
    await boot();
    const c = await new Caller(srv, UNKNOWN).dial();
    await c.press("2");
    await c.press("1");
    await c.press("10000002");
    for (let i = 0; i < 3; i++) await c.press("99999999"); // not a date (month 99) x3
    for (let i = 0; i < 3; i++) await c.press("9"); // not 1-4 x3
    for (let i = 0; i < 3; i++) await c.silence(); // no answer on injuries x3
    expect(repo.claimsFor("10000002")[0]).toMatchObject({ lossDate: null, lossType: "other", injuries: "unknown" });
  });

  it("replaying the create step does not create a second claim", async () => {
    await boot();
    const c = await reportClaim(await new Caller(srv, UNKNOWN).dial(), { policy: "10000002", date: "11102026", type: "1", injured: "2" });
    await c.post("/svc/fnol/create?back=main");
    await c.post("/svc/fnol/create?back=main");
    expect(repo.claimsFor("10000002")).toHaveLength(1);
  });

  it("a second claim in the same call gets its own number", async () => {
    await boot();
    const c = await reportClaim(await new Caller(srv, UNKNOWN).dial(), { policy: "10000002", date: "11102026", type: "1", injured: "2" });
    await c.record();
    await reportClaim(c, { policy: "10000002", date: "11112026", type: "2", injured: "2" });
    expect(repo.claimsFor("10000002")).toHaveLength(2);
  });

  it("a forged recording id is not stored", async () => {
    await boot();
    const c = await reportClaim(await new Caller(srv, UNKNOWN).dial(), { policy: "10000002", date: "11102026", type: "1", injured: "2" });
    await c.record("not-a-recording-id");
    expect(repo.claimsFor("10000002")[0].recordingSid).toBeNull();
  });
});
