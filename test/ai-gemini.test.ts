import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { GeminiClient, parseResponse, toContents } from "../src/ai/gemini.js";
import { describeMode, startupWarnings } from "../src/ops/startup.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import type { LlmMessage } from "../src/ai/types.js";

const KEY = "AQ.fake-key-for-tests";
const req = (messages: LlmMessage[], signal?: AbortSignal) => ({ system: "SYS", messages, tools: [{ name: "t", description: "d", parameters: { type: "object" } }], maxOutputTokens: 100, signal });
const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("Gemini request and response shapes", () => {
  it("our conversation becomes Gemini contents, tool results included", () => {
    const contents = toContents([
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [{ name: "save_detail", args: { field: "zip_code", value: "10001" }, id: "c1" }] },
      { role: "tool", results: [{ name: "save_detail", id: "c1", result: { ok: true } }] },
      { role: "assistant", text: "Next question?", toolCalls: [] },
    ]);
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ functionCall: { name: "save_detail", args: { field: "zip_code", value: "10001" }, id: "c1" } }] },
      { role: "user", parts: [{ functionResponse: { name: "save_detail", response: { ok: true }, id: "c1" } }] },
      { role: "model", parts: [{ text: "Next question?" }] },
    ]);
  });

  it("a turn the model produced is sent back exactly as received (hidden signatures survive)", () => {
    const raw = { role: "model", parts: [{ functionCall: { name: "finish", args: {} }, thoughtSignature: "opaque-abc" }] };
    const [c] = toContents([{ role: "assistant", text: "", toolCalls: [{ name: "finish", args: {} }], raw }]);
    expect(c).toBe(raw);
  });

  it("reads text and function calls, and leaves out the model's private thinking", () => {
    const r = parseResponse({
      candidates: [{ content: { role: "model", parts: [{ text: "secret reasoning", thought: true }, { text: "What year is the car?" }, { functionCall: { name: "save_detail", args: { field: "full_name", value: "Pat" }, id: "x" } }] }, finishReason: "STOP" }],
    });
    expect(r.text).toBe("What year is the car?");
    expect(r.toolCalls).toEqual([{ name: "save_detail", args: { field: "full_name", value: "Pat" }, id: "x" }]);
    expect(r.raw).toMatchObject({ role: "model" });
  });

  it("a blocked or empty answer is an error, not silence", () => {
    expect(() => parseResponse({ promptFeedback: { blockReason: "SAFETY" } })).toThrow("SAFETY");
    expect(() => parseResponse({ candidates: [{ finishReason: "MAX_TOKENS" }] })).toThrow("MAX_TOKENS");
    expect(() => parseResponse({})).toThrow("no content");
  });
});

describe("the Gemini client", () => {
  it("sends the key in a header, never in the address, with the system prompt, tools and a token cap", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return okJson({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] } }] });
    }) as unknown as typeof fetch;
    const g = new GeminiClient(KEY, "gemini-test-model", fetchFn);
    expect(g.name).toBe("gemini:gemini-test-model");
    const res = await g.generate(req([{ role: "user", text: "hi" }]));
    expect(res.text).toBe("hello");
    expect(seen!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent");
    expect(seen!.url).not.toContain(KEY);
    expect((seen!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    const body = JSON.parse(String(seen!.init.body));
    expect(body.systemInstruction.parts[0].text).toBe("SYS");
    expect(body.tools[0].functionDeclarations[0].name).toBe("t");
    expect(body.generationConfig.maxOutputTokens).toBe(100);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("passes the abort signal through, so a timeout really stops the request", async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = (async (_u: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return okJson({ candidates: [{ content: { parts: [{ text: "x" }] } }] });
    }) as unknown as typeof fetch;
    const ctl = new AbortController();
    await new GeminiClient(KEY, "m", fetchFn).generate(req([{ role: "user", text: "hi" }], ctl.signal));
    expect(signal).toBe(ctl.signal);
  });

  it("an HTTP error reports the status only: the body can echo what the caller said", async () => {
    const fetchFn = (async () => new Response('{"error":{"message":"bad request containing: my name is Pat Example"}}', { status: 400 })) as unknown as typeof fetch;
    const err = await new GeminiClient(KEY, "m", fetchFn).generate(req([{ role: "user", text: "hi" }])).catch((e) => e);
    expect(err.message).toBe("Gemini HTTP 400");
    expect(err.message).not.toContain("Pat");
  });

  it("refuses to be built without a key", () => {
    expect(() => new GeminiClient("")).toThrow("GEMINI_API_KEY");
  });
});

describe("AI settings", () => {
  const base = { TWILIO_AUTH_TOKEN: "t", PUBLIC_BASE_URL: "https://ivr.example.com" };
  it("is off unless asked for", () => {
    expect(loadConfig(base).aiMode).toBe("off");
    expect(loadConfig({ ...base, GEMINI_API_KEY: KEY }).aiMode).toBe("off"); // a key alone changes nothing
  });
  it("on needs a key and an https address", () => {
    expect(() => loadConfig({ ...base, AI_MODE: "on" })).toThrow("GEMINI_API_KEY");
    expect(() => loadConfig({ ...base, AI_MODE: "on", GEMINI_API_KEY: KEY, PUBLIC_BASE_URL: "http://localhost:3000" })).toThrow("https");
    expect(loadConfig({ ...base, AI_MODE: "on", GEMINI_API_KEY: KEY })).toMatchObject({ aiMode: "on", geminiApiKey: KEY });
  });
  it("rejects a mistyped mode and an odd model name", () => {
    expect(() => loadConfig({ ...base, AI_MODE: "yes" })).toThrow("AI_MODE");
    expect(() => loadConfig({ ...base, GEMINI_MODEL: "x; rm -rf /" })).toThrow("GEMINI_MODEL");
    expect(loadConfig({ ...base, GEMINI_MODEL: "gemini-3.5-flash-lite" }).geminiModel).toBe("gemini-3.5-flash-lite");
  });
  it("the startup summary says it plainly, warns about what free keys do, and never prints the key", () => {
    const off = loadConfig(base);
    expect(describeMode(off).join("\n")).toContain("AI quote line: off");
    const on = loadConfig({ ...base, AI_MODE: "on", GEMINI_API_KEY: KEY });
    const lines = [...describeMode(on), ...startupWarnings(on)].join("\n");
    expect(lines).toContain("AI quote line: ON");
    expect(lines).toContain("free AI Studio key");
    expect(lines).not.toContain(KEY);
  });
});

describe("quote requests (leads)", () => {
  it("are stored with a spoken-friendly number, newest first, complete or partial", () => {
    const repo = new SqliteRepo(":memory:");
    const now = new Date("2026-11-17T15:00:00Z");
    const a = repo.createLead({ phone: "+15555550100", complete: false, transferred: true, values: { full_name: "Pat Example" } }, now);
    const b = repo.createLead({ phone: "+15555550101", complete: true, transferred: false, values: { full_name: "Sam Q", zip_code: "10001", vehicle_year: "2019", vehicle_make: "Honda", vehicle_model: "Civic", driver_count: "2", currently_insured: "no" } }, now);
    expect(a).toMatchObject({ leadNumber: "400001", status: "partial", transferred: true, fullName: "Pat Example", zipCode: null });
    expect(b).toMatchObject({ leadNumber: "400002", status: "complete", transferred: false, currentlyInsured: "no" });
    expect(repo.leads().map((l) => l.leadNumber)).toEqual(["400002", "400001"]);
    expect(a.createdAt).toBe(now.toISOString());
  });
  it("hold nothing that is not a quote detail: there is no place for a date of birth or a policy number", () => {
    const lead = new SqliteRepo(":memory:").createLead({ phone: "+15555550100", complete: false, transferred: false, values: {} });
    expect(Object.keys(lead).sort()).toEqual(
      ["createdAt", "currentlyInsured", "driverCount", "fullName", "leadNumber", "phone", "status", "transferred", "vehicleMake", "vehicleModel", "vehicleYear", "zipCode"],
    );
  });
});
