import { describe, it, expect, afterEach, vi } from "vitest";
import { Caller, OPEN, startApp, type TestServer } from "./caller.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import type { SmsSender } from "../src/services/sms.js";

let srv: TestServer;
const sent: { to: string; body: string }[] = [];
const fakeSms: SmsSender = { send: async (to, body) => void sent.push({ to, body }) };

async function boot() {
  sent.length = 0;
  srv = await startApp({ clock: () => OPEN, sms: fakeSms });
  return srv;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await srv?.close();
});

// Seed data (src/services/policyRepo.ts):
//  Alex   10000001 dob 03/14/1985  phone +15555550100  auto, balance $1,204.50, past due, 1 claim
//  Jordan 10000002 dob 07/02/1990  phone +15555550101  home, no balance
//  Sam    10000003 + 10000004      dob 11/30/1978  phone +15555550102 (two policies on one number)
const ALEX = { phone: "+15555550100", dob: "03141985" };
const UNKNOWN = "+15555550199";

/** Dial, go to Policy (key 1), and arrive at the first auth prompt. */
async function callPolicy(from: string) {
  const c = await new Caller(srv, from).dial();
  await c.press("1");
  return c;
}

describe("recognition vs authentication", () => {
  it("a recognised number is asked only for the date of birth, and hears nothing private before it", async () => {
    await boot();
    const c = await callPolicy(ALEX.phone);
    expect(c.last.gatherAction).toContain("/svc/auth/dob");
    expect(c.hearsAll).not.toMatch(/premium|Alex|auto policy/);
    await c.press(ALEX.dob);
    expect(c.hearsAll).toContain("Your auto policy ending in 0 0 0 1 is active.");
    expect(c.hearsAll).toContain("one hundred forty-two dollars and fifty cents per month");
  });

  it("an unknown number is asked for the policy number first, then the date of birth", async () => {
    await boot();
    const c = await callPolicy(UNKNOWN);
    expect(c.last.gatherAction).toContain("/svc/auth/policy");
    await c.press("10000002");
    expect(c.last.gatherAction).toContain("/svc/auth/dob");
    await c.press("07021990");
    expect(c.hearsAll).toContain("Your home policy ending in 0 0 0 2 is active.");
  });

  it("a number shared by two policies is NOT auto-recognised (it is ambiguous)", async () => {
    await boot();
    const c = await callPolicy("+15555550102");
    expect(c.last.gatherAction).toContain("/svc/auth/policy");
  });

  it("a withheld number falls back to the policy number", async () => {
    await boot();
    const c = await callPolicy("anonymous");
    expect(c.last.gatherAction).toContain("/svc/auth/policy");
  });

  it("a malformed policy number is re-asked, then the caller is returned to the menu", async () => {
    await boot();
    const c = await callPolicy(UNKNOWN);
    await c.press("123");
    expect(c.hearsAll).toContain("eight digits");
    await c.press("123");
    await c.press("123");
    expect(c.hearsAll).toContain("trouble getting that");
    expect(c.last.gatherAction).toBe("/ivr/main/input");
  });
});

describe("wrong answers", () => {
  it("a wrong date of birth says it could not verify, and asks again", async () => {
    await boot();
    const c = await callPolicy(ALEX.phone);
    await c.press("01011990");
    expect(c.hearsAll).toContain("We could not verify that information.");
    expect(c.last.gatherAction).toContain("/svc/auth/dob");
    expect(c.hearsAll).not.toContain("premium");
  });

  it("three wrong answers in one call lock the call out and return to the menu", async () => {
    await boot();
    const c = await callPolicy(ALEX.phone);
    await c.press("01011990");
    await c.press("01011991");
    await c.press("01011992");
    expect(c.hearsAll).toContain("cannot verify you right now");
    expect(c.last.gatherAction).toBe("/ivr/main/input");
    // Even the CORRECT answer is refused for the rest of this call.
    await c.press("1");
    expect(c.hearsAll.match(/cannot verify you right now/g)!.length).toBe(2);
    expect(c.hearsAll).not.toContain("auto policy");
  });

  it("a locked number stays locked on a brand new call, even with the correct answer", async () => {
    await boot();
    const first = await callPolicy(ALEX.phone);
    for (const dob of ["01011990", "01011991", "01011992"]) await first.press(dob); // 3 failures
    const second = await callPolicy(ALEX.phone);
    await second.press("01011993");
    await second.press("01011994"); // 5th failure for this number: locked
    const third = await callPolicy(ALEX.phone);
    expect(third.hearsAll).toContain("cannot verify you right now");
    expect(third.hearsAll).not.toContain("auto policy");
  });

  it("many different numbers guessing ONE policy lock that policy, even for its owner", async () => {
    await boot();
    for (let i = 0; i < 5; i++) {
      const attacker = await callPolicy(`+1555555020${i}`);
      await attacker.press("10000002");
      await attacker.press("01011990"); // wrong
    }
    const owner = await callPolicy(UNKNOWN);
    await owner.press("10000002");
    // The owner is locked out too. That is the price of per-policy lockout (see lesson 6, threat model).
    expect(owner.hearsAll).toContain("cannot verify you right now");
    expect(owner.hearsAll).not.toContain("home policy");
  });

  it("a made-up policy number is indistinguishable from a real one with the wrong birthday", async () => {
    await boot();
    const real = await callPolicy(UNKNOWN);
    await real.press("10000002");
    await real.press("01011990");
    const fake = await callPolicy("+15555550198");
    await fake.press("99999999");
    await fake.press("01011990");
    expect(fake.last.says).toEqual(real.last.says);
    expect(fake.last.gatherAction).toBe(real.last.gatherAction);
  });

  it("an impossible date counts as a failure, not a crash", async () => {
    await boot();
    const c = await callPolicy(ALEX.phone);
    await c.press("13452000"); // month 13
    expect(c.hearsAll).toContain("We could not verify that information.");
  });

  it("silence at the date of birth counts as a failure", async () => {
    await boot();
    const c = await callPolicy(ALEX.phone);
    await c.silence();
    expect(c.hearsAll).toContain("We could not verify that information.");
  });
});

describe("the guard on protected screens", () => {
  it("an unauthenticated menu press on a protected route is sent to login, and sends no text", async () => {
    await boot();
    const c = new Caller(srv, UNKNOWN);
    await c.post("/svc/policy/input?back=main", { Digits: "2" }); // skip login, go straight for the text message
    expect(c.last.redirect).toContain("/svc/auth");
    expect(sent).toEqual([]);
  });

  it("claim status without login goes to login first", async () => {
    await boot();
    const c = new Caller(srv, UNKNOWN);
    await c.post("/svc/claimstatus?back=main");
    expect(c.last.redirect).toContain("/svc/auth");
    expect(c.hearsAll).toBe("");
  });

  it("another caller's login does not carry over to my call", async () => {
    await boot();
    const a = await callPolicy(ALEX.phone);
    await a.press(ALEX.dob);
    const b = new Caller(srv, UNKNOWN);
    await b.post("/svc/policy?back=main");
    expect(b.last.redirect).toContain("/svc/auth");
  });
});

describe("no PII in logs", () => {
  it("never logs typed digits, dates of birth, policy numbers or full phone numbers", async () => {
    await boot();
    const lines: string[] = [];
    for (const m of ["log", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...a) => void lines.push(a.join(" ")));
    }
    const c = await callPolicy(UNKNOWN);
    await c.press("10000002");
    await c.press("01011990"); // wrong birthday
    await c.press("10000002"); // asked for the policy number again
    await c.press("07021990"); // correct birthday: logged in
    const d = await callPolicy(ALEX.phone);
    await d.press(ALEX.dob);
    const all = lines.join("\n");
    for (const secret of ["10000002", "10000001", "01011990", "07021990", "03141985", "+15555550199", "+15555550100"]) {
      expect(all, `log leaked ${secret}`).not.toContain(secret);
    }
    expect(all).toContain("auth_success");
  });
});

describe("repository", () => {
  it("finds policies by phone and by number", () => {
    const repo = new SqliteRepo(":memory:");
    expect(repo.findByPhone("+15555550100").map((p) => p.policyNumber)).toEqual(["10000001"]);
    expect(repo.findByPhone("+15555550102")).toHaveLength(2);
    expect(repo.findByPolicyNumber("10000002")?.holderName).toBe("Jordan Lee");
    expect(repo.findByPolicyNumber("00000000")).toBeUndefined();
  });
});
