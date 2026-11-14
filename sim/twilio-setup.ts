// Point your Twilio number at this server (so you never have to click through the Console each time a tunnel restarts).
//   npm run twilio:setup                 show what would change
//   npm run twilio:setup -- --apply      change it
// It sets ONLY the number's voice webhook (and its method). Nothing else on the number or the account is touched.
import twilio from "twilio";
import { loadConfig } from "../src/config.js";
import { expectedVoiceUrl } from "../src/ops/startup.js";

const config = loadConfig();
const apply = process.argv.includes("--apply");
const need = (v: unknown, name: string) => {
  if (!v) {
    console.error(`${name} is not set (see .env.example).`);
    process.exit(1);
  }
};
need(config.twilioAccountSid, "TWILIO_ACCOUNT_SID");
need(config.twilioPhoneNumber, "TWILIO_PHONE_NUMBER");
if (!config.publicBaseUrl.startsWith("https://") || /localhost|127\.0\.0\.1/.test(config.publicBaseUrl)) {
  console.error(`PUBLIC_BASE_URL is "${config.publicBaseUrl}". Twilio can only call a public https address. Start your tunnel first and set it.`);
  process.exit(1);
}

const client = twilio(config.twilioAccountSid!, config.authToken);
const found = await client.incomingPhoneNumbers.list({ phoneNumber: config.twilioPhoneNumber, limit: 1 });
if (!found.length) {
  console.error(`${config.twilioPhoneNumber} is not a number on this Twilio account.`);
  process.exit(1);
}
const n = found[0];
const want = expectedVoiceUrl(config.publicBaseUrl);
console.log(`Number ending ${config.twilioPhoneNumber!.slice(-4)}`);
console.log(`  voice webhook now:    ${n.voiceUrl || "(empty)"}  [${n.voiceMethod}]`);
console.log(`  voice webhook wanted: ${want}  [POST]`);

if (n.voiceUrl === want && (n.voiceMethod ?? "").toUpperCase() === "POST") {
  console.log("Already correct. Nothing to do.");
} else if (!apply) {
  console.log("Not changed. Run again with --apply to update it.");
} else {
  await client.incomingPhoneNumbers(n.sid).update({ voiceUrl: want, voiceMethod: "POST" });
  console.log("Updated. Call the number to try it.");
}
