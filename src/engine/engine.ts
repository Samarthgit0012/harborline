import twilio from "twilio";
import type { Action, Flow } from "../flows/types.js";
import type { StateStore } from "./state.js";

const { VoiceResponse } = twilio.twiml;
export type VoiceResponseT = InstanceType<typeof VoiceResponse>;

export interface CallContext {
  callSid: string;
  state: StateStore;
}

const POST = "POST";
const nodeUrl = (id: string) => `/ivr/${encodeURIComponent(id)}`;
const inputUrl = (id: string) => `${nodeUrl(id)}/input`;

/** Append the TwiML for one action. Say/transfer/hangup/goto are the only verbs the flows can use. */
function runAction(twiml: VoiceResponseT, action: Action): void {
  switch (action.type) {
    case "goto":
      twiml.redirect({ method: POST }, nodeUrl(action.node));
      return;
    case "say":
      twiml.say(action.text);
      runAction(twiml, action.then);
      return;
    case "transfer":
      twiml.dial(action.to);
      return;
    case "hangup":
      if (action.text) twiml.say(action.text);
      twiml.hangup();
      return;
  }
}

function failSafe(message: string): VoiceResponseT {
  // A broken flow must never leave dead air. Apologise and end the call.
  const twiml = new VoiceResponse();
  twiml.say("Sorry, something went wrong. Please call back later. Goodbye.");
  twiml.hangup();
  console.error(JSON.stringify({ level: "error", msg: message }));
  return twiml;
}

/** Caller arrives at a node: a menu asks for a key, an action node just runs. */
export function renderNode(flow: Flow, nodeId: string): VoiceResponseT {
  const node = flow.nodes[nodeId];
  if (!node) return failSafe(`unknown_node:${nodeId}`);

  const twiml = new VoiceResponse();
  if (node.kind === "action") {
    runAction(twiml, node.action);
    return twiml;
  }

  // The prompt is nested INSIDE <Gather>, so the caller can press a key while it is still playing.
  const gather = twiml.gather({ numDigits: 1, timeout: 5, action: inputUrl(nodeId), method: POST });
  gather.say(node.prompt);
  // Only reached if the caller pressed nothing. It lands on the input route with no Digits = a timeout.
  twiml.redirect({ method: POST }, inputUrl(nodeId));
  return twiml;
}

/** The caller pressed a key (or nothing) at a menu. */
export function handleInput(
  flow: Flow,
  nodeId: string,
  digits: string | undefined,
  ctx: CallContext,
): VoiceResponseT {
  const node = flow.nodes[nodeId];
  if (!node || node.kind !== "menu") return failSafe(`input_for_non_menu:${nodeId}`);

  const twiml = new VoiceResponse();
  const chosen = digits ? node.options[digits] : undefined;

  if (chosen) {
    ctx.state.reset(ctx.callSid, nodeId);
    runAction(twiml, chosen);
    return twiml;
  }

  const failures = ctx.state.bump(ctx.callSid, nodeId);
  if (failures > node.maxRetries) {
    ctx.state.reset(ctx.callSid, nodeId);
    runAction(twiml, node.onGiveUp);
    return twiml;
  }

  const apology = digits
    ? (node.invalidPrompt ?? "Sorry, that is not a valid choice.")
    : (node.timeoutPrompt ?? "Sorry, I did not get your choice.");
  twiml.say(apology);
  twiml.redirect({ method: POST }, nodeUrl(nodeId)); // play the menu again
  return twiml;
}
