import type { Recording, RecordingKind, RecordingRegistry } from "./recordings.js";

/**
 * Who may do what with a recording. Least privilege, with SEPARATION OF DUTIES: the people who run the system (admin)
 * cannot listen to customers; the people who can delete (compliance) are not the people who handle calls (agents).
 * Every request, granted or refused, is written to an append-only audit trail with a reason.
 */
export type Role = "agent" | "supervisor" | "compliance" | "admin";
export type Action = "listen" | "download" | "hold" | "delete";
export const ROLES: Role[] = ["agent", "supervisor", "compliance", "admin"];
export const ACTIONS: Action[] = ["listen", "download", "hold", "delete"];

const ALL: RecordingKind[] = ["claim_description", "voicemail", "agent_call", "unknown"];

/** Which kinds each role may touch, per action. A missing entry means "never". */
export const POLICY: Record<Action, Partial<Record<Role, RecordingKind[]>>> = {
  // An agent may hear messages left for the team, not recordings of other agents' calls.
  listen: { agent: ["voicemail", "claim_description"], supervisor: ALL, compliance: ALL },
  download: { compliance: ALL },
  hold: { compliance: ALL },
  delete: { compliance: ALL },
};

export function authorize(role: string, action: string, kind: RecordingKind): boolean {
  const kinds = (POLICY as Record<string, Partial<Record<string, RecordingKind[]>>>)[action]?.[role];
  return !!kinds && kinds.includes(kind);
}

export interface AccessRequest {
  sid: string;
  who: string;
  role: string;
  action: string;
  /** Why. Required, and at least ten characters: "listening to a recording" is not a reason. */
  reason: string;
}

export type AccessResult = { granted: true; recording: Recording } | { granted: false; why: string };

/** Ask to do something with a recording. The decision is logged either way. */
export function requestAccess(registry: RecordingRegistry, req: AccessRequest, now: Date = new Date()): AccessResult {
  const deny = (why: string): AccessResult => {
    registry.logEvent({ sid: req.sid, who: req.who || "unknown", role: req.role || "unknown", action: req.action || "unknown", reason: `DENIED (${why}): ${req.reason ?? ""}`, granted: false }, now);
    return { granted: false, why };
  };
  if (!req.who?.trim()) return deny("no user named");
  if (!req.reason || req.reason.trim().length < 10) return deny("a reason of at least ten characters is required");
  const rec = registry.get(req.sid);
  if (!rec) return deny("no such recording");
  if (rec.status === "deleted") return deny("already deleted");
  if (!authorize(req.role, req.action, rec.kind)) return deny(`role ${req.role} may not ${req.action} a ${rec.kind}`);
  registry.logEvent({ sid: req.sid, who: req.who, role: req.role, action: req.action, reason: req.reason, granted: true }, now);
  return { granted: true, recording: rec };
}
