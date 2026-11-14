export interface Schedule {
  /** IANA time zone the hours are expressed in, e.g. "America/New_York". */
  timeZone: string;
  /** 0 = Sunday ... 6 = Saturday -> [open, close) as "HH:MM" 24h. Missing day = closed. */
  weekly: Partial<Record<number, [string, string]>>;
  /** Closed all day on these local dates, "YYYY-MM-DD". */
  holidays: string[];
}

export const harborlineSchedule: Schedule = {
  timeZone: "America/New_York",
  weekly: {
    1: ["08:00", "18:00"],
    2: ["08:00", "18:00"],
    3: ["08:00", "18:00"],
    4: ["08:00", "18:00"],
    5: ["08:00", "18:00"],
    6: ["09:00", "13:00"],
  },
  // Example list only. A real client supplies and maintains its own holiday calendar.
  holidays: ["2026-11-26", "2026-12-25", "2027-01-01"],
};

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The local wall-clock parts of an instant in a time zone. DST is handled by Intl. */
function localParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    weekday: WEEKDAYS[get("weekday")],
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** Today's date ("YYYY-MM-DD") on the business's wall calendar, not UTC's. */
export function localDate(now: Date, timeZone: string): string {
  return localParts(now, timeZone).date;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Is the business open at this instant? Pass the clock in, so tests can control time. */
export function isOpen(now: Date, schedule: Schedule): boolean {
  const local = localParts(now, schedule.timeZone);
  if (schedule.holidays.includes(local.date)) return false;
  const hours = schedule.weekly[local.weekday];
  if (!hours) return false;
  return local.minutes >= toMinutes(hours[0]) && local.minutes < toMinutes(hours[1]);
}
