// Talk to the AI quote line from your terminal. Free: no phone, no Twilio.
//   npm run practice:ai              an offline stand-in "model" (no key, no network; understands only this conversation)
//   npm run practice:ai -- --gemini  the REAL Gemini model (uses GEMINI_API_KEY from .env). Use MADE-UP details only:
//                                    a free AI Studio key lets Google use what is sent.
//   npm run practice:ai -- --logs    also show the server's own log lines
// Type what a caller would SAY. "0" is the keypad zero (a person). "bye" hangs up.
// You see what the caller hears, the details the code accepted, and when the safety checks replaced the model's words.
import "dotenv/config";
import { createInterface } from "node:readline";
import { QuoteAgent, GREETING } from "../src/ai/agent.js";
import { DEFAULT_GEMINI_MODEL, GeminiClient } from "../src/ai/gemini.js";
import type { LlmClient } from "../src/ai/types.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import { whisperText } from "../src/services/queue.js";
import { RuleBasedLlm } from "./ai-fakes.js";

const args = process.argv.slice(2);
const out = (s: string) => process.stdout.write(s + "\n");
if (!args.includes("--logs")) console.log = () => {}; // the app's JSON log lines would bury the conversation

let llm: LlmClient = new RuleBasedLlm();
if (args.includes("--gemini")) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error("--gemini needs GEMINI_API_KEY in .env.");
    process.exit(1);
  }
  llm = new GeminiClient(key, process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
  out(`Using the REAL model (${llm.name}). Type made-up details only: Google may use what a free key sends.`);
} else {
  out("Using the offline stand-in model. (Add --gemini to talk to the real one.)");
}

const repo = new SqliteRepo(":memory:");
const agent = new QuoteAgent({ llm, phone: "+15555550100", saveLead: (l) => ({ leadNumber: repo.createLead(l).leadNumber }) });

out("\n--- ringing: pressed 4 for a quote ---");
out(`AI says: ${GREETING}`);

const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
for (;;) {
  process.stdout.write("you > ");
  const next = await lines.next();
  if (next.done) {
    out("");
    break;
  }
  const said = next.value.trim();
  if (!process.stdin.isTTY) out(said);
  if (!said) continue;
  if (said === "bye") {
    out("[caller hung up: nothing is saved when a caller hangs up mid-conversation]");
    break;
  }
  const t0 = Date.now();
  const reply = said === "0" ? (agent.onDtmf("0") ?? { say: "" }) : await agent.onCallerText(said);
  out(`AI says: ${reply.say}   (${Date.now() - t0} ms)`);
  if (reply.blocked) out(`  [safety check: the model's own words were replaced (${reply.blocked})]`);
  out(`  [accepted so far: ${JSON.stringify(agent.intake.values)}]`);
  if (reply.end === "transfer") {
    const note = agent.intake.any() ? agent.intake.spokenSummary() : undefined;
    out(`  [call goes to the agent line${reply.urgent ? " AS URGENT" : ""}. The agent hears: ${whisperText({ reason: "quote_request", urgent: !!reply.urgent, verified: false, queuedAt: 0, note })}]`);
  }
  if (reply.end) {
    const lead = repo.leads()[0];
    if (lead) out(`  [saved quote request ${lead.leadNumber}, ${lead.status}: ${JSON.stringify({ name: lead.fullName, zip: lead.zipCode, year: lead.vehicleYear, make: lead.vehicleMake, model: lead.vehicleModel, drivers: lead.driverCount, insured: lead.currentlyInsured })}]`);
    else out("  [nothing was collected, so nothing was saved]");
    break;
  }
}
rl.close();
