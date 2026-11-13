import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import twilio from "twilio";
import { createApp } from "../src/app.js";

const config = { authToken: "test_token_123", publicBaseUrl: "https://ivr.example.com", port: 0 };
let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp(config).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const params = { CallSid: "CA123", From: "+15555550100", To: "+15555550199" };
const post = (headers: Record<string, string>, body = params) =>
  fetch(`${base}/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
const sign = (p: Record<string, string>, url = `${config.publicBaseUrl}/voice`) =>
  twilio.getExpectedTwilioSignature(config.authToken, url, p);

describe("webhook signature validation", () => {
  it("accepts a correctly signed request and returns TwiML", async () => {
    const res = await post({ "X-Twilio-Signature": sign(params) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(await res.text()).toContain("<Say>");
  });

  it("rejects a request with no signature", async () => {
    expect((await post({})).status).toBe(403);
  });

  it("rejects a forged signature", async () => {
    expect((await post({ "X-Twilio-Signature": "Zm9yZ2Vk" })).status).toBe(403);
  });

  it("rejects when the body was tampered with after signing", async () => {
    const res = await post({ "X-Twilio-Signature": sign(params) }, { ...params, From: "+19999999999" });
    expect(res.status).toBe(403);
  });

  it("rejects a signature made for a different URL (the proxy trap)", async () => {
    const res = await post({ "X-Twilio-Signature": sign(params, "http://wrong-host.example/voice") });
    expect(res.status).toBe(403);
  });

  it("leaves /health open for load balancers", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
