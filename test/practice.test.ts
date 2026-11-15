import { afterEach, describe, expect, it, vi } from "vitest";
import { runPractice, type PracticeOptions } from "../sim/practice-session.js";

/** Type these lines, in order, at the practice phone; collect everything it shows. */
async function practise(inputs: string[], opts: PracticeOptions = {}) {
  const shown: string[] = [];
  const left = [...inputs];
  await runPractice({ write: (l) => void shown.push(l), read: async () => left.shift() }, opts);
  return { text: shown.join("\n"), unused: left };
}

afterEach(() => vi.restoreAllMocks());

describe("the free practice phone", () => {
  it("runs a whole call: log in, hear the balance in words, hang up, and says it cost nothing", async () => {
    const { text } = await practise(["3", "03141985", "bye", "q"]);
    expect(text).toContain("Please enter your date of birth");
    expect(text).toContain("one thousand two hundred four dollars and fifty cents");
    expect(text).toContain("[caller hung up]");
    expect(text).toContain("Cost: $0.00");
  });

  it("only ever talks to this computer: no request leaves the loopback address", async () => {
    const real = globalThis.fetch;
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      urls.push(String(input));
      return real(input, init);
    });
    await practise(["0", "q"]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("http://127.0.0.1:"))).toBe(true);
  });

  it("speaking works like the real phone, and the agent hand-off plays the private summary", async () => {
    const { text } = await practise(["say talk to someone@0.9", "q"]);
    expect(text).toContain('CALLER says: "talk to someone" (confidence 0.9)');
    expect(text).toContain("[call rings the agent line +15555550123]");
    expect(text).toMatch(/AGENT HEARS \(whisper\): Harborline call/);
  });

  it("refuses what a phone could not send, instead of passing it to the server", async () => {
    const { text, unused } = await practise(["ok", "1", "bye", "q"]);
    expect(text).toContain("A phone cannot send that here");
    expect(text).not.toContain("CALLER presses ok");
    expect(text).toContain("CALLER presses 1");
    expect(unused).toEqual([]);
  });

  it("an empty line does nothing but remind you how to answer", async () => {
    const { text } = await practise(["", "bye", "q"]);
    expect(text).toContain("Type a key, say <words>");
    expect(text).not.toContain("CALLER presses #");
  });

  it("# is a keypress with nothing typed, and - is silence", async () => {
    const { text } = await practise(["-", "bye", "q"]);
    expect(text).toContain("CALLER: (silence)");
    const pound = await practise(["#", "bye", "q"]);
    expect(pound.text).toContain("CALLER presses #");
  });

  it("closed mode plays the after-hours menu", async () => {
    const { text } = await practise(["bye", "q"], { closed: true });
    expect(text).toContain("The business is CLOSED");
    expect(text).toContain("Harborline Insurance is closed right now");
  });

  it("open mode ignores the clock", async () => {
    const { text } = await practise(["bye", "q"]);
    expect(text).toContain("The business is OPEN");
    expect(text).not.toContain("is closed right now");
  });

  it("another sample customer can be the caller", async () => {
    const { text } = await practise(["bye", "q"], { from: "+15555550101" });
    expect(text).toContain("calling from +15555550101");
    expect(text).toContain("Jordan Lee");
  });

  it("the card option only appears when asked for, and the card step takes a result word", async () => {
    const off = await practise(["3", "03141985", "bye", "q"]);
    expect(off.text).not.toContain("To pay your balance by card");
    const on = await practise(["3", "03141985", "2", "1", "ok", "bye", "q"], { pay: true });
    expect(on.text).toContain("To pay your balance by card, press 2");
    expect(on.text).toContain("Twilio collects the card");
    expect(on.text).toContain("TWILIO reports Result=success");
  });

  it("a second call keeps what the first one did (the practice database lives for the whole session)", async () => {
    // Two calls in one session: the second call asks for the same date of birth again (call state is per call),
    // but the practice customers are still there.
    const { text } = await practise(["3", "03141985", "bye", "", "3", "03141985", "bye", "q"]);
    expect(text.match(/--- ringing/g)).toHaveLength(2);
    expect(text.match(/one thousand two hundred four dollars/g)).toHaveLength(2);
  });

  it("ending the input hangs up and quits cleanly", async () => {
    const { text } = await practise([]);
    expect(text).toContain("[caller hung up]");
    expect(text).toContain("Practice over");
  });

  it("texts the practice phone would send are shown, not sent anywhere", async () => {
    const { text } = await practise(["1", "03141985", "2", "bye", "q"]);
    expect(text).toMatch(/TEXT MESSAGE to \*\*\*0100:/);
  });
});
