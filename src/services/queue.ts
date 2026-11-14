import { speakDigits } from "./speak.js";

/**
 * A small in-memory waiting line for ONE agent line (your second phone while learning).
 *
 * Why we keep our own queue instead of Twilio's <Enqueue>: Twilio documents that the `url` of
 * <Dial><Queue> runs on the QUEUED CALLER's leg, so it cannot whisper to the agent. A whisper needs
 * <Dial><Number url=...>, which runs on the called party's leg. Our own queue lets us pick who is next
 * and then dial the agent with a whisper built from what the IVR already knows.
 *
 * Trade-off (taught in Lesson 9): in-memory means a restart empties the line and two server copies would
 * each have their own line. Phase 10 moves this behind the same interface to Redis; a real contact centre
 * uses Twilio TaskRouter/Flex, Amazon Connect or Genesys instead of hand-rolling any of this.
 */

/** What the IVR already knows about the caller, handed to the agent so they never have to re-ask. */
export interface HandoffContext {
  reason: "general" | "claim_injury";
  /** Injury claim: goes to the front of the line. */
  urgent: boolean;
  /** The caller proved who they are during THIS call (Lesson 6), not just "caller ID matched". */
  verified: boolean;
  policyLast4?: string;
  claimNumber?: string;
  /** Epoch ms when they first joined. Kept so a caller who is dropped and re-added keeps their place. */
  queuedAt: number;
}

interface Waiter {
  callSid: string;
  ctx: HandoffContext;
  lastSeen: number;
}

/** The numbers a call-centre manager asks for. All derived from events we already have. */
export class QueueStats {
  offered = 0; // callers who joined the line
  connected = 0; // callers we started ringing the agent for
  abandoned = 0; // callers who vanished (hung up) while waiting
  callbacks = 0; // callers who chose a call back instead of waiting
  timedOut = 0; // callers moved off the line because they waited too long
  noAnswer = 0; // the agent line rang and nobody took it
  private waits: number[] = []; // seconds waited, for callers who were connected
  private handled: number[] = []; // seconds of talk time

  recordConnected(waitSec: number) {
    this.connected++;
    this.waits.push(waitSec);
  }
  recordHandled(talkSec: number) {
    this.handled.push(talkSec);
  }

  /** ASA = average speed of answer (here: average wait until we rang the agent). AHT = average handle time (talk time only). */
  summary(serviceLevelSec = 30) {
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      offered: this.offered,
      connected: this.connected,
      abandoned: this.abandoned,
      callbacks: this.callbacks,
      timedOut: this.timedOut,
      noAnswer: this.noAnswer,
      abandonRate: this.offered ? this.abandoned / this.offered : 0,
      asaSec: avg(this.waits),
      ahtSec: avg(this.handled),
      /** Share of ALL offered callers who were connected within the target. */
      serviceLevel: this.offered ? this.waits.filter((w) => w <= serviceLevelSec).length / this.offered : 0,
    };
  }
}

export interface QueueOptions {
  /** A waiter not heard from for this long has hung up (the hold loop checks in every ~20 s). */
  staleMs: number;
  /** If the agent line never reports back, assume the call is over after this long. */
  agentLeaseMs: number;
  /** Longest anyone waits before we stop offering the line and offer a call back or voicemail. */
  maxWaitMs: number;
}

export const DEFAULT_QUEUE_OPTIONS: QueueOptions = { staleMs: 90_000, agentLeaseMs: 30 * 60_000, maxWaitMs: 10 * 60_000 };

export class CallQueue {
  private waiters = new Map<string, Waiter>();
  private agent?: { callSid: string; until: number };
  readonly stats = new QueueStats();
  readonly opts: QueueOptions;

  constructor(
    private now: () => number = Date.now,
    opts: Partial<QueueOptions> = {},
  ) {
    this.opts = { ...DEFAULT_QUEUE_OPTIONS, ...opts };
  }

  get maxWaitMs() {
    return this.opts.maxWaitMs;
  }

  /** Remove callers we have not heard from: they hung up while waiting. */
  private sweep() {
    for (const [sid, w] of this.waiters) {
      if (this.now() - w.lastSeen > this.opts.staleMs) {
        this.waiters.delete(sid);
        this.stats.abandoned++;
      }
    }
  }

  /** Urgent callers first, then by arrival. */
  private ordered(): Waiter[] {
    return [...this.waiters.values()].sort(
      (a, b) => Number(b.ctx.urgent) - Number(a.ctx.urgent) || a.ctx.queuedAt - b.ctx.queuedAt,
    );
  }

  /** Join the line. Joining twice does nothing. */
  join(callSid: string, ctx: HandoffContext): void {
    if (this.waiters.has(callSid)) return;
    this.sweep();
    this.waiters.set(callSid, { callSid, ctx, lastSeen: this.now() });
    this.stats.offered++;
  }

  /**
   * A caller we swept as "gone" turned out to be alive (the hold loop was just slow). Put them back in
   * their original place and take back the abandonment we wrongly counted.
   */
  rejoin(callSid: string, ctx: HandoffContext): void {
    if (this.waiters.has(callSid)) return;
    this.waiters.set(callSid, { callSid, ctx, lastSeen: this.now() });
    this.stats.abandoned = Math.max(0, this.stats.abandoned - 1);
  }

  /** "I'm still here." False if this caller is no longer in the line. */
  touch(callSid: string): boolean {
    const w = this.waiters.get(callSid);
    if (!w) return false;
    w.lastSeen = this.now(); // refresh the caller who is talking to us BEFORE sweeping, so they cannot sweep themselves
    this.sweep();
    return true;
  }

  has(callSid: string): boolean {
    return this.waiters.has(callSid);
  }

  /** 1 = next in line, 0 = not waiting. */
  position(callSid: string): number {
    return this.ordered().findIndex((w) => w.callSid === callSid) + 1;
  }

  size(): number {
    return this.waiters.size;
  }

  waitedMs(callSid: string): number {
    const w = this.waiters.get(callSid);
    return w ? this.now() - w.ctx.queuedAt : 0;
  }

  /** The caller chose something else (callback, voicemail) or waited too long. */
  leave(callSid: string, why: "callback" | "timeout" | "voicemail"): void {
    if (!this.waiters.delete(callSid)) return;
    if (why === "callback") this.stats.callbacks++;
    if (why === "timeout") this.stats.timedOut++;
  }

  agentFree(): boolean {
    if (this.agent && this.now() >= this.agent.until) this.agent = undefined; // lost the "call ended" report
    return !this.agent;
  }

  /** Connect this caller to the agent line, but only if they are first in line AND the agent is free. */
  tryConnect(callSid: string): boolean {
    if (!this.touch(callSid)) return false;
    if (!this.agentFree()) return false;
    const head = this.ordered()[0];
    if (!head || head.callSid !== callSid) return false;
    this.waiters.delete(callSid);
    this.agent = { callSid, until: this.now() + this.opts.agentLeaseMs };
    this.stats.recordConnected(Math.max(0, Math.round((this.now() - head.ctx.queuedAt) / 1000)));
    return true;
  }

  /** The agent line is free again (the Dial ended). Only the call that holds the line can release it. */
  releaseAgent(callSid: string): void {
    if (this.agent?.callSid === callSid) this.agent = undefined;
  }
}

/** What the agent hears privately, before the caller is bridged. Short, ordered by what they need first. */
export function whisperText(ctx: HandoffContext | undefined): string {
  if (!ctx) return "Harborline call. No details are available.";
  const parts = ["Harborline call."];
  if (ctx.urgent) parts.push("Urgent. Injury claim.");
  if (ctx.verified) {
    parts.push(ctx.policyLast4 ? `Verified caller, policy ending ${speakDigits(ctx.policyLast4, 4)}.` : "Verified caller.");
  } else {
    parts.push(
      ctx.policyLast4
        ? `Caller not verified. They gave a policy ending ${speakDigits(ctx.policyLast4, 4)}.`
        : "Caller not verified.",
    );
  }
  if (ctx.claimNumber) parts.push(`Claim ${speakDigits(ctx.claimNumber)} was just reported on this call.`);
  return parts.join(" ");
}
