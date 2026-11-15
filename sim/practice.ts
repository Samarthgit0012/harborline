// FREE practice phone: call the whole IVR from your terminal, answering each prompt by typing. No Twilio, no internet, no cost.
//   npm run practice                      call as Alex Rivera (owes money; date of birth 03141985)
//   npm run practice -- --from +15555550101    call as another sample customer (Jordan Lee)
//   npm run practice -- --closed          practise the after-hours menu
//   npm run practice -- --pay             include the "pay by card" option on the billing menu
//   npm run practice -- --logs            also show the server's own log lines
// It runs the same call flow the real phone line runs, in this process. What it cannot show you: how Twilio's voice
// SOUNDS, how well it hears real speech, or how the line behaves over the real phone network. Use a real call for those.
import { createInterface } from "node:readline";
import { DEFAULT_CALLER, runPractice } from "./practice-session.js";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const from = flag("from") ?? DEFAULT_CALLER;
if (!/^\+[1-9]\d{6,14}$/.test(from)) {
  console.error("--from must be a phone number like +15555550100.");
  process.exit(1);
}

// The server prints one JSON line per request, which would bury the conversation. Hidden unless you ask (--logs).
const write = (line: string) => process.stdout.write(line + "\n");
if (!args.includes("--logs")) console.log = () => {};

const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
await runPractice(
  {
    write,
    async read(prompt) {
      process.stdout.write(prompt);
      const next = await lines.next();
      if (next.done) {
        process.stdout.write("\n");
        return undefined;
      }
      if (!process.stdin.isTTY) process.stdout.write(next.value + "\n"); // piped input: show what was "typed"
      return next.value;
    },
  },
  { from, closed: args.includes("--closed"), pay: args.includes("--pay") },
);
rl.close();
