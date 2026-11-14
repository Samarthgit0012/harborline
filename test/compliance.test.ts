import { afterEach, describe, expect, it } from "vitest";
import twilio from "twilio";
import { AGENT, CLOSED, OPEN, Caller, baseConfig, startApp, type TestServer } from "./caller.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import { MemoryStateStore } from "../src/engine/state.js";
import { REDACTED, REDACTED_NUMBER, REDACTED_SSN, findSsns, redactSensitive, redactTranscript } from "../src/services/pci.js";
import { log } from "../src/log.js";
import { RecordingRegistry, type RecordingKind } from "../src/compliance/recordings.js";
import { DEFAULT_RETENTION_DAYS, runRetention, type RecordingDeleter } from "../src/compliance/retention.js";
import { ACTIONS, ROLES, authorize, requestAccess } from "../src/compliance/access.js";
import { loadConfig } from "../src/config.js";
import { CallQueue } from "../src/services/queue.js";

const DAY = 24 * 3600_000;
const sid = (c: string) => "RE" + c.repeat(32);

describe("Social Security numbers", () => {
  it("finds the usual written forms", () => {
    for (const ok of ["123-45-6789", "123 45 6789", "123456789", "my number is 078-05-1120 ok"]) expect(findSsns(ok)).toHaveLength(1);
  });
  it("ignores shapes that can never be an SSN", () => {
    for (const bad of ["000-12-3456", "666-12-3456", "900-12-3456", "987-65-4321", "123-00-6789", "123-45-0000", "123-45 6789"]) expect(findSsns(bad)).toEqual([]);
  });
  it("does not mistake the numbers this system really uses", () => {
    for (const harmless of ["10000001", "+15555550100", "5555550100", "100002", "2026-11-17", "CA00000000000000000000000000000001", "1234567890", "12345678"]) {
      expect(findSsns(harmless)).toEqual([]);
    }
  });
  it("redacts them, and card numbers, in the same sentence", () => {
    const out = redactSensitive("ssn 123-45-6789 and card 4242 4242 4242 4242 end");
    expect(out).toBe(`ssn ${REDACTED_SSN} and card ${REDACTED} end`);
  });
  it("the logger scrubs them too, in text and as plain numbers", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      log("info", "caller said 123-45-6789", { n: 123456789, policy: "10000001" });
    } finally {
      console.log = orig;
    }
    expect(lines.join("")).not.toContain("6789");
    expect(lines.join("")).toContain("10000001");
  });
});

describe("transcripts: numbers read aloud", () => {
  it("replaces a card number spoken as words, keeping the rest of the sentence", () => {
    const t = redactTranscript("my card is four two four two four two four two four two four two four two four two thanks");
    expect(t).toBe(`my card is ${REDACTED_NUMBER} thanks`);
  });
  it("handles numerals, 'oh' for zero, mixed forms and punctuation", () => {
    expect(redactTranscript("it is one two three, four five six, seven eight nine.")).toContain(REDACTED_NUMBER);
    expect(redactTranscript("4 2 4 2 four two four two four")).toBe(REDACTED_NUMBER);
    expect(redactTranscript("oh one two three four five six seven eight")).toBe(REDACTED_NUMBER);
  });
  it("leaves ordinary sentences with a few numbers alone", () => {
    for (const fine of ["I have two policies and nine claims", "call me at five five five", "one two three four five six seven eight", "the claim number is one hundred", "I am in room four"]) {
      expect(redactTranscript(fine)).toBe(fine);
    }
  });
  it("also catches digit forms and keeps spacing around the removed run", () => {
    expect(redactTranscript("ssn is 123-45-6789 ok")).toBe(`ssn is ${REDACTED_SSN} ok`);
    expect(redactTranscript("before one two three four five six seven eight nine after")).toBe(`before ${REDACTED_NUMBER} after`);
  });
});

describe("the recordings register", () => {
  const reg = () => new RecordingRegistry(":memory:");
  const base = { kind: "voicemail" as RecordingKind, consentBasis: "announced_before_record" as const, retainDays: 90 };

  it("writes the deletion deadline the moment a recording is registered", () => {
    const r = reg().register({ sid: sid("a"), ref: "200001", ...base }, new Date("2026-11-17T15:00:00Z"));
    expect(r).toMatchObject({ kind: "voicemail", ref: "200001", status: "registered", legalHold: false, consentBasis: "announced_before_record" });
    expect(new Date(r.retainUntil).getTime() - new Date(r.createdAt).getTime()).toBe(90 * DAY);
  });
  it("refuses nonsense: a bad id, an unknown kind, a zero or fractional retention", () => {
    const g = reg();
    expect(() => g.register({ sid: "nope", ...base })).toThrow();
    expect(() => g.register({ sid: sid("a"), ...base, kind: "podcast" as never })).toThrow();
    expect(() => g.register({ sid: sid("a"), ...base, consentBasis: "trust me" as never })).toThrow();
    expect(() => g.register({ sid: sid("a"), ...base, retainDays: 0 })).toThrow();
    expect(() => g.register({ sid: sid("a"), ...base, retainDays: 1.5 })).toThrow();
  });
  it("registering the same recording twice keeps the first record and its deadline", () => {
    const g = reg();
    const first = g.register({ sid: sid("a"), ...base }, new Date("2026-01-01T00:00:00Z"));
    const second = g.register({ sid: sid("a"), ...base, retainDays: 9999 }, new Date("2026-06-01T00:00:00Z"));
    expect(second.retainUntil).toBe(first.retainUntil);
  });
  it("learns when the file is ready, and never brings a deleted one back", () => {
    const g = reg();
    g.register({ sid: sid("a"), ...base });
    g.markStatus(sid("a"), "ready", 42);
    expect(g.get(sid("a"))).toMatchObject({ status: "ready", durationSec: 42 });
    g.markDeleted(sid("a"), new Date());
    g.markStatus(sid("a"), "ready", 99);
    expect(g.get(sid("a"))!.status).toBe("deleted");
  });
  it("the audit trail can never be edited or deleted", () => {
    const g = reg();
    g.logEvent({ sid: sid("a"), who: "x", role: "agent", action: "listen", reason: "because", granted: true });
    const db = (g as unknown as { db: { exec(sql: string): void } }).db;
    expect(() => db.exec("UPDATE recording_events SET who = 'y'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM recording_events")).toThrow(/append-only/);
  });
});

describe("the retention job", () => {
  const T0 = new Date("2026-01-01T00:00:00Z");
  function setup() {
    const g = new RecordingRegistry(":memory:");
    const make = (c: string, kind: RecordingKind, days: number) => g.register({ sid: sid(c), kind, consentBasis: "announced_before_record", retainDays: days }, T0);
    return { g, make };
  }
  const fakeDeleter = (behaviour: (s: string) => "deleted" | "already_gone" | Error = () => "deleted") => {
    const calls: string[] = [];
    const d: RecordingDeleter = {
      async delete(s) {
        calls.push(s);
        const r = behaviour(s);
        if (r instanceof Error) throw r;
        return r;
      },
    };
    return { d, calls };
  };

  it("deletes what is due, leaves what is not, and records why in the audit trail", async () => {
    const { g, make } = setup();
    make("a", "voicemail", 90);
    make("b", "voicemail", 400);
    const { d, calls } = fakeDeleter();
    const out = await runRetention(g, d, new Date(T0.getTime() + 100 * DAY));
    expect(out.deleted).toEqual([sid("a")]);
    expect(calls).toEqual([sid("a")]);
    expect(g.get(sid("a"))).toMatchObject({ status: "deleted", deletedAt: expect.any(String) });
    expect(g.get(sid("b"))!.status).toBe("registered");
    expect(g.events(sid("a"))[0]).toMatchObject({ role: "system", action: "delete", granted: true });
    expect(g.events(sid("a"))[0].reason).toContain("retention: voicemail");
  });
  it("never deletes anything under legal hold, even long after its date, and says so", async () => {
    const { g, make } = setup();
    make("a", "agent_call", 90);
    g.setHold(sid("a"), true, "litigation hold, case 26-114");
    const { d, calls } = fakeDeleter();
    const out = await runRetention(g, d, new Date(T0.getTime() + 1000 * DAY));
    expect(calls).toEqual([]);
    expect(out.held).toEqual([sid("a")]);
    g.setHold(sid("a"), false, null);
    expect((await runRetention(g, d, new Date(T0.getTime() + 1000 * DAY))).deleted).toEqual([sid("a")]); // released: now it goes
  });
  it("one failure does not stop the others; failures are retried on the next run", async () => {
    const { g, make } = setup();
    make("a", "voicemail", 1);
    make("b", "voicemail", 1);
    let fail = true;
    const { d } = fakeDeleter((s) => (s === sid("a") && fail ? new Error("503 from provider") : "deleted"));
    const out = await runRetention(g, d, new Date(T0.getTime() + 2 * DAY));
    expect(out.deleted).toEqual([sid("b")]);
    expect(out.failed).toEqual([{ sid: sid("a"), error: "503 from provider" }]);
    expect(g.get(sid("a"))).toMatchObject({ status: "delete_failed", deleteAttempts: 1, lastError: "503 from provider" });
    fail = false;
    const again = await runRetention(g, d, new Date(T0.getTime() + 3 * DAY));
    expect(again.deleted).toEqual([sid("a")]);
    expect(g.get(sid("a"))).toMatchObject({ status: "deleted", lastError: null });
  });
  it("counts a recording the provider no longer has as done", async () => {
    const { g, make } = setup();
    make("a", "voicemail", 1);
    const out = await runRetention(g, fakeDeleter(() => "already_gone").d, new Date(T0.getTime() + 2 * DAY));
    expect(out.alreadyGone).toEqual([sid("a")]);
    expect(g.get(sid("a"))!.status).toBe("deleted");
  });
  it("is safe to run twice", async () => {
    const { g, make } = setup();
    make("a", "voicemail", 1);
    const { d, calls } = fakeDeleter();
    await runRetention(g, d, new Date(T0.getTime() + 2 * DAY));
    await runRetention(g, d, new Date(T0.getTime() + 3 * DAY));
    expect(calls).toHaveLength(1);
  });
  it("a dry run reports what WOULD go and changes nothing: not the provider, not the register, not the audit trail", async () => {
    const { g, make } = setup();
    make("a", "voicemail", 1);
    const { d, calls } = fakeDeleter();
    const out = await runRetention(g, d, new Date(T0.getTime() + 2 * DAY), { dryRun: true });
    expect(out.deleted).toEqual([sid("a")]);
    expect(calls).toEqual([]);
    expect(g.get(sid("a"))!.status).toBe("registered");
    expect(g.events()).toEqual([]);
  });
  it("has a deadline for every kind, and an unexplained recording is kept the shortest", () => {
    expect(Object.keys(DEFAULT_RETENTION_DAYS).sort()).toEqual(["agent_call", "claim_description", "unknown", "voicemail"]);
    expect(DEFAULT_RETENTION_DAYS.unknown).toBeLessThan(DEFAULT_RETENTION_DAYS.voicemail);
  });
});

describe("who may do what with a recording", () => {
  const g = () => {
    const r = new RecordingRegistry(":memory:");
    for (const [c, k] of [["a", "voicemail"], ["b", "agent_call"], ["c", "claim_description"]] as const) r.register({ sid: sid(c), kind: k, consentBasis: "announced_before_record", retainDays: 90 });
    return r;
  };
  it("the permission table, exhaustively: every role, action and kind", () => {
    // Written independently of the policy code, as a statement of intent:
    //   compliance: everything. supervisor: listen to anything. agent: listen to messages left for the team only. admin: nothing.
    const intended = (role: string, action: string, kind: RecordingKind) =>
      role === "compliance" ? true
      : role === "supervisor" ? action === "listen"
      : role === "agent" ? action === "listen" && (kind === "voicemail" || kind === "claim_description")
      : false;
    const kinds: RecordingKind[] = ["claim_description", "voicemail", "agent_call", "unknown"];
    for (const role of ROLES) for (const action of ACTIONS) for (const kind of kinds) {
      expect(authorize(role, action, kind), `${role} ${action} ${kind}`).toBe(intended(role, action, kind));
    }
  });
  it("administrators who run the system cannot listen to customers or delete their recordings", () => {
    for (const action of ACTIONS) for (const kind of ["voicemail", "agent_call", "claim_description", "unknown"] as RecordingKind[]) expect(authorize("admin", action, kind)).toBe(false);
  });
  it("an unknown role or action is simply refused", () => {
    expect(authorize("intern", "listen", "voicemail")).toBe(false);
    expect(authorize("compliance", "teleport", "voicemail")).toBe(false);
  });
  it("grants are logged with who and why", () => {
    const reg = g();
    const r = requestAccess(reg, { sid: sid("a"), who: "maria", role: "supervisor", action: "listen", reason: "quality review of complaint 4471" }, new Date("2026-11-17T15:00:00Z"));
    expect(r.granted).toBe(true);
    expect(reg.events(sid("a"))).toEqual([expect.objectContaining({ who: "maria", role: "supervisor", action: "listen", granted: true, reason: "quality review of complaint 4471" })]);
  });
  it("refusals are logged too, with the reason they were refused", () => {
    const reg = g();
    const r = requestAccess(reg, { sid: sid("b"), who: "sam", role: "agent", action: "listen", reason: "just curious about it" });
    expect(r).toMatchObject({ granted: false });
    expect(reg.events(sid("b"))[0]).toMatchObject({ granted: false, who: "sam" });
    expect(reg.events(sid("b"))[0].reason).toContain("DENIED");
  });
  it("needs a named user and a real reason", () => {
    const reg = g();
    for (const bad of [{ who: "", reason: "a perfectly good reason" }, { who: "dana", reason: "" }, { who: "dana", reason: "because" }]) {
      expect(requestAccess(reg, { sid: sid("a"), role: "compliance", action: "listen", ...bad }).granted).toBe(false);
    }
  });
  it("refuses unknown and already-deleted recordings", () => {
    const reg = g();
    expect(requestAccess(reg, { sid: sid("z"), who: "dana", role: "compliance", action: "listen", reason: "checking a complaint" })).toMatchObject({ granted: false, why: "no such recording" });
    reg.markDeleted(sid("a"), new Date());
    expect(requestAccess(reg, { sid: sid("a"), who: "dana", role: "compliance", action: "listen", reason: "checking a complaint" })).toMatchObject({ granted: false, why: "already deleted" });
  });
});

describe("recordings on calls", () => {
  let srv: TestServer;
  let registry: RecordingRegistry;
  let state: MemoryStateStore;
  let repo: SqliteRepo;
  let queue: CallQueue;
  let now = OPEN;
  afterEach(() => srv?.close());

  async function boot(over: Partial<typeof baseConfig> & { recordAgentCalls?: boolean } = {}, at = OPEN) {
    now = at;
    registry = new RecordingRegistry(":memory:");
    state = new MemoryStateStore();
    repo = new SqliteRepo(":memory:");
    queue = new CallQueue(() => now.getTime());
    srv = await startApp({ clock: () => now, recordings: registry, state, repo, queue }, { ...baseConfig, ...over });
  }
  const injuryFreeClaim = async (c: Caller) => {
    await c.press("2");
    await c.press("1");
    await c.press("10000002");
    await c.press("11102026");
    await c.press("1");
    await c.press("2"); // nobody hurt
    return c;
  };

  it("a claim description is registered with its owner, reason and deadline, and asks Twilio to say when it is ready", async () => {
    await boot();
    const c = await injuryFreeClaim(await new Caller(srv, "+15555550199").dial());
    expect(c.last.raw).toContain("recordingStatusCallback=\"https://ivr.example.com/rec/status?kind=claim_description\"");
    await c.record(sid("c"));
    const rec = registry.get(sid("c"))!;
    expect(rec).toMatchObject({ kind: "claim_description", consentBasis: "announced_before_record", status: "registered" });
    expect(rec.ref).toMatch(/^1000\d\d$/);
    expect(new Date(rec.retainUntil).getTime() - now.getTime()).toBe(DEFAULT_RETENTION_DAYS.claim_description * DAY);
  });
  it("a forged recording id is not registered", async () => {
    await boot();
    const c = await injuryFreeClaim(await new Caller(srv, "+15555550199").dial());
    await c.record("../../etc/passwd");
    expect(registry.list()).toEqual([]);
  });
  it("a voicemail says it will be recorded BEFORE the beep, and is registered", async () => {
    await boot({}, CLOSED);
    const c = await new Caller(srv, "+15555550101").dial();
    await c.press("1");
    expect(c.hearsAll).toContain("This message will be recorded.");
    expect(c.last.raw).toContain("/rec/status?kind=voicemail");
    await c.record(sid("d"));
    expect(registry.get(sid("d"))).toMatchObject({ kind: "voicemail", ref: "200001", consentBasis: "announced_before_record" });
  });

  describe("calls with an agent", () => {
    it("are NOT recorded by default, and nobody is asked anything", async () => {
      await boot();
      const c = await new Caller(srv).dial();
      await c.press("0");
      expect(c.last.dial).toBe(AGENT);
      expect(c.rawLog.join("")).not.toMatch(/record=/i);
      expect(c.hearsAll).not.toContain("may be recorded");
    });
    it("when switched on: announce first, and a caller who stays on the line is recorded from answer, with a callback", async () => {
      await boot({ recordAgentCalls: true });
      const c = await new Caller(srv).dial();
      await c.press("0");
      expect(c.last.says.join(" ")).toContain("This call may be recorded for quality and training.");
      expect(c.last.says.join(" ")).toContain("press 2");
      expect(c.last.dial).toBeUndefined(); // not connected yet: still asking
      await c.silence(); // said nothing and stayed on the line
      expect(c.last.dial).toBe(AGENT);
      expect(c.last.raw).toContain('record="record-from-answer-dual"');
      expect(c.last.raw).toContain("recordingStatusCallback=\"https://ivr.example.com/rec/status?kind=agent_call\"");
      expect(state.get(c.callSid).recordingChoice).toBe("recorded");
    });
    it("pressing 2 declines: the call connects and is not recorded", async () => {
      await boot({ recordAgentCalls: true });
      const c = await new Caller(srv).dial();
      await c.press("0");
      await c.press("2");
      expect(c.hearsAll).toContain("This call will not be recorded.");
      expect(c.last.dial).toBe(AGENT);
      expect(c.last.raw).not.toMatch(/record=/i);
      expect(state.get(c.callSid).recordingChoice).toBe("declined");
    });
    it("is asked once per call, not on every redirect", async () => {
      await boot({ recordAgentCalls: true });
      const c = await new Caller(srv).dial();
      await c.press("0");
      await c.press("2");
      expect(c.hearsAll.split("may be recorded for quality").length - 1).toBe(1);
    });
    it("no recording choice on file means NO recording, even when recording is switched on (fail safe)", async () => {
      await boot({ recordAgentCalls: true });
      const c = new Caller(srv); // never went through the notice
      const ctx = { reason: "general" as const, urgent: false, verified: false, queuedAt: now.getTime() };
      state.update(c.callSid, { handoff: ctx, handoffState: "waiting" });
      queue.join(c.callSid, ctx);
      await c.post("/svc/handoff/hold");
      expect(c.last.dial).toBe(AGENT);
      expect(c.last.raw).not.toMatch(/record=/i);
    });
    it("Twilio's callback registers the recording with the basis the caller gave", async () => {
      await boot({ recordAgentCalls: true });
      const c = await new Caller(srv).dial();
      await c.press("0");
      await c.silence();
      await c.post("/rec/status?kind=agent_call", { RecordingSid: sid("e"), RecordingStatus: "completed", RecordingDuration: "125" });
      expect(c.status).toBe(204);
      expect(registry.get(sid("e"))).toMatchObject({ kind: "agent_call", consentBasis: "announced_continue", status: "ready", durationSec: 125 });
    });
  });

  describe("the recording status webhook", () => {
    it("answers 204, marks absent recordings, and registers unknown ones with the shortest retention", async () => {
      await boot();
      const c = await new Caller(srv).dial();
      await c.post("/rec/status", { RecordingSid: sid("f"), RecordingStatus: "absent" });
      expect(c.status).toBe(204);
      expect(registry.get(sid("f"))).toMatchObject({ kind: "unknown", status: "absent", consentBasis: "unknown" });
      expect(new Date(registry.get(sid("f"))!.retainUntil).getTime() - now.getTime()).toBe(DEFAULT_RETENTION_DAYS.unknown * DAY);
    });
    it("ignores malformed ids and unknown kinds safely", async () => {
      await boot();
      const c = await new Caller(srv).dial();
      await c.post("/rec/status?kind=%3Cscript%3E", { RecordingSid: "not-a-recording", RecordingStatus: "completed" });
      expect(c.status).toBe(204);
      expect(registry.list()).toEqual([]);
      await c.post("/rec/status?kind=..%2F..%2Fx", { RecordingSid: sid("g"), RecordingStatus: "completed", RecordingDuration: "abc" });
      expect(registry.get(sid("g"))).toMatchObject({ kind: "unknown", durationSec: null });
    });
    it("refuses anyone who is not Twilio (no signature)", async () => {
      await boot();
      const res = await fetch(`${srv.base}/rec/status`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ RecordingSid: sid("h") }).toString() });
      expect(res.status).toBe(403);
      const bad = await fetch(`${srv.base}/rec/status`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilio.getExpectedTwilioSignature("wrong", "https://x/y", {}) }, body: "RecordingSid=" + sid("h") });
      expect(bad.status).toBe(403);
      expect(registry.list()).toEqual([]);
    });
  });

  it("recording inventory: only claim descriptions, voicemail and (when switched on) agent calls are ever recorded", async () => {
    await boot();
    const c = await new Caller(srv, "+15555550101").dial(); // Alex? no: Jordan; recognised caller
    await c.press("1"); // policy -> login
    await c.press("07021990");
    await c.press("9");
    await c.press("3"); // billing
    await c.press("9");
    await c.say("pay my bill", 0.95);
    await c.press("9");
    await c.press("4"); // quote placeholder
    await c.press("0"); // agent
    expect(c.rawLog.join("")).not.toMatch(/<Record|record=/i);
  });
});

describe("settings", () => {
  const env = { TWILIO_AUTH_TOKEN: "x" };
  it("agent calls are not recorded unless switched on", () => {
    expect(loadConfig(env).recordAgentCalls).toBe(false);
    expect(loadConfig({ ...env, RECORD_AGENT_CALLS: "true" }).recordAgentCalls).toBe(true);
    expect(loadConfig({ ...env, RECORD_AGENT_CALLS: "yes" }).recordAgentCalls).toBe(false); // only exactly "true" counts
  });
  it("retention days default sensibly and can be overridden within bounds", () => {
    expect(loadConfig(env).retentionDays!).toEqual(DEFAULT_RETENTION_DAYS);
    expect(loadConfig({ ...env, RETENTION_VOICEMAIL_DAYS: "30" }).retentionDays!.voicemail).toBe(30);
    for (const bad of ["0", "-5", "abc", "3651", "1.5"]) expect(() => loadConfig({ ...env, RETENTION_AGENT_CALL_DAYS: bad })).toThrow(/RETENTION_AGENT_CALL_DAYS/);
  });
  it("real deletion needs an explicit live mode and an account", () => {
    expect(loadConfig(env).retentionMode).toBe("dry-run");
    expect(() => loadConfig({ ...env, RETENTION_MODE: "yolo" })).toThrow(/RETENTION_MODE/);
    expect(() => loadConfig({ ...env, RETENTION_MODE: "live" })).toThrow(/ACCOUNT_SID/);
    expect(loadConfig({ ...env, RETENTION_MODE: "live", TWILIO_ACCOUNT_SID: "AC1" }).retentionMode).toBe("live");
  });
});
