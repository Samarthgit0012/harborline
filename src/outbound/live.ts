import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { DryRunCaller, TwilioCaller, type OutboundCaller } from "./caller.js";

/**
 * Which "phone" a campaign run uses, decided ONLY by OUTBOUND_MODE:
 *   off      -> refuses (nothing runs)
 *   dry-run  -> a fake that records what would be dialled and rings nobody
 *   live     -> Twilio's real REST API (needs an account SID and auth token)
 * There is no flag that overrides this. To place real calls you must change the setting, restart, and mean it.
 */
export function pickCaller(config: Pick<Config, "outboundMode" | "twilioAccountSid" | "authToken">): OutboundCaller {
  switch (config.outboundMode ?? "off") {
    case "off":
      throw new Error("OUTBOUND_MODE is off. Set it to dry-run to see decisions, or live to place real calls.");
    case "dry-run":
      return new DryRunCaller();
    case "live":
      if (!config.twilioAccountSid) throw new Error("live mode needs TWILIO_ACCOUNT_SID");
      return new TwilioCaller(config.twilioAccountSid, config.authToken);
  }
}

/**
 * A fingerprint of the exact consent wording a person saw. Store the wording itself in your records under this
 * hash; later you can prove WHAT someone agreed to. Any change to a single character changes the hash.
 */
export function disclosureHash(text: string): string {
  return createHash("sha256").update(text.normalize("NFC").trim()).digest("hex");
}
