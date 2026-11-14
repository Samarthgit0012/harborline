import "dotenv/config";

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

  return {
    authToken,
    publicBaseUrl,
    port: Number(env.PORT ?? 3000),
    agentNumber,
    nowOverride,
    dbPath: env.DB_PATH || "data/harborline.db",
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || undefined,
    twilioFromNumber,
  };
}
