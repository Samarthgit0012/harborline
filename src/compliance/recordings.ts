import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The register of every recording we know exists, and what we promised to do with it. The audio itself lives at
 * Twilio; this table is OUR record of: what kind it is, which claim or ticket it belongs to, why we believed we
 * could record it, and when it must be deleted. Nothing in here holds audio or a link to audio.
 */

export const RECORDING_KINDS = ["claim_description", "voicemail", "agent_call", "unknown"] as const;
export type RecordingKind = (typeof RECORDING_KINDS)[number];

/** Why we believed we were allowed to record. "unknown" is what we write when we cannot tell, so it stands out. */
export const CONSENT_BASES = ["announced_before_record", "announced_continue", "unknown"] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export type RecordingStatus = "registered" | "ready" | "absent" | "deleted" | "delete_failed";

export interface Recording {
  sid: string;
  kind: RecordingKind;
  /** The claim number or ticket number this belongs to, when there is one. */
  ref: string | null;
  callSid: string | null;
  consentBasis: ConsentBasis;
  status: RecordingStatus;
  durationSec: number | null;
  createdAt: string;
  retainUntil: string;
  legalHold: boolean;
  holdReason: string | null;
  deletedAt: string | null;
  deleteAttempts: number;
  lastError: string | null;
}

export interface RecordingEvent {
  id: number;
  sid: string;
  who: string;
  role: string;
  action: string;
  reason: string;
  granted: boolean;
  at: string;
}

type Row = Record<string, string | number | null>;
const DAY = 24 * 60 * 60 * 1000;

export class RecordingRegistry {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recordings (
        sid TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT, call_sid TEXT, consent_basis TEXT NOT NULL,
        status TEXT NOT NULL, duration_sec INTEGER, created_at TEXT NOT NULL, retain_until TEXT NOT NULL,
        legal_hold INTEGER NOT NULL DEFAULT 0, hold_reason TEXT, deleted_at TEXT,
        delete_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS recordings_due ON recordings(retain_until);
      CREATE TABLE IF NOT EXISTS recording_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, who TEXT NOT NULL, role TEXT NOT NULL,
        action TEXT NOT NULL, reason TEXT NOT NULL, granted INTEGER NOT NULL, at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS recording_events_no_update BEFORE UPDATE ON recording_events BEGIN SELECT RAISE(ABORT, 'recording_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS recording_events_no_delete BEFORE DELETE ON recording_events BEGIN SELECT RAISE(ABORT, 'recording_events is append-only'); END;
    `);
  }

  private toRecording(r: Row): Recording {
    return {
      sid: r.sid as string, kind: r.kind as RecordingKind, ref: r.ref as string | null, callSid: r.call_sid as string | null,
      consentBasis: r.consent_basis as ConsentBasis, status: r.status as RecordingStatus, durationSec: r.duration_sec as number | null,
      createdAt: r.created_at as string, retainUntil: r.retain_until as string, legalHold: r.legal_hold === 1,
      holdReason: r.hold_reason as string | null, deletedAt: r.deleted_at as string | null,
      deleteAttempts: r.delete_attempts as number, lastError: r.last_error as string | null,
    };
  }

  /** Record that a recording exists. Registering the same one twice keeps the first record (and its deadline). */
  register(
    input: { sid: string; kind: RecordingKind; ref?: string | null; callSid?: string | null; consentBasis: ConsentBasis; retainDays: number },
    now: Date = new Date(),
  ): Recording {
    if (!/^RE\w{10,40}$/.test(input.sid)) throw new Error("not a recording id");
    if (!RECORDING_KINDS.includes(input.kind)) throw new Error("unknown recording kind");
    if (!CONSENT_BASES.includes(input.consentBasis)) throw new Error("unknown consent basis");
    if (!Number.isInteger(input.retainDays) || input.retainDays < 1) throw new Error("retention must be a whole number of days, at least 1");
    this.db
      .prepare(
        `INSERT OR IGNORE INTO recordings (sid, kind, ref, call_sid, consent_basis, status, created_at, retain_until)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(input.sid, input.kind, input.ref ?? null, input.callSid ?? null, input.consentBasis, "registered", now.toISOString(), new Date(now.getTime() + input.retainDays * DAY).toISOString());
    return this.get(input.sid)!;
  }

  get(sid: string): Recording | undefined {
    const r = this.db.prepare("SELECT * FROM recordings WHERE sid = ?").get(sid) as Row | undefined;
    return r && this.toRecording(r);
  }

  list(filter: { kind?: RecordingKind; status?: RecordingStatus } = {}): Recording[] {
    const rows = this.db.prepare("SELECT * FROM recordings ORDER BY created_at, sid").all() as Row[];
    return rows.map((r) => this.toRecording(r)).filter((x) => (!filter.kind || x.kind === filter.kind) && (!filter.status || x.status === filter.status));
  }

  /** Twilio told us the file is ready (or that there is none). A deleted recording stays deleted. */
  markStatus(sid: string, status: "ready" | "absent", durationSec?: number): void {
    const dur = durationSec !== undefined && Number.isInteger(durationSec) && durationSec >= 0 ? durationSec : null;
    this.db.prepare("UPDATE recordings SET status = ?, duration_sec = COALESCE(?, duration_sec) WHERE sid = ? AND status IN ('registered','ready','absent')").run(status, dur, sid);
  }

  /** Recordings whose time is up, that are not under legal hold, that are not already gone. */
  due(now: Date): Recording[] {
    const rows = this.db
      .prepare("SELECT * FROM recordings WHERE retain_until <= ? AND legal_hold = 0 AND status != 'deleted' ORDER BY retain_until, sid")
      .all(now.toISOString()) as Row[];
    return rows.map((r) => this.toRecording(r));
  }

  markDeleted(sid: string, now: Date): void {
    this.db.prepare("UPDATE recordings SET status = 'deleted', deleted_at = ?, last_error = NULL WHERE sid = ?").run(now.toISOString(), sid);
  }
  markDeleteFailed(sid: string, error: string): void {
    this.db.prepare("UPDATE recordings SET status = 'delete_failed', delete_attempts = delete_attempts + 1, last_error = ? WHERE sid = ?").run(error.slice(0, 200), sid);
  }

  setHold(sid: string, hold: boolean, reason: string | null): void {
    this.db.prepare("UPDATE recordings SET legal_hold = ?, hold_reason = ? WHERE sid = ? AND status != 'deleted'").run(hold ? 1 : 0, hold ? reason : null, sid);
  }

  // ---- the audit trail --------------------------------------------------------------------------

  logEvent(e: { sid: string; who: string; role: string; action: string; reason: string; granted: boolean }, now: Date = new Date()): void {
    this.db
      .prepare("INSERT INTO recording_events (sid, who, role, action, reason, granted, at) VALUES (?,?,?,?,?,?,?)")
      .run(e.sid, e.who.slice(0, 80), e.role.slice(0, 40), e.action.slice(0, 40), e.reason.slice(0, 300), e.granted ? 1 : 0, now.toISOString());
  }
  events(sid?: string): RecordingEvent[] {
    const rows = (sid ? this.db.prepare("SELECT * FROM recording_events WHERE sid = ? ORDER BY id").all(sid) : this.db.prepare("SELECT * FROM recording_events ORDER BY id").all()) as Row[];
    return rows.map((r) => ({ id: r.id as number, sid: r.sid as string, who: r.who as string, role: r.role as string, action: r.action as string, reason: r.reason as string, granted: r.granted === 1, at: r.at as string }));
  }
}
