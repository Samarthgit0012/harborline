import type { Campaign, OutboundStore } from "./store.js";
import { normalizeUsPhone } from "./phone.js";

/**
 * THE COMPLIANCE GATE. Every outbound call must pass it, in this order, and every refusal has a reason that is
 * written to the decision log. The rules come from the federal texts I could read (Lesson 11 lists exactly which
 * and what could not be verified). Anything stricter (state rules, the client's own policy) is a setting, not a guess.
 */

export type BlockReason =
  | "invalid_phone"
  | "no_caller_id"
  | "on_internal_dnc"
  | "on_national_dnc"
  | "national_dnc_list_missing"
  | "national_dnc_list_stale"
  | "no_consent"
  | "consent_revoked"
  | "consent_too_weak"
  | "outside_calling_hours"
  | "frequency_cap"
  | "contact_complete"
  | "too_many_attempts"
  | "retry_too_soon"
  | "already_in_progress"
  | "promotional_content_in_informational_campaign";

export type GateResult = { allowed: true; detail?: string } | { allowed: false; reason: BlockReason; detail?: string };

/** Hours (local time of the person called) when calls may start: from `startHour` up to but not including `endHour`. */
export interface CallWindow {
  startHour: number;
  endHour: number;
}

/**
 * 8 a.m. to 9 p.m. at the called party's location (47 CFR 64.1200(c)(1) for telephone solicitations; the FTC's Rule
 * says the same for telemarketing). We use the end as exclusive, which is the cautious reading of "after 9 p.m.".
 * We apply it to EVERY campaign, informational too: the rule is written for solicitations, but nobody wants a
 * payment reminder at 9:30 p.m.
 */
export const FEDERAL_WINDOW: CallWindow = { startHour: 8, endHour: 21 };

/** When we do not know where a person is, the call must be acceptable in ALL of these at once. */
export const US_ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
];

export interface GateRules {
  /** The calling window. Raise the start or lower the end for a stricter rule; never widen past FEDERAL_WINDOW. */
  window: CallWindow;
  /** Most calls to one number, across all campaigns, in any rolling 7 days. */
  maxPerWeek: number;
  /** Most calls to one number from one campaign, ever. */
  maxAttempts: number;
  /** Minimum gap between two calls to the same number. */
  minRetryMs: number;
  /** The registry copy must be no older than this (31 days is the maximum the FTC and FCC texts allow for the safe harbor). */
  nationalListMaxAgeMs: number;
  /** Our own caller ID. Without one we do not call. */
  from?: string;
}

export const DEFAULT_RULES: GateRules = {
  window: FEDERAL_WINDOW,
  maxPerWeek: 2,
  maxAttempts: 3,
  minRetryMs: 4 * 60 * 60 * 1000,
  nationalListMaxAgeMs: 31 * 24 * 60 * 60 * 1000,
};

const DONE_OUTCOMES = new Set(["human_answered", "transferred", "opted_out"]);
const DAY = 24 * 60 * 60 * 1000;

/** Local time of day in a zone as a decimal number of hours (21.5 = 9:30 p.m.). */
export function localHour(now: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return get("hour") + get("minute") / 60;
}

/** True only if it is inside the window in EVERY listed zone. */
export function withinWindow(now: Date, zones: string[], w: CallWindow): boolean {
  return zones.every((z) => {
    const h = localHour(now, z);
    return h >= w.startHour && h < w.endHour;
  });
}

export function checkGate(
  store: OutboundStore,
  campaign: Campaign,
  contact: { phone: string; timeZone: string | null },
  now: Date,
  rules: GateRules = DEFAULT_RULES,
): GateResult {
  const phone = normalizeUsPhone(contact.phone);
  if (!phone) return { allowed: false, reason: "invalid_phone" };
  if (!rules.from) return { allowed: false, reason: "no_caller_id" };

  // 1. Someone who said stop is never called again, whatever else is true.
  if (store.isOnInternalDnc(phone)) return { allowed: false, reason: "on_internal_dnc" };

  // 2. Consent, strongest requirement first. Marketing needs a signed written agreement for THIS scope.
  const marketing = campaign.purpose === "marketing";
  const consent = store.consentStatus(phone, campaign.consentScope);

  if (marketing) {
    // The registry copy must be fresh enough to trust (the safe harbor allows at most 31 days old).
    const loaded = store.nationalDncLoadedAt();
    if (!loaded) return { allowed: false, reason: "national_dnc_list_missing" };
    if (now.getTime() - loaded.getTime() > rules.nationalListMaxAgeMs) return { allowed: false, reason: "national_dnc_list_stale", detail: loaded.toISOString() };
    const written = consent.status === "valid" && consent.consent!.kind === "written";
    if (store.isOnNationalDnc(phone) && !written) return { allowed: false, reason: "on_national_dnc" };
    if (consent.status === "none") return { allowed: false, reason: "no_consent" };
    if (consent.status === "revoked") return { allowed: false, reason: "consent_revoked" };
    if (!written) return { allowed: false, reason: "consent_too_weak", detail: "marketing calls need prior express WRITTEN consent" };
  } else {
    if (consent.status === "none") return { allowed: false, reason: "no_consent" };
    if (consent.status === "revoked") return { allowed: false, reason: "consent_revoked" };
  }

  // 3. Calling hours, at the person's own location. Unknown location: the strictest reading (every US zone at once).
  const zones = contact.timeZone ? [contact.timeZone] : US_ZONES;
  if (!withinWindow(now, zones, rules.window)) {
    return { allowed: false, reason: "outside_calling_hours", detail: contact.timeZone ?? "zone unknown: checked all US zones" };
  }

  // 4. How often, and how persistently.
  if (store.attemptsFor(campaign.id, phone).some((a) => a.status === "queued")) return { allowed: false, reason: "already_in_progress" };
  const history = store.attemptsFor(campaign.id, phone).filter((a) => a.callSid);
  if (history.some((a) => a.outcome && DONE_OUTCOMES.has(a.outcome))) return { allowed: false, reason: "contact_complete" };
  if (store.placedSince(phone, new Date(now.getTime() - 7 * DAY)) >= rules.maxPerWeek) return { allowed: false, reason: "frequency_cap" };
  if (history.length >= rules.maxAttempts) return { allowed: false, reason: "too_many_attempts" };
  const last = history[history.length - 1];
  if (last && now.getTime() - new Date(last.createdAt).getTime() < rules.minRetryMs) return { allowed: false, reason: "retry_too_soon" };

  const detail = marketing && consent.consent ? `consent #${consent.consent.id} (${consent.consent.kind}, ${consent.consent.method})${store.isOnNationalDnc(phone) ? "; on national DNC but written agreement on file" : ""}` : consent.consent ? `consent #${consent.consent.id}` : undefined;
  return { allowed: true, detail };
}
