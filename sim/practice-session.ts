// A free practice phone. Runs the real call flow inside this process (nothing on the network, no Twilio account involved,
// so it cannot cost anything) and lets you answer each prompt by typing, like pressing keys on a phone.
// The CLI wrapper is sim/practice.ts; this file holds the session so tests can drive it too.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import twilio from "twilio";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import type { SmsSender } from "../src/services/sms.js";
import { parseTwiml, type ParsedTwiml } from "./twiml.js";

export interface PracticeIO {
  /** Show a line to the person practising. */
  write(line: string): void;
  /** Ask for one line of input. undefined = the input ended (like a hang-up). */
  read(prompt: string): Promise<string | undefined>;
}

export interface PracticeOptions {
  /** The number you "call from". Default +15555550100 (Alex Rivera, who owes money). */
  from?: string;
  /** Practise the after-hours menu instead of the open one. */
  closed?: boolean;
  /** Offer "pay by card" on the billing menu (the real server has it off until a Pay Connector exists). */
  pay?: boolean;
}

export const DEFAULT_CALLER = "+15555550100";
const SAMPLE_PHONES = ["+15555550100", "+15555550101", "+15555550102"];

export const PRACTICE_HELP = [
  "How to answer a prompt:",
  "  1  or  03141985      press those keys (a date of birth is typed as MMDDYYYY)",
  "  #                    press # with nothing typed (skips a question that offers it)",
  "  say pay my bill      SAY something (add @0.4 for low recogniser confidence: say pay my bill@0.4)",
  "  -                    stay silent until the prompt times out",
  "  rec                  at a voicemail / claim recording: leave a message",
  "  ok | star | fail | error   at a card payment: how Twilio reports the card step",
  "  bye                  hang up",
  "  ?                    show this help",
];

/** Run practice calls until the person quits (or the input ends). Returns nothing; everything goes through `io`. */
export async function runPractice(io: PracticeIO, opts: PracticeOptions = {}): Promise<void> {
  const from = opts.from ?? DEFAULT_CALLER;
  // A fake address that can never be reached: signatures are made and checked against it, nothing is ever sent there.
  const config: Config = {
    authToken: "practice-token-not-a-secret",
    publicBaseUrl: opts.pay ? "https://practice.invalid" : "http://practice.invalid",
    port: 0,
    agentNumber: "+15555550123",
    hoursMode: opts.closed ? "business" : "always-open",
    nowOverride: opts.closed ? new Date("2026-11-14T22:00:00Z") : undefined, // Saturday 5pm Eastern: closed
    payEnabled: !!opts.pay,
    outboundMode: "off",
  };

  const repo = new SqliteRepo(":memory:");
  const texts: string[] = [];
  const sms: SmsSender = {
    async send(to, body) {
      texts.push(`  TEXT MESSAGE to ***${to.slice(-4)}: ${body}`);
    },
  };
  const server: Server = createApp(config, { repo, sms }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  io.write("Practice phone: free, nothing leaves this computer, nothing is billed.");
  io.write(opts.closed ? "The business is CLOSED in this practice (Saturday 5pm)." : "The business is OPEN in this practice (any time of day).");
  io.write("\nPractice customers (caller number, then the date of birth to type at the login prompt):");
  for (const phone of SAMPLE_PHONES) {
    for (const p of repo.findByPhone(phone)) {
      const [y, m, d] = p.dob.split("-");
      io.write(`  ${phone}  ${p.holderName}, ${p.product}, balance $${(p.balanceCents / 100).toFixed(2)}, DOB ${m}${d}${y}${p.phone === from ? "   <- you are calling from this number" : ""}`);
    }
  }
  io.write("");
  for (const l of PRACTICE_HELP) io.write(l);

  try {
    for (;;) {
      await oneCall(io, { base, config, from, texts });
      const again = await io.read("\nCall again? Enter = yes, q = quit > ");
      if (again === undefined || /^\s*q/i.test(again)) break;
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  io.write("Practice over. Cost: $0.00.");
}

async function oneCall(io: PracticeIO, ctx: { base: string; config: Config; from: string; texts: string[] }): Promise<void> {
  const callSid = "CA" + Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);
  const post = async (path: string, extra: Record<string, string> = {}) => {
    const params = { CallSid: callSid, From: ctx.from, To: "+15555550199", Direction: "inbound", ...extra };
    const signature = twilio.getExpectedTwilioSignature(ctx.config.authToken, ctx.config.publicBaseUrl + path, params);
    const res = await fetch(ctx.base + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
    return { path, xml: await res.text() };
  };

  io.write(`\n--- ringing: calling from ${ctx.from} ---`);
  let { path, xml } = await post("/voice");
  for (let step = 0; step < 200; step++) {
    const t = parseTwiml(xml);
    // A step that only passes the caller on (no speech, no question) is plumbing: do not show it.
    if (t.says.length || t.gatherAction || t.recordAction || t.pay || t.dial) io.write(`\n[${path}]`);
    for (const s of t.says) io.write(`  IVR says: ${s}`);
    while (ctx.texts.length) io.write(ctx.texts.shift()!);

    if (t.gatherAction) {
      const answer = await ask(io, listensFor(t), acceptKeysOrSpeech);
      if (answer === undefined || answer === "bye") return hungUp(io);
      if (answer === "-") {
        io.write("  CALLER: (silence)");
        if (!t.redirect) return hungUp(io);
        ({ path, xml } = await post(t.redirect));
      } else if (/^say[: ]/i.test(answer)) {
        const [text, conf] = answer.slice(4).trim().split("@");
        if (!t.gatherInput?.includes("speech")) {
          io.write(`  (CALLER says "${text}", but this prompt only listens for keys, so nothing is heard)`);
          if (!t.redirect) return hungUp(io);
          ({ path, xml } = await post(t.redirect));
        } else {
          io.write(`  CALLER says: "${text}"${conf ? ` (confidence ${conf})` : " (no confidence sent)"}`);
          ({ path, xml } = await post(t.gatherAction, { SpeechResult: text, ...(conf ? { Confidence: conf } : {}) }));
        }
      } else {
        // "#" alone = pound with nothing typed. Otherwise a trailing # just ends the entry, as it does on a real phone.
        const digits = answer === "#" ? "" : answer.replace(/#$/, "");
        io.write(digits ? `  CALLER presses ${digits}` : "  CALLER presses #");
        ({ path, xml } = await post(t.gatherAction, { Digits: digits }));
      }
    } else if (t.recordAction) {
      const answer = await ask(io, "voicemail / recording: type rec to leave a message, - to say nothing", acceptRecording);
      if (answer === undefined || answer === "bye") return hungUp(io);
      if (answer === "rec") {
        io.write("  CALLER leaves a voice message");
        ({ path, xml } = await post(t.recordAction, { RecordingSid: "RE" + "c".repeat(32), RecordingDuration: "9" }));
      } else if (t.redirect) {
        io.write("  (caller says nothing during the recording)");
        ({ path, xml } = await post(t.redirect));
      } else return hungUp(io);
    } else if (t.pay) {
      io.write(`  [Twilio collects the card for $${t.pay.chargeAmount} and talks to the processor. This server sees none of it]`);
      const answer = await ask(io, "card step result: ok, star (caller pressed *), fail (too many bad tries), error (processor down)", acceptCardResult);
      if (answer === undefined || answer === "bye") return hungUp(io);
      const results: Record<string, string> = { ok: "success", star: "caller-interrupted-with-star", fail: "too-many-failed-attempts", error: "payment-connector-error" };
      const result = results[answer] ?? "success";
      io.write(`  TWILIO reports Result=${result}`);
      const action = new URL(t.pay.action);
      ({ path, xml } = await post(action.pathname + action.search, { Result: result, ...(result === "success" ? { PaymentConfirmationCode: "ch_simulated_123" } : {}) }));
    } else if (t.redirect) {
      ({ path, xml } = await post(t.redirect));
    } else if (t.dial) {
      io.write(`  [call rings the agent line ${t.dial}]`);
      if (t.whisperUrl) {
        // Twilio fetches this on the AGENT's leg after they answer, before the caller is connected.
        const w = await post(t.whisperUrl, { CallSid: "CA" + "e".repeat(32) });
        for (const s of parseTwiml(w.xml).says) io.write(`  AGENT HEARS (whisper): ${s}`);
      }
      io.write("  [the caller would now be connected to the agent: practice call ends here]");
      return;
    } else {
      io.write(t.hangup ? "  [call ends]" : "  [response had nothing to do]");
      return;
    }
  }
  io.write("  [stopped after 200 steps: a loop in the flow?]");
}

/** One line of input. "?" shows help and asks again; an empty line asks again (silence is "-", pound is "#"). */
async function ask(io: PracticeIO, hint: string, accept: (answer: string) => boolean = () => true): Promise<string | undefined> {
  io.write(`  (${hint})`);
  for (;;) {
    const line = await io.read("  you > ");
    if (line === undefined) return undefined;
    const answer = line.trim();
    if (answer === "?") {
      for (const l of PRACTICE_HELP) io.write(l);
      continue;
    }
    if (answer === "") {
      io.write("  Type a key, say <words>, - for silence, ? for help.");
      continue;
    }
    if (answer !== "bye" && !accept(answer)) {
      io.write("  A phone cannot send that here. Type ? for what works.");
      continue;
    }
    return answer;
  }
}

// What a caller can actually do at each kind of prompt. A keypad sends only 0-9, * and #.
const acceptKeysOrSpeech = (a: string) => a === "-" || /^say[: ]/i.test(a) || /^[0-9*#]+$/.test(a);
const acceptRecording = (a: string) => a === "rec" || a === "-";
const acceptCardResult = (a: string) => ["ok", "star", "fail", "error"].includes(a);

function listensFor(t: ParsedTwiml): string {
  const kinds = t.gatherInput?.includes("speech") ? (t.gatherInput.includes("dtmf") ? "keys or speech" : "speech only") : "keys only";
  const len = t.gatherNumDigits ? `, ${t.gatherNumDigits} digit${t.gatherNumDigits === 1 ? "" : "s"}` : "";
  return `listening: ${kinds}${len}`;
}

function hungUp(io: PracticeIO): void {
  io.write("  [caller hung up]");
}
