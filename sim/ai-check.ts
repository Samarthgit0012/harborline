// Does the Gemini key work, and does the model do what the quote line needs? Makes 2 or 3 small real requests.
//   npm run ai:check
// Uses made-up details only: a free AI Studio key lets Google use what is sent. Prints results, never the key.
import "dotenv/config";
import { SYSTEM_PROMPT, TOOLS } from "../src/ai/agent.js";
import { DEFAULT_GEMINI_MODEL, GeminiClient } from "../src/ai/gemini.js";
import type { LlmMessage } from "../src/ai/types.js";

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
console.log(`GEMINI_API_KEY present: ${!!key}`);
console.log(`model: ${model}`);
if (!key) {
  console.error("Set GEMINI_API_KEY in .env first (Google AI Studio > Get API key).");
  process.exit(1);
}

const llm = new GeminiClient(key, model);
const messages: LlmMessage[] = [
  { role: "user", text: "[The caller has just connected.]" },
  { role: "assistant", text: "Hi, this is Harborline's automated assistant. To start, what is your full name?", toolCalls: [] },
  { role: "user", text: "Sure, my name is Pat Example and my zip code is one zero zero zero one." },
];

async function step(label: string) {
  const t0 = Date.now();
  const res = await llm.generate({ system: SYSTEM_PROMPT, messages, tools: TOOLS, maxOutputTokens: 160 });
  console.log(`${label}: ${Date.now() - t0} ms, text=${JSON.stringify(res.text)}, tool calls=${JSON.stringify(res.toolCalls.map((c) => ({ name: c.name, args: c.args })))}`);
  return res;
}

try {
  const first = await step("1 first answer");
  messages.push({ role: "assistant", text: first.text, toolCalls: first.toolCalls, raw: first.raw });
  if (first.toolCalls.length) {
    // Answer every call the model made, the way the agent does, and see whether Gemini accepts the result turn.
    messages.push({
      role: "tool",
      results: first.toolCalls.map((c) => ({ name: c.name, id: c.id, result: { ok: true, saved: c.args.field, remaining: ["vehicle_year", "vehicle_make", "vehicle_model", "driver_count", "currently_insured"] } })),
    });
    const second = await step("2 after tool results");
    console.log(second.toolCalls.length === 0 && second.text ? "OK: the model spoke after the tool results (the result turn format is accepted)." : "NOTE: no spoken reply after the tool results.");
  } else {
    console.log("NOTE: the model made no tool call on the first turn.");
  }
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
}
