/**
 * Structured logs, with one rule: NEVER log what the caller typed or said (policy numbers, dates of
 * birth, descriptions) and never a full phone number. Log events, node names and call IDs.
 */
export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, msg, ...fields }));
}

/** "+15555550100" -> "***0100". Enough to correlate a complaint, not enough to identify a person. */
export function maskPhone(phone: string | undefined): string | undefined {
  return phone ? `***${phone.slice(-4)}` : undefined;
}
