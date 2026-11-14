// How good is the intent matcher, on sentences callers might really say?
//   npm run speech:eval
// Each line is [what the caller says, the intent they WANT, or "none" if nothing should match].
// ones you saw fail in real calls) and watch the score. This tests the TEXT matching only; whether the
// recogniser heard the words correctly is a separate problem (that is what Confidence is for).
import { buildHarborlineFlow } from "../src/flows/harborline.js";
import type { MenuNode } from "../src/flows/types.js";
import { matchIntent } from "../src/services/intent.js";

const intents = (buildHarborlineFlow().nodes.main as MenuNode).speech!.intents;

const corpus: Array<[string, string]> = [
  ["I want to file a claim", "claim_new"],
  ["I was just in a car accident", "claim_new"],
  ["someone hit me in the parking lot", "claim_new"],
  ["my house got broken into", "claim_new"], // GAP: "broken into" is not a phrase
  ["there was a break in at my place", "claim_new"],
  ["I need to check on my claim", "claim_status"],
  ["what's the status of my claim", "claim_status"],
  ["claim", "claims"],
  ["I have a question about a claim", "claims"],
  ["I need to pay my bill", "billing"],
  ["how much do I owe", "billing"],
  ["what's my balance", "billing"],
  ["I want to make a payment", "billing"],
  ["what's my deductible", "policy"],
  ["I need my id card", "policy"],
  ["am I covered for flood damage", "policy"], // GAP: no phrase for "covered for"
  ["I'd like a quote", "quote"],
  ["I want to buy a new policy", "quote"],
  ["how much would car insurance cost", "quote"], // GAP: a real quote request we miss
  ["let me speak to a person", "agent"],
  ["I want to talk to a human", "agent"],
  ["representative", "agent"],
  ["agent", "agent"],
  ["can I talk to someone", "agent"],
  ["I don't want to file a claim", "claim_new"], // naive match; `decide` forces a confirmation
  ["my policy and my claim", "none"], // ambiguous on purpose
  ["hello", "none"],
  ["um", "none"],
  ["what are your hours", "none"],
  ["the weather is nice", "none"],
];

let ok = 0;
for (const [text, expected] of corpus) {
  const m = matchIntent(text, intents);
  const got = m.intent?.id ?? "none";
  const pass = got === expected;
  if (pass) ok++;
  const flags = [m.ambiguous ? "ambiguous" : "", m.negated ? "negated" : ""].filter(Boolean).join(",");
  console.log(`${pass ? "ok  " : "MISS"}  ${got.padEnd(12)} ${expected.padEnd(12)} "${text}"${flags ? `  [${flags}]` : ""}`);
}
console.log(`\n${ok}/${corpus.length} as expected (${Math.round((100 * ok) / corpus.length)}%)`);
console.log("MISS lines are gaps: add phrases (or an LLM classifier, Lesson 8), re-run, and check you did not break an \"ok\" line.");
