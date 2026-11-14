import { log, maskPhone } from "../log.js";
import { checkGate, type GateRules } from "./gate.js";
import type { OutboundCaller } from "./caller.js";
import { promotionalTerms } from "./promo.js";
import type { OutboundStore } from "./store.js";

export interface RunnerOptions {
  rules: GateRules;
  /** https base URL of THIS server, where Twilio will fetch the call's instructions. */
  publicBaseUrl: string;
  /** Calls being set up at once. */
  concurrency?: number;
  /** Calls started per second. Twilio's default account limit is 1 (it queues anything faster). */
  cps?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunSummary {
  considered: number;
  placed: number;
  failed: number;
  blocked: { phone: string; reason: string }[];
}

const RING_SECONDS = 20; // comfortably above the 15 seconds / four rings the FCC and FTC texts require

/**
 * One pass over a campaign: gate every contact, record the decision, then place the allowed calls with a
 * concurrency limit and a calls-per-second limit. In Phase 10 this sits behind a real job queue (BullMQ + Redis);
 * the logic stays the same, only who calls `run` changes.
 */
export class CampaignRunner {
  constructor(
    private store: OutboundStore,
    private caller: OutboundCaller,
    private opts: RunnerOptions,
    private clock: () => Date = () => new Date(),
  ) {}

  async run(campaignId: number): Promise<RunSummary> {
    const campaign = this.store.getCampaign(campaignId);
    if (!campaign) throw new Error(`no campaign ${campaignId}`);
    const contacts = this.store.contacts(campaignId);
    const summary: RunSummary = { considered: contacts.length, placed: 0, failed: 0, blocked: [] };
    const block = (phone: string, reason: string, detail?: string) => {
      summary.blocked.push({ phone, reason });
      this.store.logDecision(campaignId, phone, false, reason, detail ?? null, this.clock());
      log("info", "outbound_blocked", { campaignId, to: maskPhone(phone), reason, detail });
    };

    // A campaign called "informational" whose script reads like an offer is refused before any call is made.
    const promo = campaign.purpose === "informational" ? promotionalTerms(campaign.scriptText) : [];
    const queued: { attemptId: number; phone: string }[] = [];

    for (const c of contacts) {
      if (promo.length) {
        block(c.phone, "promotional_content_in_informational_campaign", promo.join(", "));
        continue;
      }
      const verdict = checkGate(this.store, campaign, c, this.clock(), this.opts.rules);
      if (!verdict.allowed) {
        block(c.phone, verdict.reason, verdict.detail);
        continue;
      }
      this.store.logDecision(campaignId, c.phone, true, null, verdict.detail ?? null, this.clock());
      queued.push({ attemptId: this.store.createAttempt(campaignId, c.phone, this.clock()).id, phone: c.phone });
    }

    // Dispatch with a worker pool (concurrency) and a start-rate limit (calls per second).
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const gap = 1000 / (this.opts.cps ?? 1);
    let first = true;
    let pace: Promise<void> = Promise.resolve();
    const nextSlot = () => {
      const turn = pace.then(async () => {
        if (!first) await sleep(gap);
        first = false;
      });
      pace = turn;
      return turn;
    };

    const base = this.opts.publicBaseUrl;
    const work = async (job: { attemptId: number; phone: string }) => {
      await nextSlot();
      // A stop request may have arrived while this call waited its turn. Check again at the last moment.
      if (this.store.isOnInternalDnc(job.phone)) {
        this.store.setAttempt(job.attemptId, "cancelled", "cancelled_by_opt_out", this.clock());
        block(job.phone, "on_internal_dnc", "asked to stop while queued");
        return;
      }
      try {
        const { callSid } = await this.caller.create({
          to: job.phone,
          from: this.opts.rules.from!,
          answerUrl: `${base}/outbound/${job.attemptId}/answer`,
          statusUrl: `${base}/outbound/${job.attemptId}/status`,
          timeoutSec: RING_SECONDS,
        });
        this.store.setCallSid(job.attemptId, callSid, this.clock());
        summary.placed++;
      } catch (err) {
        this.store.setAttempt(job.attemptId, "failed", "create_failed", this.clock());
        summary.failed++;
        log("error", "outbound_create_failed", { attemptId: job.attemptId, to: maskPhone(job.phone), error: (err as Error).message });
      }
    };

    const pool = Math.max(1, this.opts.concurrency ?? 2);
    const todo = [...queued];
    await Promise.all(Array.from({ length: Math.min(pool, todo.length) }, async () => {
      for (let job = todo.shift(); job; job = todo.shift()) await work(job);
    }));

    log("info", "campaign_run", { campaignId, considered: summary.considered, placed: summary.placed, blocked: summary.blocked.length, failed: summary.failed });
    return summary;
  }
}
