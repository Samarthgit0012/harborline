// Manage and run REAL campaigns stored in your database (data/harborline.db). Whether anything is actually dialled
// is decided only by OUTBOUND_MODE in .env: off (refuses), dry-run (rings nobody), live (places real calls).
//
//   npm run campaign:admin -- consent +15551234567 payment_reminders written web_form form-2026-0001 consent-text.txt
//   npm run campaign:admin -- create "Payment reminder" informational payment_reminders "This is a courtesy reminder ..."
//   npm run campaign:admin -- contact 1 +15551234567 America/New_York
//   npm run campaign:admin -- registry national-dnc.txt          one phone number per line, from your registry download
//   npm run campaign:admin -- run 1
//   npm run campaign:admin -- report 1
//   npm run campaign:admin -- stop +15551234567                  put a number on the do-not-call list by hand
//
// "consent" takes the PATH of a text file containing the exact words the person agreed to; only its fingerprint is
// stored with the consent record. Use only numbers you own or have real permission to call.
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { DEFAULT_RULES } from "../src/outbound/gate.js";
import { disclosureHash, pickCaller } from "../src/outbound/live.js";
import { CampaignRunner } from "../src/outbound/runner.js";
import { OutboundStore, type ConsentKind, type ConsentMethod, type Purpose } from "../src/outbound/store.js";

const config = loadConfig();
const store = new OutboundStore(config.dbPath ?? "data/harborline.db");
const [cmd, ...a] = process.argv.slice(2);
const need = (n: number, usage: string) => {
  if (a.length < n) {
    console.error(`usage: ${usage}`);
    process.exit(1);
  }
};

switch (cmd) {
  case "consent": {
    need(6, "consent <phone> <scope> <express|written> <method> <evidenceRef> <disclosureTextFile>");
    const rec = store.addConsent({ phone: a[0], scope: a[1], kind: a[2] as ConsentKind, method: a[3] as ConsentMethod, evidenceRef: a[4], disclosureHash: disclosureHash(readFileSync(a[5], "utf8")) });
    console.log(`consent #${rec.id} recorded for ${rec.phone} (${rec.kind}, scope ${rec.scope})`);
    break;
  }
  case "create": {
    need(4, 'create <name> <informational|marketing> <consentScope> "<message>"');
    const c = store.createCampaign({ name: a[0], purpose: a[1] as Purpose, consentScope: a[2], scriptText: a[3] });
    console.log(`campaign #${c.id} created`);
    break;
  }
  case "contact": {
    need(2, "contact <campaignId> <phone> [timeZone]");
    const c = store.addContact(Number(a[0]), a[1], a[2]);
    console.log(c ? `added ${c.phone}` : "not a dialable US number: not added");
    break;
  }
  case "registry": {
    need(1, "registry <fileWithOneNumberPerLine>");
    const n = store.loadNationalDnc(readFileSync(a[0], "utf8").split(/\r?\n/), new Date());
    console.log(`loaded ${n} numbers; the gate will accept this copy for 31 days`);
    break;
  }
  case "stop": {
    need(1, "stop <phone>");
    store.addDnc(a[0], "agent_entered");
    store.revoke(a[0], "all", "agent_entered");
    store.cancelQueued(a[0]);
    console.log("recorded");
    break;
  }
  case "run": {
    need(1, "run <campaignId>");
    const caller = pickCaller(config); // refuses unless OUTBOUND_MODE is dry-run or live
    const runner = new CampaignRunner(store, caller, { rules: { ...DEFAULT_RULES, from: config.outboundFrom }, publicBaseUrl: config.publicBaseUrl });
    const s = await runner.run(Number(a[0]));
    console.log(`mode=${config.outboundMode}: ${s.placed} placed, ${s.failed} failed, ${s.blocked.length} blocked`);
    for (const b of s.blocked) console.log(`  blocked ${b.phone}: ${b.reason}`);
    break;
  }
  case "report": {
    need(1, "report <campaignId>");
    for (const d of store.decisions(Number(a[0]))) console.log(`${d.createdAt}  ${d.phone}  ${d.allowed ? "allowed" : `BLOCKED ${d.reason}`}${d.detail ? `  (${d.detail})` : ""}`);
    break;
  }
  default:
    console.error("commands: consent, create, contact, registry, stop, run, report");
    process.exit(1);
}
