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
}

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

  openTickets(): Ticket[] {
    return (this.db.prepare("SELECT * FROM tickets WHERE status = 'open' ORDER BY urgent DESC, id ASC").all() as Row[]).map((r) => this.toTicket(r));
  }
}
