import { afterEach, describe, expect, it } from "vitest";
import { CLOSED, Caller, baseConfig, startApp, type TestServer } from "./caller.js";
import { loadConfig } from "../src/config.js";
import { alwaysOpenSchedule, harborlineSchedule, isOpen } from "../src/services/businessHours.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import { DEMO_POLICY_NUMBERS, demoPolicies, dobFromDigits } from "../src/ops/demo.js";
import { describeMode, expectedVoiceUrl, startupWarnings } from "../src/ops/startup.js";

const env = { TWILIO_AUTH_TOKEN: "x" };

describe("demo hours", () => {
  it("always-open really is open at every awkward moment, including the last minute of a day and 3 a.m. Sunday", () => {
    for (const iso of ["2026-11-15T08:00:00Z", "2026-11-18T04:59:00Z", "2026-11-18T05:00:00Z", "2026-12-25T15:00:00Z", "2026-07-04T07:30:00Z"]) {
      expect(isOpen(new Date(iso), alwaysOpenSchedule), iso).toBe(true);
    }
  });
  it("the real schedule is still closed at those moments (the demo setting is not the default)", () => {
    expect(isOpen(new Date("2026-11-15T08:00:00Z"), harborlineSchedule)).toBe(false); // Sunday 3 a.m. New York
    expect(isOpen(new Date("2026-12-25T15:00:00Z"), harborlineSchedule)).toBe(false); // a listed holiday
  });
  it("the setting is off unless asked for, and only two values exist", () => {
    expect(loadConfig(env).hoursMode).toBe("business");
    expect(loadConfig({ ...env, HOURS_MODE: "always-open" }).hoursMode).toBe("always-open");
    expect(() => loadConfig({ ...env, HOURS_MODE: "24/7" })).toThrow(/HOURS_MODE/);
  });
  describe("on a call", () => {
    let srv: TestServer;
    afterEach(() => srv?.close());
    it("a call in the dead of night gets the MAIN menu when always-open, and the closed menu otherwise", async () => {
      srv = await startApp({ clock: () => CLOSED }, { ...baseConfig, hoursMode: "always-open" });
      const open = await new Caller(srv).dial();
      expect(open.hearsAll).toContain("For policy questions, press 1");
      await srv.close();
      srv = await startApp({ clock: () => CLOSED }, baseConfig);
      const closed = await new Caller(srv).dial();
      expect(closed.hearsAll).toContain("closed right now");
    });
  });
});

describe("the Twilio number setting", () => {
  it("is optional and must be E.164", () => {
    expect(loadConfig(env).twilioPhoneNumber).toBeUndefined();
    expect(loadConfig({ ...env, TWILIO_PHONE_NUMBER: "+15551234567" }).twilioPhoneNumber).toBe("+15551234567");
    expect(() => loadConfig({ ...env, TWILIO_PHONE_NUMBER: "555-1234" })).toThrow(/E.164/);
  });
  it("the webhook address we expect is the public address plus /voice, with no doubled slash", () => {
    expect(expectedVoiceUrl("https://abc.example.com")).toBe("https://abc.example.com/voice");
    expect(expectedVoiceUrl("https://abc.example.com/")).toBe("https://abc.example.com/voice");
  });
});

describe("startup honesty", () => {
  const cfg = (o: Record<string, string> = {}) => loadConfig({ ...env, PUBLIC_BASE_URL: "https://x.example.com", ...o });
  it("a clean production-style setup has no warnings except what is genuinely missing", () => {
    const w = startupWarnings(cfg({ AGENT_PHONE: "+15551234567" }), { NODE_ENV: "production" });
    expect(w).toEqual([]);
  });
  it("shouts about the settings that cause real-phone trouble", () => {
    expect(startupWarnings(cfg({ PUBLIC_BASE_URL: "http://localhost:3000" }), {}).join("\n")).toMatch(/not https/);
    expect(startupWarnings(cfg({ PUBLIC_BASE_URL: "http://localhost:3000" }), {}).join("\n")).toMatch(/localhost/);
    expect(startupWarnings(cfg({ PUBLIC_BASE_URL: "https://random-words.trycloudflare.com" }), {}).join("\n")).toMatch(/temporary/);
    expect(startupWarnings(cfg(), {}).join("\n")).toMatch(/AGENT_PHONE is not set/);
  });
  it("flags the demo shortcuts so they are never silent", () => {
    const w = startupWarnings(cfg({ HOURS_MODE: "always-open", NOW_OVERRIDE: "2026-01-01T00:00:00Z", AGENT_PHONE: "+15551234567" }), {}).join("\n");
    expect(w).toMatch(/always-open/);
    expect(w).toMatch(/NOW_OVERRIDE is active/);
  });
  it("says NOW_OVERRIDE is ignored in production instead of silently ignoring it", () => {
    const w = startupWarnings(cfg({ AGENT_PHONE: "+15551234567" }), { NODE_ENV: "production", NOW_OVERRIDE: "2026-01-01T00:00:00Z" });
    expect(w.join("\n")).toMatch(/ignored in production/);
  });
  it("warns loudly about the two settings that act on the real world", () => {
    const w = startupWarnings(
      cfg({ AGENT_PHONE: "+15551234567", OUTBOUND_MODE: "live", OUTBOUND_FROM: "+15551230000", OUTBOUND_CALLBACK: "+15551230001", TWILIO_ACCOUNT_SID: "AC1", RETENTION_MODE: "live" }),
      { NODE_ENV: "production" },
    ).join("\n");
    expect(w).toMatch(/place REAL outbound calls/);
    expect(w).toMatch(/really delete recordings/);
  });
  it("the mode summary never contains a secret", () => {
    const text = describeMode(cfg({ TWILIO_AUTH_TOKEN: "super-secret-token-123", AGENT_PHONE: "+15551234567", TWILIO_ACCOUNT_SID: "AC_secret_sid" }), {}).join("\n");
    expect(text).not.toContain("super-secret-token-123");
    expect(text).not.toContain("AC_secret_sid");
    expect(text).not.toContain("5551234567");
  });
});

describe("demo customers", () => {
  it("reads a date of birth the way the caller types it, and refuses impossible ones", () => {
    expect(dobFromDigits("03141985")).toBe("1985-03-14");
    for (const bad of ["02302000", "13012000", "00102000", "01011800", "1985", "3141985", "ab141985"]) expect(dobFromDigits(bad), bad).toBeUndefined();
    expect(dobFromDigits("02292028")).toBe("2028-02-29"); // a real leap day
  });
  it("puts the caller's own number on a policy that owes money, due soon", () => {
    const [p] = demoPolicies({ customer: "+15551230001", dob: "1985-03-14", today: new Date("2026-11-17T00:00:00Z") });
    expect(p).toMatchObject({ policyNumber: "90000001", phone: "+15551230001", balanceCents: 8750, nextDue: "2026-11-22", product: "auto" });
  });
  it("the optional second customer owes nothing", () => {
    const list = demoPolicies({ customer: "+15551230001", second: "+15551230002", dob: "1985-03-14" });
    expect(list.map((p) => p.policyNumber)).toEqual([...DEMO_POLICY_NUMBERS]);
    expect(list[1].balanceCents).toBe(0);
  });
  it("after setup the caller is recognised by caller ID; a reset removes only the demo customers", () => {
    const repo = new SqliteRepo(":memory:");
    for (const p of demoPolicies({ customer: "+15551230001", dob: "1985-03-14" })) repo.upsertPolicy(p);
    expect(repo.findByPhone("+15551230001").map((p) => p.policyNumber)).toEqual(["90000001"]);
    expect(repo.findByPolicyNumber("10000001")).toBeDefined(); // seeded customers untouched
    repo.upsertPolicy({ ...repo.findByPolicyNumber("90000001")!, phone: "+15551239999" }); // setting up again replaces, never duplicates
    expect(repo.findByPhone("+15551230001")).toEqual([]);
    for (const n of DEMO_POLICY_NUMBERS) repo.removePolicy(n);
    expect(repo.findByPolicyNumber("90000001")).toBeUndefined();
    expect(repo.findByPolicyNumber("10000001")).toBeDefined();
  });
});
