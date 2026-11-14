/**
 * US phone numbers in one canonical form (+1XXXXXXXXXX), so "(555) 555-0100", "5555550100" and "+15555550100"
 * are the same person everywhere (consent, do-not-call, call limits). Returns undefined for anything else.
 * North American numbers: area code and exchange cannot start with 0 or 1.
 */
export function normalizeUsPhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[\s().-]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return undefined;
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : undefined;
  if (!ten || !/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return undefined;
  return `+1${ten}`;
}
