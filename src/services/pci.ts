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
  if (typeof value === "string") return redactSensitive(value) as T;
  if (typeof value === "number") {
    const s = String(value);
    if (Number.isInteger(value) && looksLikePan(s)) return REDACTED as T;
    if (Number.isInteger(value) && value > 0 && /^\d{9}$/.test(s) && findSsns(s).length) return REDACTED_SSN as T;
    return value;
  }
  if (depth >= 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, depth + 1)])) as T;
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 8: more kinds of sensitive text (Social Security numbers, digits spoken as words) for logs and transcripts.
// ---------------------------------------------------------------------------------------------------------------

/**
 * A US Social Security number shape: 9 digits, written 123-45-6789, 123 45 6789 or 123456789, not part of a longer run
 * of digits. Plausibility rules (from my memory of how the SSA issues numbers, NOT sourced in this project): the first
 * three digits are not 000, 666 or 900-999; the middle two are not 00; the last four are not 0000. They cut false alarms.
 */
const SSN_CANDIDATE = /(?<!\d)(\d{3})([ -]?)(\d{2})\2(\d{4})(?!\d)/g;

function plausibleSsn(area: string, group: string, serial: string): boolean {
  const a = Number(area);
  return a !== 0 && a !== 666 && a < 900 && group !== "00" && serial !== "0000";
}

export function findSsns(text: string): string[] {
  return [...text.matchAll(SSN_CANDIDATE)].filter((m) => plausibleSsn(m[1], m[3], m[4])).map((m) => m[0]);
}

export const REDACTED_SSN = "[REDACTED-SSN]";

/** Replace card-number-looking and SSN-looking text. This is what the logger uses on every line. */
export function redactSensitive(text: string): string {
  return redactPans(text).replace(SSN_CANDIDATE, (m, area: string, _sep: string, group: string, serial: string) =>
    plausibleSsn(area, group, serial) ? REDACTED_SSN : m,
  );
}

const DIGIT_WORDS = new Map<string, string>([
  ["zero", "0"], ["oh", "0"], ["o", "0"], ["one", "1"], ["two", "2"], ["three", "3"], ["four", "4"], ["five", "5"],
  ["six", "6"], ["seven", "7"], ["eight", "8"], ["nine", "9"],
]);
export const REDACTED_NUMBER = "[REDACTED-NUMBER]";

/**
 * For TRANSCRIPTS of what people said. People read card and Social Security numbers aloud as words ("four two four
 * two ..."), which a digit scanner cannot see. Any run of nine or more spoken digits, in words or numerals or a mix,
 * is replaced. Conservative on purpose: a long phone number read aloud is replaced too.
 */
export function redactTranscript(text: string, minRun = 9): string {
  const parts = redactSensitive(text).split(/(\s+)/); // keep the spaces so the sentence survives
  const out: string[] = [];
  let run: string[] = []; // tokens (and the spaces between them) of the digit run being built
  let digits = 0;
  const flush = () => {
    if (run.length) out.push(digits >= minRun ? REDACTED_NUMBER : run.join(""));
    run = [];
    digits = 0;
  };
  for (const tok of parts) {
    if (/^\s+$/.test(tok)) {
      if (run.length) run.push(tok);
      else out.push(tok);
      continue;
    }
    const bare = tok.toLowerCase().replace(/[^a-z0-9]/g, "");
    const d = DIGIT_WORDS.get(bare) ?? (/^\d+$/.test(bare) ? bare : undefined);
    if (d !== undefined) {
      run.push(tok);
      digits += d.length;
    } else {
      // a trailing space belongs to the text, not the run
      let trailing = "";
      if (run.length && /^\s+$/.test(run[run.length - 1])) trailing = run.pop()!;
      flush();
      if (trailing) out.push(trailing);
      out.push(tok);
    }
  }
  let trailing = "";
  if (run.length && /^\s+$/.test(run[run.length - 1])) trailing = run.pop()!;
  flush();
  if (trailing) out.push(trailing);
  return out.join("");
}
