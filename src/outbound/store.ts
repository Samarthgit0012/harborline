import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeUsPhone } from "./phone.js";

/**
 * Everything outbound calling needs to remember: who agreed to what, who said stop, which campaigns exist, what
 * we tried, and WHY we refused to call. Consent, revocations, the internal do-not-call list and the decision log
 * are APPEND-ONLY: database triggers reject any UPDATE or DELETE. They are evidence, and evidence is not edited.
 */

export type ConsentKind = "express" | "written";
export type Purpose = "informational" | "marketing";
export const CONSENT_METHODS = ["web_form", "paper", "recorded_call", "sms_reply", "in_person", "import"] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];
export type DncSource = "keypress_opt_out" | "inbound_request" | "customer_request" | "agent_entered";

export interface Consent {
  id: number;
  phone: string;
  kind: ConsentKind;
  /** What they agreed to receive, e.g. "payment_reminders" or "marketing". Consent for one scope never covers another. */
  scope: string;
  method: ConsentMethod;
  /** A pointer to the proof (a form submission id, a recording id). Never the proof itself and never personal data. */
  evidenceRef: string;
  /** Fingerprint of the exact disclosure text they saw, so we can later show WHAT they agreed to. */
  disclosureHash: string;
  createdAt: string;
}

export interface Campaign {
  id: number;
  name: string;
  purpose: Purpose;
  /** The scope a contact must have consented to for this campaign. */
  consentScope: string;
  /** The message body spoken after the standard identification and opt-out announcement. */
  scriptText: string;
  createdAt: string;
}

export interface Contact {
  id: number;
  campaignId: number;
  phone: string;
  /** IANA zone of where the person is (from their address). Unknown means we use the strictest window. */
  timeZone: string | null;
}

export type AttemptStatus = "queued" | "placed" | "in_progress" | "done" | "failed" | "cancelled";
export interface Attempt {
  id: number;
  campaignId: number;
  phone: string;
  status: AttemptStatus;
  /** What happened, in our words: human_answered, machine, opted_out, transferred, busy, no-answer, failed, create_failed... */
  outcome: string | null;
  callSid: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, string | number | null>;

export class OutboundStore {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL,
        method TEXT NOT NULL, evidence_ref TEXT NOT NULL, disclosure_hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS consents_phone ON consents(phone);
      CREATE TABLE IF NOT EXISTS revocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, scope TEXT NOT NULL, via TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS revocations_phone ON revocations(phone);
      CREATE TABLE IF NOT EXISTS dnc_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dnc_phone ON dnc_entries(phone);
      CREATE TABLE IF NOT EXISTS gate_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, phone TEXT NOT NULL,
        allowed INTEGER NOT NULL, reason TEXT, detail TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS national_dnc (phone TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, purpose TEXT NOT NULL, consent_scope TEXT NOT NULL,
        script_text TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, phone TEXT NOT NULL, time_zone TEXT,
        UNIQUE(campaign_id, phone)
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, phone TEXT NOT NULL, status TEXT NOT NULL,
        outcome TEXT, call_sid TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attempts_phone ON attempts(phone);
    `);
    for (const table of ["consents", "revocations", "dnc_entries", "gate_decisions"]) {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
      `);
    }
  }

  // ---- consent ---------------------------------------------------------------------------------

  addConsent(
    input: { phone: string; kind: ConsentKind; scope: string; method: ConsentMethod; evidenceRef: string; disclosureHash: string },
    now: Date = new Date(),
  ): Consent {
    const phone = normalizeUsPhone(input.phone);
    if (!phone) throw new Error("consent needs a valid US phone number");
    if (!/^[a-z][a-z0-9_]{1,59}$/.test(input.scope)) throw new Error("consent scope must be lowercase letters, digits and underscores");
    if (!CONSENT_METHODS.includes(input.method)) throw new Error("unknown consent method");
    if (!input.evidenceRef.trim() || input.evidenceRef.length > 100) throw new Error("consent needs an evidence reference (100 characters or fewer)");
    if (!/^[0-9a-f]{16,64}$/.test(input.disclosureHash)) throw new Error("consent needs the fingerprint of the disclosure text shown");
    const res = this.db
      .prepare("INSERT INTO consents (phone, kind, scope, method, evidence_ref, disclosure_hash, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(phone, input.kind, input.scope, input.method, input.evidenceRef, input.disclosureHash, now.toISOString());
    return this.toConsent(this.db.prepare("SELECT * FROM consents WHERE id = ?").get(Number(res.lastInsertRowid)) as Row);
  }

  private toConsent(r: Row): Consent {
    return {
      id: r.id as number, phone: r.phone as string, kind: r.kind as ConsentKind, scope: r.scope as string,
      method: r.method as ConsentMethod, evidenceRef: r.evidence_ref as string, disclosureHash: r.disclosure_hash as string,
      createdAt: r.created_at as string,
    };
  }

  /** Withdraw consent for one scope, or for everything ("all"). A later consent for the same scope starts a fresh agreement. */
  revoke(phoneRaw: string, scope: string, via: string, now: Date = new Date()): void {
    const phone = normalizeUsPhone(phoneRaw);
    if (!phone) throw new Error("revocation needs a valid US phone number");
    this.db.prepare("INSERT INTO revocations (phone, scope, via, created_at) VALUES (?,?,?,?)").run(phone, scope, via.slice(0, 60), now.toISOString());
  }

  /**
   * What consent stands for this number and scope RIGHT NOW. The newest consent counts unless a revocation (for this
   * scope or "all") was recorded at the same moment or later.
   */
  consentStatus(phoneRaw: string, scope: string): { status: "none" | "valid" | "revoked"; consent?: Consent } {
    const phone = normalizeUsPhone(phoneRaw);
    if (!phone) return { status: "none" };
    const row = this.db.prepare("SELECT * FROM consents WHERE phone = ? AND scope = ? ORDER BY id DESC LIMIT 1").get(phone, scope) as Row | undefined;
    if (!row) return { status: "none" };
    const consent = this.toConsent(row);
    const revoked = this.db
      .prepare("SELECT 1 AS x FROM revocations WHERE phone = ? AND (scope = ? OR scope = 'all') AND created_at >= ? LIMIT 1")
      .get(phone, scope, consent.createdAt);
    return revoked ? { status: "revoked", consent } : { status: "valid", consent };
  }

  // ---- do not call -----------------------------------------------------------------------------

  /** Internal do-not-call: "stop calling me". Never removed by code: a person who asked to stop stays stopped. */
  addDnc(phoneRaw: string, source: DncSource, now: Date = new Date()): void {
    const phone = normalizeUsPhone(phoneRaw);
    if (!phone) throw new Error("do-not-call needs a valid US phone number");
    this.db.prepare("INSERT INTO dnc_entries (phone, source, created_at) VALUES (?,?,?)").run(phone, source, now.toISOString());
  }

  isOnInternalDnc(phoneRaw: string): boolean {
    const phone = normalizeUsPhone(phoneRaw);
    return !!phone && !!this.db.prepare("SELECT 1 AS x FROM dnc_entries WHERE phone = ? LIMIT 1").get(phone);
  }

  /** Replace our copy of the National Do Not Call Registry (for the area codes we subscribe to) and remember when we got it. */
  loadNationalDnc(numbers: string[], loadedAt: Date): number {
    const clean = [...new Set(numbers.map((n) => normalizeUsPhone(n)).filter((n): n is string => !!n))];
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM national_dnc");
      const ins = this.db.prepare("INSERT INTO national_dnc (phone) VALUES (?)");
      for (const p of clean) ins.run(p);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('national_dnc_loaded_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(loadedAt.toISOString());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return clean.length;
  }
  isOnNationalDnc(phoneRaw: string): boolean {
    const phone = normalizeUsPhone(phoneRaw);
    return !!phone && !!this.db.prepare("SELECT 1 AS x FROM national_dnc WHERE phone = ?").get(phone);
  }
  nationalDncLoadedAt(): Date | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'national_dnc_loaded_at'").get() as Row | undefined;
    return r ? new Date(r.value as string) : undefined;
  }

  // ---- campaigns and contacts ------------------------------------------------------------------

  createCampaign(input: { name: string; purpose: Purpose; consentScope: string; scriptText: string }, now: Date = new Date()): Campaign {
    if (!/^[a-z][a-z0-9_]{1,59}$/.test(input.consentScope)) throw new Error("campaign consent scope must be lowercase letters, digits and underscores");
    const res = this.db
      .prepare("INSERT INTO campaigns (name, purpose, consent_scope, script_text, created_at) VALUES (?,?,?,?,?)")
      .run(input.name.slice(0, 100), input.purpose, input.consentScope, input.scriptText, now.toISOString());
    return this.getCampaign(Number(res.lastInsertRowid))!;
  }
  getCampaign(id: number): Campaign | undefined {
    const r = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as Row | undefined;
    return r && { id: r.id as number, name: r.name as string, purpose: r.purpose as Purpose, consentScope: r.consent_scope as string, scriptText: r.script_text as string, createdAt: r.created_at as string };
  }
  addContact(campaignId: number, phoneRaw: string, timeZone?: string): Contact | undefined {
    const phone = normalizeUsPhone(phoneRaw);
    if (!phone) return undefined; // the gate would block it anyway: do not even store a number we cannot dial
    if (timeZone) new Intl.DateTimeFormat("en-US", { timeZone }); // throws on a zone name that does not exist
    this.db.prepare("INSERT OR IGNORE INTO contacts (campaign_id, phone, time_zone) VALUES (?,?,?)").run(campaignId, phone, timeZone ?? null);
    return this.contacts(campaignId).find((c) => c.phone === phone);
  }
  contacts(campaignId: number): Contact[] {
    return (this.db.prepare("SELECT * FROM contacts WHERE campaign_id = ? ORDER BY id").all(campaignId) as Row[]).map((r) => ({
      id: r.id as number, campaignId: r.campaign_id as number, phone: r.phone as string, timeZone: r.time_zone as string | null,
    }));
  }

  // ---- attempts and decisions ------------------------------------------------------------------

  private toAttempt(r: Row): Attempt {
    return {
      id: r.id as number, campaignId: r.campaign_id as number, phone: r.phone as string, status: r.status as AttemptStatus,
      outcome: r.outcome as string | null, callSid: r.call_sid as string | null, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    };
  }
  createAttempt(campaignId: number, phone: string, now: Date = new Date()): Attempt {
    const t = now.toISOString();
    const res = this.db.prepare("INSERT INTO attempts (campaign_id, phone, status, created_at, updated_at) VALUES (?,?,?,?,?)").run(campaignId, phone, "queued", t, t);
    return this.getAttempt(Number(res.lastInsertRowid))!;
  }
  getAttempt(id: number): Attempt | undefined {
    if (!Number.isInteger(id) || id < 1) return undefined;
    const r = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as Row | undefined;
    return r && this.toAttempt(r);
  }
  setCallSid(id: number, callSid: string, now: Date = new Date()): void {
    this.db.prepare("UPDATE attempts SET call_sid = ?, status = CASE WHEN status = 'queued' THEN 'placed' ELSE status END, updated_at = ? WHERE id = ?").run(callSid, now.toISOString(), id);
  }
  setAttempt(id: number, status: AttemptStatus, outcome: string | null, now: Date = new Date()): void {
    this.db.prepare("UPDATE attempts SET status = ?, outcome = COALESCE(?, outcome), updated_at = ? WHERE id = ?").run(status, outcome, now.toISOString(), id);
  }
  /** A person who says stop must not be rung by a call that is merely waiting its turn. */
  cancelQueued(phoneRaw: string, now: Date = new Date()): number {
    const phone = normalizeUsPhone(phoneRaw);
    if (!phone) return 0;
    const r = this.db.prepare("UPDATE attempts SET status = 'cancelled', outcome = 'cancelled_by_opt_out', updated_at = ? WHERE phone = ? AND status = 'queued'").run(now.toISOString(), phone);
    return Number(r.changes);
  }
  /** Calls actually placed to this number since a moment, across every campaign (the person feels all of them). */
  placedSince(phoneRaw: string, since: Date): number {
    const phone = normalizeUsPhone(phoneRaw);
    if (!phone) return 0;
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE phone = ? AND call_sid IS NOT NULL AND created_at >= ?").get(phone, since.toISOString()) as Row;
    return r.n as number;
  }
  attemptsFor(campaignId: number, phone: string): Attempt[] {
    return (this.db.prepare("SELECT * FROM attempts WHERE campaign_id = ? AND phone = ? ORDER BY id").all(campaignId, phone) as Row[]).map((r) => this.toAttempt(r));
  }

  logDecision(campaignId: number, phone: string, allowed: boolean, reason: string | null, detail: string | null, now: Date = new Date()): void {
    this.db.prepare("INSERT INTO gate_decisions (campaign_id, phone, allowed, reason, detail, created_at) VALUES (?,?,?,?,?,?)").run(campaignId, phone, allowed ? 1 : 0, reason, detail, now.toISOString());
  }
  decisions(campaignId: number): { phone: string; allowed: boolean; reason: string | null; detail: string | null; createdAt: string }[] {
    return (this.db.prepare("SELECT * FROM gate_decisions WHERE campaign_id = ? ORDER BY id").all(campaignId) as Row[]).map((r) => ({
      phone: r.phone as string, allowed: r.allowed === 1, reason: r.reason as string | null, detail: r.detail as string | null, createdAt: r.created_at as string,
    }));
  }
}
