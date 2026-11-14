import twilio from "twilio";
import { log, maskPhone } from "../log.js";

export interface SmsSender {
  send(to: string, body: string): Promise<void>;
}

/** Development stand-in: sends nothing, so practising costs no money and texts no one. */
export class ConsoleSms implements SmsSender {
  async send(to: string, _body: string): Promise<void> {
    log("info", "sms_skipped_dev", { to: maskPhone(to) });
  }
}

/** Real SMS through the Twilio REST API. */
export class TwilioSms implements SmsSender {
  private client: ReturnType<typeof twilio>;
  constructor(accountSid: string, authToken: string, private from: string) {
    this.client = twilio(accountSid, authToken);
  }
  async send(to: string, body: string): Promise<void> {
    await this.client.messages.create({ to, from: this.from, body });
    log("info", "sms_sent", { to: maskPhone(to) });
  }
}
