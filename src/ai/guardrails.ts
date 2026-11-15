// Guardrails that live in CODE. A prompt asking the model to behave is a request; this file is the enforcement.
// Two checkpoints: what the caller says BEFORE the model sees it, and what the model says BEFORE the caller hears it.

export const EMERGENCY_NOTICE = "If anyone is hurt or in danger, hang up and call 9 1 1 now.";

/** What we say instead of anything the output check refuses. Never mentions why (that would teach a caller how to get round it). */
export const SAFE_REPLY: Record<BlockReason, string> = {
  price: "I am not able to talk about prices. A licensed agent will give you your quote. Let me keep going with your details.",
  promise: "I am not able to promise anything about coverage or claims. A licensed agent can help with that. Let me keep going with your details.",
  leak: "I can only help with getting a quote. Let me keep going with your details.",
  empty: "Sorry, I did not catch that. Could you say it again?",
  too_long: "Sorry, let me say that more simply. Could you tell me a little more about what you need?",
};

export type BlockReason = "price" | "promise" | "leak" | "empty" | "too_long";

export type CallerSignal = { kind: "emergency" } | { kind: "human" } | { kind: "ok" };

// Someone may be hurt: no model, no questions, straight to a person with the 9-1-1 notice.
const EMERGENCY = /\b(9\s?1\s?1|nine[\s-]one[\s-]one|ambulance|bleeding|injur(?:ed|y|ies)|hurt|unconscious|not breathing|can'?t breathe|heart attack|on fire|caught fire|emergency)\b/i;
// Asking for a person is always honoured at once. Never make a caller argue with a machine.
// A REQUEST, not a mention: "I want to talk to a real person" transfers, but "are you a real person?" is a question the
// assistant should answer honestly (a red-team run found the looser version transferring on exactly that question).
const PERSON = "(?:person|human|someone|somebody|agent|representative|operator|manager|supervisor)";
const HUMAN = new RegExp(
  `\\b(?:talk|speak|connect|transfer|put|get|let)\\b[^.?!]{0,25}\\b${PERSON}\\b` + // "let me talk to a real person"
    `|\\bi (?:want|need|would like|d like)\\b[^.?!]{0,25}\\b${PERSON}\\b` + // "I want a human"
    `|^\\W*(?:an? )?(?:real |live )?${PERSON}(?: please)?\\W*$` + // just "agent", "representative please"
    `|\\bcustomer service\\b`,
  "i",
);

/** Checked on the caller's words before any model sees them. */
export function screenCaller(text: string): CallerSignal {
  if (EMERGENCY.test(text)) return { kind: "emergency" };
  if (HUMAN.test(text)) return { kind: "human" };
  return { kind: "ok" };
}

// Money: the model must never state a price, rate, discount or saving. A quote comes from a licensed agent.
// Deliberately blunt: a spoken amount ("about a hundred") has no digits and no dollar sign, so we refuse the money WORDS, not just
// the numbers. A harmless sentence that mentions "price" is replaced by our own line, which says the same thing. Safe direction to be wrong in.
const PRICE = /\$|%|\b(?:dollars?|bucks?|cents?|percent|costs?|costing|prices?|priced|pricing|pays?|paying|payments?|premiums?|rates?|discounts?|savings?|cheap|cheaper|cheapest|afford|affordable|monthly|annually|yearly)\b|\b(?:per|a|each|every) (?:month|year|week|day)\b/i;
// Promises and coverage statements: only a licensed agent, reading the policy, may say these.
const PROMISE = /\b(?:guarantee[ds]?|promise[ds]?|for sure|definitely (?:be )?(?:covered|paid|approved)|will (?:definitely )?be (?:paid|covered|approved|accepted|honou?red|processed)|you(?:'re| are) (?:fully |already |definitely )?(?:covered|approved|eligible|qualified|insured)|we(?:'ll| will) (?:pay|cover|approve|insure|honou?r)|(?:is|are|would be|will be) covered|your claim (?:will|would|is going to))\b/i;
// The model describing its own instructions.
const LEAK = /\b(?:system prompt|my instructions|my (?:programming|rules)|ignore (?:all |any )?(?:previous|prior) instructions|as an? (?:ai )?language model)\b/i;

const MAX_REPLY_CHARS = 420; // about 25 seconds of speech: a caller will not listen to a speech

/** What a reply sounds like once a text-to-speech voice has read it: no markdown, no emoji, no stray symbols. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/[*_`#>~|]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type ModelVerdict = { ok: true; text: string } | { ok: false; reason: BlockReason };

/** Checked on the model's words before the caller hears them. */
export function screenModel(raw: string): ModelVerdict {
  const text = cleanForSpeech(raw);
  if (!text) return { ok: false, reason: "empty" };
  if (LEAK.test(text)) return { ok: false, reason: "leak" };
  if (PROMISE.test(text)) return { ok: false, reason: "promise" };
  if (PRICE.test(text)) return { ok: false, reason: "price" };
  if (text.length > MAX_REPLY_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, text };
}
