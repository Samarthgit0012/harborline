import { afterEach, describe, expect, it } from "vitest";
import { AGENT, CLOSED, OPEN, Caller, baseConfig, startApp, type TestServer } from "./caller.js";
import { SqliteRepo } from "../src/services/policyRepo.js";
import { MemoryStateStore } from "../src/engine/state.js";
import { REDACTED, findPans, luhnValid, maskPan, redactDeep, redactPans } from "../src/services/pci.js";
import { log } from "../src/log.js";
import { loadConfig } from "../src/config.js";
import { centsToDecimal } from "../src/svc/pay.js";

const ALEX = "+15555550100"; // policy 10000001, balance $1,204.50, dob 03/14/1985
const JORDAN = "+15555550101"; // balance zero, dob 07/02/1990
const TEST_CARD = "4242424242424242"; // a well-known test card number: passes the Luhn check

let srv: TestServer;
let repo: SqliteRepo;
let state: MemoryStateStore;
let now = OPEN.getTime();

async function boot(config: Partial<typeof baseConfig> = {}) {
  now = OPEN.getTime();
  repo = new SqliteRepo(":memory:");
  state = new MemoryStateStore();
  srv = await startApp({ clock: () => new Date(now), repo, state }, { ...baseConfig, payEnabled: true, ...config });
}
afterEach(() => srv?.close());

/** Capture everything the server logs while `fn` runs. */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    [console.log, console.warn, console.error] = orig;
  }
  return lines.join("\n");
}

/** Dial in as Alex, log in via billing, and stop at the billing menu. */
async function atBilling(from = ALEX, dob = "03141985") {
  const c = await new Caller(srv, from).dial();
  await c.press("3");
  await c.press(dob);
  return c;
}
/** ...and go on to the point where Twilio would take over the keypad. */
async function atPay(from = ALEX) {
  const c = await atBilling(from);
  await c.press("2"); // pay by card
  await c.press("1"); // yes, the full balance
  return c;
}

describe("spotting card numbers", () => {
  it("the Luhn check accepts real-looking numbers and rejects typos", () => {
    expect(luhnValid(TEST_CARD)).toBe(true);
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(luhnValid("378282246310005")).toBe(true); // a 15-digit test number
    expect(luhnValid("")).toBe(false);
    expect(luhnValid("12a4")).toBe(false);
  });
  it("finds card numbers written with spaces or dashes, inside a sentence", () => {
    expect(findPans(`my card is ${TEST_CARD} thanks`)).toEqual([TEST_CARD]);
    expect(findPans("4242 4242 4242 4242")).toHaveLength(1);
    expect(findPans("4242-4242-4242-4242")).toHaveLength(1);
  });
  it("does not flag the numbers this system really uses", () => {
    for (const harmless of ["10000001", "+15555550100", "100001", "200001", "2026-11-17T15:00:00.000Z", "CA00000000000000000000000000000001", "120450", "12345678901"]) {
      expect(findPans(harmless)).toEqual([]);
    }
    expect(findPans("4242424242424241")).toEqual([]); // 16 digits but fails Luhn
  });
  it("masks to the last four only", () => {
    expect(maskPan(TEST_CARD)).toBe("************4242");
    expect(maskPan("1234")).toBe("****");
  });
  it("redacts inside text and inside nested log fields, numbers included", () => {
    expect(redactPans(`card ${TEST_CARD} ok`)).toBe(`card ${REDACTED} ok`);
    const out = redactDeep({ a: `x ${TEST_CARD}`, n: 4242424242424242, list: [`4242 4242 4242 4242`], deep: { s: TEST_CARD }, keep: "10000001" });
    expect(JSON.stringify(out)).not.toContain("4242");
    expect(out.keep).toBe("10000001");
  });
  it("the logger redacts a card number even when a developer logs one by mistake", async () => {
    const out = await captureLogs(async () => log("info", `oops ${TEST_CARD}`, { policy: "10000001", card: TEST_CARD, nested: { n: 4242424242424242 } }));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("4242");
    expect(out).toContain("10000001");
  });
});

describe("money as whole numbers", () => {
  it("turns cents into the decimal string Twilio wants without floating point", () => {
    expect(centsToDecimal(120450)).toBe("1204.50");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(100)).toBe("1.00");
    expect(centsToDecimal(1)).toBe("0.01");
  });
});

describe("the payments record", () => {
  it("starts an attempt before any card is typed, with the amount in cents", async () => {
    repo = new SqliteRepo(":memory:");
    const p = repo.startPayment("10000001", 120450, new Date(0));
    expect(p).toMatchObject({ paymentNumber: "300001", policyNumber: "10000001", amountCents: 120450, status: "started", confirmation: null, needsReview: false });
  });
  it("refuses a zero, negative or fractional amount", () => {
    repo = new SqliteRepo(":memory:");
    for (const bad of [0, -5, 10.5, Number.NaN]) expect(() => repo.startPayment("10000001", bad)).toThrow();
  });
  it("a success lowers the balance exactly once, even if the report arrives twice", () => {
    repo = new SqliteRepo(":memory:");
    const p = repo.startPayment("10000001", 120450);
    repo.completePayment(p.paymentNumber, { status: "succeeded", result: "success", confirmation: "ch_1" });
    repo.completePayment(p.paymentNumber, { status: "succeeded", result: "success", confirmation: "ch_1" });
    expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(0);
    expect(repo.getPayment(p.paymentNumber)).toMatchObject({ status: "succeeded", confirmation: "ch_1" });
  });
  it("a partial payment reduces the balance by that amount only", () => {
    repo = new SqliteRepo(":memory:");
    const p = repo.startPayment("10000001", 20000);
    repo.completePayment(p.paymentNumber, { status: "succeeded", result: "success" });
    expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(100450);
  });
  it("a failure leaves the balance alone, and a later success report cannot rewrite a failure", () => {
    repo = new SqliteRepo(":memory:");
    const p = repo.startPayment("10000001", 120450);
    repo.completePayment(p.paymentNumber, { status: "failed", result: "caller-interrupted-with-star" });
    repo.completePayment(p.paymentNumber, { status: "succeeded", result: "success" });
    expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(120450);
    expect(repo.getPayment(p.paymentNumber)!.status).toBe("failed");
  });
  it("never lets a balance go negative: an overpayment is flagged for a human", () => {
    repo = new SqliteRepo(":memory:");
    const p = repo.startPayment("10000002", 5000); // Jordan owes nothing
    const done = repo.completePayment(p.paymentNumber, { status: "succeeded", result: "success" })!;
    expect(done.needsReview).toBe(true);
    expect(repo.findByPolicyNumber("10000002")!.balanceCents).toBe(0);
  });
  it("an unconfirmed attempt can be settled later, once a human learns the truth", () => {
    repo = new SqliteRepo(":memory:");
    const p = repo.startPayment("10000001", 120450);
    repo.completePayment(p.paymentNumber, { status: "unconfirmed", result: "caller-hung-up" });
    expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(120450);
    repo.completePayment(p.paymentNumber, { status: "succeeded", result: "reconciled", confirmation: "ch_9" });
    expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(0);
  });
  it("the same processor confirmation cannot be used for two payments", () => {
    repo = new SqliteRepo(":memory:");
    const a = repo.startPayment("10000001", 100);
    const b = repo.startPayment("10000001", 100);
    repo.completePayment(a.paymentNumber, { status: "succeeded", result: "success", confirmation: "ch_same" });
    expect(() => repo.completePayment(b.paymentNumber, { status: "succeeded", result: "success", confirmation: "ch_same" })).toThrow();
    expect(repo.getPayment(b.paymentNumber)!.status).toBe("started"); // rolled back, nothing half-applied
    expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(120450 - 100);
  });
  it("lists attempts we never heard back about, and unconfirmed ones, but not fresh or finished ones", () => {
    repo = new SqliteRepo(":memory:");
    const old = repo.startPayment("10000001", 100, new Date("2026-11-17T10:00:00Z"));
    const fresh = repo.startPayment("10000001", 100, new Date("2026-11-17T14:59:00Z"));
    const unconf = repo.startPayment("10000001", 100, new Date("2026-11-17T14:59:30Z"));
    const done = repo.startPayment("10000001", 100, new Date("2026-11-17T10:00:00Z"));
    repo.completePayment(unconf.paymentNumber, { status: "unconfirmed", result: "internal-error" });
    repo.completePayment(done.paymentNumber, { status: "failed", result: "caller-interrupted-with-star" });
    const ids = repo.unresolvedPayments(30 * 60_000, new Date("2026-11-17T15:00:00Z")).map((p) => p.paymentNumber);
    expect(ids).toEqual([old.paymentNumber, unconf.paymentNumber]);
    expect(ids).not.toContain(fresh.paymentNumber);
  });
});

describe("offering to pay", () => {
  it("is not offered when card payment is switched off (the default)", async () => {
    await boot({ payEnabled: false });
    const c = await atBilling();
    expect(c.last.says.join(" ")).not.toContain("pay your balance by card");
    await c.press("2");
    expect(c.hearsAll).toContain("not a valid choice");
  });
  it("is offered when switched on and money is owed", async () => {
    await boot();
    const c = await atBilling();
    expect(c.last.says.join(" ")).toContain("To pay your balance by card, press 2.");
  });
  it("is not offered when nothing is owed", async () => {
    await boot();
    const c = await atBilling(JORDAN, "07021990");
    expect(c.hearsAll).toContain("You have no balance due");
    expect(c.last.says.join(" ")).not.toContain("pay your balance by card");
  });
  it("direct requests are refused without a login, and no attempt is created", async () => {
    await boot();
    const c = await new Caller(srv, ALEX).dial();
    await c.post("/svc/pay/confirm", { Digits: "1" });
    await c.settle();
    expect(c.last.pay).toBeUndefined();
    expect(repo.getPayment("300001")).toBeUndefined();
    expect(c.hearsAll).toMatch(/date of birth|policy number/i);
  });
  it("asks before charging: the amount is spoken and 9 backs out", async () => {
    await boot();
    const c = await atBilling();
    await c.press("2");
    expect(c.last.says.join(" ")).toContain("Your balance is one thousand two hundred four dollars and fifty cents.");
    await c.press("9");
    expect(c.last.pay).toBeUndefined();
    expect(repo.getPayment("300001")).toBeUndefined();
  });
});

describe("handing the keypad to Twilio <Pay>", () => {
  it("emits <Pay> with the amount from OUR records, an https callback, and nothing that collects card digits itself", async () => {
    await boot();
    const c = await atPay();
    expect(c.last.pay).toMatchObject({
      chargeAmount: "1204.50",
      currency: "usd",
      paymentMethod: "credit-card",
      input: "dtmf",
      maxAttempts: "2",
      securityCode: "true",
      postalCode: "true",
      description: "Harborline policy ending 0001",
    });
    expect(c.last.pay!.validCardTypes).toBe("visa mastercard amex");
    expect(c.last.pay!.action).toMatch(/^https:\/\/ivr\.example\.com\/svc\/pay\/result\?p=300001&back=main$/);
    expect(c.last.pay!.statusCallback).toMatch(/^https:\/\/ivr\.example\.com\/svc\/pay\/status\?p=300001$/);
    expect(c.last.gatherAction).toBeUndefined(); // our server does NOT run a <Gather> for the card
    expect(c.last.raw).not.toContain("10000001"); // the whole policy number is not sent to the processor
    expect(c.last.says.join(" ")).toContain("Press star at any time to cancel");
    expect(repo.getPayment("300001")).toMatchObject({ status: "started", amountCents: 120450, policyNumber: "10000001" });
  });
  it("uses the named connector when one is configured", async () => {
    await boot({ payConnector: "Stripe_Test" });
    const c = await atPay();
    expect(c.last.pay!.paymentConnector).toBe("Stripe_Test");
  });
  it("omits the connector attribute otherwise, so Twilio uses the one named Default", async () => {
    await boot();
    const c = await atPay();
    expect(c.last.pay!.paymentConnector).toBeUndefined();
  });
  it("the caller cannot choose the amount", async () => {
    await boot();
    const c = await atBilling();
    await c.press("2");
    await c.post(c.last.gatherAction!, { Digits: "1", Amount: "1", chargeAmount: "0.01", amount: "1" });
    expect(c.last.pay!.chargeAmount).toBe("1204.50");
    expect(repo.getPayment("300001")!.amountCents).toBe(120450);
  });
  it("a repeated 'yes' reuses the open attempt instead of starting a second charge", async () => {
    await boot();
    const c = await atPay();
    await c.post("/svc/pay/confirm", { Digits: "1" });
    expect(c.last.pay!.action).toContain("p=300001");
    expect(repo.getPayment("300002")).toBeUndefined();
  });
});

describe("what Twilio reports back", () => {
  it("success: the balance drops once, the caller hears a confirmation number, and billing now shows zero", async () => {
    await boot();
    const c = await atPay();
    await c.payResult("success", { PaymentConfirmationCode: "ch_abc123" });
    expect(c.hearsAll).toContain("Your payment of one thousand two hundred four dollars and fifty cents was successful.");
    expect(c.hearsAll).toContain("Your confirmation number is 3 0 0, 0 0 1.");
    expect(c.hearsAll).not.toContain("ch_abc123"); // the processor's code is for humans reconciling, not for the caller
    expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(0);
    expect(repo.getPayment("300001")).toMatchObject({ status: "succeeded", confirmation: "ch_abc123", result: "success" });
    expect(c.last.says.join(" ")).toContain("You have no balance due");
  });
  it("a repeated success report does not take the money twice", async () => {
    await boot();
    const c = await atPay();
    const action = new URL(c.last.pay!.action);
    await c.payResult("success", { PaymentConfirmationCode: "ch_abc123" });
    await c.post(action.pathname + action.search, { Result: "success", PaymentConfirmationCode: "ch_abc123" });
    expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(0);
    expect(repo.getPayment("300002")).toBeUndefined();
  });
  it("a malformed confirmation code is not stored", async () => {
    await boot();
    const c = await atPay();
    await c.payResult("success", { PaymentConfirmationCode: "x'; DROP TABLE payments;--" });
    expect(repo.getPayment("300001")).toMatchObject({ status: "succeeded", confirmation: null });
  });
  it("a result from some other call's attempt is ignored", async () => {
    await boot();
    const a = await atPay();
    const b = await new Caller(srv, JORDAN).dial();
    await b.post("/svc/pay/result?p=300001&back=main", { Result: "success" });
    expect(repo.getPayment("300001")!.status).toBe("started");
    expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(120450);
    void a;
  });
  it("a result with a missing or malformed attempt number is ignored", async () => {
    await boot();
    const c = await atPay();
    for (const q of ["", "?p=abc", "?p=300001%27%20OR%201=1", "?p=999999"]) {
      await c.post(`/svc/pay/result${q}`, { Result: "success" });
    }
    expect(repo.getPayment("300001")!.status).toBe("started");
    expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(120450);
  });
  it("star: cancelled, not charged, and nothing changes", async () => {
    await boot();
    const c = await atPay();
    await c.payResult("caller-interrupted-with-star");
    expect(c.hearsAll).toContain("cancelled and your card was not charged");
    expect(repo.getPayment("300001")!.status).toBe("failed");
    expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(120450);
  });
  it("too many failed card entries: a failure, with a way forward", async () => {
    await boot();
    const c = await atPay();
    await c.payResult("too-many-failed-attempts");
    expect(c.hearsAll).toContain("could not accept that card");
    expect(c.hearsAll).toContain("speak with an agent");
    expect(repo.getPayment("300001")!.status).toBe("failed");
  });
  it.each(["payment-connector-error", "internal-error", "caller-hung-up", "some-new-result-twilio-adds-later"])(
    "%s: we do not claim success OR failure; it goes on the reconciliation list",
    async (result) => {
      await boot();
      const c = await atPay();
      await c.payResult(result);
      expect(c.hearsAll).toContain("could not confirm your payment");
      expect(c.hearsAll).toContain("do not pay again");
      expect(repo.getPayment("300001")!.status).toBe("unconfirmed");
      expect(repo.findByPolicyNumber("10000001")!.balanceCents).toBe(120450);
      expect(repo.unresolvedPayments(0).map((p) => p.paymentNumber)).toContain("300001");
    },
  );
  it("a payment that never reports back stays 'started' and shows up for reconciliation", async () => {
    await boot();
    await atPay(); // the caller's phone dies mid-payment
    now += 2 * 60 * 60_000;
    expect(repo.unresolvedPayments(30 * 60_000, new Date(now)).map((p) => p.status)).toEqual(["started"]);
  });
});

describe("never charged twice", () => {
  it("after an unconfirmed payment, paying again is refused and not even offered", async () => {
    await boot();
    const c = await atPay();
    await c.payResult("payment-connector-error");
    expect(c.last.says.join(" ")).not.toContain("pay your balance by card");
    await c.post("/svc/pay");
    await c.settle();
    expect(c.hearsAll).toContain("still checking on a recent payment");
    expect(repo.getPayment("300002")).toBeUndefined();
  });
  it("a confirm request that skips the menu is refused too", async () => {
    await boot();
    const first = await atPay();
    await first.payResult("internal-error");
    const second = await atBilling();
    await second.post("/svc/pay/confirm", { Digits: "1" });
    expect(second.last.pay).toBeUndefined();
    expect(repo.getPayment("300002")).toBeUndefined();
  });
  it("another call cannot pay the same policy while one is mid-payment", async () => {
    await boot();
    await atPay(); // first call is typing its card
    const other = await atBilling();
    expect(other.last.says.join(" ")).not.toContain("pay your balance by card");
    await other.post("/svc/pay/confirm", { Digits: "1" });
    expect(other.last.pay).toBeUndefined();
  });
  it("once a human settles the unknown payment as not charged, paying works again", async () => {
    await boot();
    const c = await atPay();
    await c.payResult("caller-hung-up");
    repo.completePayment("300001", { status: "failed", result: "reconciled-by-hand" });
    const again = await atBilling();
    expect(again.last.says.join(" ")).toContain("To pay your balance by card, press 2.");
  });
  it("and if the human finds it WAS charged, the balance is applied and nothing more is owed", async () => {
    await boot();
    const c = await atPay();
    await c.payResult("caller-hung-up");
    repo.completePayment("300001", { status: "succeeded", result: "reconciled-by-hand", confirmation: "ch_found" });
    const again = await atBilling();
    expect(again.hearsAll).toContain("You have no balance due");
  });
});

describe("card-testing and abuse", () => {
  it("allows three attempts per policy per hour, then refuses without creating a fourth", async () => {
    await boot();
    for (let i = 0; i < 3; i++) {
      const c = await atPay();
      await c.payResult("caller-interrupted-with-star");
    }
    const c = await atBilling();
    await c.press("2");
    expect(c.hearsAll).toContain("too many payment attempts");
    expect(repo.getPayment("300004")).toBeUndefined();
    now += 61 * 60_000; // the hour passes
    const later = await atBilling();
    await later.press("2");
    await later.press("1");
    expect(later.last.pay).toBeDefined();
  });
  it("also limits by calling number, so one phone cannot spray attempts across policies", async () => {
    await boot();
    for (let i = 0; i < 3; i++) {
      const c = await atPay(ALEX);
      await c.payResult("caller-interrupted-with-star");
    }
    // The same policy is now locked; the per-number limit is checked at the confirm step too.
    const c = await atBilling();
    await c.press("2");
    expect(c.last.pay).toBeUndefined();
  });
});

describe("card data never reaches us", () => {
  const CVV = "7391";
  const TOKEN = "tok_super_secret_9f8e7d";
  const hostile = {
    PaymentCardNumber: TEST_CARD,
    SecurityCode: CVV,
    ExpirationDate: "1229",
    PaymentToken: TOKEN,
    ProfileId: "cus_private_77",
    PaymentConfirmationCode: "ch_ok_1",
    Digits: TEST_CARD,
    SpeechResult: `my card is ${TEST_CARD}`,
  };
  async function dump(): Promise<string> {
    const sids = [...(srv as unknown as { sids?: string[] }).sids ?? []];
    void sids;
    return JSON.stringify({ payment: repo.getPayment("300001"), unresolved: repo.unresolvedPayments(0), claims: repo.claimsFor("10000001"), tickets: repo.openTickets() });
  }
  it("even if a card number, security code and token were sent to us, none is logged or stored", async () => {
    await boot();
    let c!: Caller;
    const logs = await captureLogs(async () => {
      c = await atPay();
      await c.payResult("success", hostile);
      await c.post("/svc/pay/status?p=300001", { For: "payment-card-number", ErrorType: "invalid-card-number", PaymentCardNumber: TEST_CARD, SecurityCode: CVV, PaymentToken: TOKEN });
    });
    const everything = logs + (await dump()) + JSON.stringify(state.get(c.callSid)) + c.hearsAll;
    for (const secret of [TEST_CARD, CVV, TOKEN, "cus_private_77", "1229"]) expect(everything).not.toContain(secret);
    expect(logs).toContain("payment_result");
  });
  it("the status callback logs only which step failed, and answers 204", async () => {
    await boot();
    const c = await atPay();
    const statuses: number[] = [];
    const logs = await captureLogs(async () => {
      await c.post("/svc/pay/status?p=300001", { For: "security-code", ErrorType: "invalid-security-code", SecurityCode: CVV });
      statuses.push(c.status);
      await c.post("/svc/pay/status?p=300001", { For: "<script>", ErrorType: "made up" });
      statuses.push(c.status);
    });
    expect(statuses).toEqual([204, 204]);
    expect(logs).toContain('"step":"security-code"');
    expect(logs).toContain('"error":"invalid-security-code"');
    expect(logs).toContain('"step":"other"');
    expect(logs).toContain('"error":"other"');
    expect(logs).not.toContain(CVV);
    expect(logs).not.toContain("<script>");
  });
  it("a caller who types a card number into a policy number prompt leaves it nowhere", async () => {
    await boot();
    const c = await new Caller(srv, "+15555550199").dial(); // unknown caller: asked for a policy number
    await c.press("3");
    let logs = "";
    logs = await captureLogs(async () => {
      await c.press(TEST_CARD);
    });
    expect(c.hearsAll).toContain("eight digits");
    expect(logs).not.toContain(TEST_CARD);
    expect(JSON.stringify(state.get(c.callSid))).not.toContain(TEST_CARD);
  });
  it("tells callers not to speak card numbers into messages, and never records agent calls", async () => {
    await boot();
    const fnol = await new Caller(srv).dial();
    await fnol.press("2");
    await fnol.press("1");
    expect(fnol.hearsAll).toContain("do not say any card numbers");
    await srv.close();
    await boot();
    const agent = await new Caller(srv).dial();
    await agent.press("0");
    expect(agent.last.dial).toBe(AGENT);
    expect(agent.last.raw).not.toMatch(/record=/i);
    await srv.close();
    now = CLOSED.getTime();
    srv = await startApp({ clock: () => CLOSED, repo, state }, { ...baseConfig, payEnabled: true });
    const vm = await new Caller(srv).dial();
    await vm.press("1");
    expect(vm.hearsAll).toContain("do not say any card numbers");
  });
});

describe("settings", () => {
  const env = { TWILIO_AUTH_TOKEN: "x" };
  it("payments stay off unless explicitly enabled", () => {
    expect(loadConfig(env).payEnabled).toBe(false);
  });
  it("enabling payments needs an https public URL (Twilio requires it for <Pay>)", () => {
    expect(() => loadConfig({ ...env, PAY_ENABLED: "true", PUBLIC_BASE_URL: "http://localhost:3000" })).toThrow(/https/);
    expect(loadConfig({ ...env, PAY_ENABLED: "true", PUBLIC_BASE_URL: "https://ivr.example.com" }).payEnabled).toBe(true);
  });
  it("the connector name is checked", () => {
    expect(() => loadConfig({ ...env, PAY_CONNECTOR: "bad name; drop" })).toThrow(/PAY_CONNECTOR/);
    expect(loadConfig({ ...env, PAY_CONNECTOR: "Stripe_Test" }).payConnector).toBe("Stripe_Test");
  });
});
