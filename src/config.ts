import "dotenv/config";

export interface Config {
  authToken: string;
  publicBaseUrl: string;
  port: number;
}

/** Read config from env. Fails fast: a missing token must never silently disable security. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!authToken) throw new Error("TWILIO_AUTH_TOKEN is required (see .env.example)");
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return { authToken, publicBaseUrl, port: Number(env.PORT ?? 3000) };
}
