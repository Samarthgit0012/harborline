import type { Router } from "express";
import { log, maskPhone } from "../log.js";
import { isOpen, localDate } from "../services/businessHours.js";
import type { LossType } from "../services/policyRepo.js";
import { speakDigits } from "../services/speak.js";
import { ask, callInfo, parseUsDate, redirect, send, svcUrl, VoiceResponse, type SvcDeps } from "./helpers.js";

const MAX_RETRIES = 2;
const LOSS_TYPES: Record<string, LossType> = { "1": "auto", "2": "property", "3": "theft", "4": "other" };

/**
 * First notice of loss: the caller reports a claim. Design rules:
 *  - 24/7 and no login: someone standing next to a wrecked car should not need a date of birth.
 *  - Safety first: the very first thing said is "if anyone is hurt, dial 911".
 *  - Never strand the caller: every question has a retry cap and a safe default ("unknown"), so the
 *    claim is ALWAYS created.
 *  - Create the claim BEFORE recording the description, so a caller who hangs up mid-sentence still
 *    has a claim and a reference number.
 */
export function mountFnol(r: Router, d: SvcDeps) {
  const step = (path: string, back: string) => svcUrl(path, { back });

  r.post("/fnol", (req, res) => {
    const { callSid, back } = callInfo(req);
    const s = d.state.get(callSid);
    // Start fresh: a second claim in the same call must not reuse the first one's answers or number.
    d.state.update(callSid, { fnol: { policyNumber: s.authedPolicy }, claimNumber: undefined });
    for (const k of ["fnol:date", "fnol:type", "fnol:injury"]) d.state.reset(callSid, k);

    const t = new VoiceResponse();
    t.say(
      "I can take your claim report now. If anyone is injured or in danger, hang up and dial 9 1 1 first. " +
        "Your description at the end of this call will be recorded.",
    );
    if (s.authedPolicy) redirect(t, step("fnol/date", back));
    else {
      ask(t, {
        action: step("fnol/policy/in", back),
        finishOnKey: "#",
        timeout: 8,
        prompt: "If you have your policy number, enter its eight digits, then press pound. If not, just press pound.",
      });
    }
    send(res, t);
  });

  r.post("/fnol/policy/in", (req, res) => {
    const { callSid, digits, back } = callInfo(req);
    const draft = d.state.get(callSid).fnol ?? {};
    // Unverified: we store what they typed so an adjuster can check it. We never confirm or deny it here.
    if (digits && /^\d{8}$/.test(digits)) d.state.update(callSid, { fnol: { ...draft, policyNumber: digits } });
    const t = new VoiceResponse();
    redirect(t, step("fnol/date", back));
    send(res, t);
  });

  r.post("/fnol/date", (req, res) => {
    const { back } = callInfo(req);
    const t = new VoiceResponse();
    ask(t, {
      action: step("fnol/date/in", back),
      numDigits: 8,
      finishOnKey: "",
      prompt: "On what date did it happen? Enter the month, day and year as eight digits.",
    });
    send(res, t);
  });

  r.post("/fnol/date/in", (req, res) => {
    const { callSid, digits, back } = callInfo(req);
    const t = new VoiceResponse();
    const draft = d.state.get(callSid).fnol ?? {};
    const date = parseUsDate(digits);
    const today = localDate(d.clock(), d.schedule.timeZone);
    if (date && date <= today) {
      d.state.update(callSid, { fnol: { ...draft, lossDate: date } });
      redirect(t, step("fnol/type", back));
    } else if (d.state.bump(callSid, "fnol:date") > MAX_RETRIES) {
      d.state.update(callSid, { fnol: { ...draft, lossDate: null } });
      t.say("That is all right. You can tell us the date when you describe what happened.");
      redirect(t, step("fnol/type", back));
    } else {
      t.say("Sorry, that is not a valid date in the past.");
      redirect(t, step("fnol/date", back));
    }
    send(res, t);
  });

  r.post("/fnol/type", (req, res) => {
    const { back } = callInfo(req);
    const t = new VoiceResponse();
    ask(t, {
      action: step("fnol/type/in", back),
      numDigits: 1,
      prompt:
        "What kind of loss is it? For a car accident, press 1. For damage to your home or property, press 2. " +
        "For theft, press 3. For anything else, press 4.",
    });
    send(res, t);
  });

  r.post("/fnol/type/in", (req, res) => {
    const { callSid, digits, back } = callInfo(req);
    const t = new VoiceResponse();
    const draft = d.state.get(callSid).fnol ?? {};
    const lossType = digits ? LOSS_TYPES[digits] : undefined;
    if (lossType) {
      d.state.update(callSid, { fnol: { ...draft, lossType } });
      redirect(t, step("fnol/injury", back));
    } else if (d.state.bump(callSid, "fnol:type") > MAX_RETRIES) {
      d.state.update(callSid, { fnol: { ...draft, lossType: "other" } });
      redirect(t, step("fnol/injury", back));
    } else {
      t.say("Sorry, that is not a valid choice.");
      redirect(t, step("fnol/type", back));
    }
    send(res, t);
  });

  r.post("/fnol/injury", (req, res) => {
    const { back } = callInfo(req);
    const t = new VoiceResponse();
    ask(t, {
      action: step("fnol/injury/in", back),
      numDigits: 1,
      prompt: "Was anyone injured? Press 1 for yes, or 2 for no.",
    });
    send(res, t);
  });

  r.post("/fnol/injury/in", (req, res) => {
    const { callSid, digits, back } = callInfo(req);
    const t = new VoiceResponse();
    const draft = d.state.get(callSid).fnol ?? {};
    const injuries = digits === "1" ? "yes" : digits === "2" ? "no" : undefined;
    if (injuries) {
      d.state.update(callSid, { fnol: { ...draft, injuries } });
      redirect(t, step("fnol/create", back));
    } else if (d.state.bump(callSid, "fnol:injury") > MAX_RETRIES) {
      d.state.update(callSid, { fnol: { ...draft, injuries: "unknown" } });
      redirect(t, step("fnol/create", back));
    } else {
      t.say("Sorry, that is not a valid choice.");
      redirect(t, step("fnol/injury", back));
    }
    send(res, t);
  });

  /** Create the claim now, tell the caller the number, THEN ask for the recording. */
  r.post("/fnol/create", (req, res) => {
    const { callSid, from, back } = callInfo(req);
    const s = d.state.get(callSid);
    const t = new VoiceResponse();
    const draft = s.fnol ?? {};

    let claimNumber = s.claimNumber;
    if (!claimNumber) {
      const claim = d.repo.createClaim(
        {
          policyNumber: draft.policyNumber ?? null,
          policyVerified: !!s.authedPolicy && s.authedPolicy === draft.policyNumber,
          lossDate: draft.lossDate ?? null,
          lossType: draft.lossType ?? "other",
          injuries: draft.injuries ?? "unknown",
          callbackPhone: from,
        },
        d.clock(),
      );
      claimNumber = claim.claimNumber;
      d.state.update(callSid, { claimNumber });
      log("info", "claim_created", { callSid, claimNumber, urgent: claim.urgent, verified: claim.policyVerified, from: maskPhone(from) });
    }

    if (draft.injuries === "yes") {
      t.say(
        "I am sorry to hear that. Please make sure everyone is safe and has medical help. " +
          "If you have not called 9 1 1, hang up and do that now. We are marking your claim as urgent.",
      );
    }
    t.say(`Your claim reference number is ${speakDigits(claimNumber)}. Please write it down.`);
    t.say("After the beep, describe what happened. Press pound when you are finished.");
    t.record({
      action: step("fnol/recorded", back),
      method: "POST",
      maxLength: 120,
      finishOnKey: "#",
      playBeep: true,
    });
    redirect(t, step("fnol/recorded", back)); // reached only if nothing was recorded
    send(res, t);
  });

  r.post("/fnol/recorded", (req, res) => {
    const { callSid, back } = callInfo(req);
    const s = d.state.get(callSid);
    const sid = String(req.body?.RecordingSid ?? "");
    const t = new VoiceResponse();
    if (s.claimNumber && /^RE\w{10,40}$/.test(sid)) {
      d.repo.attachRecording(s.claimNumber, sid);
      log("info", "claim_recording_attached", { callSid, claimNumber: s.claimNumber });
    }
    t.say("Thank you. Your claim has been recorded, and an adjuster will contact you at the number you called from.");

    // Urgent claim and someone is here to take it: hand over now. After hours it waits for a callback.
    const urgent = s.fnol?.injuries === "yes";
    if (urgent && d.agentNumber && isOpen(d.clock(), d.schedule)) {
      t.say("Because someone was injured, I am connecting you to an agent now.");
      t.dial(d.agentNumber);
    } else {
      redirect(t, `/ivr/${back}`);
    }
    send(res, t);
  });
}
