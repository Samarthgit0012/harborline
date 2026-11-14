// Scripted phone call against your running server, signed like Twilio would.
//   npm run call -- 1        press 1 at the first menu
//   npm run call -- 9 -      press 9 (invalid), then stay silent ("-" = silence)
//   npm run call -- - - -    silence three times (watch the give-up)
//   npm run call -- "say:file a claim@0.93"   SAY something (@confidence is optional) instead of pressing a key
//   npm run call -- 2 1 "" 11102026 1 2 rec     report a claim: claims, report, skip policy #, date,
//                                               car accident, nobody hurt, then leave a recording ("rec")
// Digits can be several at once (a date of birth is "03141985"). "" presses pound with nothing typed.
// Set SIM_FROM=+15555550101 to call from a different caller ID (default +15555550100 = Alex Rivera).
// It follows <Gather>, <Record> and <Redirect> like the real platform, and stops at <Dial>, <Hangup>,
// or when your key list runs out ("caller hangs up").
import twilio from "twilio";
import { loadConfig } from "../src/config.js";
import { parseTwiml } from "./twiml.js";

const config = loadConfig();
const keys = process.argv.slice(2);
const callSid = "CA" + Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);

async function post(path: string, extra: Record<string, string> = {}) {
  const params = { CallSid: callSid, From: process.env.SIM_FROM ?? "+15555550100", To: "+15555550199", Direction: "inbound", ...extra };
  const signature = twilio.getExpectedTwilioSignature(config.authToken, config.publicBaseUrl + path, params);
  const res = await fetch(`http://localhost:${config.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return { path, xml: await res.text() };
}

let { path, xml } = await post("/voice");
for (let step = 0; step < 60; step++) {
  const t = parseTwiml(xml);
  console.log(`\n[${path}]`);
  for (const s of t.says) console.log(`  IVR says: ${s}`);

  if (t.gatherAction) {
    const key = keys.shift();
    if (key === undefined) {
      console.log("  (caller hangs up: no more keys given)");
      break;
    }
    if (key === "-") {
      console.log("  CALLER: (silence)");
      if (!t.redirect) break;
      ({ path, xml } = await post(t.redirect));
    } else if (key.startsWith("say:")) {
      const [text, conf] = key.slice(4).split("@");
      if (!t.gatherInput?.includes("speech")) {
        console.log(`  (CALLER says "${text}", but this prompt only listens for keys, so nothing is heard)`);
        if (!t.redirect) break;
        ({ path, xml } = await post(t.redirect));
      } else {
        console.log(`  CALLER says: "${text}"${conf ? ` (confidence ${conf})` : " (no confidence sent)"}`);
        ({ path, xml } = await post(t.gatherAction, { SpeechResult: text, ...(conf ? { Confidence: conf } : {}) }));
      }
    } else {
      console.log(`  CALLER presses ${key}`);
      ({ path, xml } = await post(t.gatherAction, { Digits: key }));
    }
  } else if (t.recordAction) {
    const key = keys.shift();
    if (key === "rec") {
      console.log("  CALLER leaves a voice message");
      ({ path, xml } = await post(t.recordAction, { RecordingSid: "RE" + "c".repeat(32), RecordingDuration: "9" }));
    } else if (t.redirect) {
      console.log("  (caller hangs up or says nothing during the recording)");
      if (key === undefined) break;
      ({ path, xml } = await post(t.redirect));
    } else break;
  } else if (t.pay) {
    // In real life the caller now types their card into TWILIO. We never see those digits, only the outcome.
    console.log(`  [Twilio collects the card for $${t.pay.chargeAmount} and talks to the processor. This server sees none of it]`);
    const key = keys.shift();
    if (key === undefined) {
      console.log("  (caller hangs up mid-payment: no outcome given)");
      break;
    }
    const results: Record<string, string> = { "pay:success": "success", "pay:star": "caller-interrupted-with-star", "pay:fail": "too-many-failed-attempts", "pay:error": "payment-connector-error" };
    const result = results[key] ?? "success";
    console.log(`  TWILIO reports Result=${result}`);
    const action = new URL(t.pay.action);
    ({ path, xml } = await post(action.pathname + action.search, { Result: result, ...(result === "success" ? { PaymentConfirmationCode: "ch_simulated_123" } : {}) }));
  } else if (t.redirect) {
    ({ path, xml } = await post(t.redirect));
  } else if (t.dial) {
    console.log(`  [call rings the agent line ${t.dial}]`);
    if (t.whisperUrl) {
      // Twilio fetches this on the AGENT's leg after they answer, before the caller is connected.
      const w = await post(t.whisperUrl, { CallSid: "CA" + "e".repeat(32) });
      for (const s of parseTwiml(w.xml).says) console.log(`  AGENT HEARS (whisper): ${s}`);
    }
    break;
  } else {
    console.log(t.hangup ? "  [call ends]" : "  [response had nothing to do]");
    break;
  }
}
