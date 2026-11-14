import { Router } from "express";
import type { StateStore } from "../engine/state.js";
import { log } from "../log.js";
import { RECORDING_KINDS, type RecordingKind, type RecordingRegistry } from "./recordings.js";
import type { RetentionDays } from "./retention.js";

export interface RecordingHookDeps {
  registry: RecordingRegistry;
  state: StateStore;
  clock: () => Date;
  retentionDays: RetentionDays;
}

const SID = /^RE\w{10,40}$/;
const CALL_SID = /^CA[0-9a-fA-F]{32}$/;

/**
 * Twilio's recording status callback: "your recording is ready" (or "there is none"). It arrives AFTER the <Record> or
 * <Dial> action URL (Twilio warns that the file may not be ready when the action fires), so this is where we learn the
 * final status and length. We never fetch the audio and never store a link to it. Signed by Twilio like every route.
 */
export function recordingRouter(d: RecordingHookDeps): Router {
  const r = Router();
  r.post("/status", (req, res) => {
    const sid = String(req.body?.RecordingSid ?? "");
    const callSid = String(req.body?.CallSid ?? "");
    const status = String(req.body?.RecordingStatus ?? "");
    const kindParam = String(req.query.kind ?? "");
    const kind: RecordingKind = (RECORDING_KINDS as readonly string[]).includes(kindParam) ? (kindParam as RecordingKind) : "unknown";

    if (SID.test(sid)) {
      // A recording we have never heard of (an agent call: its id only exists here). Register it with the deadline for its kind.
      if (!d.registry.get(sid)) {
        const choice = CALL_SID.test(callSid) ? d.state.get(callSid).recordingChoice : undefined;
        d.registry.register(
          {
            sid, kind, callSid: CALL_SID.test(callSid) ? callSid : null,
            consentBasis: kind === "agent_call" && choice === "recorded" ? "announced_continue" : "unknown",
            retainDays: d.retentionDays[kind],
          },
          d.clock(),
        );
      }
      if (status === "completed") d.registry.markStatus(sid, "ready", /^\d{1,6}$/.test(String(req.body?.RecordingDuration ?? "")) ? Number(req.body.RecordingDuration) : undefined);
      else if (status === "absent" || status === "failed") d.registry.markStatus(sid, "absent");
      log("info", "recording_status", { kind, status: status.slice(0, 20), known: true });
    } else {
      log("warn", "recording_status_ignored", { reason: "bad recording id" });
    }
    res.status(204).end();
  });
  return r;
}
