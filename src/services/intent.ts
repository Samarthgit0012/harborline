import type { SpeechIntent } from "../flows/types.js";

/**
 * Turning what the caller SAID (text from Twilio's recogniser) into an intent.
 * Deliberately simple and deterministic: whole-phrase matching, longest phrase wins.
 * An LLM classifier could replace matchIntent later without touching the engine (same return shape).
 */

/** Confidence at or above this, with a clear match, is accepted without asking. */
export const ACCEPT_CONFIDENCE = 0.8;
/** Below this, we act as if we heard nothing useful. In between, we ask "did you want X?". */
export const REJECT_CONFIDENCE = 0.5;

const NEGATIONS = new Set(["no", "not", "dont", "never", "cant", "wont", "without", "nothing"]);
const MAX_UTTERANCE = 300;

/** lowercase, drop punctuation and apostrophes ("don't" -> "dont"), collapse spaces. */
export function normalize(text: string): string {
  return text
    .slice(0, MAX_UTTERANCE)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Match {
  intent?: SpeechIntent;
  /** Two different intents tied for best: we cannot tell which one the caller meant. */
  ambiguous: boolean;
  /** The caller used a negation ("I do NOT want to file a claim"). Keyword matching can't read it, so a human-style confirmation is required. */
  negated: boolean;
}

export function matchIntent(utterance: string, intents: SpeechIntent[]): Match {
  const said = ` ${normalize(utterance)} `;
  const negated = said
    .trim()
    .split(" ")
    .some((w) => NEGATIONS.has(w));

  let best = 0; // words in the longest matching phrase
  let winners = new Set<SpeechIntent>();
  for (const intent of intents) {
    for (const phrase of intent.phrases) {
      const p = normalize(phrase);
      if (!p || !said.includes(` ${p} `)) continue; // whole words only: "bill" must not match "billion"
      const len = p.split(" ").length;
      if (len > best) {
        best = len;
        winners = new Set([intent]);
      } else if (len === best) {
        winners.add(intent);
      }
    }
  }
  if (winners.size === 0) return { ambiguous: false, negated };
  if (winners.size > 1) return { ambiguous: true, negated };
  return { intent: [...winners][0], ambiguous: false, negated };
}

export type Verdict = "accept" | "confirm" | "reject";

/**
 * What to do with a match, given the recogniser's confidence score.
 * Twilio documents that Confidence is not guaranteed to be present, so a missing score never auto-accepts.
 */
export function decide(confidence: number | undefined, negated: boolean): Verdict {
  if (confidence !== undefined && confidence < REJECT_CONFIDENCE) return "reject";
  if (confidence === undefined || negated || confidence < ACCEPT_CONFIDENCE) return "confirm";
  return "accept";
}

/** Parse Twilio's Confidence form field. Anything not a number from 0 to 1 counts as "no score". */
export function parseConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

const YES = new Set(["yes", "yeah", "yep", "yup", "correct", "right", "sure", "ok", "okay", "affirmative"]);
const NO = new Set(["no", "nope", "nah", "wrong", "incorrect", "negative"]);

/** Answer to a yes/no confirmation. Mixed or unrecognised answers return null (= not understood). */
export function yesNo(utterance: string): "yes" | "no" | null {
  const words = normalize(utterance).split(" ");
  const yes = words.some((w) => YES.has(w));
  const no = words.some((w) => NO.has(w));
  if (yes === no) return null;
  return yes ? "yes" : "no";
}

/** Phrases to give the recogniser as `hints`, so it prefers our vocabulary. Twilio limit: 500 entries of up to 100 chars. */
export function hintsFor(intents: SpeechIntent[]): string {
  return [...new Set(intents.flatMap((i) => i.phrases.map(normalize)))].join(", ");
}
