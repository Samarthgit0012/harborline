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
}

export class MemoryStateStore implements StateStore {
  private calls = new Map<string, { touched: number; attempts: Map<string, number> }>();

  constructor(
    private ttlMs = 2 * 60 * 60 * 1000,
    private now: () => number = Date.now,
  ) {}

  private entry(callSid: string) {
    this.prune();
    let e = this.calls.get(callSid);
    if (!e) {
      e = { touched: this.now(), attempts: new Map() };
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
}
