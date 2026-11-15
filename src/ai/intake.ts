// What the quote line collects, and the rules each answer must pass. The MODEL proposes a value; this code decides.
// Whatever the model (or a caller trying to trick it) says, only a value that passes here is ever stored.
import { speakDigits } from "../services/speak.js";

export const REQUIRED_FIELDS = ["full_name", "zip_code", "vehicle_year", "vehicle_make", "vehicle_model", "driver_count", "currently_insured"] as const;
export type LeadField = (typeof REQUIRED_FIELDS)[number];

export const isLeadField = (v: unknown): v is LeadField => typeof v === "string" && (REQUIRED_FIELDS as readonly string[]).includes(v);

export type Checked = { ok: true; value: string } | { ok: false; error: string };

const NAME = /^[\p{L}][\p{L} .'’-]{1,59}$/u;
const VEHICLE_WORD = /^[\p{L}\p{N}][\p{L}\p{N} .\/-]{0,39}$/u;

/** Check one answer. `now` only matters for the vehicle year. Returns the tidied value, or why it was refused. */
export function checkField(field: LeadField, input: unknown, now: Date = new Date()): Checked {
  const raw = typeof input === "string" ? input.trim() : typeof input === "number" ? String(input) : "";
  switch (field) {
    case "full_name":
      return NAME.test(raw) ? { ok: true, value: raw } : { ok: false, error: "That does not look like a name. Ask the caller to say their first and last name." };
    case "zip_code": {
      const digits = raw.replace(/[\s-]/g, "");
      return /^\d{5}$/.test(digits) ? { ok: true, value: digits } : { ok: false, error: "A zip code is exactly five digits. Ask the caller to repeat it." };
    }
    case "vehicle_year": {
      const n = Number(raw);
      const max = now.getUTCFullYear() + 1;
      return /^\d{4}$/.test(raw) && n >= 1981 && n <= max ? { ok: true, value: raw } : { ok: false, error: `The year must be four digits between 1981 and ${max}.` };
    }
    case "vehicle_make":
    case "vehicle_model":
      return VEHICLE_WORD.test(raw) ? { ok: true, value: raw } : { ok: false, error: "That does not look like a vehicle make or model. Ask again." };
    case "driver_count": {
      const n = Number(raw);
      return /^\d{1,2}$/.test(raw) && n >= 1 && n <= 8 ? { ok: true, value: String(n) } : { ok: false, error: "The number of drivers must be from 1 to 8." };
    }
    case "currently_insured": {
      const v = raw.toLowerCase();
      if (["yes", "y", "true"].includes(v)) return { ok: true, value: "yes" };
      if (["no", "n", "false"].includes(v)) return { ok: true, value: "no" };
      return { ok: false, error: "Answer must be yes or no." };
    }
  }
}

export interface LeadInput {
  phone: string;
  values: Partial<Record<LeadField, string>>;
  complete: boolean;
  /** True if the caller was passed to an agent instead of finishing. */
  transferred: boolean;
}

/** The answers collected so far on one call. */
export class QuoteIntake {
  readonly values: Partial<Record<LeadField, string>> = {};

  set(field: LeadField, value: string): void {
    this.values[field] = value;
  }

  missing(): LeadField[] {
    return REQUIRED_FIELDS.filter((f) => !this.values[f]);
  }

  complete(): boolean {
    return this.missing().length === 0;
  }

  any(): boolean {
    return Object.keys(this.values).length > 0;
  }

  /** What the agent hears privately before being connected. Spoken text, so digits are spaced out. */
  spokenSummary(): string {
    if (!this.any()) return "No details were collected yet.";
    const v = this.values;
    const parts: string[] = [];
    if (v.full_name) parts.push(`Name ${v.full_name}.`);
    if (v.zip_code) parts.push(`Zip ${speakDigits(v.zip_code)}.`);
    const car = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(" ");
    if (car) parts.push(`Vehicle ${car}.`);
    if (v.driver_count) parts.push(`${v.driver_count} ${v.driver_count === "1" ? "driver" : "drivers"}.`);
    if (v.currently_insured) parts.push(v.currently_insured === "yes" ? "Currently insured." : "Not currently insured.");
    const missing = this.missing();
    if (missing.length) parts.push(`Still missing: ${missing.map((m) => m.replace("_", " ")).join(", ")}.`);
    return parts.join(" ");
  }
}
