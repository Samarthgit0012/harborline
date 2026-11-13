// Local call simulator. Posts a Twilio-shaped webhook to YOUR server, correctly signed.
// Usage:  npm run sim                 -> valid signed request to /voice
//         npm run sim -- --forge      -> request with a wrong signature (expect 403)
//         npm run sim -- --unsigned   -> request with no signature header (expect 403)
import twilio from "twilio";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const args = new Set(process.argv.slice(2));
const path = "/voice";

const params: Record<string, string> = {
  CallSid: "CA" + "0".repeat(32),
  From: "+15555550100",
  To: "+15555550199",
  CallStatus: "ringing",
  Direction: "inbound",
};

const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
if (!args.has("--unsigned")) {
  headers["X-Twilio-Signature"] = args.has("--forge")
    ? "Zm9yZ2VkLXNpZ25hdHVyZQ=="
    : twilio.getExpectedTwilioSignature(config.authToken, config.publicBaseUrl + path, params);
}

const res = await fetch(`http://localhost:${config.port}${path}`, {
  method: "POST",
  headers,
  body: new URLSearchParams(params).toString(),
});
console.log(`HTTP ${res.status}`);
console.log(await res.text());
