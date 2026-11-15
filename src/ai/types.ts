// The only thing the rest of the code knows about "an AI model". Gemini, a test script and the offline practice model
// all fit this shape, so swapping the vendor never touches the call logic.

/** A function the model may ask us to run. `parameters` is a JSON-schema object. */
export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ToolResult {
  name: string;
  id?: string;
  result: Record<string, unknown>;
}

/** The conversation so far, in a vendor-neutral form. */
export type LlmMessage =
  | { role: "user"; text: string }
  /** `raw` is the vendor's own copy of the turn, handed back unchanged next time (some vendors need hidden fields kept). */
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolDecl[];
  maxOutputTokens: number;
  /** Aborted when we stop waiting: a caller on the phone cannot be kept in silence. */
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
}

export interface LlmClient {
  /** For logs only, e.g. "gemini:gemini-3.5-flash-lite". */
  readonly name: string;
  generate(req: LlmRequest): Promise<LlmResponse>;
}
