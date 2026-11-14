/**
 * Helpers for keeping card numbers out of our systems.
 *
 * The real protection is architectural: card digits are typed into Twilio's <Pay>, which sends them to the
 * payment processor, so our server never receives them (Lesson 10). These helpers are the second layer:
 * they notice a card number if one ever leaks into a log line or a test fixture anyway.
 */

/** The Luhn check: the checksum every real card number satisfies. It rules out most random digit strings. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Runs of 13 to 19 digits, optionally split by single spaces or dashes ("4242 4242 4242 4242"), that pass the
 * Luhn check. 13 to 19 is the length range of payment card numbers. Shorter things (an 8-digit policy number,
 * a phone number, a claim number) are never matched.
 */
// Not part of a longer run of digits (a 32-digit ID is not a card), and not "0000000000000000" (which passes
// the checksum but is no card).
const CANDIDATE = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

function looksLikePan(match: string): boolean {
  const digits = match.replace(/\D/g, "");
  return digits.length >= 13 && digits.length <= 19 && new Set(digits).size > 1 && luhnValid(digits);
}

export function findPans(text: string): string[] {
  return [...text.matchAll(CANDIDATE)].map((m) => m[0]).filter(looksLikePan);
}

export const REDACTED = "[REDACTED-PAN]";

/** Replace any card-number-looking text. Safe to call on anything that might be printed. */
export function redactPans(text: string): string {
  return text.replace(CANDIDATE, (m) => (looksLikePan(m) ? REDACTED : m));
}

/** For showing a card to a human: last four only ("************4242"). Never more. */
export function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, "");
  return digits.length <= 4 ? "****" : "*".repeat(digits.length - 4) + digits.slice(-4);
}

/** Redact every string (and number) inside a log record, a few levels deep. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return redactPans(value) as T;
  if (typeof value === "number") {
    const s = String(value);
    return (Number.isInteger(value) && looksLikePan(s) ? REDACTED : value) as T;
  }
  if (depth >= 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, depth + 1)])) as T;
}
