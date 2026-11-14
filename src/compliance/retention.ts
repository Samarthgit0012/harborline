import twilio from "twilio";
import { log } from "../log.js";
import type { RecordingKind, RecordingRegistry } from "./recordings.js";

/**
 * How long we keep each kind of recording. THESE NUMBERS ARE PLACEHOLDERS, not legal advice and not researched
 * insurance record-retention rules: set them from the client's own retention schedule. The point of the phase is that
 * the deadline exists, is written down the moment a recording is made, and is enforced by a job.
 */
export type RetentionDays = Record<RecordingKind, number>;
export const DEFAULT_RETENTION_DAYS: RetentionDays = {
  voicemail: 90,
  agent_call: 90,
  claim_description: 730,
  unknown: 30, // a recording we cannot explain is kept the shortest time
};

/** The one door to deleting audio. A fake in dry runs and tests, Twilio's API in live mode. */
export interface RecordingDeleter {
  /** "already_gone" means the provider no longer had it (deleted by hand, or earlier): that still counts as done. */
  delete(sid: string): Promise<"deleted" | "already_gone">;
}

export class DryRunDeleter implements RecordingDeleter {
  readonly wouldDelete: string[] = [];
  async delete(sid: string) {
    this.wouldDelete.push(sid);
    return "deleted" as const;
  }
}

export class TwilioDeleter implements RecordingDeleter {
  private client: ReturnType<typeof twilio>;
  constructor(accountSid: string, authToken: string) {
    this.client = twilio(accountSid, authToken);
  }
  async delete(sid: string) {
    try {
      await this.client.recordings(sid).remove();
      return "deleted" as const;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return "already_gone" as const;
      throw err;
    }
  }
}

export interface RetentionSummary {
  deleted: string[];
  alreadyGone: string[];
  failed: { sid: string; error: string }[];
  /** Past their date but kept because of a legal hold. */
  held: string[];
}

/**
 * The retention job. Safe to run as often as you like: it only touches recordings whose time is up, skips any under
 * legal hold, never stops at the first failure, and logs every deletion in the audit trail with the reason "retention".
 */
export async function runRetention(
  registry: RecordingRegistry,
  deleter: RecordingDeleter,
  now: Date,
  opts: { who?: string; dryRun?: boolean } = {},
): Promise<RetentionSummary> {
  const who = opts.who ?? "retention-job";
  const out: RetentionSummary = { deleted: [], alreadyGone: [], failed: [], held: [] };
  const expired = registry.list().filter((r) => r.status !== "deleted" && r.retainUntil <= now.toISOString());
  out.held = expired.filter((r) => r.legalHold).map((r) => r.sid);

  // A dry run only REPORTS what would go. It touches nothing: not the provider, not the register, not the audit trail.
  if (opts.dryRun) {
    out.deleted = registry.due(now).map((r) => r.sid);
    return out;
  }

  for (const rec of registry.due(now)) {
    try {
      const result = await deleter.delete(rec.sid);
      registry.markDeleted(rec.sid, now);
      registry.logEvent({ sid: rec.sid, who, role: "system", action: "delete", reason: `retention: ${rec.kind} kept until ${rec.retainUntil}`, granted: true }, now);
      (result === "deleted" ? out.deleted : out.alreadyGone).push(rec.sid);
    } catch (err) {
      const error = (err as Error).message ?? "unknown error";
      registry.markDeleteFailed(rec.sid, error);
      out.failed.push({ sid: rec.sid, error });
      log("error", "retention_delete_failed", { sid: rec.sid, error });
    }
  }
  log("info", "retention_run", { deleted: out.deleted.length, alreadyGone: out.alreadyGone.length, failed: out.failed.length, held: out.held.length });
  return out;
}
