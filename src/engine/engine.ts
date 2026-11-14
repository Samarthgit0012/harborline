import twilio from "twilio";
import type { Action, Flow, MenuNode } from "../flows/types.js";
import type { StateStore } from "./state.js";
import { decide, hintsFor, matchIntent, yesNo } from "../services/intent.js";
import { log } from "../log.js";
import { redactPans } from "../services/pci.js";

const { VoiceResponse } = twilio.twiml;
export type VoiceResponseT = InstanceType<typeof VoiceResponse>;

export interface CallContext {
  callSid: string;
  state: StateStore;
}

const POST = "POST";
const nodeUrl = (id: string) => `/ivr/${encodeURIComponent(id)}`;
const inputUrl = (id: string) => `${nodeUrl(id)}/input`;
const confirmUrl = (id: string) => `${nodeUrl(id)}/confirm`;

/** After this many speech failures in one call we stop offering speech and use the keypad only. */
export const MAX_SPEECH_MISSES = 2;

/** What Twilio's recogniser heard, as received on the webhook. */
export interface Speech {
  text: string;
  confidence?: number;
}

const speechOn = (node: MenuNode, ctx?: CallContext) =>
  !!node.speech && !!ctx && (ctx.state.get(ctx.callSid).speechMisses ?? 0) < MAX_SPEECH_MISSES;

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
    case "service":
      twiml.redirect({ method: POST }, `/svc/${encodeURIComponent(action.name)}?back=${encodeURIComponent(action.back)}`);
      return;
  }
}

export function failSafe(message: string): VoiceResponseT {
  // A broken flow must never leave dead air. Apologise and end the call.
  const twiml = new VoiceResponse();
  twiml.say("Sorry, something went wrong. Please call back later. Goodbye.");
  twiml.hangup();
  console.error(JSON.stringify({ level: "error", msg: redactPans(message) }));
  return twiml;
}

/** Caller arrives at a node: a menu asks for a key, an action node just runs. */
export function renderNode(flow: Flow, nodeId: string, ctx?: CallContext): VoiceResponseT {
  const node = flow.nodes[nodeId];
  if (!node) return failSafe(`unknown_node:${nodeId}`);

  const twiml = new VoiceResponse();
  if (node.kind === "action") {
    runAction(twiml, node.action);
    return twiml;
  }

  // The prompt is nested INSIDE <Gather>, so the caller can press a key while it is still playing.
  if (node.speech && speechOn(node, ctx)) {
    // Hybrid: keypad OR voice, whichever Twilio detects first. "auto" ends speech at the first pause.
    const gather = twiml.gather({
      input: ["dtmf", "speech"],
      numDigits: 1,
      timeout: 5,
      speechTimeout: "auto",
      language: "en-US",
      hints: hintsFor(node.speech.intents),
      action: inputUrl(nodeId),
      method: POST,
    });
    gather.say(`${node.speech.intro} ${node.prompt}`);
  } else {
    const gather = twiml.gather({ numDigits: 1, timeout: 5, action: inputUrl(nodeId), method: POST });
    gather.say(node.prompt);
  }
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
  speech?: Speech,
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

  // A key always wins (Twilio acts on whichever input it detects first). Speech only counts if we offered it.
  if (!digits && speech?.text && speechOn(node, ctx)) return handleSpeech(node, nodeId, speech, ctx, twiml);

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

/** The caller said something at a speech-enabled menu. */
function handleSpeech(node: MenuNode, nodeId: string, speech: Speech, ctx: CallContext, twiml: VoiceResponseT): VoiceResponseT {
  const m = matchIntent(speech.text, node.speech!.intents);
  // Never log what the caller said: it can contain names, policy numbers, health details. Outcome and score only.
  const logOutcome = (outcome: string) =>
    log("info", "speech_result", { callSid: ctx.callSid, node: nodeId, outcome, confidence: speech.confidence, intent: m.intent?.id });

  if (!m.intent) {
    logOutcome(m.ambiguous ? "ambiguous" : "nomatch");
    return speechMiss(node, nodeId, ctx, twiml, "Sorry, I did not catch that.");
  }
  const verdict = decide(speech.confidence, m.negated);
  logOutcome(verdict);
  if (verdict === "reject") return speechMiss(node, nodeId, ctx, twiml, "Sorry, I did not catch that.");

  if (verdict === "accept") {
    ctx.state.reset(ctx.callSid, nodeId);
    runAction(twiml, m.intent.action);
    return twiml;
  }

  // Unsure: ask before acting. The pending guess is stored by id; the answer route re-reads it from the flow.
  ctx.state.update(ctx.callSid, { speechPending: { node: nodeId, intent: m.intent.id } });
  const gather = twiml.gather({
    input: ["dtmf", "speech"],
    numDigits: 1,
    timeout: 5,
    speechTimeout: "auto",
    language: "en-US",
    hints: "yes, no",
    action: confirmUrl(nodeId),
    method: POST,
  });
  gather.say(`Did you want ${m.intent.label}? If that is right, press 1 or say yes. Otherwise, press 2 or say no.`);
  twiml.redirect({ method: POST }, confirmUrl(nodeId)); // silence = not confirmed
  return twiml;
}

/** The caller answered "did you want X?". Only a clear yes (or the 1 key) acts on the guess. */
export function handleConfirm(
  flow: Flow,
  nodeId: string,
  digits: string | undefined,
  speech: Speech | undefined,
  ctx: CallContext,
): VoiceResponseT {
  const node = flow.nodes[nodeId];
  if (!node || node.kind !== "menu" || !node.speech) return failSafe(`confirm_for_non_speech_menu:${nodeId}`);

  const pending = ctx.state.get(ctx.callSid).speechPending;
  const intent = pending?.node === nodeId ? node.speech.intents.find((i) => i.id === pending.intent) : undefined;
  if (!intent) return renderNode(flow, nodeId, ctx); // nothing to confirm (replayed or forged request): start the menu over

  ctx.state.update(ctx.callSid, { speechPending: undefined }); // a guess can be answered once
  const answer = digits ? (digits === "1" ? "yes" : digits === "2" ? "no" : null) : speech?.text ? yesNo(speech.text) : null;
  log("info", "speech_confirm", { callSid: ctx.callSid, node: nodeId, intent: intent.id, answer: answer ?? "unclear" });

  const twiml = new VoiceResponse();
  if (answer === "yes") {
    ctx.state.reset(ctx.callSid, nodeId);
    runAction(twiml, intent.action);
    return twiml;
  }
  return speechMiss(node, nodeId, ctx, twiml, answer === "no" ? "Okay, sorry about that." : "Sorry, I did not get that.");
}

/** Speech failed (nothing matched, too unsure, or the caller rejected our guess). Retry, then drop to keypad-only. */
function speechMiss(node: MenuNode, nodeId: string, ctx: CallContext, twiml: VoiceResponseT, apology: string): VoiceResponseT {
  const misses = (ctx.state.get(ctx.callSid).speechMisses ?? 0) + 1;
  ctx.state.update(ctx.callSid, { speechMisses: misses });

  const failures = ctx.state.bump(ctx.callSid, nodeId);
  if (failures > node.maxRetries) {
    ctx.state.reset(ctx.callSid, nodeId);
    runAction(twiml, node.onGiveUp);
    return twiml;
  }
  twiml.say(misses >= MAX_SPEECH_MISSES ? `${apology} Let's use your keypad instead.` : apology);
  twiml.redirect({ method: POST }, nodeUrl(nodeId)); // replay the menu (keypad-only once speech is switched off)
  return twiml;
}
