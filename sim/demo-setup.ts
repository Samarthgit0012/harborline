// Put YOUR phone number on a practice customer, so that when you call from it the IVR recognises you and you can log in.
//   npm run demo:setup -- --customer +15551234567
//   npm run demo:setup -- --customer +15551234567 --second +15557654321 --dob 03141985 --outbound-consent
//   npm run demo:setup -- --reset                 remove the demo customers again
//
// --customer        your own phone (the one you will call FROM). Gets policy 90000001: an auto policy with a balance owing.
// --second          optional second customer (policy 90000002: home policy, nothing owing).
// --dob             the date of birth you will type to log in, as MMDDYYYY (default 03141985).
// --outbound-consent  also record that YOU consented to practice payment-reminder calls on --customer (for the outbound demo).
//                   Use this ONLY for a number you own. It writes a consent record like any other (and is as permanent).
import { loadConfig } from "../src/config.js";
import { disclosureHash } from "../src/outbound/live.js";
import { normalizeUsPhone } from "../src/outbound/phone.js";
import { OutboundStore } from "../src/outbound/store.js";
import { DEMO_POLICY_NUMBERS, demoPolicies, dobFromDigits, normalizeE164 } from "../src/ops/demo.js";
import { SqliteRepo } from "../src/services/policyRepo.js";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const config = loadConfig();
const dbPath = config.dbPath ?? "data/harborline.db";
const repo = new SqliteRepo(dbPath);

if (args.includes("--reset")) {
  for (const p of DEMO_POLICY_NUMBERS) repo.removePolicy(p);
  console.log("Demo customers removed. (Consent and do-not-call records are never deleted, by design.)");
  process.exit(0);
}

const customer = normalizeE164(flag("customer"));
if (!customer) {
  console.error("Give your own phone in international form, for example --customer +919876543210 or --customer +15551234567.");
  process.exit(1);
}
const dobDigits = flag("dob") ?? "03141985";
const dob = dobFromDigits(dobDigits);
if (!dob) {
  console.error("--dob must be a real date as MMDDYYYY, for example 03141985.");
  process.exit(1);
}
const second = flag("second") ? normalizeE164(flag("second")) : undefined;
if (flag("second") && !second) {
  console.error("--second is not a valid phone number (use international form, like +919876543210).");
  process.exit(1);
}

const demo = demoPolicies({ customer, second, dob });
for (const p of demo) repo.upsertPolicy(p);

console.log("Demo customers ready:");
for (const p of demo) console.log(`  policy ${p.policyNumber} (${p.product}) for the phone ending ${p.phone.slice(-4)}; balance $${(p.balanceCents / 100).toFixed(2)}`);
console.log(`\nTo log in on a call: press 3 (billing), then type your date of birth: ${dobDigits}`);

if (args.includes("--outbound-consent") && !normalizeUsPhone(customer)) {
  console.log("Skipped --outbound-consent: the outbound-calling part of this project handles US numbers only.");
} else if (args.includes("--outbound-consent")) {
  const store = new OutboundStore(dbPath);
  const wording = "Practice project: I own this phone number and I agree to receive practice payment reminder calls from the Harborline demo.";
  const c = store.addConsent({ phone: customer, kind: "express", scope: "payment_reminders", method: "in_person", evidenceRef: "demo-self-consent", disclosureHash: disclosureHash(wording) });
  console.log(`Recorded consent #${c.id} for practice payment-reminder calls to ${customer.slice(-4)} (you own it).`);
}
