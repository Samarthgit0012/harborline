// Payments we are not sure about: attempts that started but never reported back, and ones marked unconfirmed.
//   npm run payments:report
// Each line needs a human to look the payment up at the payment processor (match on time and amount, or on the
// confirmation code) and settle it. We never guess in either direction: "unconfirmed" means exactly that.
import { loadConfig } from "../src/config.js";
import { SqliteRepo } from "../src/services/policyRepo.js";

const config = loadConfig();
const repo = new SqliteRepo(config.dbPath ?? "data/harborline.db");
const stuck = repo.unresolvedPayments(30 * 60_000);
if (!stuck.length) console.log("Nothing to reconcile.");
for (const p of stuck) {
  const dollars = (p.amountCents / 100).toFixed(2);
  console.log(
    `${p.paymentNumber}  ${p.status.padEnd(11)} $${dollars.padStart(9)}  policy ending ${p.policyNumber.slice(-4)}  ${p.createdAt}  result=${p.result ?? "(never reported)"}`,
  );
}
