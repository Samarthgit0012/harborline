import type { Action, Flow } from "./types.js";

export interface FlowOptions {
  /** Where "speak to an agent" rings. If absent, callers are told no agent is available. */
  agentNumber?: string;
}

/**
 * Harborline's phone menu.
 * Menu-design rules applied here: short menus (5 options), most common option first, the
 * action before the key ("For claims, press 2"), a way to reach a human, and capped retries.
 */
export function buildHarborlineFlow(opts: FlowOptions = {}): Flow {
  const toAgent: Action = { type: "goto", node: "agent" };
  // `back` matters: an after-hours caller must return to the AFTER-HOURS menu, never the main menu
  // (which offers "press 0" for an agent who is not there).
  const comingSoon = (what: string, back: "main" | "closed" = "main"): Action => ({
    type: "say",
    text: `${what} will be available soon. ${back === "main" ? "Returning to the main menu." : "Returning to the previous menu."}`,
    then: { type: "goto", node: back },
  });

  return {
    start: "welcome",
    closedStart: "closed",
    nodes: {
      welcome: {
        kind: "action",
        action: {
          type: "say",
          text: "Thank you for calling Harborline Insurance.",
          then: { type: "goto", node: "main" },
        },
      },
      main: {
        kind: "menu",
        prompt:
          "For policy questions, press 1. For claims, press 2. For billing, press 3. " +
          "To get a new quote, press 4. To speak with an agent, press 0.",
        options: {
          "1": { type: "goto", node: "policy" },
          "2": { type: "goto", node: "claims" },
          "3": { type: "goto", node: "billing" },
          "4": { type: "goto", node: "quotes" },
          "0": toAgent,
        },
        maxRetries: 2,
        invalidPrompt: "Sorry, that is not a valid choice.",
        timeoutPrompt: "Sorry, I did not get your choice.",
        onGiveUp: {
          type: "say",
          text: "I am having trouble hearing you. Let me connect you to an agent.",
          then: toAgent,
        },
      },
      policy: { kind: "action", action: comingSoon("Policy information") },
      claims: { kind: "action", action: comingSoon("Claims service") },
      billing: { kind: "action", action: comingSoon("Billing service") },
      quotes: { kind: "action", action: comingSoon("Quote service") },
      // After-hours twin of "claims". Phase 3 replaces this with the real 24/7 claim-reporting flow.
      closedClaims: { kind: "action", action: comingSoon("Claims service", "closed") },
      agent: {
        kind: "action",
        action: opts.agentNumber
          ? { type: "say", text: "Please hold while I connect you.", then: { type: "transfer", to: opts.agentNumber } }
          : {
              type: "hangup",
              text: "Sorry, no agents are available right now. Please call back during business hours. Goodbye.",
            },
      },
      closed: {
        kind: "menu",
        prompt:
          "Harborline Insurance is closed right now. Our hours are Monday to Friday, eight to six, " +
          "and Saturday, nine to one, Eastern time. To report a claim, press 2. " +
          "If this is an emergency, hang up and dial 9 1 1.",
        options: { "2": { type: "goto", node: "closedClaims" } },
        maxRetries: 1,
        invalidPrompt: "Sorry, that is not a valid choice.",
        onGiveUp: { type: "hangup", text: "Please call back during business hours. Goodbye." },
      },
    },
  };
}
