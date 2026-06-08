/**
 * Item 12: telephony latency test.
 *
 *   POST /api/telephony/latency-test
 *     body: { toNumber: string, probeText?: string }
 *
 * Initiates a Twilio call, times: (a) provider acceptance, (b) ring,
 * (c) answered, (d) call ended.  Returns per-phase millis plus a verdict.
 *
 * Designed for opportunistic verification — Twilio's REST API does NOT give us
 * sub-second SIP timing, so the latency here is "end-to-end perceived
 * latency" not protocol-level latency.  For SIP-grade timing the user would
 * need to hook into Twilio's "Voice Insights" advanced product.
 */

import { Router, Request, Response } from 'express';
import Twilio from 'twilio';
import { logger } from '../services/logger.service';

const router = Router();

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return Twilio(sid, token);
}

router.post('/latency-test', async (req: Request, res: Response) => {
  try {
    const { toNumber, probeText } = req.body || {};
    if (!toNumber || typeof toNumber !== 'string') {
      return res.status(400).json({ success: false, error: 'toNumber required (E.164)' });
    }
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
      return res.status(503).json({
        success: false,
        error: 'Twilio not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER env vars.',
      });
    }
    const client = getTwilioClient()!;
    const requestedAt = Date.now();
    const sayText = (probeText || 'STABLR latency probe. Please disconnect.').slice(0, 240);
    const call = await client.calls.create({
      from: process.env.TWILIO_PHONE_NUMBER!,
      to: toNumber,
      twiml: `<Response><Say>${sayText}</Say><Hangup/></Response>`,
      record: false,
      timeout: 20,
    });
    const queuedAt = Date.now();

    // Poll the call status a few times to capture answered + completed timestamps.
    const poll = async () => {
      const c = await client.calls(call.sid).fetch();
      return c;
    };
    let answeredAt: number | null = null;
    let completedAt: number | null = null;
    let lastStatus: string = call.status;
    const phasePolls: any[] = [];
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const c = await poll();
      lastStatus = c.status;
      phasePolls.push({ status: c.status, at: Date.now() - requestedAt });
      if (!answeredAt && c.status === 'in-progress') answeredAt = Date.now();
      if (c.status === 'completed' || c.status === 'busy' || c.status === 'no-answer' || c.status === 'failed' || c.status === 'canceled') {
        completedAt = Date.now();
        break;
      }
    }

    const apiSubmitMs = queuedAt - requestedAt;
    const ringToAnswerMs = answeredAt ? answeredAt - queuedAt : null;
    const totalCallMs = completedAt ? completedAt - requestedAt : null;

    res.json({
      success: true,
      callSid: call.sid,
      finalStatus: lastStatus,
      timings: {
        apiSubmitMs,
        ringToAnswerMs,
        totalCallMs,
      },
      verdict:
        ringToAnswerMs && ringToAnswerMs < 5000
          ? 'fast'
          : ringToAnswerMs && ringToAnswerMs < 12000
          ? 'acceptable'
          : ringToAnswerMs
          ? 'slow'
          : 'not_answered',
      polls: phasePolls,
      notes: [
        'These are perceived end-to-end timings via Twilio REST polling, not SIP-level metrics.',
        'For SIP/RTP-grade timing enable Twilio Voice Insights Advanced features.',
      ],
    });
  } catch (err: any) {
    logger.error(`[TelephonyLatency] error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
