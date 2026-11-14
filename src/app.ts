import express from "express";
import type { Config } from "./config.js";
import { twilioSignature } from "./middleware/twilioSignature.js";
import type { Flow } from "./flows/types.js";
import { buildHarborlineFlow } from "./flows/harborline.js";
import { validateFlow } from "./flows/validate.js";
import { MemoryStateStore, type StateStore } from "./engine/state.js";
import { failSafe, handleInput, renderNode, type VoiceResponseT } from "./engine/engine.js";
import { harborlineSchedule, isOpen, type Schedule } from "./services/businessHours.js";
import { SqliteRepo, type PolicyRepo } from "./services/policyRepo.js";
import { AttemptLimiter } from "./services/rateLimiter.js";
import { ConsoleSms, TwilioSms, type SmsSender } from "./services/sms.js";
import { serviceRouter } from "./svc/router.js";
import { log, maskPhone } from "./log.js";
import { SERVICE_NAMES } from "./flows/harborline.js";

export interface Deps {
  flow?: Flow;
  schedule?: Schedule;
  state?: StateStore;
  clock?: () => Date;
  repo?: PolicyRepo;
  limiter?: AttemptLimiter;
  sms?: SmsSender;
}

export function createApp(config: Config, deps: Deps = {}) {
  const flow = deps.flow ?? buildHarborlineFlow({ agentNumber: config.agentNumber });
  const schedule = deps.schedule ?? harborlineSchedule;
  const state = deps.state ?? new MemoryStateStore();
  const clock = deps.clock ?? (config.nowOverride ? () => config.nowOverride! : () => new Date());
  const repo = deps.repo ?? new SqliteRepo(config.dbPath ?? ":memory:");
  const limiter = deps.limiter ?? new AttemptLimiter(5, 30 * 60 * 1000, () => clock().getTime());
  const sms =
    deps.sms ??
    (config.twilioAccountSid && config.twilioFromNumber
      ? new TwilioSms(config.twilioAccountSid, config.authToken, config.twilioFromNumber)
      : new ConsoleSms());

  // Refuse to start with a broken flow: a dead end in production means a stranded caller.
  const problems = validateFlow(flow, SERVICE_NAMES);
  if (problems.length) throw new Error(`Invalid call flow:\n - ${problems.join("\n - ")}`);

  const app = express();
  const send = (res: express.Response, twiml: VoiceResponseT) => res.type("text/xml").send(twiml.toString());

  // Health check: unsigned on purpose (load balancers call it). Never put business logic here.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Twilio sends application/x-www-form-urlencoded. Parse it, then verify the signature.
  app.use(express.urlencoded({ extended: false }));
  app.use(twilioSignature(config.authToken, config.publicBaseUrl));

  // A new call arrives. Pick the entry point from the clock.
  app.post("/voice", (req, res) => {
    const callSid = req.body?.CallSid as string | undefined;
    const open = isOpen(clock(), schedule);
    log("info", "call_started", { callSid, from: maskPhone(req.body?.From), open }); // masked: no full numbers in logs
    send(res, renderNode(flow, open ? flow.start : flow.closedStart));
  });

  // Code-driven services: authentication, account read-backs, claim intake.
  app.use("/svc", serviceRouter({ repo, state, limiter, sms, clock, schedule, agentNumber: config.agentNumber }));

  // The caller is (re)entering a node, e.g. after a Redirect.
  app.post("/ivr/:nodeId", (req, res) => {
    send(res, renderNode(flow, req.params.nodeId));
  });

  // The caller pressed a key (or nothing) at a menu.
  app.post("/ivr/:nodeId/input", (req, res) => {
    const callSid = req.body?.CallSid as string;
    const digits = (req.body?.Digits as string | undefined) || undefined; // "" and missing both mean silence
    // Log the node and whether a key was pressed, never the digits themselves (later phases collect secrets).
    console.log(JSON.stringify({ level: "info", msg: "menu_input", callSid, node: req.params.nodeId, pressed: !!digits }));
    send(res, handleInput(flow, req.params.nodeId, digits, { callSid, state }));
  });

  // Last resort: a crash must never leave the caller in silence. Apologise (HTTP 200 so Twilio plays it) and end.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    send(res, failSafe(`unhandled_error:${err instanceof Error ? err.message : "unknown"}`));
  });

  return app;
}
