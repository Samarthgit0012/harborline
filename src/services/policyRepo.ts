import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Policy {
  policyNumber: string;
  holderName: string;
  /** ISO date YYYY-MM-DD. The knowledge factor we check at login. */
  dob: string;
  /** E.164. Used to recognise the caller AND as the only place we ever text. */
  phone: string;
  product: "auto" | "home" | "life";
  status: "active" | "lapsed";
  premiumCents: number;
  balanceCents: number;
  /** ISO date of the next payment. */
  nextDue: string;
}

export type LossType = "auto" | "property" | "theft" | "other";
export type Injuries = "yes" | "no" | "unknown";

export interface Claim {
  claimNumber: string;
  policyNumber: string | null;
  /** True only if the caller had authenticated. Otherwise an adjuster must verify the policy number. */
  policyVerified: boolean;
  status: "received" | "in review" | "closed";
  lossDate: string | null;
  lossType: LossType;
  injuries: Injuries;
  urgent: boolean;
  callbackPhone: string;
  recordingSid: string | null;
  createdAt: string;
}

export interface NewClaim {
  policyNumber: string | null;
  policyVerified: boolean;
  lossDate: string | null;
  lossType: LossType;
  injuries: Injuries;
  callbackPhone: string;
}

/** A request for a human to call the customer back: either "call me instead of making me wait" or a voicemail. */
export interface Ticket {
  ticketNumber: string;
  kind: "callback" | "voicemail";
  /** Where to call back (E.164 when we could parse it). Outbound calling rules apply: see Phase 7. */
  phone: string;
  reason: string;
  /** Only set if the caller proved who they were. Otherwise an agent must verify before discussing anything. */
  policyNumber: string | null;
  policyVerified: boolean;
  claimNumber: string | null;
  urgent: boolean;
  recordingSid: string | null;
  status: "open" | "done";
  createdAt: string;
}

export type NewTicket = Pick<Ticket, "kind" | "phone" | "reason" | "policyNumber" | "policyVerified" | "claimNumber" | "urgent">;

/**
 * One attempt to pay by card. Note what is NOT here: no card number, no expiry, no security code, no payment
 * token. Those live only with the payment processor. We keep the amount, what happened, and the processor's
 * confirmation code (a transaction reference, not card data) so a human can match it to the processor's records.
 */
export interface Payment {
  paymentNumber: string;
  policyNumber: string;
  amountCents: number;
  /** started: the caller is typing their card. succeeded / failed: the processor told us. unconfirmed: we do NOT know (reconcile by hand). */
  status: "started" | "succeeded" | "failed" | "unconfirmed";
  /** Twilio's Result value ("success", "caller-interrupted-with-star", ...). */
  result: string | null;
  confirmation: string | null;
  /** The balance was smaller than the payment by the time it landed (paid twice, or paid elsewhere). A human must look. */
  needsReview: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentOutcome {
  status: "succeeded" | "failed" | "unconfirmed";
  result: string;
  confirmation?: string;
}

/** The only door to customer data. A real client swaps this for their policy-admin system's API. */
export interface PolicyRepo {
  findByPhone(phone: string): Policy[];
  findByPolicyNumber(policyNumber: string): Policy | undefined;
  claimsFor(policyNumber: string): Claim[];
  createClaim(input: NewClaim, now?: Date): Claim;
  attachRecording(claimNumber: string, recordingSid: string): void;
  createTicket(input: NewTicket, now?: Date): Ticket;
  attachTicketRecording(ticketNumber: string, recordingSid: string): void;
  openTickets(): Ticket[];
  /** Record that a card payment is about to be attempted. Done BEFORE the caller types anything. */
  startPayment(policyNumber: string, amountCents: number, now?: Date): Payment;
  getPayment(paymentNumber: string): Payment | undefined;
  /** Apply the result. A payment already finished is returned unchanged, so a repeated webhook cannot apply it twice. */
  completePayment(paymentNumber: string, outcome: PaymentOutcome, now?: Date): Payment | undefined;
  /** Attempts we never heard back about (started too long ago) plus ones marked unconfirmed: the reconciliation list. */
  unresolvedPayments(olderThanMs: number, now?: Date): Payment[];
  /**
   * Payments on this policy that might still turn into a charge: in progress (started) or of unknown outcome
   * (unconfirmed). While any exist, a new payment is refused so nobody is charged twice.
   * `ownOpenPayment` is the caller's own attempt that is still in progress (it is being reused, so it is not "another" payment).
   * It is only excluded while it is still "started": once it is unconfirmed it blocks like any other.
   */
  blockingPayments(policyNumber: string, ownOpenPayment?: string): Payment[];
}

const PAYMENT_BASE = 300000; // payments are spoken as "3 0 0, 0 0 1"
const TICKET_BASE = 200000; // tickets are spoken as "2 0 0, 0 0 1"
const CLAIM_BASE = 100000; // claim 1 is spoken as "1 0 0, 0 0 1": six digits is easy to write down
type Row = Record<string, string | number | null>;

export class SqliteRepo implements PolicyRepo {
  private db: DatabaseSync;

  /** `path` is a file path, or ":memory:" for tests. Sample data is seeded into an empty database. */
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS policies (
        policy_number TEXT PRIMARY KEY, holder_name TEXT NOT NULL, dob TEXT NOT NULL, phone TEXT NOT NULL,
        product TEXT NOT NULL, status TEXT NOT NULL, premium_cents INTEGER NOT NULL,
        balance_cents INTEGER NOT NULL, next_due TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS policies_phone ON policies(phone);
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT, policy_number TEXT, policy_verified INTEGER NOT NULL,
        status TEXT NOT NULL, loss_date TEXT, loss_type TEXT NOT NULL, injuries TEXT NOT NULL,
        urgent INTEGER NOT NULL, callback_phone TEXT NOT NULL, recording_sid TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, policy_number TEXT NOT NULL, amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL, result TEXT, confirmation TEXT, needs_review INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS payments_confirmation ON payments(confirmation) WHERE confirmation IS NOT NULL;
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, phone TEXT NOT NULL, reason TEXT NOT NULL,
        policy_number TEXT, policy_verified INTEGER NOT NULL, claim_number TEXT, urgent INTEGER NOT NULL,
        recording_sid TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM policies").get() as Row;
    if (count.n === 0) this.seed();
  }

  /** Fictional customers. Phone numbers use the reserved 555-01xx range. */
  private seed() {
    const ins = this.db.prepare("INSERT INTO policies VALUES (?,?,?,?,?,?,?,?,?)");
    ins.run("10000001", "Alex Rivera", "1985-03-14", "+15555550100", "auto", "active", 14250, 120450, "2026-11-01");
    ins.run("10000002", "Jordan Lee", "1990-07-02", "+15555550101", "home", "active", 8900, 0, "2026-12-15");
    // Two policies on one phone: caller ID alone cannot tell us which one is calling.
    ins.run("10000003", "Sam Patel", "1978-11-30", "+15555550102", "life", "active", 5400, 0, "2027-01-10");
    ins.run("10000004", "Sam Patel", "1978-11-30", "+15555550102", "auto", "active", 11800, 0, "2026-12-20");
    this.createClaim(
      { policyNumber: "10000001", policyVerified: true, lossDate: "2026-10-20", lossType: "auto", injuries: "no", callbackPhone: "+15555550100" },
      new Date("2026-10-21T14:00:00Z"),
    );
    this.db.prepare("UPDATE claims SET status = 'in review' WHERE id = 1").run();
  }

  /** Add or replace a policy. Used by the demo setup tool to put YOUR phone number on a practice customer. */
  upsertPolicy(p: Policy): void {
    this.db
      .prepare("INSERT OR REPLACE INTO policies VALUES (?,?,?,?,?,?,?,?,?)")
      .run(p.policyNumber, p.holderName, p.dob, p.phone, p.product, p.status, p.premiumCents, p.balanceCents, p.nextDue);
  }

  /** Remove a policy (demo cleanup only). */
  removePolicy(policyNumber: string): void {
    this.db.prepare("DELETE FROM policies WHERE policy_number = ?").run(policyNumber);
  }

  private toPolicy(r: Row): Policy {
    return {
      policyNumber: r.policy_number as string,
      holderName: r.holder_name as string,
      dob: r.dob as string,
      phone: r.phone as string,
      product: r.product as Policy["product"],
      status: r.status as Policy["status"],
      premiumCents: r.premium_cents as number,
      balanceCents: r.balance_cents as number,
      nextDue: r.next_due as string,
    };
  }

  private toClaim(r: Row): Claim {
    return {
      claimNumber: String(CLAIM_BASE + (r.id as number)),
      policyNumber: r.policy_number as string | null,
      policyVerified: r.policy_verified === 1,
      status: r.status as Claim["status"],
      lossDate: r.loss_date as string | null,
      lossType: r.loss_type as LossType,
      injuries: r.injuries as Injuries,
      urgent: r.urgent === 1,
      callbackPhone: r.callback_phone as string,
      recordingSid: r.recording_sid as string | null,
      createdAt: r.created_at as string,
    };
  }

  findByPhone(phone: string): Policy[] {
    return (this.db.prepare("SELECT * FROM policies WHERE phone = ?").all(phone) as Row[]).map((r) => this.toPolicy(r));
  }

  findByPolicyNumber(policyNumber: string): Policy | undefined {
    const r = this.db.prepare("SELECT * FROM policies WHERE policy_number = ?").get(policyNumber) as Row | undefined;
    return r && this.toPolicy(r);
  }

  claimsFor(policyNumber: string): Claim[] {
    const rows = this.db.prepare("SELECT * FROM claims WHERE policy_number = ? ORDER BY id DESC").all(policyNumber) as Row[];
    return rows.map((r) => this.toClaim(r));
  }

  createClaim(input: NewClaim, now: Date = new Date()): Claim {
    const urgent = input.injuries === "yes";
    const res = this.db
      .prepare(
        `INSERT INTO claims (policy_number, policy_verified, status, loss_date, loss_type, injuries, urgent, callback_phone, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(input.policyNumber, input.policyVerified ? 1 : 0, "received", input.lossDate, input.lossType, input.injuries, urgent ? 1 : 0, input.callbackPhone, now.toISOString());
    const row = this.db.prepare("SELECT * FROM claims WHERE id = ?").get(Number(res.lastInsertRowid)) as Row;
    return this.toClaim(row);
  }

  attachRecording(claimNumber: string, recordingSid: string): void {
    this.db.prepare("UPDATE claims SET recording_sid = ? WHERE id = ?").run(recordingSid, Number(claimNumber) - CLAIM_BASE);
  }

  private toTicket(r: Row): Ticket {
    return {
      ticketNumber: String(TICKET_BASE + (r.id as number)),
      kind: r.kind as Ticket["kind"],
      phone: r.phone as string,
      reason: r.reason as string,
      policyNumber: r.policy_number as string | null,
      policyVerified: r.policy_verified === 1,
      claimNumber: r.claim_number as string | null,
      urgent: r.urgent === 1,
      recordingSid: r.recording_sid as string | null,
      status: r.status as Ticket["status"],
      createdAt: r.created_at as string,
    };
  }

  createTicket(input: NewTicket, now: Date = new Date()): Ticket {
    const res = this.db
      .prepare(
        `INSERT INTO tickets (kind, phone, reason, policy_number, policy_verified, claim_number, urgent, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(input.kind, input.phone, input.reason, input.policyNumber, input.policyVerified ? 1 : 0, input.claimNumber, input.urgent ? 1 : 0, "open", now.toISOString());
    return this.toTicket(this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(Number(res.lastInsertRowid)) as Row);
  }

  attachTicketRecording(ticketNumber: string, recordingSid: string): void {
    this.db.prepare("UPDATE tickets SET recording_sid = ? WHERE id = ?").run(recordingSid, Number(ticketNumber) - TICKET_BASE);
  }

  private toPayment(r: Row): Payment {
    return {
      paymentNumber: String(PAYMENT_BASE + (r.id as number)),
      policyNumber: r.policy_number as string,
      amountCents: r.amount_cents as number,
      status: r.status as Payment["status"],
      result: r.result as string | null,
      confirmation: r.confirmation as string | null,
      needsReview: r.needs_review === 1,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  startPayment(policyNumber: string, amountCents: number, now: Date = new Date()): Payment {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("payment amount must be a positive whole number of cents");
    const t = now.toISOString();
    const res = this.db
      .prepare("INSERT INTO payments (policy_number, amount_cents, status, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run(policyNumber, amountCents, "started", t, t);
    return this.getPayment(String(PAYMENT_BASE + Number(res.lastInsertRowid)))!;
  }

  getPayment(paymentNumber: string): Payment | undefined {
    if (!/^\d{6}$/.test(paymentNumber)) return undefined;
    const r = this.db.prepare("SELECT * FROM payments WHERE id = ?").get(Number(paymentNumber) - PAYMENT_BASE) as Row | undefined;
    return r && this.toPayment(r);
  }

  completePayment(paymentNumber: string, outcome: PaymentOutcome, now: Date = new Date()): Payment | undefined {
    const current = this.getPayment(paymentNumber);
    if (!current) return undefined;
    // Only a payment still waiting for its result can be settled. Anything else is a repeat delivery or a late report.
    // (An "unconfirmed" attempt may still be upgraded once we learn the truth.)
    if (current.status !== "started" && current.status !== "unconfirmed") return current;
    if (current.status === "unconfirmed" && outcome.status === "unconfirmed") return current;

    const id = Number(paymentNumber) - PAYMENT_BASE;
    this.db.exec("BEGIN");
    try {
      let needsReview = 0;
      if (outcome.status === "succeeded") {
        const pol = this.db.prepare("SELECT balance_cents FROM policies WHERE policy_number = ?").get(current.policyNumber) as Row | undefined;
        const balance = (pol?.balance_cents as number | undefined) ?? 0;
        if (balance < current.amountCents) needsReview = 1; // overpaid: never let the balance go negative, flag it
        this.db.prepare("UPDATE policies SET balance_cents = ? WHERE policy_number = ?").run(Math.max(0, balance - current.amountCents), current.policyNumber);
      }
      this.db
        .prepare("UPDATE payments SET status = ?, result = ?, confirmation = ?, needs_review = ?, updated_at = ? WHERE id = ?")
        .run(outcome.status, outcome.result, outcome.confirmation ?? null, needsReview, now.toISOString(), id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getPayment(paymentNumber);
  }

  unresolvedPayments(olderThanMs: number, now: Date = new Date()): Payment[] {
    const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
    const rows = this.db
      .prepare("SELECT * FROM payments WHERE status = 'unconfirmed' OR (status = 'started' AND created_at < ?) ORDER BY id ASC")
      .all(cutoff) as Row[];
    return rows.map((r) => this.toPayment(r));
  }

  blockingPayments(policyNumber: string, ownOpenPayment?: string): Payment[] {
    const rows = this.db
      .prepare("SELECT * FROM payments WHERE policy_number = ? AND status IN ('started','unconfirmed') ORDER BY id ASC")
      .all(policyNumber) as Row[];
    return rows.map((r) => this.toPayment(r)).filter((p) => !(p.paymentNumber === ownOpenPayment && p.status === "started"));
  }

  openTickets(): Ticket[] {
    return (this.db.prepare("SELECT * FROM tickets WHERE status = 'open' ORDER BY urgent DESC, id ASC").all() as Row[]).map((r) => this.toTicket(r));
  }
}
