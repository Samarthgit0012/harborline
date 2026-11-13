import { describe, it, expect } from "vitest";
import { harborlineSchedule as s, isOpen } from "../src/services/businessHours.js";

const at = (iso: string) => new Date(iso);

describe("isOpen (America/New_York)", () => {
  it("is open mid-morning on a weekday", () => {
    expect(isOpen(at("2026-11-17T15:00:00Z"), s)).toBe(true); // Tue 10:00 EST
  });
  it("is closed in the evening on a weekday", () => {
    expect(isOpen(at("2026-11-18T00:30:00Z"), s)).toBe(false); // Tue 19:30 EST
  });
  it("opens at 08:00 sharp and not a minute earlier (winter, EST = UTC-5)", () => {
    expect(isOpen(at("2026-11-16T12:59:00Z"), s)).toBe(false); // Mon 07:59 EST
    expect(isOpen(at("2026-11-16T13:00:00Z"), s)).toBe(true); // Mon 08:00 EST
  });
  it("opens at 08:00 sharp in summer too (EDT = UTC-4): same local time, different UTC", () => {
    expect(isOpen(at("2026-07-13T11:59:00Z"), s)).toBe(false); // Mon 07:59 EDT
    expect(isOpen(at("2026-07-13T12:00:00Z"), s)).toBe(true); // Mon 08:00 EDT
  });
  it("closes at 18:00 (close time is exclusive)", () => {
    expect(isOpen(at("2026-11-17T22:59:00Z"), s)).toBe(true); // Tue 17:59 EST
    expect(isOpen(at("2026-11-17T23:00:00Z"), s)).toBe(false); // Tue 18:00 EST
  });
  it("uses shorter Saturday hours", () => {
    expect(isOpen(at("2026-11-14T15:00:00Z"), s)).toBe(true); // Sat 10:00 EST
    expect(isOpen(at("2026-11-14T19:00:00Z"), s)).toBe(false); // Sat 14:00 EST
  });
  it("is closed all day Sunday", () => {
    expect(isOpen(at("2026-11-15T17:00:00Z"), s)).toBe(false);
  });
  it("is closed on a listed holiday even though it is a weekday", () => {
    expect(isOpen(at("2026-12-25T15:00:00Z"), s)).toBe(false); // Fri Dec 25 10:00 EST
  });
  it("judges by the business's local date, not UTC's", () => {
    // 2026-11-17 23:30 UTC is Tue 18:30 EST (closed), but UTC says it is still the 17th.
    expect(isOpen(at("2026-11-17T23:30:00Z"), s)).toBe(false);
  });
});
