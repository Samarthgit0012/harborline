/**
 * Structured logs, with one rule: NEVER log what the caller typed or said (policy numbers, dates of
 * birth, descriptions) and never a full phone number. Log events, node names and call IDs.
 */
import { redactDeep } from "./services/pci.js";

export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  // Last line of defence: if anything that looks like a card number reaches a log line, it is redacted.
  console.log(JSON.stringify(redactDeep({ level, msg, ...fields })));
}

/** "+15555550100" -> "***0100". Enough to correlate a complaint, not enough to identify a person. */
export function maskPhone(phone: string | undefined): string | undefined {
  return phone ? `***${phone.slice(-4)}` : undefined;
}
