// Tiny TwiML reader for the simulator and tests. It reads only what OUR engine emits,
// so a few regexes are enough. It is not a general XML parser.
export interface ParsedTwiml {
  says: string[];
  gatherAction?: string;
  /** Redirect target. If a Gather is present, this is where the call goes when the caller is silent. */
  redirect?: string;
  dial?: string;
  hangup: boolean;
}

const decode = (s: string) =>
  s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function parseTwiml(xml: string): ParsedTwiml {
  return {
    says: [...xml.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)].map((m) => decode(m[1])),
    gatherAction: xml.match(/<Gather[^>]*\saction="([^"]+)"/)?.[1],
    redirect: xml.match(/<Redirect[^>]*>([^<]+)<\/Redirect>/)?.[1],
    dial: xml.match(/<Dial[^>]*>([^<]+)<\/Dial>/)?.[1],
    hangup: /<Hangup\s*\/>/.test(xml),
  };
}
