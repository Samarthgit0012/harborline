/**
 * A call flow is DATA, not code: a set of named nodes plus where the call starts.
 * The engine turns one node into TwiML. Keeping flows as data lets us validate them
 * (no dead ends, no infinite loops) before a single call is made.
 */

/** What happens next. Actions can be chained: say something, then do another action. */
export type Action =
  | { type: "goto"; node: string }
  | { type: "say"; text: string; then: Action }
  | { type: "transfer"; to: string } // E.164 phone number to <Dial>
  | { type: "hangup"; text?: string };

/** Asks the caller to press a key. */
export interface MenuNode {
  kind: "menu";
  prompt: string;
  /** key ("0"-"9", "*", "#") -> action */
  options: Record<string, Action>;
  /** How many times we re-prompt after a bad or missing key before giving up. */
  maxRetries: number;
  /** What to do when retries run out. Must END the call or hand it to a human (validated). */
  onGiveUp: Action;
  invalidPrompt?: string;
  timeoutPrompt?: string;
}

/** Non-interactive step: just runs an action. */
export interface ActionNode {
  kind: "action";
  action: Action;
}

export type FlowNode = MenuNode | ActionNode;

export interface Flow {
  /** Node used when the business is open. */
  start: string;
  /** Node used when the business is closed. */
  closedStart: string;
  nodes: Record<string, FlowNode>;
}
