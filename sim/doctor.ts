// "Is everything ready for a real phone call?" Checks your settings, your public address and your Twilio account, and
// tells you the next thing to fix. It never prints a password, token or key: only whether each one is present.
//   npm run doctor
import twilio from "twilio";
import { loadConfig, type Config } from "../src/config.js";
import { alwaysOpenSchedule, harborlineSchedule, isOpen } from "../src/services/businessHours.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import { describeMode, expectedVoiceUrl, startupWarnings } from "../src/ops/startup.js";

let fixes = 0;
const ok = (m: string) => console.log(`  OK    ${m}`);
const fix = (m: string) => {
  fixes++;
  console.log(`  FIX   ${m}`);
};
const note = (m: string) => console.log(`  NOTE  ${m}`);

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.log(`\nSettings do not load: ${(err as Error).message}\nFix your .env first (see .env.example), then run this again.`);
  process.exit(1);
}

console.log("\n1. Your settings");
for (const line of describeMode(config)) console.log(`        ${line}`);
for (const w of startupWarnings(config)) note(w);
if (!config.twilioAccountSid) fix("TWILIO_ACCOUNT_SID is not set (Twilio Console home page, starts with AC). Needed to check and set up your number, and for texts.");
else ok("TWILIO_ACCOUNT_SID is set");
if (!config.twilioPhoneNumber) fix("TWILIO_PHONE_NUMBER is not set (your Twilio number in +1... form). The setup tool needs it to find your number.");
else ok(`TWILIO_PHONE_NUMBER is set (ends ${config.twilioPhoneNumber.slice(-4)})`);
if (!config.agentNumber) fix("AGENT_PHONE is not set (your SECOND phone, +1... form): without it nobody can be connected to an 'agent'.");
else ok(`AGENT_PHONE is set (ends ${config.agentNumber.slice(-4)})`);

console.log("\n2. Is your server reachable from the internet?");
const base = config.publicBaseUrl;
if (!base.startsWith("https://") || /localhost|127\.0\.0\.1/.test(base)) {
  fix(`PUBLIC_BASE_URL is "${base}". It must be your public https address (a tunnel or a host), the same one Twilio will call.`);
} else {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (res.ok && body.ok) ok(`${base}/health answers: the public address reaches this app`);
    else fix(`${base}/health answered HTTP ${res.status} but not like this app. Is the tunnel pointing at the right port, and is the server running?`);
  } catch (err) {
    fix(`Could not reach ${base}/health (${(err as Error).message}). Start the server and the tunnel, or fix the address.`);
  }
}

console.log("\n3. Your Twilio account");
if (config.twilioAccountSid) {
  const client = twilio(config.twilioAccountSid, config.authToken);
  try {
    const account = await client.api.accounts(config.twilioAccountSid).fetch();
    ok(`credentials work; account status: ${account.status}, type: ${account.type}`);
    if (account.type === "Trial") note("This is a TRIAL account. Trial accounts have limits (commonly: calls only to numbers you have verified, and a spoken trial message on calls). I could not confirm the exact rules from Twilio's pages, so check your Console.");
    try {
      const bal = await client.balance.fetch();
      ok(`balance: ${bal.balance} ${bal.currency}`);
    } catch {
      note("could not read the balance");
    }

    if (config.twilioPhoneNumber) {
      const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: config.twilioPhoneNumber, limit: 1 });
      if (!numbers.length) fix(`${config.twilioPhoneNumber} is not a number on this account.`);
      else {
        const n = numbers[0];
        ok(`number found on your account; voice calls: ${n.capabilities.voice ? "yes" : "NO"}`);
        const want = expectedVoiceUrl(base);
        if (n.voiceUrl === want && (n.voiceMethod ?? "POST").toUpperCase() === "POST") ok("the number's voice webhook points at your server");
        else fix(`the number's voice webhook is "${n.voiceUrl || "(empty)"}" (${n.voiceMethod}); it should be ${want} (POST). Run: npm run twilio:setup -- --apply`);
      }
    }
    if (config.agentNumber) {
      const verified = await client.outgoingCallerIds.list({ phoneNumber: config.agentNumber, limit: 1 });
      if (verified.length) ok("the agent phone is a verified caller ID on your account");
      else if (account.type === "Trial") fix("the agent phone is NOT verified on your trial account, so Twilio may refuse to call it. Console > Phone Numbers > Verified Caller IDs.");
      else note("the agent phone is not in your verified caller IDs (fine on a paid account)");
    }
  } catch (err) {
    fix(`Twilio rejected the credentials or the request: ${(err as Error).message}. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.`);
  }
}

console.log("\n4. Data and hours");
try {
  const repo = new SqliteRepo(config.dbPath ?? "data/harborline.db");
  const demo = repo.findByPolicyNumber("90000001");
  if (demo) ok(`database opens; demo customer present (phone ends ${demo.phone.slice(-4)})`);
  else fix("no demo customer yet: run  npm run demo:setup -- --customer +1YOURPHONE  so your own phone is recognised and can log in.");
} catch (err) {
  fix(`the database could not be opened: ${(err as Error).message}`);
}
const open = isOpen(new Date(), config.hoursMode === "always-open" ? alwaysOpenSchedule : harborlineSchedule);
if (open) ok("the business is OPEN right now (callers get the main menu)");
else note("the business is CLOSED right now: callers get the after-hours menu and cannot reach an agent. For a demo set HOURS_MODE=always-open in .env.");

console.log(fixes ? `\n${fixes} thing(s) to fix before a real call will work.\n` : "\nEverything checks out. Call your Twilio number.\n");
process.exit(fixes ? 1 : 0);
