import type { Action, Flow } from "./types.js";

/** Code-driven services the flow may hand a call to (see src/svc). The server validates against this. */
export const SERVICE_NAMES = ["policy", "billing", "claimstatus", "fnol"];

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
  const comingSoon = (what: string): Action => ({
    type: "say",
    text: `${what} will be available soon. Returning to the main menu.`,
    then: { type: "goto", node: "main" },
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
        // Callers may also SAY what they need. Each intent maps straight to an action, so "file a claim"
        // skips the claims submenu. Longest phrase wins ("file a claim" beats "claim"); equal-length ties are ambiguous.
        speech: {
          intro: "You can say what you need, like file a claim, or pay my bill. Or use your keypad.",
          intents: [
            {
              id: "claim_new",
              label: "to report a new claim",
              phrases: [
                "file a claim", "report a claim", "new claim", "make a claim", "start a claim", "open a claim",
                "accident", "car accident", "crash", "collision", "someone hit me", "break in", "theft", "stolen",
              ],
              action: { type: "service", name: "fnol", back: "main" },
            },
            {
              id: "claim_status",
              label: "to check on a claim",
              phrases: [
                "claim status", "status of my claim", "check my claim", "existing claim", "my claim",
                "where is my claim", "update on my claim",
              ],
              action: { type: "service", name: "claimstatus", back: "main" },
            },
            { id: "claims", label: "claims", phrases: ["claim", "claims"], action: { type: "goto", node: "claims" } },
            {
              id: "billing",
              label: "billing",
              phrases: [
                "pay my bill", "pay bill", "make a payment", "billing", "bill", "payment", "balance",
                "how much do i owe", "amount due", "premium",
              ],
              action: { type: "service", name: "billing", back: "main" },
            },
            {
              id: "policy",
              label: "policy questions",
              phrases: [
                "policy", "my policy", "coverage", "deductible", "policy information", "policy question",
                "what am i covered for", "id card",
              ],
              action: { type: "service", name: "policy", back: "main" },
            },
            {
              id: "quote",
              label: "to get a quote",
              phrases: ["quote", "new quote", "get a quote", "price", "new policy", "buy insurance", "sign up"],
              action: { type: "goto", node: "quotes" },
            },
            {
              id: "agent",
              label: "to speak with an agent",
              phrases: [
                "agent", "representative", "a person", "human", "real person", "operator",
                "talk to someone", "speak to someone", "speak with someone", "speak to an agent", "talk to an agent",
              ],
              action: toAgent,
            },
          ],
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
      // These need code (data lookups, authentication), so the flow hands the call to a service.
      policy: { kind: "action", action: { type: "service", name: "policy", back: "main" } },
      billing: { kind: "action", action: { type: "service", name: "billing", back: "main" } },
      claims: {
        kind: "menu",
        prompt:
          "To report a new claim, press 1. To check the status of an existing claim, press 2. " +
          "To return to the main menu, press 9.",
        options: {
          "1": { type: "service", name: "fnol", back: "main" },
          "2": { type: "service", name: "claimstatus", back: "main" },
          "9": { type: "goto", node: "main" },
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
      quotes: { kind: "action", action: comingSoon("Quote service") },
      // After-hours twin of "claims": reporting a loss works 24/7 and returns to the AFTER-HOURS menu.
      closedClaims: { kind: "action", action: { type: "service", name: "fnol", back: "closed" } },
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
