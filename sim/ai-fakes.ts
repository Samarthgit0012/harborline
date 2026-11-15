// Stand-ins for the AI model, so everything around it can be tested and practised for free, with no key and no network.
//   ScriptedLlm    says exactly what a test tells it to, including bad things (the red-team tests use this).
//   RuleBasedLlm   a tiny keyword "model" that can run the whole quote conversation offline (npm run practice:ai).
import type { LlmClient, LlmRequest, LlmResponse, ToolCall } from "../src/ai/types.js";

type Step = LlmResponse | Error | ((req: LlmRequest) => LlmResponse | Promise<LlmResponse>);

export class ScriptedLlm implements LlmClient {
  readonly name = "scripted";
  requests: LlmRequest[] = [];
  constructor(private steps: Step[]) {}

  async generate(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const step = this.steps.shift();
    if (!step) throw new Error("ScriptedLlm ran out of steps");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(req) : step;
  }
}

export const say = (text: string): LlmResponse => ({ text, toolCalls: [] });
export const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ name, args });
export const calls = (...toolCalls: ToolCall[]): LlmResponse => ({ text: "", toolCalls });

// ---------------------------------------------------------------------------------------------------------------

const MAKES = ["honda", "toyota", "ford", "chevrolet", "chevy", "nissan", "tesla", "bmw", "subaru", "kia", "hyundai", "mazda", "volkswagen", "jeep", "dodge", "audi", "mercedes", "lexus"];
const NUM_WORDS: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };

const QUESTIONS: Record<string, string> = {
  full_name: "What is your full name?",
  zip_code: "What is your zip code?",
  vehicle_year: "What year is the car?",
  vehicle_make: "What is the make of the car?",
  vehicle_model: "And the model?",
  driver_count: "How many drivers are in your household?",
  currently_insured: "Are you insured right now?",
};
const KEYWORD_FOR_FIELD: [string, string][] = [
  ["full name", "full_name"], ["zip", "zip_code"], ["what year", "vehicle_year"], ["make", "vehicle_make"],
  ["model", "vehicle_model"], ["drivers", "driver_count"], ["insured right now", "currently_insured"],
];

/** A very small keyword "model". It only understands the quote conversation, which is all this line does. */
export class RuleBasedLlm implements LlmClient {
  readonly name = "rule-based";

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const saved = this.savedValues(req);
    const last = req.messages[req.messages.length - 1];

    if (last.role === "tool") {
      const refused = last.results.find((r) => r.result.ok === false && typeof r.result.error === "string");
      if (refused) return { text: "Sorry, could you say that again?", toolCalls: [] };
      return { text: this.nextQuestion(saved), toolCalls: [] };
    }
    if (last.role !== "user") return { text: "Could you say that again?", toolCalls: [] };

    const said = last.text;
    const lower = said.toLowerCase();
    const asked = this.lastQuestion(req);

    // A "yes" to the read-back finishes the call.
    if (asked === "confirm") {
      if (/\b(yes|yeah|yep|correct|right)\b/.test(lower) && !/\b(no|not|wrong)\b/.test(lower)) return { text: "", toolCalls: [{ name: "finish", args: {} }] };
      return { text: "Okay. Which detail should I change?", toolCalls: [] };
    }

    const found: ToolCall[] = [];
    const add = (field: string, value: string) => !found.some((c) => c.args.field === field) && found.push({ name: "save_detail", args: { field, value } });

    // The name is only listened for until it has been saved ("I am insured" later is not a name).
    const name = saved.full_name ? undefined : /(?:my name is|i am|i'm|this is|it's)\s+([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+)?)/i.exec(said)?.[1];
    if (name) add("full_name", name);
    else if (!saved.full_name && asked === "full_name" && /^[a-z][a-z'’ .-]{1,40}$/i.test(said.trim())) add("full_name", said.trim());

    const zip = /\b(\d{5})\b/.exec(said)?.[1] ?? (asked === "zip_code" ? this.spokenDigits(lower, 5) : undefined);
    if (zip) add("zip_code", zip);
    const year = /\b(19[89]\d|20\d{2})\b/.exec(said)?.[1];
    if (year) add("vehicle_year", year);
    const make = MAKES.find((m) => new RegExp(`\\b${m}\\b`).test(lower));
    if (make) {
      add("vehicle_make", make[0].toUpperCase() + make.slice(1));
      const model = new RegExp(`\\b${make}\\s+([a-z0-9-]+)`, "i").exec(said)?.[1];
      if (model) add("vehicle_model", model[0].toUpperCase() + model.slice(1));
    } else if (asked === "vehicle_make" && /^[a-z0-9 -]{2,30}$/i.test(said.trim())) add("vehicle_make", said.trim());
    else if (asked === "vehicle_model" && /^[a-z0-9 -]{1,30}$/i.test(said.trim())) add("vehicle_model", said.trim());
    const drivers = /\b(\d+|one|two|three|four|five|six)\s+drivers?\b/i.exec(said)?.[1] ?? (asked === "driver_count" ? (/\b(\d+)\b/.exec(said)?.[1] ?? Object.keys(NUM_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(lower))) : undefined);
    if (drivers) add("driver_count", NUM_WORDS[drivers.toLowerCase()] ?? drivers);
    if (asked === "currently_insured" || /\binsured\b/.test(lower)) {
      if (/\b(yes|yeah|yep|i am|currently)\b/.test(lower) && !/\b(not|no|don'?t)\b/.test(lower)) add("currently_insured", "yes");
      else if (/\b(no|nope|not|don'?t)\b/.test(lower)) add("currently_insured", "no");
    }

    if (found.length) return { text: "", toolCalls: found };
    return { text: this.nextQuestion(saved) || "Could you say that again?", toolCalls: [] };
  }

  /** Every value the model has saved so far (read back from its own earlier tool calls that were accepted). */
  private savedValues(req: LlmRequest): Record<string, string> {
    const out: Record<string, string> = {};
    const pending = new Map<string, ToolCall[]>();
    for (const m of req.messages) {
      if (m.role === "assistant") pending.set("last", m.toolCalls);
      if (m.role === "tool") {
        const prior = pending.get("last") ?? [];
        m.results.forEach((r, i) => {
          const c = prior[i];
          if (r.result.ok === true && c?.name === "save_detail") out[String(c.args.field)] = String(c.args.value);
        });
      }
    }
    return out;
  }

  private nextQuestion(saved: Record<string, string>): string {
    const missing = Object.keys(QUESTIONS).filter((f) => !saved[f]);
    if (missing.length) return QUESTIONS[missing[0]];
    return `Let me confirm. ${saved.full_name}, zip ${saved.zip_code.split("").join(" ")}, a ${saved.vehicle_year} ${saved.vehicle_make} ${saved.vehicle_model}, ${saved.driver_count} drivers, insured: ${saved.currently_insured}. Is that right?`;
  }

  private lastQuestion(req: LlmRequest): string | undefined {
    const lastAssistant = [...req.messages].reverse().find((m) => m.role === "assistant" && m.text);
    const text = lastAssistant && lastAssistant.role === "assistant" ? lastAssistant.text.toLowerCase() : "";
    if (text.includes("is that right")) return "confirm";
    return KEYWORD_FOR_FIELD.find(([kw]) => text.includes(kw))?.[1];
  }

  private spokenDigits(lower: string, want: number): string | undefined {
    const digits = lower.split(/[\s,-]+/).map((w) => NUM_WORDS[w] ?? (/^\d$/.test(w) ? w : "")).join("");
    return digits.length === want ? digits : undefined;
  }
}
