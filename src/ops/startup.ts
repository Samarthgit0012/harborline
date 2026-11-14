import type { Config } from "../config.js";

/**
 * What the server is about to do, in plain words, with nothing secret in it. Printed at startup so that a demo (or
 * a production deploy) never quietly runs in a mode nobody meant.
 */
export function describeMode(config: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const lines: string[] = [];
  lines.push(`environment: ${env.NODE_ENV === "production" ? "PRODUCTION" : "development"}`);
  lines.push(`public URL (used to check Twilio's signatures): ${config.publicBaseUrl}`);
  lines.push(`hours: ${config.hoursMode === "always-open" ? "ALWAYS OPEN (demo setting)" : "real business hours (Mon-Fri 8-6, Sat 9-1 Eastern)"}`);
  lines.push(`agent line: ${config.agentNumber ? "set" : "NOT set (callers asking for a person get an apology)"}`);
  lines.push(`texts: ${config.twilioAccountSid && config.twilioFromNumber ? "real Twilio texts" : "logged only, nothing is sent"}`);
  lines.push(`card payments: ${config.payEnabled ? `on (connector ${config.payConnector ?? "Default"})` : "off"}`);
  lines.push(`outbound calling: ${config.outboundMode ?? "off"}`);
  lines.push(`recording agent calls: ${config.recordAgentCalls ? "ON (callers are told and can decline)" : "off"}`);
  lines.push(`recording retention: ${config.retentionMode ?? "dry-run"}`);
  return lines;
}

/** Things that are almost certainly mistakes (or demo shortcuts) and deserve a loud line. */
export function startupWarnings(config: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const w: string[] = [];
  const url = config.publicBaseUrl;
  if (!url.startsWith("https://")) w.push("PUBLIC_BASE_URL is not https. Twilio can only reach an https address, so real calls will fail signature checks or never arrive.");
  if (/localhost|127\.0\.0\.1/.test(url)) w.push("PUBLIC_BASE_URL points at localhost. Twilio cannot reach that: start a tunnel and set it to the tunnel's https address.");
  if (/trycloudflare\.com/.test(url)) w.push("This is a temporary quick-tunnel address. It changes every time the tunnel restarts; re-run the Twilio setup after a restart.");
  if (config.hoursMode === "always-open") w.push("HOURS_MODE=always-open: the closed-hours behaviour is switched off. This is for demos.");
  if (env.NODE_ENV !== "production" && config.nowOverride) w.push(`NOW_OVERRIDE is active: the server believes it is ${config.nowOverride.toISOString()}.`);
  if (env.NODE_ENV === "production" && env.NOW_OVERRIDE) w.push("NOW_OVERRIDE is set but ignored in production (by design).");
  if (!config.agentNumber) w.push("AGENT_PHONE is not set: 'speak to an agent' will not connect anyone.");
  if (config.outboundMode === "live") w.push("OUTBOUND_MODE=live: this server can place REAL outbound calls.");
  if (config.retentionMode === "live") w.push("RETENTION_MODE=live: the retention job will really delete recordings.");
  return w;
}

/** The same comparison the setup tool and the readiness checker both need: is Twilio pointed at the right address? */
export function expectedVoiceUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/voice`;
}
