// Scripted phone call against your running server, signed like Twilio would.
//   npm run call -- 1        press 1 at the first menu
//   npm run call -- 9 -      press 9 (invalid), then stay silent ("-" = silence)
//   npm run call -- - - -    silence three times (watch the give-up)
// It follows <Gather> and <Redirect> like the real platform, and stops at <Dial>, <Hangup>, or when
// your key list runs out ("caller hangs up").
import twilio from "twilio";
import { loadConfig } from "../src/config.js";
import { parseTwiml } from "./twiml.js";

const config = loadConfig();
const keys = process.argv.slice(2);
const callSid = "CA" + Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);

async function post(path: string, extra: Record<string, string> = {}) {
  const params = { CallSid: callSid, From: "+15555550100", To: "+15555550199", Direction: "inbound", ...extra };
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
    } else {
      console.log(`  CALLER presses ${key}`);
      ({ path, xml } = await post(t.gatherAction, { Digits: key }));
    }
  } else if (t.redirect) {
    ({ path, xml } = await post(t.redirect));
  } else if (t.dial) {
    console.log(`  [call transfers to ${t.dial}]`);
    break;
  } else {
    console.log(t.hangup ? "  [call ends]" : "  [response had nothing to do]");
    break;
  }
}
