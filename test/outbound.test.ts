import { afterEach, describe, expect, it } from "vitest";
import { AGENT, OPEN, Caller, baseConfig, startApp, type TestServer } from "./caller.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import { normalizeUsPhone } from "../src/outbound/phone.js";
import { OutboundStore, type Campaign } from "../src/outbound/store.js";
import { DEFAULT_RULES, FEDERAL_WINDOW, checkGate, localHour, withinWindow, type GateRules } from "../src/outbound/gate.js";
import { promotionalTerms } from "../src/outbound/promo.js";
import { CampaignRunner } from "../src/outbound/runner.js";
import { DryRunCaller, type OutboundCaller, type OutboundCallRequest } from "../src/outbound/caller.js";
import { spokenPhone } from "../src/outbound/routes.js";
import { loadConfig } from "../src/config.js";

const US = "+15555550190"; // our caller ID
const A = "+15555550101";
const B = "+15555550102";
const C = "+15555550103";
const TUE_10AM_NY = new Date("2026-11-17T15:00:00Z");
const HASH = "c".repeat(32);
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const rules: GateRules = { ...DEFAULT_RULES, from: US };

let store: OutboundStore;
const fresh = () => (store = new OutboundStore(":memory:"));

function campaign(purpose: "informational" | "marketing" = "informational", script = "This is a courtesy reminder about your Harborline account."): Campaign {
  return store.createCampaign({ name: "test", purpose, consentScope: purpose === "marketing" ? "marketing" : "payment_reminders", scriptText: script }, new Date("2026-10-01T00:00:00Z"));
}
function consent(phone: string, c: Campaign, kind: "express" | "written" = "written", when = new Date("2026-10-02T00:00:00Z")) {
  return store.addConsent({ phone, kind, scope: c.consentScope, method: "web_form", evidenceRef: "form-1", disclosureHash: HASH }, when);
}
const loadRegistry = (numbers: string[] = [], when = new Date(TUE_10AM_NY.getTime() - DAY)) => store.loadNationalDnc(numbers, when);
const gate = (c: Campaign, phone: string, zone: string | null = "America/New_York", now = TUE_10AM_NY, r = rules) => checkGate(store, c, { phone, timeZone: zone }, now, r);

describe("phone numbers", () => {
  it("one canonical form for every way of writing a US number", () => {
    for (const same of ["(555) 555-0101", "555-555-0101", "5555550101", "+1 555 555 0101", "1-555-555-0101", "+15555550101"]) {
      expect(normalizeUsPhone(same)).toBe("+15555550101");
    }
  });
  it("rejects what cannot be dialled", () => {
    for (const bad of ["", undefined, "123", "+44 20 7946 0958", "055 555 0101", "555 155 0101", "555555010x", "+1555555010123"]) {
      expect(normalizeUsPhone(bad as string | undefined)).toBeUndefined();
    }
  });
});

describe("consent and do-not-call records", () => {
  it("records what, when, how, and the fingerprint of the text shown", () => {
    fresh();
    const c = campaign();
    const rec = consent(A, c);
    expect(rec).toMatchObject({ phone: A, kind: "written", scope: "payment_reminders", method: "web_form", evidenceRef: "form-1", disclosureHash: HASH });
  });
  it("refuses sloppy consent: bad number, bad scope, unknown method, no evidence, no disclosure fingerprint", () => {
    fresh();
    const ok = { phone: A, kind: "written" as const, scope: "marketing", method: "web_form" as const, evidenceRef: "f", disclosureHash: HASH };
    expect(() => store.addConsent({ ...ok, phone: "12" })).toThrow();
    expect(() => store.addConsent({ ...ok, scope: "Marketing!" })).toThrow();
    expect(() => store.addConsent({ ...ok, method: "vibes" as never })).toThrow();
    expect(() => store.addConsent({ ...ok, evidenceRef: " " })).toThrow();
    expect(() => store.addConsent({ ...ok, disclosureHash: "xyz" })).toThrow();
  });
  it("consent, revocations, do-not-call entries and gate decisions can never be edited or deleted", () => {
    fresh();
    const c = campaign();
    consent(A, c);
    store.revoke(A, "all", "test");
    store.addDnc(A, "customer_request");
    store.logDecision(c.id, A, false, "no_consent", null);
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    for (const table of ["consents", "revocations", "dnc_entries", "gate_decisions"]) {
      expect(() => db.exec(`UPDATE ${table} SET phone = '+15555550999'`)).toThrow(/append-only/);
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/append-only/);
    }
  });
  it("consent for one purpose never covers another", () => {
    fresh();
    const reminders = campaign("informational");
    const promo = campaign("marketing", "A renewal offer.");
    consent(A, reminders);
    expect(store.consentStatus(A, reminders.consentScope).status).toBe("valid");
    expect(store.consentStatus(A, promo.consentScope).status).toBe("none");
  });
  it("a revocation ends consent; a later fresh consent starts a new agreement; a scoped revocation leaves other scopes alone", () => {
    fresh();
    const c = campaign();
    consent(A, c, "written", new Date("2026-10-01T00:00:00Z"));
    store.revoke(A, c.consentScope, "customer_request", new Date("2026-10-05T00:00:00Z"));
    expect(store.consentStatus(A, c.consentScope).status).toBe("revoked");
    consent(A, c, "written", new Date("2026-10-10T00:00:00Z"));
    expect(store.consentStatus(A, c.consentScope).status).toBe("valid");
    store.revoke(A, "marketing", "customer_request", new Date("2026-10-11T00:00:00Z"));
    expect(store.consentStatus(A, c.consentScope).status).toBe("valid"); // marketing withdrawn, reminders untouched
    store.revoke(A, "all", "keypress_opt_out", new Date("2026-10-12T00:00:00Z"));
    expect(store.consentStatus(A, c.consentScope).status).toBe("revoked");
  });
  it("a revocation recorded at the same instant as the consent wins (cautious)", () => {
    fresh();
    const c = campaign();
    const t = new Date("2026-10-01T00:00:00Z");
    consent(A, c, "written", t);
    store.revoke(A, "all", "test", t);
    expect(store.consentStatus(A, c.consentScope).status).toBe("revoked");
  });
  it("loading the national registry replaces the old copy and remembers when", () => {
    fresh();
    expect(store.nationalDncLoadedAt()).toBeUndefined();
    store.loadNationalDnc([A, "(555) 555-0102", "garbage"], new Date("2026-11-01T00:00:00Z"));
    expect(store.isOnNationalDnc(B)).toBe(true);
    store.loadNationalDnc([C], new Date("2026-11-10T00:00:00Z"));
    expect(store.isOnNationalDnc(A)).toBe(false);
    expect(store.isOnNationalDnc(C)).toBe(true);
    expect(store.nationalDncLoadedAt()!.toISOString()).toBe("2026-11-10T00:00:00.000Z");
  });
  it("does not store contacts it cannot dial, or time zones that do not exist", () => {
    fresh();
    const c = campaign();
    expect(store.addContact(c.id, "12345")).toBeUndefined();
    expect(() => store.addContact(c.id, A, "Mars/Olympus")).toThrow();
  });
});

describe("calling hours", () => {
  it("is 8:00 up to (not including) 21:00 at the person's own location", () => {
    const at = (iso: string, zone = "America/New_York") => withinWindow(new Date(iso), [zone], FEDERAL_WINDOW);
    expect(at("2026-11-17T12:59:00Z")).toBe(false); // 7:59 NY
    expect(at("2026-11-17T13:00:00Z")).toBe(true); // 8:00 NY
    expect(at("2026-11-18T01:59:00Z")).toBe(true); // 20:59 NY
    expect(at("2026-11-18T02:00:00Z")).toBe(false); // 21:00 NY
  });
  it("uses the recipient's clock, not ours: 10 a.m. in New York is 7 a.m. in California", () => {
    expect(localHour(TUE_10AM_NY, "America/New_York")).toBe(10);
    expect(localHour(TUE_10AM_NY, "America/Los_Angeles")).toBe(7);
    expect(withinWindow(TUE_10AM_NY, ["America/Los_Angeles"], FEDERAL_WINDOW)).toBe(false);
  });
  it("follows daylight saving time", () => {
    // 15:00 UTC in July is 11:00 in New York and 8:00 in Los Angeles (summer time); in November it is 7:00 in LA.
    expect(localHour(new Date("2026-07-15T15:00:00Z"), "America/Los_Angeles")).toBe(8);
    expect(withinWindow(new Date("2026-07-15T15:00:00Z"), ["America/Los_Angeles"], FEDERAL_WINDOW)).toBe(true);
  });
});

describe("the compliance gate", () => {
  it("lets a consented contact through, in hours, and records the consent it relied on", () => {
    fresh();
    const c = campaign();
    consent(A, c);
    const r = gate(c, A);
    expect(r.allowed).toBe(true);
    expect((r as { detail?: string }).detail).toContain("consent #1");
  });
  it("no consent -> blocked", () => {
    fresh();
    expect(gate(campaign(), A)).toMatchObject({ allowed: false, reason: "no_consent" });
  });
  it("withdrawn consent -> blocked", () => {
    fresh();
    const c = campaign();
    consent(A, c, "written", new Date("2026-10-01T00:00:00Z"));
    store.revoke(A, "all", "test", new Date("2026-11-01T00:00:00Z"));
    expect(gate(c, A)).toMatchObject({ allowed: false, reason: "consent_revoked" });
  });
  it("an invalid number, or no caller ID of our own, -> blocked", () => {
    fresh();
    const c = campaign();
    expect(gate(c, "123")).toMatchObject({ reason: "invalid_phone" });
    expect(gate(c, A, "America/New_York", TUE_10AM_NY, { ...rules, from: undefined })).toMatchObject({ reason: "no_caller_id" });
  });
  it("the internal do-not-call list beats everything, even valid written consent", () => {
    fresh();
    const c = campaign("marketing", "A renewal offer.");
    loadRegistry();
    consent(A, c);
    store.addDnc(A, "keypress_opt_out");
    expect(gate(c, A)).toMatchObject({ allowed: false, reason: "on_internal_dnc" });
  });
  it("marketing needs WRITTEN consent: express consent is not enough", () => {
    fresh();
    const c = campaign("marketing", "A renewal offer.");
    loadRegistry();
    consent(A, c, "express");
    expect(gate(c, A)).toMatchObject({ allowed: false, reason: "consent_too_weak" });
    consent(B, c, "written");
    expect(gate(c, B).allowed).toBe(true);
  });
  it("informational calls accept plain express consent", () => {
    fresh();
    const c = campaign("informational");
    consent(A, c, "express");
    expect(gate(c, A).allowed).toBe(true);
  });
  it("marketing is refused if we have no copy of the national registry, or it is more than 31 days old", () => {
    fresh();
    const c = campaign("marketing", "A renewal offer.");
    consent(A, c);
    expect(gate(c, A)).toMatchObject({ reason: "national_dnc_list_missing" });
    loadRegistry([], new Date(TUE_10AM_NY.getTime() - 32 * DAY));
    expect(gate(c, A)).toMatchObject({ reason: "national_dnc_list_stale" });
    loadRegistry([], new Date(TUE_10AM_NY.getTime() - 31 * DAY));
    expect(gate(c, A).allowed).toBe(true); // exactly 31 days is the limit, not over it
  });
  it("a number on the national registry is blocked for marketing unless a signed written agreement is on file", () => {
    fresh();
    const c = campaign("marketing", "A renewal offer.");
    loadRegistry([A, B]);
    consent(B, c, "written");
    expect(gate(c, A)).toMatchObject({ allowed: false, reason: "on_national_dnc" });
    const r = gate(c, B);
    expect(r.allowed).toBe(true);
    expect((r as { detail?: string }).detail).toContain("on national DNC but written agreement on file");
  });
  it("informational calls are not held to the registry", () => {
    fresh();
    const c = campaign("informational");
    consent(A, c);
    loadRegistry([A]);
    expect(gate(c, A).allowed).toBe(true);
  });
  it("9:30 p.m. in California is blocked, 9:30 p.m. in New York is blocked, 7:30 a.m. in New York is blocked", () => {
    fresh();
    const c = campaign();
    consent(A, c);
    expect(gate(c, A, "America/Los_Angeles", new Date("2026-11-18T05:30:00Z"))).toMatchObject({ reason: "outside_calling_hours" });
    expect(gate(c, A, "America/New_York", new Date("2026-11-18T02:30:00Z"))).toMatchObject({ reason: "outside_calling_hours" });
    expect(gate(c, A, "America/New_York", new Date("2026-11-17T12:30:00Z"))).toMatchObject({ reason: "outside_calling_hours" });
  });
  it("when we do not know where someone is, the call must be fine in EVERY US time zone", () => {
    fresh();
    const c = campaign();
    consent(A, c);
    expect(gate(c, A, null, TUE_10AM_NY)).toMatchObject({ reason: "outside_calling_hours" }); // 5 a.m. in Hawaii
    expect(gate(c, A, null, new Date("2026-11-17T19:00:00Z")).allowed).toBe(true); // 9 a.m. Hawaii ... 2 p.m. New York
    expect(gate(c, A, null, new Date("2026-11-18T03:00:00Z"))).toMatchObject({ reason: "outside_calling_hours" }); // 10 p.m. New York
  });
  it("a stricter window (a state rule or client policy, set in config) is honoured and cannot be widened by accident", () => {
    fresh();
    const c = campaign();
    consent(A, c);
    const strict = { ...rules, window: { startHour: 9, endHour: 20 } }; // illustrative, not a real state's rule
    expect(gate(c, A, "America/New_York", new Date("2026-11-17T13:30:00Z"), rules).allowed).toBe(true); // 8:30 a.m.
    expect(gate(c, A, "America/New_York", new Date("2026-11-17T13:30:00Z"), strict)).toMatchObject({ reason: "outside_calling_hours" });
  });
  it("a third call in a week is blocked, counting every campaign; older calls and calls never placed do not count", () => {
    fresh();
    const c = campaign();
    const other = campaign();
    consent(A, c);
    const place = (camp: Campaign, hoursAgo: number, sid: string | null) => {
      const a = store.createAttempt(camp.id, A, new Date(TUE_10AM_NY.getTime() - hoursAgo * HOUR));
      if (sid) store.setCallSid(a.id, sid, new Date(TUE_10AM_NY.getTime() - hoursAgo * HOUR));
    };
    place(other, 8 * 24, "CA" + "1".padStart(32, "0")); // 8 days ago: outside the week
    place(other, 30, null); // created but never placed
    expect(gate(c, A).allowed).toBe(true);
    place(other, 30, "CA" + "2".padStart(32, "0"));
    expect(gate(c, A).allowed).toBe(true);
    place(other, 10, "CA" + "3".padStart(32, "0"));
    expect(gate(c, A)).toMatchObject({ allowed: false, reason: "frequency_cap" });
  });
  it("retries: spaced apart, capped, and never after the person was reached", () => {
    fresh();
    const c = campaign();
    consent(A, c);
    consent(B, c);
    const wide = { ...rules, maxPerWeek: 99 };
    const att = (phone: string, hoursAgo: number, outcome: string | null, n: number) => {
      const t = new Date(TUE_10AM_NY.getTime() - hoursAgo * HOUR);
      const a = store.createAttempt(c.id, phone, t);
      store.setCallSid(a.id, "CA" + String(n).padStart(32, "0"), t);
      if (outcome) store.setAttempt(a.id, "done", outcome, t);
    };
    att(A, 1, "no-answer", 1);
    expect(gate(c, A, "America/New_York", TUE_10AM_NY, wide)).toMatchObject({ reason: "retry_too_soon" });
    att(B, 5, "busy", 2);
    expect(gate(c, B, "America/New_York", TUE_10AM_NY, wide).allowed).toBe(true); // 5 hours later: fine
    att(B, 30, "no-answer", 3);
    att(B, 40, "no-answer", 4);
    expect(gate(c, B, "America/New_York", TUE_10AM_NY, wide)).toMatchObject({ reason: "too_many_attempts" });
    for (const [i, outcome] of ["human_answered", "transferred", "opted_out"].entries()) {
      const p = `+1555555020${i}`;
      consent(p, c);
      att(p, 50, outcome, 10 + i);
      expect(gate(c, p, "America/New_York", TUE_10AM_NY, wide)).toMatchObject({ reason: "contact_complete" });
    }
  });
  it("a contact already waiting in a queued call is not queued a second time", () => {
    fresh();
    const c = campaign();
    consent(A, c);
    store.createAttempt(c.id, A, TUE_10AM_NY);
    expect(gate(c, A)).toMatchObject({ reason: "already_in_progress" });
  });
});

describe("promotional content in an 'informational' campaign", () => {
  it("catches offers hiding in reminders, and leaves plain reminders alone", () => {
    expect(promotionalTerms("This is a courtesy reminder that a payment on your account is coming up.")).toEqual([]);
    expect(promotionalTerms("Your policy renews soon. Ask about our special offer and save twenty percent.")).toEqual(expect.arrayContaining(["offer", "save"]));
    expect(promotionalTerms("Get a free quote today.")).toEqual(expect.arrayContaining(["free", "quote"]));
  });
});

describe("running a campaign", () => {
  const sleeps: number[] = [];
  const runnerFor = (caller: OutboundCaller, o: Partial<ConstructorParameters<typeof CampaignRunner>[2]> = {}, now = TUE_10AM_NY) =>
    new CampaignRunner(store, caller, { rules, publicBaseUrl: "https://ivr.example.com", cps: 2, sleep: async (ms) => void sleeps.push(ms), ...o }, () => now);

  it("places calls to the cleared contacts, blocks the rest with reasons, and logs EVERY decision", async () => {
    fresh();
    const c = campaign();
    consent(A, c);
    consent(C, c);
    store.addDnc(C, "keypress_opt_out");
    for (const p of [A, B, C]) store.addContact(c.id, p, "America/New_York");
    const caller = new DryRunCaller();
    const out = await runnerFor(caller).run(c.id);
    expect(out).toMatchObject({ considered: 3, placed: 1, failed: 0 });
    expect(out.blocked).toEqual([{ phone: B, reason: "no_consent" }, { phone: C, reason: "on_internal_dnc" }]);
    expect(caller.calls.map((x) => x.to)).toEqual([A]);
    expect(store.decisions(c.id).map((d) => [d.phone, d.allowed, d.reason])).toEqual([[A, true, null], [B, false, "no_consent"], [C, false, "on_internal_dnc"]]);
  });
  it("builds the URLs Twilio will call and rings long enough (at least 15 seconds)", async () => {
    fresh();
    const c = campaign();
    consent(A, c);
    store.addContact(c.id, A, "America/New_York");
    const caller = new DryRunCaller();
    await runnerFor(caller).run(c.id);
    const req = caller.calls[0];
    expect(req.answerUrl).toBe("https://ivr.example.com/outbound/1/answer");
    expect(req.statusUrl).toBe("https://ivr.example.com/outbound/1/status");
    expect(req.from).toBe(US);
    expect(req.timeoutSec).toBeGreaterThanOrEqual(15);
    expect(store.getAttempt(1)).toMatchObject({ status: "placed", callSid: expect.stringMatching(/^CA[0-9a-f]{32}$/) });
  });
  it("refuses an 'informational' campaign whose script is an offer, and calls nobody", async () => {
    fresh();
    const c = campaign("informational", "Renew now and save twenty percent with our special offer.");
    consent(A, c);
    store.addContact(c.id, A, "America/New_York");
    const caller = new DryRunCaller();
    const out = await runnerFor(caller).run(c.id);
    expect(out.placed).toBe(0);
    expect(out.blocked[0]).toMatchObject({ reason: "promotional_content_in_informational_campaign" });
    expect(caller.calls).toEqual([]);
  });
  it("paces call starts to the calls-per-second limit", async () => {
    fresh();
    const c = campaign();
    for (const p of [A, B, C]) {
      consent(p, c);
      store.addContact(c.id, p, "America/New_York");
    }
    sleeps.length = 0;
    await runnerFor(new DryRunCaller(), { cps: 4 }).run(c.id);
    expect(sleeps).toEqual([250, 250]); // between 3 starts
  });
  it("never has more calls being set up at once than the concurrency limit", async () => {
    fresh();
    const c = campaign();
    for (let i = 0; i < 6; i++) {
      const p = `+1555555030${i}`;
      consent(p, c);
      store.addContact(c.id, p, "America/New_York");
    }
    let now = 0, peak = 0;
    const slow: OutboundCaller = {
      async create() {
        peak = Math.max(peak, ++now);
        await new Promise((r) => setTimeout(r, 15));
        now--;
        return { callSid: "CA" + Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32) };
      },
    };
    await runnerFor(slow, { concurrency: 2 }).run(c.id);
    expect(peak).toBeLessThanOrEqual(2);
  });
  it("one call failing to start does not stop the others, and does not count against the contact", async () => {
    fresh();
    const c = campaign();
    for (const p of [A, B]) {
      consent(p, c);
      store.addContact(c.id, p, "America/New_York");
    }
    let n = 0;
    const flaky: OutboundCaller = {
      async create() {
        if (++n === 1) throw new Error("twilio said no");
        return { callSid: "CA" + "9".repeat(32) };
      },
    };
    const out = await runnerFor(flaky).run(c.id);
    expect(out).toMatchObject({ placed: 1, failed: 1 });
    expect(store.getAttempt(1)).toMatchObject({ status: "failed", outcome: "create_failed", callSid: null });
    expect(store.placedSince(A, new Date(0))).toBe(0); // it never rang, so it is not "a call this week"
  });
  it("someone who said stop while their call was waiting its turn is not rung", async () => {
    fresh();
    const c = campaign();
    for (const p of [A, B]) {
      consent(p, c);
      store.addContact(c.id, p, "America/New_York");
    }
    const caller: OutboundCaller = {
      async create(req: OutboundCallRequest) {
        if (req.to === A) store.addDnc(B, "keypress_opt_out"); // B presses 9 on another call while we are dialling A
        return { callSid: "CA" + "7".repeat(32) };
      },
    };
    const out = await runnerFor(caller, { concurrency: 1 }).run(c.id);
    expect(out.placed).toBe(1);
    expect(out.blocked).toContainEqual({ phone: B, reason: "on_internal_dnc" });
    expect(store.getAttempt(2)).toMatchObject({ status: "cancelled", outcome: "cancelled_by_opt_out" });
  });
  it("running the same campaign twice does not double-call anyone", async () => {
    fresh();
    const c = campaign();
    consent(A, c);
    store.addContact(c.id, A, "America/New_York");
    const caller = new DryRunCaller();
    await runnerFor(caller).run(c.id);
    const second = await runnerFor(caller).run(c.id);
    expect(second.placed).toBe(0);
    expect(second.blocked[0].reason).toBe("retry_too_soon");
    expect(caller.calls).toHaveLength(1);
  });
});

describe("the call itself (webhooks)", () => {
  let srv: TestServer;
  let repo: SqliteRepo;
  let clockNow = TUE_10AM_NY.getTime();

  async function boot(mode: "off" | "dry-run" = "dry-run") {
    fresh();
    repo = new SqliteRepo(":memory:");
    clockNow = TUE_10AM_NY.getTime();
    srv = await startApp({ clock: () => new Date(clockNow), outbound: store, repo }, { ...baseConfig, outboundMode: mode, outboundCallback: "+15555550177" });
  }
  afterEach(() => srv?.close());

  /** Gate and "place" a call to `phone`, then return a Twilio-like caller that is on that call. */
  async function placed(phone = A, c = campaign("informational")): Promise<{ call: Caller; attemptId: number; campaign: Campaign }> {
    if (store.consentStatus(phone, c.consentScope).status === "none") consent(phone, c);
    store.addContact(c.id, phone, "America/New_York");
    const caller = new DryRunCaller();
    await new CampaignRunner(store, caller, { rules, publicBaseUrl: "https://ivr.example.com", cps: 1000, sleep: async () => {} }, () => new Date(clockNow)).run(c.id);
    const attempt = store.attemptsFor(c.id, phone).at(-1)!;
    const call = new Caller(srv, US);
    call.callSid = attempt.callSid!;
    return { call, attemptId: attempt.id, campaign: c };
  }
  const answer = (call: Caller, id: number, extra: Record<string, string> = { AnsweredBy: "human" }) => call.post(`/outbound/${id}/answer`, extra);

  it("opens with who we are and how to stop, THEN the message, then the choices; and says no account details", async () => {
    await boot();
    const { call, attemptId, campaign: c } = await placed();
    await answer(call, attemptId);
    const said = call.last.says[0];
    expect(said.startsWith("Hello, this is Harborline Insurance. To stop receiving these calls at any time, press 9.")).toBe(true);
    expect(said.indexOf("press 9")).toBeLessThan(said.indexOf(c.scriptText));
    expect(said).toContain("To speak with an agent, press 1. To stop these calls, press 9.");
    expect(said).toContain("call us at 5 5 5, 5 5 5, 0 1 7 7 to be removed");
    expect(said).not.toMatch(/policy|balance|\$|due on/i);
    expect(call.last.gatherAction).toBe(`/outbound/${attemptId}/key`);
    expect(call.last.gatherNumDigits).toBe(1);
    expect(store.getAttempt(attemptId)).toMatchObject({ status: "in_progress", outcome: "human_answered" });
  });
  it("speaks the callback number the way a person would write it down", () => {
    expect(spokenPhone("+15555550177")).toBe("5 5 5, 5 5 5, 0 1 7 7");
  });
  it.each(["machine_start", "machine_end_beep", "fax", "unknown", ""])("AnsweredBy=%s: hangs up without saying a word", async (answeredBy) => {
    await boot();
    const { call, attemptId } = await placed();
    await answer(call, attemptId, answeredBy ? { AnsweredBy: answeredBy } : {});
    expect(call.last.says).toEqual([]);
    expect(call.last.hangup).toBe(true);
    expect(store.getAttempt(attemptId)!.outcome).toBe("machine");
  });
  it("hangs up if the person pressed 9 on another call between our dialling and their answer", async () => {
    await boot();
    const { call, attemptId } = await placed();
    store.addDnc(A, "keypress_opt_out");
    await answer(call, attemptId);
    expect(call.last.says).toEqual([]);
    expect(store.getAttempt(attemptId)!.outcome).toBe("stopped_before_answer");
  });
  it("hangs up if consent was withdrawn after dialling", async () => {
    await boot();
    const { call, attemptId } = await placed();
    store.revoke(A, "all", "customer_request", new Date(clockNow + 1000));
    await answer(call, attemptId);
    expect(call.last.says).toEqual([]);
    expect(call.last.hangup).toBe(true);
  });
  it("ignores a request that does not belong to the attempt: wrong call, bad id, bad sid, or outbound switched off", async () => {
    await boot();
    const { call, attemptId } = await placed();
    const stranger = new Caller(srv, US);
    await answer(stranger, attemptId); // a different (valid-looking) call sid
    expect(stranger.last.says).toEqual([]);
    await answer(call, 9999);
    expect(call.last.says).toEqual([]);
    await call.post(`/outbound/${attemptId}/answer`, { AnsweredBy: "human", CallSid: "not-a-sid" });
    expect(call.last.says).toEqual([]);
    expect(store.getAttempt(attemptId)!.outcome).toBeNull();
    await srv.close();
    await boot("off");
    const off = await placed();
    await answer(off.call, off.attemptId);
    expect(off.call.last.says).toEqual([]);
  });
  it("adopts the call id if Twilio reaches us before our own create-call request returned", async () => {
    await boot();
    const c = campaign();
    consent(A, c);
    const attempt = store.createAttempt(c.id, A, TUE_10AM_NY); // no call sid recorded yet
    const call = new Caller(srv, US);
    await answer(call, attempt.id);
    expect(call.last.gatherAction).toBe(`/outbound/${attempt.id}/key`);
    expect(store.getAttempt(attempt.id)!.callSid).toBe(call.callSid);
  });

  describe("pressing 9 (stop)", () => {
    it("records the opt-out BEFORE saying goodbye, for every campaign, and ends the call", async () => {
      await boot();
      const { call, attemptId } = await placed();
      await answer(call, attemptId);
      await call.post(`/outbound/${attemptId}/key`, { Digits: "9" });
      expect(call.last.says.join(" ")).toContain("You will not receive any more calls from us.");
      expect(call.last.hangup).toBe(true);
      expect(store.isOnInternalDnc(A)).toBe(true);
      expect(store.consentStatus(A, "payment_reminders").status).toBe("revoked"); // consent itself is withdrawn too
      expect(store.getAttempt(attemptId)!.outcome).toBe("opted_out");
      // consent is withdrawn for ALL purposes, not just this campaign's
      const promo = campaign("marketing", "A renewal offer.");
      consent(A, promo, "written", new Date(clockNow + HOUR));
      expect(store.consentStatus(A, promo.consentScope).status).toBe("valid"); // consent given AFTER the stop is a new agreement...
      loadRegistry();
      expect(gate(promo, A)).toMatchObject({ reason: "on_internal_dnc" }); // ...but the do-not-call entry still wins
    });
    it("the next run of the same campaign does not call them", async () => {
      await boot();
      const { call, attemptId, campaign: c } = await placed();
      await answer(call, attemptId);
      await call.post(`/outbound/${attemptId}/key`, { Digits: "9" });
      const caller = new DryRunCaller();
      const out = await new CampaignRunner(store, caller, { rules, publicBaseUrl: "https://ivr.example.com", cps: 1000, sleep: async () => {} }, () => new Date(clockNow + 7 * DAY)).run(c.id);
      expect(out.blocked).toEqual([{ phone: A, reason: "on_internal_dnc" }]);
      expect(caller.calls).toEqual([]);
    });
    it("cancels any other call to that person that is still waiting its turn", async () => {
      await boot();
      const other = campaign("informational", "Another reminder.");
      store.addContact(other.id, A, "America/New_York");
      consent(A, other);
      const waiting = store.createAttempt(other.id, A, TUE_10AM_NY);
      const { call, attemptId } = await placed();
      await answer(call, attemptId);
      await call.post(`/outbound/${attemptId}/key`, { Digits: "9" });
      expect(store.getAttempt(waiting.id)).toMatchObject({ status: "cancelled", outcome: "cancelled_by_opt_out" });
    });
    it("the plan's done-when: a campaign of three own numbers, the gate blocks two, the keypress updates the DNC list", async () => {
      await boot();
      const c = campaign();
      consent(A, c);
      consent(C, c);
      store.addDnc(C, "keypress_opt_out"); // C asked to stop earlier
      for (const p of [A, B, C]) store.addContact(c.id, p, "America/New_York"); // B never consented
      const caller = new DryRunCaller();
      const out = await new CampaignRunner(store, caller, { rules, publicBaseUrl: "https://ivr.example.com", cps: 1000, sleep: async () => {} }, () => new Date(clockNow)).run(c.id);
      expect(out.placed).toBe(1);
      expect(out.blocked.map((b) => b.reason).sort()).toEqual(["no_consent", "on_internal_dnc"]);
      const attempt = store.attemptsFor(c.id, A)[0];
      const call = new Caller(srv, US);
      call.callSid = attempt.callSid!;
      await answer(call, attempt.id);
      await call.post(`/outbound/${attempt.id}/key`, { Digits: "9" });
      expect(store.isOnInternalDnc(A)).toBe(true);
    });
  });

  describe("pressing 1 (speak to an agent)", () => {
    it("connects to the agent line with a whisper that says this is a returned outbound call", async () => {
      await boot();
      const { call, attemptId } = await placed();
      await answer(call, attemptId);
      await call.post(`/outbound/${attemptId}/key`, { Digits: "1" });
      await call.settle();
      expect(call.last.dial).toBe(AGENT);
      expect(await call.whisper()).toContain("returning an outbound call");
      expect(store.getAttempt(attemptId)!.outcome).toBe("transferred");
    });
    it("a callback request from this call is for the PERSON we rang, not for our own number", async () => {
      await boot();
      const busy = await new Caller(srv, "+15555550177").dial();
      await busy.press("0"); // someone else holds the agent line
      const { call, attemptId } = await placed(A);
      await answer(call, attemptId);
      await call.post(`/outbound/${attemptId}/key`, { Digits: "1" });
      await call.settle();
      expect(call.hearsAll).toContain("You are next in line.");
      await call.press("1"); // call me back instead
      expect(call.last.says.join(" ")).toContain("ending in 0 1 0 1"); // A's number, not ours (0190)
      await call.press("1");
      expect(repo.openTickets()[0]).toMatchObject({ kind: "callback", phone: A });
    });
  });
  it("any other key, or silence, just ends the call politely", async () => {
    await boot();
    const { call, attemptId } = await placed();
    await answer(call, attemptId);
    await call.post(`/outbound/${attemptId}/key`, { Digits: "5" });
    expect(call.last.hangup).toBe(true);
    expect(store.isOnInternalDnc(A)).toBe(false);
  });

  describe("status reports", () => {
    it.each([["busy", "busy"], ["no-answer", "no-answer"], ["failed", "failed"], ["canceled", "canceled"], ["completed", "completed"]])("%s is recorded as %s", async (status, outcome) => {
      await boot();
      const { call, attemptId } = await placed();
      await call.post(`/outbound/${attemptId}/status`, { CallStatus: status });
      expect(call.status).toBe(204);
      expect(store.getAttempt(attemptId)!.outcome).toBe(outcome);
    });
    it("never overwrites what the person chose, ignores in-progress reports, and ignores strangers", async () => {
      await boot();
      const { call, attemptId } = await placed();
      await answer(call, attemptId);
      await call.post(`/outbound/${attemptId}/key`, { Digits: "9" });
      await call.post(`/outbound/${attemptId}/status`, { CallStatus: "completed" });
      expect(store.getAttempt(attemptId)).toMatchObject({ status: "done", outcome: "opted_out" });
      const fresh2 = await placed(B);
      await fresh2.call.post(`/outbound/${fresh2.attemptId}/status`, { CallStatus: "in-progress" });
      expect(store.getAttempt(fresh2.attemptId)!.outcome).toBeNull();
      const stranger = new Caller(srv, US);
      await stranger.post(`/outbound/${fresh2.attemptId}/status`, { CallStatus: "failed" });
      expect(store.getAttempt(fresh2.attemptId)!.outcome).toBeNull();
    });
  });
});

describe("asking us to stop on our inbound line", () => {
  let srv: TestServer;
  afterEach(() => srv?.close());
  async function boot() {
    fresh();
    srv = await startApp({ outbound: store, clock: () => OPEN });
  }
  it("saying 'stop calling me' and confirming puts the calling number on the do-not-call list and withdraws consent", async () => {
    await boot();
    const c = campaign();
    consent(A, c);
    const queued = store.createAttempt(c.id, A);
    const call = await new Caller(srv, A).dial();
    await call.say("please stop calling me", 0.95);
    expect(call.last.says.join(" ")).toContain("To stop receiving calls from Harborline Insurance");
    await call.press("1");
    expect(call.hearsAll).toContain("You will not receive any more calls from us.");
    expect(store.isOnInternalDnc(A)).toBe(true);
    expect(store.consentStatus(A, c.consentScope).status).toBe("revoked");
    expect(store.getAttempt(queued.id)!.status).toBe("cancelled");
    expect(call.last.gatherAction).toBe("/ivr/main/input"); // back at the menu
  });
  it("pressing 9 instead changes nothing", async () => {
    await boot();
    const call = await new Caller(srv, A).dial();
    await call.say("stop calling me", 0.95);
    await call.press("9");
    expect(store.isOnInternalDnc(A)).toBe(false);
  });
  it("a hidden caller ID cannot be recorded, and the caller is told what to do instead", async () => {
    await boot();
    const call = await new Caller(srv, "anonymous").dial();
    await call.say("stop calling me", 0.95);
    await call.press("1");
    expect(call.hearsAll).toContain("could not read your phone number");
  });
});

describe("settings", () => {
  const env = { TWILIO_AUTH_TOKEN: "x" };
  it("outbound calling is off unless switched on", () => {
    expect(loadConfig(env).outboundMode).toBe("off");
  });
  it("only three modes exist", () => {
    expect(() => loadConfig({ ...env, OUTBOUND_MODE: "yolo" })).toThrow(/OUTBOUND_MODE/);
    expect(loadConfig({ ...env, OUTBOUND_MODE: "dry-run" }).outboundMode).toBe("dry-run");
  });
  it("live mode needs everything a real call needs: caller ID, a stop-calling number, an account, https", () => {
    const live = { ...env, OUTBOUND_MODE: "live", OUTBOUND_FROM: US, OUTBOUND_CALLBACK: "+15555550177", TWILIO_ACCOUNT_SID: "AC1", PUBLIC_BASE_URL: "https://ivr.example.com" };
    expect(loadConfig(live).outboundMode).toBe("live");
    for (const missing of ["OUTBOUND_FROM", "OUTBOUND_CALLBACK", "TWILIO_ACCOUNT_SID"]) {
      expect(() => loadConfig({ ...live, [missing]: "" })).toThrow();
    }
    expect(() => loadConfig({ ...live, PUBLIC_BASE_URL: "http://localhost:3000" })).toThrow(/https/);
  });
  it("numbers must be E.164", () => {
    expect(() => loadConfig({ ...env, OUTBOUND_FROM: "555-0100" })).toThrow(/E.164/);
  });
});
