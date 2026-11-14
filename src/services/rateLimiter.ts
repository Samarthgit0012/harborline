/**
 * Sliding-window failure counter. After `max` failures inside `windowMs`, the key is locked until
 * the oldest failure ages out.
 *
 * We keep one counter per CALLER NUMBER and one per POLICY NUMBER:
 *  - per number stops one phone from guessing across many policies,
 *  - per policy stops many numbers (or a spoofer rotating caller IDs) from guessing one policy.
 * Successes deliberately do NOT clear a counter: otherwise an attacker who owns one valid account
 * could log in to it between guesses and keep resetting the lockout.
 */
export class AttemptLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private max = 5,
    private windowMs = 30 * 60 * 1000,
    private now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  recordFailure(key: string): void {
    const kept = this.recent(key);
    kept.push(this.now());
    this.failures.set(key, kept);
  }

  isLocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }
}
