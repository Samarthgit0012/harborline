import { Router } from "express";
import { mountAccount } from "./account.js";
import { mountAuth } from "./auth.js";
import { mountFnol } from "./fnol.js";
import { mountHandoff } from "./handoff.js";
import { mountPay } from "./pay.js";
import { mountOptOut } from "./optout.js";
import { mountQuote } from "./quote.js";
import type { SvcDeps } from "./helpers.js";

/** Code-driven services, mounted at /svc (behind the same signature check as everything else). */
export function serviceRouter(deps: SvcDeps): Router {
  const r = Router();
  mountAuth(r, deps);
  mountAccount(r, deps);
  mountFnol(r, deps);
  mountHandoff(r, deps);
  mountPay(r, deps);
  mountOptOut(r, deps);
  mountQuote(r, deps);
  return r;
}
