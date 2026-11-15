// Have Twilio ring YOUR phone and connect you to the IVR, instead of you dialling the Twilio number.
// Handy when your own carrier charges for calling a foreign number: here Twilio makes the call and you just answer.
//   npm run demo:callme -- --to +919876543210            show what would happen
//   npm run demo:callme -- --to +919876543210 --apply    place the call
//
// Safety rules (this rings a real phone):
//   * It only rings a number you enrolled yourself with `npm run demo:setup` (a practice customer). Never a stranger.
//   * It is NOT the campaign dialer: no campaign, no consent record, no do-not-call logic. It is a practice call to
//     your own phone. Calling real customers goes through `npm run campaign` and its compliance gate, not this.
//   * On a Twilio trial account the number must also be a Verified Caller ID, or Twilio refuses the call.
import twilio from "twilio";
import { loadConfig } from "../src/config.js";
import { expectedVoiceUrl } from "../src/ops/startup.js";
import { DEMO_POLICY_NUMBERS, normalizeE164 } from "../src/ops/demo.js";
import { maskPhone } from "../src/log.js";
import { SqliteRepo } from "../src/services/policyRepo.js";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const config = loadConfig();
if (!config.twilioAccountSid) fail("TWILIO_ACCOUNT_SID is not set (see .env.example).");
if (!config.twilioPhoneNumber) fail("TWILIO_PHONE_NUMBER is not set (see .env.example).");
if (!config.publicBaseUrl.startsWith("https://") || /localhost|127\.0\.0\.1/.test(config.publicBaseUrl)) {
  fail(`PUBLIC_BASE_URL is "${config.publicBaseUrl}". Twilio can only reach a public https address: start your tunnel, then run this with PUBLIC_BASE_URL set to it.`);
}

const to = normalizeE164(flag("to"));
if (!to) fail("Give your own phone in international form, for example --to +919876543210.");

const repo = new SqliteRepo(config.dbPath ?? "data/harborline.db");
const enrolled = repo.findByPhone(to!).filter((p) => (DEMO_POLICY_NUMBERS as readonly string[]).includes(p.policyNumber));
if (!enrolled.length) {
  fail(`${maskPhone(to!)} is not a practice customer. Enrol it first (it must be your own phone):\n  npm run demo:setup -- --customer ${to}`);
}

const client = twilio(config.twilioAccountSid!, config.authToken);
const account = await client.api.accounts(config.twilioAccountSid!).fetch();
if (account.type === "Trial") {
  const verified = await client.outgoingCallerIds.list({ phoneNumber: to!, limit: 1 });
  if (!verified.length) {
    fail(
      `This is a Twilio TRIAL account, and ${maskPhone(to!)} is not a Verified Caller ID, so Twilio will refuse to ring it.\n` +
        "Verify it in the Console (Phone Numbers > Verified Caller IDs); the owner of the phone has to answer a verification call.",
    );
  }
}

const url = expectedVoiceUrl(config.publicBaseUrl);
console.log(`From ${maskPhone(config.twilioPhoneNumber!)} (your Twilio number) to ${maskPhone(to!)} (practice customer ${enrolled[0].policyNumber}).`);
console.log(`When answered, Twilio asks ${url} what to say, exactly as for an inbound call.`);
if (!args.includes("--apply")) {
  console.log("Not placed. Run again with --apply to ring the phone. (It uses your Twilio credit for the minutes you are on the line.)");
  process.exit(0);
}

const call = await client.calls.create({ to: to!, from: config.twilioPhoneNumber!, url, method: "POST", timeout: 30 });
console.log(`Ringing now (call ...${call.sid.slice(-6)}). Answer, press a key at Twilio's trial notice, then use the menu.`);
