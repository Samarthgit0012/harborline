import twilio from "twilio";
import { log, maskPhone } from "../log.js";

/** Everything Twilio needs to place one call. */
export interface OutboundCallRequest {
  to: string;
  from: string;
  /** Twilio fetches the call's instructions from here once someone answers. */
  answerUrl: string;
  /** Twilio reports progress (answered, completed...) here. */
  statusUrl: string;
  /** Seconds to ring. The FCC and FTC texts require at least 15 seconds or four rings before giving up on an unanswered telemarketing call. */
  timeoutSec: number;
}

/** The one door to the phone network for outbound calls. Swapped for a fake in tests and in dry runs. */
export interface OutboundCaller {
  create(req: OutboundCallRequest): Promise<{ callSid: string }>;
}

/** Records what WOULD be dialled and rings nobody. The default, because a mistake here is a lawsuit. */
export class DryRunCaller implements OutboundCaller {
  readonly calls: OutboundCallRequest[] = [];
  private n = 0;
  async create(req: OutboundCallRequest) {
    this.calls.push(req);
    log("info", "dry_run_call", { to: maskPhone(req.to), from: maskPhone(req.from) });
    return { callSid: "CA" + (++this.n).toString(16).padStart(32, "0") };
  }
}

/** Places a real call with Twilio's REST API. Only used when OUTBOUND_MODE=live. */
export class TwilioCaller implements OutboundCaller {
  private client: ReturnType<typeof twilio>;
  constructor(accountSid: string, authToken: string) {
    this.client = twilio(accountSid, authToken);
  }
  async create(req: OutboundCallRequest) {
    const call = await this.client.calls.create({
      to: req.to,
      from: req.from,
      url: req.answerUrl,
      method: "POST",
      statusCallback: req.statusUrl,
      statusCallbackEvent: ["answered", "completed"],
      statusCallbackMethod: "POST",
      // Twilio's docs: "Enable" returns AnsweredBy as soon as it can tell human from machine. We only ever speak to humans.
      machineDetection: "Enable",
      timeout: req.timeoutSec,
    });
    return { callSid: call.sid };
  }
}
