/**
 * A smoke alarm for mislabelled campaigns. The rules treat a call that "includes or introduces an advertisement" or
 * encourages a purchase as telemarketing, and the FTC's guidance says a call that combines information with a
 * solicitation is not exempt. So a campaign labelled "informational" whose script reads like an offer is a problem
 * waiting to happen. This is a simple word list, NOT a legal determination: a human decides what a call is. But
 * it catches the mistake that costs the most (an offer hiding in a "reminder").
 */
const PROMO_PATTERNS: [string, RegExp][] = [
  ["offer", /\boffers?\b/i],
  ["discount", /\bdiscounts?\b/i],
  ["save", /\bsav(?:e|es|ing|ings)\b/i],
  ["percent off", /\d+\s*%\s*off|\bpercent off\b/i],
  ["upgrade", /\bupgrad(?:e|es|ing)\b/i],
  ["deal", /\bdeals?\b/i],
  ["special", /\bspecial (?:rate|price|promotion|offer)\b/i],
  ["limited time", /\blimited[- ]time\b/i],
  ["free", /\bfree\b/i],
  ["bundle", /\bbundl(?:e|es|ing)\b/i],
  ["quote", /\bquotes?\b/i],
  ["lower your", /\blower your\b/i],
  ["buy / purchase", /\b(?:buy|purchase)\b/i],
  ["add coverage", /\badd(?:ing)? (?:coverage|a policy|another policy)\b/i],
  ["promotion", /\bpromotions?\b|\bpromotional\b/i],
  ["sign up", /\bsign up\b/i],
];

/** The promotional terms found in a script (empty if it reads as purely informational). */
export function promotionalTerms(text: string): string[] {
  return PROMO_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}
