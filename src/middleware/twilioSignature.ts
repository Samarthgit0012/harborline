import type { RequestHandler } from "express";
import twilio from "twilio";

/**
 * Rejects any request that Twilio did not sign.
 *
 * Design choice: the URL we verify against is built from PUBLIC_BASE_URL (config), NOT from the
 * Host / X-Forwarded-* headers. Twilio signs the exact URL it called, and proxies often rewrite
 * scheme/host, so rebuilding it from headers is the classic cause of "403 only in production".
 */
export function twilioSignature(authToken: string, publicBaseUrl: string): RequestHandler {
  return (req, res, next) => {
    const signature = req.get("X-Twilio-Signature");
    if (!signature) {
      res.status(403).type("text/plain").send("Missing signature");
      return;
    }
    const url = `${publicBaseUrl}${req.originalUrl}`; // includes the query string, if any
    const ok = twilio.validateRequest(authToken, signature, url, req.body ?? {});
    if (!ok) {
      // Log WHY (without secrets) so a production 403 is debuggable.
      console.warn(JSON.stringify({ level: "warn", msg: "signature_mismatch", url }));
      res.status(403).type("text/plain").send("Invalid signature");
      return;
    }
    next();
  };
}
