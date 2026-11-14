import type { Action, Flow } from "./types.js";

/** Every node a given action can send the call to. */
export function gotoTargets(a: Action): string[] {
  switch (a.type) {
    case "goto":
      return [a.node];
    case "say":
      return gotoTargets(a.then);
    case "service":
      return [a.back]; // the service sends the caller back here when it finishes
    default:
      return [];
  }
}

/** Service names an action refers to. */
function serviceNames(a: Action): string[] {
  if (a.type === "service") return [a.name];
  if (a.type === "say") return serviceNames(a.then);
  return [];
}

/**
 * True if the action ends the call or hands it to a human WITHOUT passing through another menu.
 * It follows `goto`s into non-interactive nodes (e.g. "goto agent", where agent is a transfer),
 * but a goto into a menu does not count: that would loop the caller back into the flow.
 */
export function reachesEnd(flow: Flow, a: Action, seen = new Set<string>()): boolean {
  switch (a.type) {
    case "transfer":
    case "hangup":
      return true;
    case "say":
      return reachesEnd(flow, a.then, seen);
    case "goto": {
      const target = flow.nodes[a.node];
      if (!target || target.kind !== "action" || seen.has(a.node)) return false;
      return reachesEnd(flow, target.action, new Set(seen).add(a.node));
    }
    case "service":
      return false; // a service returns the caller to the flow, so it does not end the call
  }
}

/**
 * Static checks on a flow. Returns a list of problems (empty = OK).
 * The goal: a caller can never be trapped, and the system can never spin without the caller acting.
 */
export function validateFlow(flow: Flow, knownServices?: string[]): string[] {
  const errors: string[] = [];
  const ids = Object.keys(flow.nodes);

  for (const entry of [flow.start, flow.closedStart]) {
    if (!flow.nodes[entry]) errors.push(`entry node "${entry}" does not exist`);
  }

  const edges = new Map<string, string[]>();
  for (const id of ids) {
    const node = flow.nodes[id];
    let targets: string[];
    if (node.kind === "menu") {
      if (!Number.isInteger(node.maxRetries) || node.maxRetries < 0 || node.maxRetries > 5) {
        errors.push(`menu "${id}": maxRetries must be an integer from 0 to 5 (got ${node.maxRetries})`);
      }
      const keys = Object.keys(node.options);
      if (keys.length === 0) errors.push(`menu "${id}": has no options`);
      for (const k of keys) {
        if (!/^[0-9*#]$/.test(k)) errors.push(`menu "${id}": "${k}" is not a single keypad key`);
      }
      if (!reachesEnd(flow, node.onGiveUp)) {
        errors.push(
          `menu "${id}": onGiveUp must end the call or transfer to a human, not loop back into the flow`,
        );
      }
      targets = [...keys.flatMap((k) => gotoTargets(node.options[k])), ...gotoTargets(node.onGiveUp)];
    } else {
      targets = gotoTargets(node.action);
    }
    for (const t of targets) {
      if (!flow.nodes[t]) errors.push(`node "${id}" goes to unknown node "${t}"`);
    }
    if (knownServices) {
      const actions = node.kind === "menu" ? [...Object.values(node.options), node.onGiveUp] : [node.action];
      for (const name of actions.flatMap(serviceNames)) {
        if (!knownServices.includes(name)) errors.push(`node "${id}" uses unknown service "${name}"`);
      }
    }
    edges.set(id, targets.filter((t) => flow.nodes[t]));
  }

  // Reachability: every node should be reachable from an entry point.
  const seen = new Set<string>();
  const stack = [flow.start, flow.closedStart].filter((e) => flow.nodes[e]);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(edges.get(id) ?? []));
  }
  for (const id of ids) if (!seen.has(id)) errors.push(`node "${id}" is unreachable`);

  // Non-interactive nodes must not form a cycle: that would spin forever with no caller input.
  // (Cycles THROUGH a menu are fine, because a menu waits for the caller and caps its retries.)
  const color = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const visit = (id: string, path: string[]): void => {
    if (color.get(id) === 2) return;
    if (color.get(id) === 1) {
      errors.push(`non-interactive loop: ${[...path.slice(path.indexOf(id)), id].join(" -> ")}`);
      return;
    }
    color.set(id, 1);
    for (const t of edges.get(id) ?? []) {
      if (flow.nodes[t].kind === "action") visit(t, [...path, id]);
    }
    color.set(id, 2);
  };
  for (const id of ids) if (flow.nodes[id].kind === "action") visit(id, []);

  return errors;
}
