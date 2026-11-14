/**
 * Turn data into text a voice reads naturally. Text-to-speech engines guess at "$1,204.50" or
 * "03/15/2027", and the guess differs per voice, so we spell it out ourselves. This works with any
 * voice because it only produces plain words (no SSML).
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORDINAL_ONES: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth",
};
const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December",
];

function below100(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (!h) return below100(rest);
  return `${ONES[h]} hundred${rest ? ` ${below100(rest)}` : ""}`;
}

/** 1204 -> "one thousand two hundred four". Whole numbers 0 to 999,999,999. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) throw new RangeError(`cannot speak ${n}`);
  if (n === 0) return "zero";
  const parts: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  if (millions) parts.push(`${below1000(millions)} million`);
  if (thousands) parts.push(`${below1000(thousands)} thousand`);
  if (rest) parts.push(below1000(rest));
  return parts.join(" ");
}

function ordinalWords(n: number): string {
  const words = below100(n);
  const last = words.split("-").pop()!;
  const head = words.slice(0, words.length - last.length);
  if (ORDINAL_ONES[last]) return head + ORDINAL_ONES[last];
  if (last.endsWith("y")) return `${head}${last.slice(0, -1)}ieth`; // twenty -> twentieth
  return `${head}${last}th`; // fourth, sixth, seventh, tenth, eleventh...
}

/** Money is stored as integer cents. 120450 -> "one thousand two hundred four dollars and fifty cents". */
export function speakCurrency(cents: number): string {
  if (!Number.isInteger(cents)) throw new RangeError("amount must be whole cents");
  const sign = cents < 0 ? "minus " : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const c = abs % 100;
  const d = `${numberToWords(dollars)} ${dollars === 1 ? "dollar" : "dollars"}`;
  if (!c) return sign + d;
  const cc = `${numberToWords(c)} ${c === 1 ? "cent" : "cents"}`;
  return dollars ? `${sign}${d} and ${cc}` : sign + cc;
}

/** "2027-03-15" -> "March fifteenth, twenty twenty-seven". */
export function speakDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new RangeError(`not an ISO date: ${iso}`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return `${MONTHS[month - 1]} ${ordinalWords(day)}, ${speakYear(year)}`;
}

function speakYear(y: number): string {
  if (y >= 2000 && y < 2010) return `two thousand${y % 100 ? ` ${ONES[y % 100]}` : ""}`;
  if (y >= 1000 && y < 10000) {
    const hi = Math.floor(y / 100);
    const lo = y % 100;
    return `${below100(hi)} ${lo === 0 ? "hundred" : lo < 10 ? `oh ${ONES[lo]}` : below100(lo)}`;
  }
  return numberToWords(y);
}

/**
 * Identifiers are read one digit at a time, in short groups with a comma (a pause) between them,
 * because people write them down as they listen. "100001" -> "1 0 0, 0 0 1".
 */
export function speakDigits(value: string, group = 3): string {
  const digits = value.replace(/\D/g, "").split("");
  const chunks: string[] = [];
  for (let i = 0; i < digits.length; i += group) chunks.push(digits.slice(i, i + group).join(" "));
  return chunks.join(", ");
}
