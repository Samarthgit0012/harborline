import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVICE_NAMES, buildHarborlineFlow } from "../src/flows/harborline.js";
import { validateFlow } from "../src/flows/validate.js";
import type { Flow, MenuNode } from "../src/flows/types.js";
import {
  ACCEPT_CONFIDENCE, REJECT_CONFIDENCE, decide, hintsFor, matchIntent, normalize, parseConfidence, yesNo,
} from "../src/services/intent.js";
import { AGENT, Caller, OPEN, startApp, type TestServer } from "./caller.js";

const flow = buildHarborlineFlow({ agentNumber: AGENT });
const main = flow.nodes.main as MenuNode;
const intents = main.speech!.intents;
const idOf = (text: string) => matchIntent(text, intents).intent?.id;

describe("intent matching", () => {
  it("maps natural phrases to intents", () => {
    expect(idOf("I want to file a claim")).toBe("claim_new");
    expect(idOf("hi, uh, I need to pay my bill please")).toBe("billing");
    expect(idOf("what's my deductible")).toBe("policy");
    expect(idOf("can I talk to someone")).toBe("agent");
    expect(idOf("I got into a car accident")).toBe("claim_new");
    expect(idOf("I'd like a quote")).toBe("quote");
  });
  it("longest phrase wins, so specific beats general", () => {
    expect(idOf("claim")).toBe("claims"); // vague: goes to the claims submenu
    expect(idOf("claim status please")).toBe("claim_status");
    expect(idOf("I want a new policy")).toBe("quote"); // "new policy" (2 words) beats "policy" (1)
  });
  it("matches whole words only", () => {
    expect(idOf("a billion dollars")).toBeUndefined(); // "bill" inside "billion"
    expect(idOf("my cousin is a policeman")).toBeUndefined(); // "police" is not "policy" and "man" is no phrase
  });
  it("treats equal-length matches for different intents as ambiguous, never guessing", () => {
    const m = matchIntent("my policy and my claim", intents); // "my policy" vs "my claim": both 2 words
    expect(m.intent).toBeUndefined();
    expect(m.ambiguous).toBe(true);
  });
  it("returns nothing for unrelated speech and empty text", () => {
    expect(idOf("the weather is lovely today")).toBeUndefined();
    expect(idOf("")).toBeUndefined();
  });
  it("flags negation, because keyword matching cannot read it", () => {
    const m = matchIntent("I do not want to file a claim", intents);
    expect(m.intent?.id).toBe("claim_new"); // the naive match is wrong...
    expect(m.negated).toBe(true); // ...which is why `decide` never auto-accepts a negated utterance
    expect(decide(0.99, true)).toBe("confirm");
  });
  it("normalizes case, punctuation and apostrophes", () => {
    expect(normalize("  Don't  PANIC!!! ")).toBe("dont panic");
  });
  it("never throws on hostile input (random strings, huge strings)", () => {
    const alphabet = ["a", "b", "c", " ", "claim", "bill", "'", ".", "!", "\n", "\t", "\u0000", "🙂", "é", "7"];
    for (let n = 0; n < 300; n++) {
      const text = Array.from({ length: Math.floor(Math.random() * 40) }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
      expect(() => matchIntent(text, intents)).not.toThrow();
    }
    // Only the first 300 characters are ever read, so a huge utterance costs the same as a short one.
    expect(() => matchIntent("claim ".repeat(100_000), intents)).not.toThrow();
    expect(normalize("x".repeat(10_000)).length).toBe(300);
  });
});

describe("confidence policy", () => {
  it("accepts only a high score, confirms the middle, rejects the low", () => {
    expect(decide(0.95, false)).toBe("accept");
    expect(decide(ACCEPT_CONFIDENCE, false)).toBe("accept");
    expect(decide(0.65, false)).toBe("confirm");
    expect(decide(REJECT_CONFIDENCE, false)).toBe("confirm");
    expect(decide(0.3, false)).toBe("reject");
  });
  it("never auto-accepts when no score was sent (Twilio does not guarantee one)", () => {
    expect(decide(undefined, false)).toBe("confirm");
  });
  it("parses the Confidence field defensively", () => {
    expect(parseConfidence("0.93")).toBe(0.93);
    expect(parseConfidence("")).toBeUndefined();
    expect(parseConfidence("abc")).toBeUndefined();
    expect(parseConfidence("1.5")).toBeUndefined();
    expect(parseConfidence("-0.1")).toBeUndefined();
    expect(parseConfidence(undefined)).toBeUndefined();
  });
  it("reads yes/no answers, and refuses mixed ones", () => {
    expect(yesNo("yeah that's right")).toBe("yes");
    expect(yesNo("no")).toBe("no");
    expect(yesNo("nope, wrong")).toBe("no");
    expect(yesNo("yes no")).toBeNull();
    expect(yesNo("banana")).toBeNull();
  });
  it("builds hints from every phrase, de-duplicated", () => {
    const h = hintsFor(intents).split(", ");
    expect(h).toContain("file a claim");
    expect(new Set(h).size).toBe(h.length);
    expect(h.length).toBeLessThanOrEqual(500);
  });
});

describe("flow validation of speech", () => {
  const base = (): Flow => ({
    start: "m",
    closedStart: "m",
    nodes: {
      m: {
        kind: "menu",
        prompt: "p",
        options: { "1": { type: "hangup" } },
        maxRetries: 1,
        onGiveUp: { type: "hangup" },
        speech: { intro: "i", intents: [{ id: "a", label: "x", phrases: ["hello"], action: { type: "hangup" } }] },
      },
    },
  });
  const speechOf = (f: Flow) => (f.nodes.m as MenuNode).speech!;

  it("accepts the Harborline flow and a minimal speech flow", () => {
    expect(validateFlow(flow, SERVICE_NAMES)).toEqual([]);
    expect(validateFlow(base())).toEqual([]);
  });
  it("rejects a spoken action that goes to a node that does not exist", () => {
    const f = base();
    speechOf(f).intents[0].action = { type: "goto", node: "nowhere" };
    expect(validateFlow(f).join()).toContain('unknown node "nowhere"');
  });
  it("rejects an unknown service in a spoken action", () => {
    const f = base();
    speechOf(f).intents[0].action = { type: "service", name: "teleport", back: "m" };
    expect(validateFlow(f, ["fnol"]).join()).toContain('unknown service "teleport"');
  });
  it("rejects duplicate ids, empty phrase lists and over-long phrases", () => {
    const f = base();
    speechOf(f).intents.push({ id: "a", label: "y", phrases: [], action: { type: "hangup" } });
    speechOf(f).intents.push({ id: "b", label: "z", phrases: ["x".repeat(101)], action: { type: "hangup" } });
    const errs = validateFlow(f).join();
    expect(errs).toContain('duplicate speech intent "a"');
    expect(errs).toContain("has no phrases");
    expect(errs).toContain("over-100-character");
  });
  it("rejects speech enabled with no intents", () => {
    const f = base();
    speechOf(f).intents = [];
    expect(validateFlow(f).join()).toContain("no intents");
  });
  it("counts speech targets for reachability (a node only reachable by voice is still reachable)", () => {
    const f = base();
    f.nodes.hidden = { kind: "action", action: { type: "hangup" } };
    expect(validateFlow(f).join()).toContain("unreachable");
    speechOf(f).intents[0].action = { type: "goto", node: "hidden" };
    expect(validateFlow(f)).toEqual([]);
  });
});

describe("speech on a call", () => {
  let srv: TestServer;
  beforeEach(async () => {
    srv = await startApp({ clock: () => OPEN });
  });
  afterEach(() => srv.close());

  it("offers speech and keys together, with hints, at the main menu", async () => {
    const c = await new Caller(srv).dial();
    expect(c.last.gatherInput).toBe("dtmf speech");
    expect(c.last.gatherSpeechTimeout).toBe("auto");
    expect(c.last.gatherHints).toContain("file a claim");
    expect(c.last.gatherNumDigits).toBe(1);
    expect(c.hearsAll).toContain("You can say what you need");
    expect(c.hearsAll).toContain("press 1"); // the keypad still works, and is still described
  });
  it("keeps keypad-only menus keypad-only (the claims submenu and the after-hours menu)", async () => {
    const c = await new Caller(srv).dial();
    await c.press("2");
    expect(c.last.gatherInput).toBeUndefined();
  });

  it("a confident phrase skips the claims submenu and starts claim intake", async () => {
    const c = await new Caller(srv).dial();
    await c.say("I need to file a claim", 0.93);
    expect(c.hearsAll).toContain("I can take your claim report now");
  });
  it("a confident billing request still demands authentication (speech is a shortcut, not a bypass)", async () => {
    const c = await new Caller(srv, "+15555550199").dial(); // unknown number
    await c.say("pay my bill", 0.95);
    expect(c.hearsAll).toMatch(/policy number/i);
    expect(c.hearsAll).not.toMatch(/balance/i);
  });
  it("a confident request for an agent transfers", async () => {
    const c = await new Caller(srv).dial();
    await c.say("let me talk to someone", 0.9);
    expect(c.last.dial).toBe(AGENT);
  });
  it("a vague 'claim' goes to the claims submenu", async () => {
    const c = await new Caller(srv).dial();
    await c.say("claim", 0.9);
    expect(c.hearsAll).toContain("To report a new claim, press 1");
  });
  it("pressing a key still works, and a key beats speech if both arrive", async () => {
    const c = await new Caller(srv).dial();
    await c.post(c.last.gatherAction!, { Digits: "0", SpeechResult: "pay my bill", Confidence: "0.99" });
    await c.settle();
    expect(c.last.dial).toBe(AGENT);
  });

  it("an invalid key is NOT rescued by speech that arrives with it", async () => {
    const c = await new Caller(srv).dial();
    await c.post(c.last.gatherAction!, { Digits: "7", SpeechResult: "pay my bill", Confidence: "0.99" });
    await c.settle();
    expect(c.hearsAll).toContain("not a valid choice");
    expect(c.hearsAll).not.toMatch(/date of birth|policy number/i);
  });

  describe("middle confidence asks first", () => {
    it("confirms with yes (key 1) and then acts", async () => {
      const c = await new Caller(srv).dial();
      await c.say("pay my bill", 0.6);
      expect(c.last.says.join(" ")).toContain("Did you want billing?");
      expect(c.last.gatherAction).toContain("/confirm");
      await c.press("1");
      expect(c.hearsAll).toMatch(/date of birth/i); // caller ID recognised Alex, so we go straight to the birthday check
    });
    it("confirms with a spoken yes", async () => {
      const c = await new Caller(srv).dial();
      await c.say("talk to an agent", 0.6);
      await c.say("yes please", 0.9);
      expect(c.last.dial).toBe(AGENT);
    });
    it("a spoken no (or key 2) takes nothing, apologises, and re-offers the menu", async () => {
      const c = await new Caller(srv).dial();
      await c.say("talk to an agent", 0.6);
      await c.press("2");
      expect(c.last.dial).toBeUndefined();
      expect(c.hearsAll).toContain("Okay, sorry about that.");
      expect(c.last.gatherAction).toContain("/ivr/main/input");
    });
    it("silence at the confirmation is NOT a yes", async () => {
      const c = await new Caller(srv).dial();
      await c.say("talk to an agent", 0.6);
      await c.silence();
      expect(c.last.dial).toBeUndefined();
      expect(c.hearsAll).toContain("did not get that");
    });
    it("a missing Confidence field is treated as unsure", async () => {
      const c = await new Caller(srv).dial();
      await c.say("talk to an agent"); // no Confidence sent
      expect(c.last.says.join(" ")).toContain("Did you want to speak with an agent?");
    });
    it("a negated sentence is confirmed even at 0.99", async () => {
      const c = await new Caller(srv).dial();
      await c.say("I do not want to file a claim", 0.99);
      expect(c.last.says.join(" ")).toContain("Did you want to report a new claim?");
    });
    it("a guess can be answered only once (replaying the confirm route does nothing)", async () => {
      const c = await new Caller(srv).dial();
      await c.say("talk to an agent", 0.6);
      const confirmUrl = c.last.gatherAction!;
      await c.press("1");
      expect(c.last.dial).toBe(AGENT);
      await c.post(confirmUrl, { Digits: "1" }); // replay
      await c.settle();
      expect(c.last.dial).toBeUndefined();
      expect(c.last.gatherAction).toContain("/ivr/main/input"); // menu restarted instead
    });
    it("a forged confirm with no pending guess just restarts the menu", async () => {
      const c = await new Caller(srv).dial();
      await c.post("/ivr/main/confirm", { Digits: "1" });
      expect(c.last.dial).toBeUndefined();
      expect(c.last.gatherAction).toContain("/ivr/main/input");
    });
    it("a confirm for a menu without speech is refused safely", async () => {
      const c = await new Caller(srv).dial();
      await c.post("/ivr/claims/confirm", { Digits: "1" });
      expect(c.last.hangup).toBe(true);
    });
  });

  describe("failures fall back to the keypad, never to a dead end", () => {
    it("low confidence is treated as not heard", async () => {
      const c = await new Caller(srv).dial();
      await c.say("pay my bill", 0.2);
      expect(c.hearsAll).toContain("did not catch that");
      expect(c.last.gatherInput).toBe("dtmf speech"); // first miss: speech is still offered
    });
    it("unrelated speech is treated as not heard", async () => {
      const c = await new Caller(srv).dial();
      await c.say("banana bread recipe", 0.95);
      expect(c.hearsAll).toContain("did not catch that");
    });
    it("after two misses speech is switched off for the call and the keypad takes over", async () => {
      const c = await new Caller(srv).dial();
      await c.say("mumble mumble", 0.9);
      await c.say("mumble again", 0.9);
      expect(c.hearsAll).toContain("Let's use your keypad instead.");
      expect(c.last.gatherInput).toBeUndefined(); // dtmf only
      expect(c.hearsAll.split("You can say what you need").length - 1).toBe(2); // intro played twice, not a third time
      await c.press("0");
      expect(c.last.dial).toBe(AGENT);
    });
    it("a forged SpeechResult is ignored once speech is off", async () => {
      const c = await new Caller(srv).dial();
      await c.say("mumble", 0.9);
      await c.say("mumble", 0.9);
      await c.post(c.last.gatherAction!, { SpeechResult: "pay my bill", Confidence: "0.99" });
      await c.settle();
      expect(c.hearsAll).not.toMatch(/date of birth|policy number/i); // the spoken request was NOT acted on
      expect(c.hearsAll).toContain("trouble hearing you"); // it counted as a failed attempt (the retry cap was reached)
    });
    it("never traps the caller: repeated failures end at the agent", async () => {
      const c = await new Caller(srv).dial();
      await c.say("blah", 0.9);
      await c.say("blah", 0.9);
      await c.say("blah", 0.9);
      expect(c.hearsAll).toContain("trouble hearing you");
      expect(c.last.dial).toBe(AGENT);
    });
    it("silence still behaves exactly as before", async () => {
      const c = await new Caller(srv).dial();
      await c.silence();
      expect(c.hearsAll).toContain("I did not get your choice");
    });
  });

  it("does not log what the caller said", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      const c = await new Caller(srv).dial();
      await c.say("my policy number is 10000001 and I am Alex Rivera", 0.4);
      await c.say("zebra crossing", 0.9);
    } finally {
      console.log = orig;
    }
    const all = lines.join("\n");
    expect(all).toContain("speech_result");
    expect(all).not.toContain("10000001");
    expect(all).not.toContain("Alex");
    expect(all).not.toContain("zebra");
  });
});
