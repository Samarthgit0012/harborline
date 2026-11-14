import type { HandoffContext } from "../services/queue.js";

/**
 * Per-call state: how many times the caller failed each menu.
 * Each webhook is a separate HTTP request (Lesson 1), so retry counts must live somewhere keyed by CallSid.
 *
 * In-memory is fine for learning and a single instance. Phase 10 swaps in Redis behind this
 * same interface, which is why the engine only ever talks to the interface.
 */
export interface StateStore {
  /** Record one more failure at this menu and return the new total. */
  bump(callSid: string, nodeId: string): number;
  reset(callSid: string, nodeId: string): void;
  /** What we know about this call so far (a copy: change it with `update`). */
  get(callSid: string): Session;
  update(callSid: string, patch: Partial<Session>): Session;
}

/** Answers collected during a first-notice-of-loss call, before the claim is created. */
export interface FnolDraft {
  policyNumber?: string;
  lossDate?: string | null;
  lossType?: "auto" | "property" | "theft" | "other";
  injuries?: "yes" | "no" | "unknown";
}

/** Everything that must survive between webhooks of ONE call. Dropped when the call's state expires. */
export interface Session {
  /** Set only after the caller proved who they are. Never set from caller ID alone. */
  authedPolicy?: string;
  /** Policy the caller claims to be, waiting for the date-of-birth check. */
  pendingPolicy?: string;
  /** True if pendingPolicy came from caller ID (so we skip asking for the number). */
  viaCallerId?: boolean;
  /** Failed verifications during this call. */
  authFailures: number;
  fnol?: FnolDraft;
  /** Claim created during this call (so a redirect replay cannot create a second one). */
  claimNumber?: string;
  /** Times speech failed this call (not understood, too unsure, or the caller said "no" to our guess). */
  speechMisses?: number;
  /** A guess waiting for the caller's yes/no. Stores the intent id only; the engine re-reads the flow. */
  speechPending?: { node: string; intent: string };
  /** What the agent should know (and hear in the whisper). Set when the caller joins the agent line. */
  handoff?: HandoffContext;
  /** Where this call is in the agent line. Only a "waiting" call may be (re)joined to the line by a hold request. */
  handoffState?: "waiting" | "connected" | "left";
  /** Callback or voicemail ticket made during this call (so a replayed request cannot make a second one). */
  ticketNumber?: string;
  /** The card payment attempt this call started (a number we made up: never any card data). */
  paymentNumber?: string;
  /** For an OUTBOUND call: the person we rang (our own number is the call's "From", so we remember theirs here). */
  contactPhone?: string;
}

export class MemoryStateStore implements StateStore {
  private calls = new Map<string, { touched: number; attempts: Map<string, number>; session: Session }>();

  constructor(
    private ttlMs = 2 * 60 * 60 * 1000,
    private now: () => number = Date.now,
  ) {}

  private entry(callSid: string) {
    this.prune();
    let e = this.calls.get(callSid);
    if (!e) {
      e = { touched: this.now(), attempts: new Map(), session: { authFailures: 0 } };
      this.calls.set(callSid, e);
    }
    e.touched = this.now();
    return e;
  }

  /** Drop state of calls that must be over by now, so memory can't grow forever. */
  private prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [sid, e] of this.calls) if (e.touched < cutoff) this.calls.delete(sid);
  }

  bump(callSid: string, nodeId: string): number {
    const e = this.entry(callSid);
    const n = (e.attempts.get(nodeId) ?? 0) + 1;
    e.attempts.set(nodeId, n);
    return n;
  }

  reset(callSid: string, nodeId: string): void {
    this.entry(callSid).attempts.delete(nodeId);
  }

  get(callSid: string): Session {
    return { ...this.entry(callSid).session };
  }

  update(callSid: string, patch: Partial<Session>): Session {
    const e = this.entry(callSid);
    e.session = { ...e.session, ...patch };
    return { ...e.session };
  }
}
