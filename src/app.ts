import express from "express";
import twilio from "twilio";
import type { Config } from "./config.js";
import { twilioSignature } from "./middleware/twilioSignature.js";

const { VoiceResponse } = twilio.twiml;

export function createApp(config: Config) {
  const app = express();

  // Health check: unsigned on purpose (load balancers call it). Never put business logic here.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Twilio sends application/x-www-form-urlencoded. Parse it, then verify the signature.
  app.use(express.urlencoded({ extended: false }));
  app.use(twilioSignature(config.authToken, config.publicBaseUrl));

  app.post("/voice", (req, res) => {
    const callSid = req.body.CallSid as string | undefined;
    // Structured log with CallSid: the habit that makes production calls traceable.
    console.log(JSON.stringify({ level: "info", msg: "call_started", callSid, from: req.body.From }));

    const twiml = new VoiceResponse();
    twiml.say("Welcome to Harborline Insurance. The system is under construction. Goodbye.");
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
  });

  return app;
}
