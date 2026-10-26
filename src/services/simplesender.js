// ---------------------------------------------------------------------------
// SMS provider - SimpleSender REST API. The platform has ONE shared sending
// number (unlike the old per-event Twilio numbers); customers reach a
// specific event by texting that event's keyword (see sms_keyword on events,
// handled in routes/sms-ivr.js).
//
// Mock mode (logged only, nothing actually sent) until SMS_API_BASE /
// SMS_API_KEY are set in the deploy environment.
//
// SimpleSender takes a bare `to` and a `message` field (no `from` - the
// account has a single dedicated sending number) and treats a 2xx response
// as a successful hand-off, not a delivery guarantee. Base URL + key:
// Developer > Docs & Keys in the SimpleSender dashboard.
//
// Unlike Twilio's TwiML webhooks, SimpleSender's inbound webhook is just a
// notification - there's no way to return reply content as the HTTP
// response. Every reply (including the ticket-buying conversation) is sent
// explicitly via sendSmsChecked().
// ---------------------------------------------------------------------------
import { v4 as uuid } from 'uuid';
import db from '../db.js';

const CONFIG = {
  apiBase: process.env.SMS_API_BASE || '',
  apiKey: process.env.SMS_API_KEY || '',
};

export function isSmsMockMode() {
  return !CONFIG.apiBase || !CONFIG.apiKey;
}

// Sends one SMS and logs every attempt to sms_messages, mock or real,
// success or failure - that log is what backs any future SMS activity view.
// meta: { eventId, accountId }
export async function sendSmsChecked(to, body, meta = {}) {
  let status = 'sent', error = null;
  if (isSmsMockMode()) {
    status = 'mock';
    error = 'SMS provider not configured (SMS_API_BASE/SMS_API_KEY missing). No message was actually sent.';
    console.log(`[sms:MOCK] To: ${to}\n${body}`);
  } else {
    try {
      const res = await fetch(`${CONFIG.apiBase}/v1/messages/send`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CONFIG.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: String(to).replace(/\D/g, ''), message: body }),
      });
      const resBody = await res.json().catch(() => ({}));
      // A 2xx response is treated as success by default - only an explicit
      // failure signal in the body (or a non-2xx status) counts as a real
      // failure, since the provider's exact success wording isn't confirmed.
      if (!res.ok || resBody?.status === 'failed' || resBody?.success === false || resBody?.error) {
        status = 'failed'; error = resBody?.error || resBody?.message || `SMS send failed (${res.status})`;
      }
    } catch (e) {
      status = 'failed'; error = e.message;
    }
  }
  try {
    db.prepare(`INSERT INTO sms_messages (id, event_id, account_id, direction, phone, body, status, error_message)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(uuid(), meta.eventId || null, meta.accountId || null, 'outbound', to, body, status, error);
  } catch (e) { console.error('[sms] failed to log sent message:', e.message); }
  return { ok: status === 'sent' || status === 'mock', error };
}

// Logs an inbound message (called from the public webhook route).
export function logInboundSms(from, body, meta = {}) {
  try {
    db.prepare(`INSERT INTO sms_messages (id, event_id, account_id, direction, phone, body, status)
      VALUES (?,?,?,'inbound',?,?,'received')`)
      .run(uuid(), meta.eventId || null, meta.accountId || null, from, body);
  } catch (e) { console.error('[sms] failed to log inbound message:', e.message); }
}
