import type { Router } from "express";
import { VoiceResponse, callInfo, redirect, send, type SvcDeps } from "./helpers.js";

/**
 * "To get a new quote, press 4." With the AI quote line switched on, the caller goes to it. Without it they hear the same
 * "coming soon" as before, so turning the AI off (or losing the model's key) never breaks the menu.
 */
export function mountQuote(r: Router, d: SvcDeps) {
  r.post("/quote", (req, res) => {
    const { back } = callInfo(req);
    const t = new VoiceResponse();
    if (d.aiEnabled) {
      redirect(t, "/ai/quote");
    } else {
      t.say("Quote service will be available soon. Returning to the main menu.");
      redirect(t, `/ivr/${back}`);
    }
    send(res, t);
  });
}
