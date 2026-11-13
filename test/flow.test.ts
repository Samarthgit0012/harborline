import { describe, it, expect } from "vitest";
import { buildHarborlineFlow } from "../src/flows/harborline.js";
import { gotoTargets, validateFlow } from "../src/flows/validate.js";
import type { Flow } from "../src/flows/types.js";

const hangup = { type: "hangup" as const, text: "Bye." };

/** Smallest valid flow, to mutate in the negative tests. */
const base = (): Flow => ({
  start: "m",
  closedStart: "m",
  nodes: {
    m: { kind: "menu", prompt: "p", options: { "1": hangup }, maxRetries: 2, onGiveUp: hangup },
  },
});

describe("Harborline flow", () => {
  it("passes validation with an agent number", () => {
    expect(validateFlow(buildHarborlineFlow({ agentNumber: "+15555550123" }))).toEqual([]);
  });
  it("passes validation without an agent number", () => {
    expect(validateFlow(buildHarborlineFlow())).toEqual([]);
  });
  it("keeps the main menu within the 3-5 option guideline", () => {
    const main = buildHarborlineFlow().nodes.main;
    expect(main.kind).toBe("menu");
    if (main.kind === "menu") expect(Object.keys(main.options).length).toBeLessThanOrEqual(5);
  });
});

/** Every node a caller could ever reach from an entry point. */
function reachableFrom(flow: Flow, entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = flow.nodes[id];
    const actions = node.kind === "menu" ? [...Object.values(node.options), node.onGiveUp] : [node.action];
    stack.push(...actions.flatMap(gotoTargets));
  }
  return seen;
}

describe("after-hours safety", () => {
  it("a caller who starts after hours can never reach the main menu or the agent transfer", () => {
    const flow = buildHarborlineFlow({ agentNumber: "+15555550123" });
    const reachable = reachableFrom(flow, flow.closedStart);
    expect(reachable.has("main")).toBe(false);
    expect(reachable.has("agent")).toBe(false);
  });
  it("a caller who starts during business hours can reach the agent", () => {
    const flow = buildHarborlineFlow({ agentNumber: "+15555550123" });
    expect(reachableFrom(flow, flow.start).has("agent")).toBe(true);
  });
});

describe("validateFlow catches design mistakes", () => {
  it("passes the minimal flow", () => {
    expect(validateFlow(base())).toEqual([]);
  });

  it("rejects a goto to a node that does not exist", () => {
    const f = base();
    (f.nodes.m as any).options["2"] = { type: "goto", node: "nowhere" };
    expect(validateFlow(f).join()).toContain('unknown node "nowhere"');
  });

  it("rejects a missing entry node", () => {
    const f = base();
    f.start = "ghost";
    expect(validateFlow(f).join()).toContain('entry node "ghost"');
  });

  it("rejects unlimited or negative retries", () => {
    for (const bad of [Infinity, -1, 99, 1.5]) {
      const f = base();
      (f.nodes.m as any).maxRetries = bad;
      expect(validateFlow(f).join()).toContain("maxRetries");
    }
  });

  it("rejects onGiveUp that loops back into the flow (silence would repeat forever)", () => {
    const f = base();
    (f.nodes.m as any).onGiveUp = { type: "goto", node: "m" };
    expect(validateFlow(f).join()).toContain("onGiveUp must end the call");
  });

  it("rejects onGiveUp that goes through a non-menu node and then back into a menu", () => {
    const f = base();
    f.nodes.back = { kind: "action", action: { type: "goto", node: "m" } };
    (f.nodes.m as any).onGiveUp = { type: "goto", node: "back" };
    expect(validateFlow(f).join()).toContain("onGiveUp must end the call");
  });

  it("accepts onGiveUp that goes to a non-menu node which transfers (how Harborline reaches an agent)", () => {
    const f = base();
    f.nodes.agent = { kind: "action", action: { type: "transfer", to: "+15555550123" } };
    (f.nodes.m as any).onGiveUp = { type: "say", text: "x", then: { type: "goto", node: "agent" } };
    expect(validateFlow(f)).toEqual([]);
  });

  it("accepts onGiveUp that says something then transfers", () => {
    const f = base();
    (f.nodes.m as any).onGiveUp = { type: "say", text: "x", then: { type: "transfer", to: "+15555550123" } };
    expect(validateFlow(f)).toEqual([]);
  });

  it("rejects a loop made only of non-interactive nodes", () => {
    const f = base();
    f.nodes.a = { kind: "action", action: { type: "goto", node: "b" } };
    f.nodes.b = { kind: "action", action: { type: "goto", node: "a" } };
    (f.nodes.m as any).options["2"] = { type: "goto", node: "a" };
    expect(validateFlow(f).join()).toContain("non-interactive loop");
  });

  it("allows a loop that passes through a menu (the caller must act each time)", () => {
    const f = base();
    f.nodes.a = { kind: "action", action: { type: "say", text: "again", then: { type: "goto", node: "m" } } };
    (f.nodes.m as any).options["2"] = { type: "goto", node: "a" };
    expect(validateFlow(f)).toEqual([]);
  });

  it("rejects unreachable nodes", () => {
    const f = base();
    f.nodes.orphan = { kind: "action", action: hangup };
    expect(validateFlow(f).join()).toContain('"orphan" is unreachable');
  });

  it("rejects options that are not single keypad keys", () => {
    const f = base();
    (f.nodes.m as any).options["12"] = hangup;
    expect(validateFlow(f).join()).toContain("not a single keypad key");
  });
});
