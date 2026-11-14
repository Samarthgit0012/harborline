import type { Policy } from "../services/policyRepo.js";

/** "03141985" -> "1985-03-14", or undefined if it is not a real calendar date (or before 1900). */
export function dobFromDigits(d: string): string | undefined {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(d);
  if (!m) return undefined;
  const month = Number(m[1]), day = Number(m[2]), year = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return undefined;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

export const DEMO_POLICY_NUMBERS = ["90000001", "90000002"] as const;

/**
 * The practice customers. The first is YOU: an auto policy with a small balance owing, due in five days, so billing and
 * the payment option have something to show. The second (optional) owes nothing.
 */
export function demoPolicies(opts: { customer: string; second?: string; dob: string; today?: Date }): Policy[] {
  const due = new Date((opts.today ?? new Date()).getTime() + 5 * 24 * 3600_000).toISOString().slice(0, 10);
  const out: Policy[] = [
    { policyNumber: "90000001", holderName: "Demo Customer", dob: opts.dob, phone: opts.customer, product: "auto", status: "active", premiumCents: 14250, balanceCents: 8750, nextDue: due },
  ];
  if (opts.second) {
    out.push({ policyNumber: "90000002", holderName: "Demo Customer Two", dob: opts.dob, phone: opts.second, product: "home", status: "active", premiumCents: 8900, balanceCents: 0, nextDue: due });
  }
  return out;
}
