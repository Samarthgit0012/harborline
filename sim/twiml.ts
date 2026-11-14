// Tiny TwiML reader for the simulator and tests. It reads only what OUR engine emits,
// so a few regexes are enough. It is not a general XML parser.
export interface ParsedTwiml {
  says: string[];
  gatherAction?: string;
  /** Number of digits the Gather waits for (undefined = until finishOnKey or timeout). */
  gatherNumDigits?: number;
  /** Redirect target. If a Gather or Record is present, this is where the call goes when the caller is silent. */
  redirect?: string;
  /** <Record action=...>: the caller is asked to leave a voice message. */
  recordAction?: string;
  dial?: string;
  hangup: boolean;
}

const decode = (s: string) =>
  s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const pick = (xml: string, re: RegExp) => {
  const v = xml.match(re)?.[1];
  return v === undefined ? undefined : decode(v);
};

export function parseTwiml(xml: string): ParsedTwiml {
  const num = xml.match(/<Gather[^>]*\snumDigits="(\d+)"/)?.[1];
  return {
    says: [...xml.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)].map((m) => decode(m[1])),
    gatherAction: pick(xml, /<Gather[^>]*\saction="([^"]+)"/),
    gatherNumDigits: num ? Number(num) : undefined,
    redirect: pick(xml, /<Redirect[^>]*>([^<]+)<\/Redirect>/),
    recordAction: pick(xml, /<Record[^>]*\saction="([^"]+)"/),
    dial: xml.match(/<Dial[^>]*>([^<]+)<\/Dial>/)?.[1],
    hangup: /<Hangup\s*\/>/.test(xml),
  };
}
