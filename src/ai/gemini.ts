// Gemini (Google AI Studio) adapter: turns our vendor-neutral conversation into a generateContent request and back.
// Written from Google's REST reference. Items the docs did not settle are marked VERIFY: check them against a real call
// (npm run ai:check) before relying on them.
import type { LlmClient, LlmMessage, LlmRequest, LlmResponse, ToolCall } from "./types.js";

// VERIFY: model names change; this is configurable (GEMINI_MODEL). A "lite" model is chosen for speed on a phone call.
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  [other: string]: unknown;
}
interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

/** Our conversation as Gemini "contents". An assistant turn we got from Gemini is sent back exactly as received. */
export function toContents(messages: LlmMessage[]): GeminiContent[] {
  return messages.map((m): GeminiContent => {
    if (m.role === "user") return { role: "user", parts: [{ text: m.text }] };
    if (m.role === "assistant") {
      if (m.raw) return m.raw as GeminiContent; // keeps any hidden fields (such as thought signatures) the model needs back
      const parts: GeminiPart[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls) parts.push({ functionCall: { name: c.name, args: c.args, ...(c.id ? { id: c.id } : {}) } });
      return { role: "model", parts };
    }
    // VERIFY: the docs show the result part but do not state the role of this turn. "user" is the documented convention.
    return { role: "user", parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: r.result, ...(r.id ? { id: r.id } : {}) } })) };
  });
}

/** Read a generateContent response. Throws if the model returned nothing usable (blocked, or empty). */
export function parseResponse(json: unknown): LlmResponse {
  const body = json as { candidates?: { content?: GeminiContent; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
  const cand = body?.candidates?.[0];
  if (!cand?.content?.parts) {
    throw new Error(`Gemini returned no content (${body?.promptFeedback?.blockReason ?? cand?.finishReason ?? "unknown reason"})`);
  }
  const parts = cand.content.parts;
  const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text as string).join(" ").trim();
  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {}, ...(p.functionCall!.id ? { id: p.functionCall!.id } : {}) }));
  return { text, toolCalls, raw: cand.content };
}

export class GeminiClient implements LlmClient {
  readonly name: string;

  constructor(
    private apiKey: string,
    private model: string = DEFAULT_GEMINI_MODEL,
    private fetchFn: typeof fetch = fetch,
    private baseUrl: string = BASE_URL,
  ) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is required");
    this.name = `gemini:${model}`;
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toContents(req.messages),
      tools: [{ functionDeclarations: req.tools }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      // temperature is ignored by the newest models and harmless on older ones.
      generationConfig: { maxOutputTokens: req.maxOutputTokens, temperature: 0.3 },
    };
    // The key goes in a header, never in the URL, so it cannot end up in a log line or a proxy's record of addresses.
    // VERIFY: the reference examples for generateContent use ?key=; the x-goog-api-key header is the documented alternative.
    const res = await this.fetchFn(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      // Status only. The error body can echo parts of the request, which holds what the caller said.
      throw new Error(`Gemini HTTP ${res.status}`);
    }
    return parseResponse(await res.json());
  }
}
