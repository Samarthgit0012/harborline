import "dotenv/config";
import { DEFAULT_RETENTION_DAYS, type RetentionDays } from "./compliance/retention.js";

export interface Config {
  authToken: string;
  publicBaseUrl: string;
  port: number;
  /** E.164 number "speak to an agent" rings. Use your own second phone while learning. */
  agentNumber?: string;
  /** Dev-only: pretend it is this instant, to test open/closed behaviour. Ignored in production. */
  nowOverride?: Date;
  /** SQLite file for policies and claims. Default: ./data/harborline.db */
  dbPath?: string;
  /** Needed to send real texts (ID card). Without both, texts are skipped and only logged. */
  twilioAccountSid?: string;
  twilioFromNumber?: string;
  /** https URL of hold music (an mp3 or wav you host). Optional. */
  holdMusicUrl?: string;
  /** Offer "pay by card" on the billing menu. Needs a Pay Connector on your Twilio account. Default: off. */
  payEnabled?: boolean;
  /** Unique name of the Twilio Pay Connector to use. Omit to use the one named "Default". */
  payConnector?: string;
  /** Outbound calling: "off" (default: webhooks refuse), "dry-run" (decisions and fake calls, rings nobody), or "live". */
  outboundMode?: "off" | "dry-run" | "live";
  /** Our caller ID for outbound calls: must be a Twilio number you own (E.164). */
  outboundFrom?: string;
  /** The number a recipient can call to ask us to stop (E.164). Spoken in every outbound message. Required for live mode. */
  outboundCallback?: string;
  /** Record calls that are connected to an agent (after announcing it and offering to decline). Off by default. */
  recordAgentCalls?: boolean;
  /** How many days each kind of recording is kept before the retention job deletes it. */
  retentionDays?: RetentionDays;
  /** "dry-run" (default) only reports what the retention job would delete; "live" really deletes at Twilio. */
  retentionMode?: "dry-run" | "live";
}

const E164 = /^\+[1-9]\d{6,14}$/;

/** Read config from env. Fails fast: a missing token must never silently disable security. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!authToken) throw new Error("TWILIO_AUTH_TOKEN is required (see .env.example)");
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

  const agentNumber = env.AGENT_PHONE || undefined;
  if (agentNumber && !E164.test(agentNumber)) {
    throw new Error(`AGENT_PHONE must be E.164 like +15551234567 (got "${agentNumber}")`);
  }

  let nowOverride: Date | undefined;
  if (env.NOW_OVERRIDE && env.NODE_ENV !== "production") {
    nowOverride = new Date(env.NOW_OVERRIDE);
    if (Number.isNaN(nowOverride.getTime())) throw new Error(`NOW_OVERRIDE is not a valid date: ${env.NOW_OVERRIDE}`);
  }

  const twilioFromNumber = env.TWILIO_FROM_NUMBER || undefined;
  if (twilioFromNumber && !E164.test(twilioFromNumber)) {
    throw new Error(`TWILIO_FROM_NUMBER must be E.164 like +15551234567 (got "${twilioFromNumber}")`);
  }

  const holdMusicUrl = env.HOLD_MUSIC_URL || undefined;
  if (holdMusicUrl) {
    let ok = false;
    try {
      ok = new URL(holdMusicUrl).protocol === "https:";
    } catch {
      /* not a URL */
    }
    if (!ok) throw new Error("HOLD_MUSIC_URL must be an https URL to an audio file");
  }

  const payConnector = env.PAY_CONNECTOR || undefined;
  if (payConnector && !/^[A-Za-z0-9_-]{1,64}$/.test(payConnector)) {
    throw new Error("PAY_CONNECTOR must be 1 to 64 letters, digits, dashes or underscores");
  }
  const payEnabled = env.PAY_ENABLED === "true";
  if (payEnabled && !publicBaseUrl.startsWith("https://")) {
    // Twilio's Pay docs: the action URL "Must use https".
    throw new Error("PAY_ENABLED needs PUBLIC_BASE_URL to be https (Twilio requires an https action URL for <Pay>)");
  }

  const outboundMode = (env.OUTBOUND_MODE || "off") as "off" | "dry-run" | "live";
  if (!["off", "dry-run", "live"].includes(outboundMode)) throw new Error('OUTBOUND_MODE must be "off", "dry-run" or "live"');
  const outboundFrom = env.OUTBOUND_FROM || undefined;
  const outboundCallback = env.OUTBOUND_CALLBACK || undefined;
  for (const [name, v] of [["OUTBOUND_FROM", outboundFrom], ["OUTBOUND_CALLBACK", outboundCallback]] as const) {
    if (v && !E164.test(v)) throw new Error(`${name} must be E.164 like +15551234567 (got "${v}")`);
  }
  if (outboundMode === "live") {
    if (!outboundFrom || !outboundCallback) throw new Error("OUTBOUND_MODE=live needs OUTBOUND_FROM and OUTBOUND_CALLBACK");
    if (!env.TWILIO_ACCOUNT_SID) throw new Error("OUTBOUND_MODE=live needs TWILIO_ACCOUNT_SID");
    if (!publicBaseUrl.startsWith("https://")) throw new Error("OUTBOUND_MODE=live needs an https PUBLIC_BASE_URL");
  }

  const retentionDays: RetentionDays = { ...DEFAULT_RETENTION_DAYS };
  for (const [kind, name] of [["voicemail", "RETENTION_VOICEMAIL_DAYS"], ["agent_call", "RETENTION_AGENT_CALL_DAYS"], ["claim_description", "RETENTION_CLAIM_DAYS"], ["unknown", "RETENTION_UNKNOWN_DAYS"]] as const) {
    const v = env[name];
    if (v === undefined || v === "") continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error(`${name} must be a whole number of days from 1 to 3650`);
    retentionDays[kind] = n;
  }
  const retentionMode = (env.RETENTION_MODE || "dry-run") as "dry-run" | "live";
  if (!["dry-run", "live"].includes(retentionMode)) throw new Error('RETENTION_MODE must be "dry-run" or "live"');
  if (retentionMode === "live" && !env.TWILIO_ACCOUNT_SID) throw new Error("RETENTION_MODE=live needs TWILIO_ACCOUNT_SID");

  return {
    authToken,
    publicBaseUrl,
    port: Number(env.PORT ?? 3000),
    agentNumber,
    nowOverride,
    dbPath: env.DB_PATH || "data/harborline.db",
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || undefined,
    twilioFromNumber,
    holdMusicUrl,
    payEnabled,
    payConnector,
    outboundMode,
    outboundFrom,
    outboundCallback,
    recordAgentCalls: env.RECORD_AGENT_CALLS === "true",
    retentionDays,
    retentionMode,
  };
}
