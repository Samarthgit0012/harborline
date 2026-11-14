// Look after the recordings register: what exists, what is due for deletion, who asked to hear what.
// Whether anything is REALLY deleted at Twilio is decided only by RETENTION_MODE in .env (dry-run by default).
//
//   npm run recordings -- list [claim_description|voicemail|agent_call|unknown]
//   npm run recordings -- retention                      delete everything whose time is up (dry-run unless RETENTION_MODE=live)
//   npm run recordings -- access RExxxx listen --as maria --role supervisor --reason "quality review of complaint 4471"
//   npm run recordings -- hold RExxxx on --as dana --role compliance --reason "litigation hold, case 26-114"
//   npm run recordings -- delete RExxxx --as dana --role compliance --reason "customer erasure request, verified"
//   npm run recordings -- events [RExxxx]                the audit trail
//
// Every command except list and events needs --as (who you are), --role and --reason (at least ten characters).
import { requestAccess } from "../src/compliance/access.js";
import { DryRunDeleter, TwilioDeleter, runRetention, type RecordingDeleter } from "../src/compliance/retention.js";
import { RECORDING_KINDS, RecordingRegistry, type RecordingKind } from "../src/compliance/recordings.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const registry = new RecordingRegistry(config.dbPath ?? "data/harborline.db");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const [cmd, a, b] = args;
const who = { who: flag("as") ?? "", role: flag("role") ?? "", reason: flag("reason") ?? "" };

const deleter = (): RecordingDeleter => {
  if (config.retentionMode === "live") {
    if (!config.twilioAccountSid) throw new Error("live deletion needs TWILIO_ACCOUNT_SID");
    return new TwilioDeleter(config.twilioAccountSid, config.authToken);
  }
  return new DryRunDeleter();
};

switch (cmd) {
  case "list": {
    const kind = RECORDING_KINDS.includes(a as RecordingKind) ? (a as RecordingKind) : undefined;
    for (const r of registry.list({ kind })) {
      console.log(`${r.sid}  ${r.kind.padEnd(17)} ${r.status.padEnd(13)} keep until ${r.retainUntil.slice(0, 10)}${r.legalHold ? "  LEGAL HOLD" : ""}  ref=${r.ref ?? "-"}  basis=${r.consentBasis}`);
    }
    break;
  }
  case "retention": {
    const mode = config.retentionMode;
    const out = await runRetention(registry, deleter(), new Date(), { dryRun: mode !== "live" });
    console.log(`mode=${mode}: ${out.deleted.length} ${mode === "live" ? "deleted" : "WOULD be deleted (dry-run: nothing was changed anywhere)"}, ${out.alreadyGone.length} already gone, ${out.failed.length} failed, ${out.held.length} kept under legal hold`);
    if (mode !== "live") for (const sid of out.deleted) console.log(`  would delete ${sid}`);
    for (const f of out.failed) console.log(`  FAILED ${f.sid}: ${f.error}`);
    break;
  }
  case "access": {
    const r = requestAccess(registry, { sid: a ?? "", action: b ?? "", ...who });
    console.log(r.granted ? `GRANTED: ${b} ${a} (${r.recording.kind}, ${r.recording.status}). Fetch it from Twilio with your API credentials; this tool never prints a link.` : `DENIED: ${r.why}`);
    break;
  }
  case "hold": {
    const r = requestAccess(registry, { sid: a ?? "", action: "hold", ...who });
    if (!r.granted) console.log(`DENIED: ${r.why}`);
    else {
      registry.setHold(a!, b === "on", b === "on" ? who.reason : null);
      console.log(`legal hold ${b === "on" ? "ON" : "OFF"} for ${a}`);
    }
    break;
  }
  case "delete": {
    const r = requestAccess(registry, { sid: a ?? "", action: "delete", ...who });
    if (!r.granted) {
      console.log(`DENIED: ${r.why}`);
    } else if (r.recording.legalHold) {
      console.log("REFUSED: this recording is under legal hold. Release the hold first (with a reason).");
    } else {
      const result = await deleter().delete(a!);
      if (config.retentionMode === "live") registry.markDeleted(a!, new Date());
      console.log(`${config.retentionMode === "live" ? result : "dry-run: would delete"} ${a}`);
    }
    break;
  }
  case "events": {
    for (const e of registry.events(a)) console.log(`${e.at}  ${e.granted ? "granted" : "DENIED "}  ${e.action.padEnd(8)} ${e.sid}  by ${e.who} (${e.role}): ${e.reason}`);
    break;
  }
  default:
    console.error("commands: list, retention, access, hold, delete, events");
    process.exit(1);
}
