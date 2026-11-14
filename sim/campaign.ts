// Run a small demo campaign through the compliance gate. Nothing is dialled: it uses a "dry run" caller that only
// records what WOULD have been placed. Everything lives in memory and is thrown away at the end.
//
//   npm run campaign                                  informational payment reminder, Tuesday 10 a.m. New York
//   npm run campaign -- --kind marketing              a renewal promotion (needs written consent)
//   npm run campaign -- --at 2026-11-18T05:30:00Z     pick the moment (UTC): 9:30 p.m. Pacific is 05:30Z
//   npm run campaign -- --promo                       an "informational" script that sneaks in an offer
import { CampaignRunner } from "../src/outbound/runner.js";
import { DryRunCaller } from "../src/outbound/caller.js";
import { DEFAULT_RULES } from "../src/outbound/gate.js";
import { OutboundStore } from "../src/outbound/store.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const marketing = arg("kind") === "marketing";
const promo = process.argv.includes("--promo");
const now = new Date(arg("at") ?? "2026-11-17T15:00:00Z"); // Tuesday 10:00 a.m. New York
const ourNumber = "+15555550190";

const store = new OutboundStore(":memory:");
const hash = "a".repeat(32); // stands in for the fingerprint of the consent text shown to each person
const longAgo = new Date("2026-10-01T12:00:00Z");

const campaign = store.createCampaign(
  marketing
    ? { name: "Renewal promotion", purpose: "marketing", consentScope: "marketing", scriptText: "We have a new renewal offer for your policy." }
    : { name: "Payment reminder", purpose: "informational", consentScope: "payment_reminders", scriptText: promo ? "Your payment is coming up. Renew now and save twenty percent with our special offer." : "This is a courtesy reminder that a payment on your Harborline account is coming up." },
  longAgo,
);
const scope = campaign.consentScope;
const consent = (phone: string, kind: "express" | "written") => store.addConsent({ phone, kind, scope, method: "web_form", evidenceRef: `form-${phone.slice(-4)}`, disclosureHash: hash }, longAgo);

const people: { phone: string; note: string; zone?: string }[] = [
  { phone: "+15555550101", note: "has consent, lives in New York", zone: "America/New_York" },
  { phone: "+15555550102", note: "never gave consent", zone: "America/New_York" },
  { phone: "+15555550103", note: "consented, later pressed 9 (do not call)", zone: "America/New_York" },
  { phone: "+15555550104", note: "has consent, lives in California", zone: "America/Los_Angeles" },
  { phone: "+15555550105", note: "has consent, location unknown" },
  { phone: "+15555550106", note: "has consent, already called twice this week", zone: "America/New_York" },
  { phone: "+15555550107", note: marketing ? "only EXPRESS consent (marketing needs written)" : "has consent, withdrew it last week", zone: "America/New_York" },
  { phone: "+15555550108", note: "on the National Do Not Call list, no written agreement", zone: "America/New_York" },
];
for (const p of people) store.addContact(campaign.id, p.phone, p.zone);
for (const p of people) {
  if (p.phone.endsWith("0102") || p.phone.endsWith("0108")) continue;
  consent(p.phone, marketing && p.phone.endsWith("0107") ? "express" : "written");
}
store.addDnc("+15555550103", "keypress_opt_out", new Date("2026-10-20T12:00:00Z"));
if (!marketing) store.revoke("+15555550107", "all", "customer_request", new Date("2026-11-10T12:00:00Z"));
for (let i = 0; i < 2; i++) {
  const a = store.createAttempt(campaign.id + 99, "+15555550106", new Date(now.getTime() - (i + 1) * 24 * 3600_000));
  store.setCallSid(a.id, "CA" + String(i + 1).padStart(32, "0"), new Date(now.getTime() - (i + 1) * 24 * 3600_000));
}
store.loadNationalDnc(["+15555550108"], new Date(now.getTime() - 24 * 3600_000));

const caller = new DryRunCaller();
const runner = new CampaignRunner(store, caller, { rules: { ...DEFAULT_RULES, from: ourNumber }, publicBaseUrl: "https://ivr.example.com", cps: 1000, sleep: async () => {} }, () => now);
console.log(`\nCampaign "${campaign.name}" (${campaign.purpose}), clock = ${now.toISOString()}`);
const summary = await runner.run(campaign.id);

console.log("\nWho                  Decision   Why");
for (const p of people) {
  const blocked = summary.blocked.find((b) => b.phone === p.phone);
  console.log(`${p.phone}  ${blocked ? "BLOCKED  " : "allowed  "}  ${blocked ? blocked.reason : "would be called"}   (${p.note})`);
}
console.log(`\n${summary.placed} call(s) would be placed, ${summary.blocked.length} blocked. Nothing was dialled.`);
