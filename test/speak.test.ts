import { describe, it, expect } from "vitest";
import { numberToWords, speakCurrency, speakDate, speakDigits } from "../src/services/speak.js";
import { AttemptLimiter } from "../src/services/rateLimiter.js";
import { parseUsDate } from "../src/svc/helpers.js";

describe("speakCurrency", () => {
  it("says $1,204.50 the way a person would", () => {
    expect(speakCurrency(120450)).toBe("one thousand two hundred four dollars and fifty cents");
  });
  it.each([
    [0, "zero dollars"],
    [100, "one dollar"],
    [101, "one dollar and one cent"],
    [5, "five cents"],
    [8900, "eighty-nine dollars"],
    [100000, "one thousand dollars"],
    [1234567, "twelve thousand three hundred forty-five dollars and sixty-seven cents"],
    [-2500, "minus twenty-five dollars"],
  ])("%i cents", (cents, words) => expect(speakCurrency(cents)).toBe(words));
  it("refuses fractional cents rather than rounding silently", () => {
    expect(() => speakCurrency(12.5)).toThrow();
  });
});

describe("numberToWords", () => {
  it.each([
    [0, "zero"],
    [13, "thirteen"],
    [21, "twenty-one"],
    [100, "one hundred"],
    [999, "nine hundred ninety-nine"],
    [1000, "one thousand"],
    [1_000_000, "one million"],
    [2_005_010, "two million five thousand ten"],
  ])("%i", (n, words) => expect(numberToWords(n)).toBe(words));
});

describe("speakDate", () => {
  it.each([
    ["2027-03-15", "March fifteenth, twenty twenty-seven"],
    ["2026-11-01", "November first, twenty twenty-six"],
    ["2026-12-22", "December twenty-second, twenty twenty-six"],
    ["2026-10-30", "October thirtieth, twenty twenty-six"],
    ["2026-04-12", "April twelfth, twenty twenty-six"],
    ["2005-01-03", "January third, two thousand five"],
    ["2010-07-04", "July fourth, twenty ten"],
    ["1985-03-14", "March fourteenth, nineteen eighty-five"],
  ])("%s", (iso, words) => expect(speakDate(iso)).toBe(words));
});

describe("speakDigits", () => {
  it("reads identifiers digit by digit, in groups with a pause", () => {
    expect(speakDigits("100001")).toBe("1 0 0, 0 0 1");
    expect(speakDigits("0001", 4)).toBe("0 0 0 1");
  });
  it("ignores punctuation", () => expect(speakDigits("HL-1234")).toBe("1 2 3, 4"));
});

describe("parseUsDate", () => {
  it("converts MMDDYYYY to ISO", () => expect(parseUsDate("03142026")).toBe("2026-03-14"));
  it.each(["13012000", "02302000", "00102000", "1234567", "abcdefgh", "", undefined, "01011800"])("rejects %s", (v) =>
    expect(parseUsDate(v as string | undefined)).toBeUndefined(),
  );
  it("accepts a real leap day and rejects a fake one", () => {
    expect(parseUsDate("02292024")).toBe("2024-02-29");
    expect(parseUsDate("02292023")).toBeUndefined();
  });
});

describe("AttemptLimiter", () => {
  it("locks after max failures and unlocks when the window passes", () => {
    let t = 0;
    const l = new AttemptLimiter(3, 1000, () => t);
    for (let i = 0; i < 3; i++) l.recordFailure("k");
    expect(l.isLocked("k")).toBe(true);
    expect(l.isLocked("other")).toBe(false);
    t = 1001;
    expect(l.isLocked("k")).toBe(false);
  });
  it("counts failures in a sliding window, not fixed buckets", () => {
    let t = 0;
    const l = new AttemptLimiter(3, 1000, () => t);
    l.recordFailure("k"); // t=0
    t = 600;
    l.recordFailure("k");
    t = 1100; // the first failure has aged out
    l.recordFailure("k");
    expect(l.isLocked("k")).toBe(false);
    t = 1200;
    l.recordFailure("k");
    expect(l.isLocked("k")).toBe(true);
  });
});
