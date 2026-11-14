// Settle a payment a human has checked at the payment processor.
//   npm run payments:settle -- 300001 succeeded ch_1Abc...    the processor DID charge: apply it to the balance
//   npm run payments:settle -- 300001 failed                    the processor did NOT charge: unblock the caller
// Only attempts that are still "started" or "unconfirmed" can be settled; a finished payment is left alone.
import { loadConfig } from "../src/config.js";
import { SqliteRepo } from "../src/services/policyRepo.js";

const [number, status, confirmation] = process.argv.slice(2);
if (!number || (status !== "succeeded" && status !== "failed")) {
  console.error("usage: npm run payments:settle -- <paymentNumber> <succeeded|failed> [processorConfirmation]");
  process.exit(1);
}
const repo = new SqliteRepo(loadConfig().dbPath ?? "data/harborline.db");
const before = repo.getPayment(number);
if (!before) {
  console.error(`No payment ${number}.`);
  process.exit(1);
}
const after = repo.completePayment(number, { status, result: "reconciled-by-hand", confirmation });
console.log(`${number}: ${before.status} -> ${after?.status}${after?.needsReview ? " (needs review: balance was lower than the payment)" : ""}`);
