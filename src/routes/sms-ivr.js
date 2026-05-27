/**
 * SMS & IVR Ticket Purchasing — Platform Stripe Only
 * PCI: Card digits never stored. Twilio → RAM → Stripe API → gone.
 * MOTO flag required on platform Stripe (get gated via Stripe support).
 */
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import Stripe from 'stripe';
import twilio from 'twilio';
import db from '../db.js';
import { sendMail, ticketEmail } from '../services/mail.js';
import { generateTicketPDF } from '../services/ticketPDF.js';
import { generateStaffTicketPDF } from '../services/staffTicketPDF.js';

const r = Router();
const SESSION_TTL = 15; // minutes
const MAX_QTY = 10;

// ── Platform Stripe ───────────────────────────────────────
function getPlatformStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Platform Stripe not configured');
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

// ── Settings helper ───────────────────────────────────────
function g(key, fallback = '') {
  const row = db.prepare('SELECT value FROM platform_settings WHERE key=?').get(key);
  return row?.value ?? fallback;
}

// ── Message template engine ───────────────────────────────
function tmpl(key, vars = {}) {
  let msg = g(key, key);
  for (const [k, v] of Object.entries(vars)) msg = msg.replace(new RegExp(`{{${k}}}`, 'g'), v ?? '');
  return msg;
}

// ── Route SMS/call to correct event by phone number ──────
// Each event has its own Twilio number — callers/texters land on that specific event
function getEventByNumber(toNumber) {
  return db.prepare(`
    SELECT e.*, a.email as owner_email, a.name as owner_name, a.id as account_id_val
    FROM events e
    JOIN accounts a ON a.id = e.account_id
    WHERE e.phone_number=? AND e.sms_ivr_enabled=1 AND e.deleted_at IS NULL AND e.closed_at IS NULL
  `).get(toNumber);
}

// ── Session management ────────────────────────────────────
function getSession(phone) {
  const s = db.prepare('SELECT * FROM sms_sessions WHERE phone=?').get(phone);
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) { db.prepare('DELETE FROM sms_sessions WHERE phone=?').run(phone); return null; }
  return { ...s, data: JSON.parse(s.data || '{}') };
}

function setSession(phone, step, data = {}, eventSlug = null, accountId = null) {
  const expires = new Date(Date.now() + SESSION_TTL * 60000).toISOString();
  db.prepare(`INSERT OR REPLACE INTO sms_sessions (phone,account_id,event_slug,step,data,expires_at,updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'))`)
    .run(phone, accountId, eventSlug, step, JSON.stringify(data), expires);
}

function clearSession(phone) { db.prepare('DELETE FROM sms_sessions WHERE phone=?').run(phone); }

// ── MOTO charge ───────────────────────────────────────────
async function chargeMOTO({ cardNumber, expMonth, expYear, cvc, amountCents, description, email, orderId }) {
  const stripe = getPlatformStripe();
  const pm = await stripe.paymentMethods.create({ type:'card', card:{ number:cardNumber, exp_month:expMonth, exp_year:expYear, cvc } });
  const pi = await stripe.paymentIntents.create({
    amount: amountCents, currency: g('currency','usd'),
    payment_method: pm.id,
    payment_method_options: { card: { moto: true } },
    confirm: true,
    description, receipt_email: email||undefined,
    metadata: { order_id: orderId, channel: 'sms_ivr' },
    error_on_requires_action: true,
  });
  // Immediately null card data — never returned or stored
  cardNumber = null; cvc = null;
  return pi;
}

// ── Ticket fulfillment ────────────────────────────────────
async function fulfillOrder(orderId, piId) {
  const order = db.prepare('SELECT * FROM phone_orders WHERE id=?').get(orderId);
  if (!order) return [];
  const event   = db.prepare('SELECT * FROM events WHERE id=?').get(order.event_id);
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(order.account_id);
  const tid = () => 'TKT-' + Math.random().toString(36).substr(2,8).toUpperCase();
  const ticketIds = [];

  for (let i = 0; i < order.quantity; i++) {
    const aId = uuid(), ticketId = tid();
    const nameParts = (order.attendee_name||'Guest').split(' ');
    db.prepare(`INSERT INTO attendees (id,event_id,account_id,first_name,last_name,email,ticket_id,status,confirmed,level_id,source)
      VALUES (?,?,?,?,?,?,?,'sent',1,?,'online')`)
      .run(aId, order.event_id, order.account_id, nameParts[0], nameParts.slice(1).join(' ')||'', order.attendee_email||null, ticketId, order.level_id||null);
    ticketIds.push(ticketId);
  }

  db.prepare("UPDATE phone_orders SET status='paid',ticket_ids=?,stripe_payment_intent_id=? WHERE id=?")
    .run(JSON.stringify(ticketIds), piId, orderId);

  if (order.attendee_email) {
    try {
      const attachments = [];
      for (const ticketId of ticketIds) {
        const att = db.prepare('SELECT att.*, l.name as level_name, l.color as level_color, l.is_staff FROM attendees att LEFT JOIN ticket_levels l ON l.id=att.level_id WHERE att.ticket_id=?').get(ticketId);
        const pdf = att?.is_staff
          ? await generateStaffTicketPDF({ attendee: att, event, eventDesignPath: null })
          : await generateTicketPDF({ attendee: att, event, eventDesignPath: null });
        attachments.push({ filename: `ticket-${ticketId}.pdf`, content: pdf, contentType: 'application/pdf' });
      }
      const mainAtt = db.prepare('SELECT att.*, l.name as level_name FROM attendees att LEFT JOIN ticket_levels l ON l.id=att.level_id WHERE att.ticket_id=?').get(ticketIds[0]);
      await sendMail({
        to: order.attendee_email,
        subject: `Your ticket(s) for ${event.name}`,
        html: ticketEmail({ attendee: mainAtt, event }),
        attachments,
        replyTo: account?.reply_to || account?.email
      });
    } catch(e) { console.error('[phone/email]', e.message); }
  }
  return ticketIds;
}

// ── TwiML helpers ─────────────────────────────────────────
function twimlMsg(msg) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`;
}

function twimlSay(key, vars = {}, hangup = false, redirect = null) {
  const recording = g(key + '_recording', '');
  const voice     = g('ivr.tts_voice', 'Polly.Joanna');
  const text      = tmpl(key, vars);
  const audio     = recording
    ? `<Play>${recording}</Play>`
    : `<Say voice="${voice}">${text}</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${audio}
  ${hangup ? '<Hangup/>' : redirect ? `<Redirect>${redirect}</Redirect>` : ''}
</Response>`;
}

function twimlGather({ textKey, vars = {}, action, numDigits, timeout = 10, finishOnKey = '#' }) {
  const recording = g(textKey + '_recording', '');
  const voice     = g('ivr.tts_voice', 'Polly.Joanna');
  const text      = tmpl(textKey, vars);
  const audio     = recording ? `<Play>${recording}</Play>` : `<Say voice="${voice}">${text}</Say>`;
  const APP_URL   = process.env.APP_URL || '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="${APP_URL}${action}" method="POST" ${numDigits?`numDigits="${numDigits}"`:`finishOnKey="${finishOnKey}"`} timeout="${timeout}" input="dtmf">
    ${audio}
  </Gather>
  ${audio}
  <Redirect>${APP_URL}${action}</Redirect>
</Response>`;
}

// ── SMS Inbound ───────────────────────────────────────────
r.post('/sms/inbound', async (req, res) => {
  const from    = req.body.From || '';
  const to      = req.body.To   || '';   // which Twilio number received it
  const body    = (req.body.Body || '').trim();
  const upper   = body.toUpperCase();

  if (g('sms.enabled') !== '1') return res.type('text/xml').send(twimlMsg('SMS ordering is not available.'));

  // Route to event by the number they texted
  const linkedEvent = getEventByNumber(to);

  // Global commands
  if (upper === 'HELP' || upper === 'HELP?') { return res.type('text/xml').send(twimlMsg(tmpl('sms.help'))); }
  if (['STOP','CANCEL','QUIT','END'].includes(upper)) {
    clearSession(from);
    return res.type('text/xml').send(twimlMsg(tmpl('sms.cancelled')));
  }

  const session = getSession(from);
  const step    = session?.step || 'welcome';

  try {
    const reply = await smsStep(from, body, upper, session, linkedEvent);
    res.type('text/xml').send(twimlMsg(reply));
  } catch(e) {
    console.error('[SMS]', e.message);
    clearSession(from);
    res.type('text/xml').send(twimlMsg(tmpl('sms.error')));
  }
});

async function smsStep(from, body, upper, session, linkedEvent) {
  const step = session?.step || 'welcome';
  const data = session?.data || {};

  // ── No session: use the linked event directly ────────────
  if (!session || step === 'welcome') {
    const event = linkedEvent;
    if (!event) return tmpl('sms.invalid_code');
    const levels = db.prepare("SELECT * FROM ticket_levels WHERE event_id=? AND online_sale=1 AND is_staff=0 AND price>0").all(event.id);
    if (!levels.length) return tmpl('sms.no_levels');
    const levelList = levels.map((l,i)=>`${i+1}. ${l.name} — $${(l.price/100).toFixed(2)}`).join('\n');
    setSession(from, 'select_level', { eventId:event.id, levels:levels.map(l=>({id:l.id,name:l.name,price:l.price})) }, event.slug, event.account_id);
    return tmpl('sms.select_level', { event_name:event.name, event_date:event.date||'', levels:levelList });
  }

  // ── Select level ──────────────────────────────────────────
  if (step === 'select_level') {
    const idx = parseInt(body) - 1;
    if (isNaN(idx) || idx < 0 || idx >= (data.levels||[]).length) return `Please reply with a number between 1 and ${(data.levels||[]).length}.`;
    const lvl = data.levels[idx];
    setSession(from, 'select_quantity', { ...data, levelId:lvl.id, levelName:lvl.name, levelPrice:lvl.price }, session.event_slug, session.account_id);
    return tmpl('sms.select_quantity', { level_name:lvl.name, price:(lvl.price/100).toFixed(2) });
  }

  // ── Select quantity ───────────────────────────────────────
  if (step === 'select_quantity') {
    const qty = parseInt(body);
    if (isNaN(qty) || qty < 1 || qty > MAX_QTY) return `Please enter a number between 1 and ${MAX_QTY}.`;
    const total = data.levelPrice * qty;
    setSession(from, 'get_name', { ...data, quantity:qty, totalCents:total }, session.event_slug, session.account_id);
    return tmpl('sms.get_name', { quantity:qty, level_name:data.levelName, total:(total/100).toFixed(2) });
  }

  // ── Get name ──────────────────────────────────────────────
  if (step === 'get_name') {
    if (body.trim().split(/\s+/).length < 2) return 'Please enter your full name (first and last).';
    setSession(from, 'get_email', { ...data, name:body.trim() }, session.event_slug, session.account_id);
    return tmpl('sms.get_email', { first_name:body.trim().split(' ')[0] });
  }

  // ── Get email ─────────────────────────────────────────────
  if (step === 'get_email') {
    if (!body.includes('@') || !body.includes('.')) return 'Please enter a valid email address.';
    setSession(from, 'confirm', { ...data, email:body.trim() }, session.event_slug, session.account_id);
    return tmpl('sms.confirm', { quantity:data.quantity, level_name:data.levelName, total:(data.totalCents/100).toFixed(2), email:body.trim() });
  }

  // ── Confirm (YES/NO) ──────────────────────────────────────
  if (step === 'confirm') {
    if (upper !== 'YES' && upper !== 'Y') {
      clearSession(from);
      return tmpl('sms.cancelled');
    }
    setSession(from, 'get_card', data, session.event_slug, session.account_id);
    return tmpl('sms.get_card');
  }

  // ── Get card number ───────────────────────────────────────
  if (step === 'get_card') {
    const digits = body.replace(/\D/g,'');
    if (digits.length < 13 || digits.length > 19) return 'Please enter your card number (digits only, no spaces). Or text CANCEL.';
    setSession(from, 'get_expiry', { ...data, cardNumber:digits, last4:digits.slice(-4) }, session.event_slug, session.account_id);
    return tmpl('sms.get_expiry', { last4:digits.slice(-4) });
  }

  // ── Get expiry ────────────────────────────────────────────
  if (step === 'get_expiry') {
    const d = body.replace(/\D/g,'');
    if (d.length !== 4) return 'Please enter expiry as MMYY (4 digits, e.g. 1228).';
    const em = parseInt(d.slice(0,2)), ey = parseInt('20'+d.slice(2));
    if (em < 1 || em > 12) return 'Invalid month. Please enter MMYY.';
    setSession(from, 'get_cvv', { ...data, expMonth:em, expYear:ey }, session.event_slug, session.account_id);
    return tmpl('sms.get_cvv');
  }

  // ── Get CVV → charge ──────────────────────────────────────
  if (step === 'get_cvv') {
    const cvv = body.replace(/\D/g,'');
    if (cvv.length < 3 || cvv.length > 4) return 'Please enter the 3 or 4 digit security code from your card.';

    const cardNumber = data.cardNumber;
    const event = db.prepare('SELECT * FROM events WHERE id=?').get(data.eventId);
    if (!event) { clearSession(from); return tmpl('sms.error'); }

    const orderId = uuid();
    db.prepare(`INSERT INTO phone_orders (id,event_id,account_id,channel,from_number,attendee_name,attendee_email,level_id,quantity,amount_cents,status)
      VALUES (?,?,?,'sms',?,?,?,?,?,?,'pending')`)
      .run(orderId, event.id, event.account_id, from, data.name, data.email||null, data.levelId||null, data.quantity, data.totalCents);

    // Charge — card data only in this scope
    let pi;
    try {
      pi = await chargeMOTO({ cardNumber, expMonth:data.expMonth, expYear:data.expYear, cvc:cvv, amountCents:data.totalCents, description:`${event.name} — ${data.quantity}× ${data.levelName} — ${data.name}`, email:data.email, orderId });
    } catch(e) {
      db.prepare("UPDATE phone_orders SET status='failed',error_message=? WHERE id=?").run(e.message, orderId);
      clearSession(from);
      return tmpl('sms.declined');
    } finally { /* cardNumber and cvv go out of scope */ }

    await fulfillOrder(orderId, pi.id);
    clearSession(from);
    return tmpl('sms.success', { total:(data.totalCents/100).toFixed(2), quantity:data.quantity, event_name:event.name, email:data.email||'' });
  }

  clearSession(from);
  return tmpl('sms.session_expired');
}

// ── IVR Inbound ───────────────────────────────────────────
const AU = () => process.env.APP_URL || '';

r.post('/ivr/inbound', async (req, res) => {
  if (g('ivr.enabled') !== '1') return res.type('text/xml').send(twimlSay('ivr.no_available',{},true));
  clearSession('ivr:'+req.body.From); // fresh session on new call
  res.type('text/xml').send(twimlGather({ textKey:'ivr.welcome', action:'/api/phone/ivr/menu', numDigits:1 }));
});

r.post('/ivr/menu', async (req, res) => {
  const from = req.body.From||'', to = req.body.To||'', d = req.body.Digits||'';
  if (d === '9' || !d) return res.type('text/xml').send(twimlGather({ textKey:'ivr.welcome', action:'/api/phone/ivr/menu', numDigits:1 }));
  if (d !== '1')       return res.type('text/xml').send(twimlGather({ textKey:'ivr.welcome', action:'/api/phone/ivr/menu', numDigits:1 }));

  // Route directly to the event tied to this phone number
  const linkedEvent = getEventByNumber(to);
  if (!linkedEvent) return res.type('text/xml').send(twimlSay('ivr.no_available',{},true));
  setSession('ivr:'+from, 'select_level', { eventId:linkedEvent.id }, linkedEvent.slug, linkedEvent.account_id);
  return res.type('text/xml').send(await ivrLevelMenu(from, linkedEvent.id));
});

r.post('/ivr/event', async (req, res) => {
  const from = req.body.From||'', d = req.body.Digits||'';
  const session = getSession('ivr:'+from);
  if (!session) return res.type('text/xml').send(twimlSay('ivr.error',{},true));
  if (d==='0') { clearSession('ivr:'+from); return res.type('text/xml').send(twimlGather({ textKey:'ivr.welcome', action:'/api/phone/ivr/menu', numDigits:1 })); }
  const events = session.data.events||[];
  const idx = parseInt(d)-1;
  if (isNaN(idx)||idx<0||idx>=events.length) return res.type('text/xml').send(twimlGather({ textKey:'ivr.select_event', vars:{event_list:events.map((e,i)=>`Press ${i+1} for ${e.name}.`).join(' ')}, action:'/api/phone/ivr/event', numDigits:1 }));
  setSession('ivr:'+from, 'select_level', { eventId:events[idx].id }, null, session.account_id);
  return res.type('text/xml').send(await ivrLevelMenu(from, events[idx].id));
});

async function ivrLevelMenu(from, eventId) {
  const event  = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  const levels = db.prepare("SELECT * FROM ticket_levels WHERE event_id=? AND online_sale=1 AND is_staff=0 AND price>0").all(eventId);
  if (!levels.length) return twimlSay('ivr.no_available',{},true);
  const levelList = levels.map((l,i)=>`Press ${i+1} for ${l.name} at ${(l.price/100).toFixed(0)} dollars.`).join(' ');
  const session = getSession('ivr:'+from);
  setSession('ivr:'+from, 'select_level', { eventId, levels:levels.map(l=>({id:l.id,name:l.name,price:l.price})) }, null, session?.account_id);
  return twimlGather({ textKey:'ivr.select_level', vars:{ event_name:event?.name||'', level_list:levelList+' Press 0 to go back.' }, action:'/api/phone/ivr/level', numDigits:1 });
}

r.post('/ivr/level', async (req, res) => {
  const from = req.body.From||'', d = req.body.Digits||'';
  const session = getSession('ivr:'+from);
  if (!session) return res.type('text/xml').send(twimlSay('ivr.error',{},true));
  if (d==='0') return res.type('text/xml').send(twimlGather({ textKey:'ivr.welcome', action:'/api/phone/ivr/menu', numDigits:1 }));
  const levels = session.data.levels||[];
  const idx = parseInt(d)-1;
  if (isNaN(idx)||idx<0||idx>=levels.length) return res.type('text/xml').send(await ivrLevelMenu(from, session.data.eventId));
  const lvl = levels[idx];
  setSession('ivr:'+from, 'select_quantity', { ...session.data, levelId:lvl.id, levelName:lvl.name, levelPrice:lvl.price }, session.event_slug, session.account_id);
  return res.type('text/xml').send(twimlGather({ textKey:'ivr.select_quantity', vars:{ level_name:lvl.name, price:(lvl.price/100).toFixed(0) }, action:'/api/phone/ivr/quantity', numDigits:2 }));
});

r.post('/ivr/quantity', async (req, res) => {
  const from = req.body.From||'', d = req.body.Digits||'';
  const session = getSession('ivr:'+from);
  if (!session) return res.type('text/xml').send(twimlSay('ivr.error',{},true));
  const qty = parseInt(d);
  if (isNaN(qty)||qty<1||qty>MAX_QTY) return res.type('text/xml').send(twimlGather({ textKey:'ivr.select_quantity', vars:{ level_name:session.data.levelName, price:(session.data.levelPrice/100).toFixed(0) }, action:'/api/phone/ivr/quantity', numDigits:2 }));
  const total = session.data.levelPrice * qty;
  setSession('ivr:'+from, 'confirm', { ...session.data, quantity:qty, totalCents:total }, session.event_slug, session.account_id);
  return res.type('text/xml').send(twimlGather({ textKey:'ivr.confirm', vars:{ quantity:qty, total:(total/100).toFixed(2) }, action:'/api/phone/ivr/confirm', numDigits:1 }));
});

r.post('/ivr/confirm', async (req, res) => {
  const from = req.body.From||'', d = req.body.Digits||'';
  const session = getSession('ivr:'+from);
  if (!session) return res.type('text/xml').send(twimlSay('ivr.error',{},true));
  if (d === '2') { clearSession('ivr:'+from); return res.type('text/xml').send(twimlSay('ivr.no_available',{quantity:0,total:0},true)); } // cancelled
  if (d !== '1') return res.type('text/xml').send(twimlGather({ textKey:'ivr.confirm', vars:{ quantity:session.data.quantity, total:(session.data.totalCents/100).toFixed(2) }, action:'/api/phone/ivr/confirm', numDigits:1 }));
  setSession('ivr:'+from, 'get_card', session.data, session.event_slug, session.account_id);
  return res.type('text/xml').send(twimlGather({ textKey:'ivr.get_card', action:'/api/phone/ivr/card', timeout:30 }));
});

r.post('/ivr/card', async (req, res) => {
  const from = req.body.From||'', d = (req.body.Digits||'').replace(/\D/g,'');
  const session = getSession('ivr:'+from);
  if (!session) return res.type('text/xml').send(twimlSay('ivr.error',{},true));
  if (d.length<13||d.length>19) return res.type('text/xml').send(twimlGather({ textKey:'ivr.get_card', action:'/api/phone/ivr/card', timeout:30 }));
  setSession('ivr:'+from, 'get_expiry', { ...session.data, cardNumber:d, last4:d.slice(-4) }, session.event_slug, session.account_id);
  return res.type('text/xml').send(twimlGather({ textKey:'ivr.get_expiry', vars:{ last4:d.slice(-4) }, action:'/api/phone/ivr/expiry', timeout:20, numDigits:4 }));
});

r.post('/ivr/expiry', async (req, res) => {
  const from = req.body.From||'', d = (req.body.Digits||'').replace(/\D/g,'');
  const session = getSession('ivr:'+from);
  if (!session) return res.type('text/xml').send(twimlSay('ivr.error',{},true));
  if (d.length!==4) return res.type('text/xml').send(twimlGather({ textKey:'ivr.get_expiry', vars:{ last4:session.data.last4 }, action:'/api/phone/ivr/expiry', timeout:20, numDigits:4 }));
  const em = parseInt(d.slice(0,2)), ey = parseInt('20'+d.slice(2));
  if (em<1||em>12) return res.type('text/xml').send(twimlGather({ textKey:'ivr.get_expiry', vars:{ last4:session.data.last4 }, action:'/api/phone/ivr/expiry', timeout:20, numDigits:4 }));
  setSession('ivr:'+from, 'get_cvv', { ...session.data, expMonth:em, expYear:ey }, session.event_slug, session.account_id);
  return res.type('text/xml').send(twimlGather({ textKey:'ivr.get_cvv', action:'/api/phone/ivr/cvv', timeout:20, numDigits:4 }));
});

r.post('/ivr/cvv', async (req, res) => {
  const from = req.body.From||'', cvv = (req.body.Digits||'').replace(/\D/g,'');
  const session = getSession('ivr:'+from);
  if (!session) return res.type('text/xml').send(twimlSay('ivr.error',{},true));
  if (cvv.length<3||cvv.length>4) return res.type('text/xml').send(twimlGather({ textKey:'ivr.get_cvv', action:'/api/phone/ivr/cvv', timeout:20, numDigits:4 }));

  const data = session.data;
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(data.eventId);
  if (!event) { clearSession('ivr:'+from); return res.type('text/xml').send(twimlSay('ivr.error',{},true)); }

  // Send processing message immediately, then charge async
  res.type('text/xml').send(twimlSay('ivr.processing',{},false,null));

  const orderId = uuid();
  db.prepare(`INSERT INTO phone_orders (id,event_id,account_id,channel,from_number,level_id,quantity,amount_cents,status)
    VALUES (?,?,?,'ivr',?,?,?,?,'pending')`)
    .run(orderId, event.id, event.account_id, from, data.levelId||null, data.quantity, data.totalCents);

  // Charge — card data goes out of scope immediately after
  setImmediate(async () => {
    try {
      const pi = await chargeMOTO({ cardNumber:data.cardNumber, expMonth:data.expMonth, expYear:data.expYear, cvc:cvv, amountCents:data.totalCents, description:`${event.name} — ${data.quantity}× IVR`, email:null, orderId });
      await fulfillOrder(orderId, pi.id);
    } catch(e) {
      db.prepare("UPDATE phone_orders SET status='failed',error_message=? WHERE id=?").run(e.message, orderId);
    }
    clearSession('ivr:'+from);
  });
});

// Toggle SMS/IVR on/off without cancelling the number
r.post('/event/:id/toggle-sms', (req, res) => {
  const { enabled } = req.body;
  const ev = db.prepare('SELECT phone_number FROM events WHERE id=?').get(req.params.id);
  if (!ev?.phone_number) return res.status(400).json({ error: 'No number assigned to this event.' });
  db.prepare('UPDATE events SET sms_ivr_enabled=? WHERE id=?').run(enabled ? 1 : 0, req.params.id);
  res.json({ ok: true, enabled: !!enabled });
});

r.post('/ivr/status', (_req, res) => res.sendStatus(204));

// ── Twilio number purchase/release/search (from portal) ──

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) throw new Error('Set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN in Render env vars.');
  return twilio(sid, tok);
}

// Search available numbers
r.get('/numbers/search', async (req, res) => {
  try {
    const client = getTwilioClient();
    const { areaCode, country='US', contains } = req.query;
    const params = { voiceEnabled:true, smsEnabled:true, limit:20 };
    if (areaCode) params.areaCode = areaCode;
    if (contains) params.contains = contains;
    const nums = await client.availablePhoneNumbers(country).local.list(params);
    res.json({ numbers: nums.map(n => ({
      phoneNumber: n.phoneNumber, friendlyName: n.friendlyName,
      locality: n.locality, region: n.region,
      capabilities: n.capabilities, monthly_cost: '$1.15'
    })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Buy a number — auto-sets webhooks and optionally assigns to event
r.post('/numbers/purchase', async (req, res) => {
  try {
    const { phoneNumber, eventId, expiresAt } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });
    const client = getTwilioClient();
    const appUrl = process.env.APP_URL || '';
    const p = await client.incomingPhoneNumbers.create({
      phoneNumber,
      smsUrl:    `${appUrl}/api/phone/sms/inbound`, smsMethod: 'POST',
      voiceUrl:  `${appUrl}/api/phone/ivr/inbound`, voiceMethod: 'POST',
    });
    try { db.exec("ALTER TABLE events ADD COLUMN twilio_sid TEXT"); } catch {}
    if (eventId) {
      db.prepare('UPDATE events SET phone_number=?,phone_number_expires=?,phone_number_notified=0,sms_ivr_enabled=1,twilio_sid=? WHERE id=?')
        .run(p.phoneNumber, expiresAt||null, p.sid, eventId);
    }
    res.json({ ok:true, phoneNumber:p.phoneNumber, sid:p.sid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Release a number back to Twilio
r.post('/numbers/release', async (req, res) => {
  try {
    const { eventId } = req.body;
    const ev = db.prepare('SELECT phone_number, twilio_sid FROM events WHERE id=?').get(eventId);
    if (!ev?.phone_number) return res.status(404).json({ error: 'No number on this event' });
    if (ev.twilio_sid) {
      await getTwilioClient().incomingPhoneNumbers(ev.twilio_sid).remove().catch(e => console.warn('[release]', e.message));
    }
    db.prepare('UPDATE events SET phone_number=NULL,phone_number_expires=NULL,sms_ivr_enabled=0,phone_number_notified=0,twilio_sid=NULL WHERE id=?').run(eventId);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// List all Twilio numbers you own
r.get('/numbers/owned', async (req, res) => {
  try {
    const client = getTwilioClient();
    const nums = await client.incomingPhoneNumbers.list({ limit:100 });
    const appUrl = process.env.APP_URL || '';
    const events = db.prepare('SELECT id,name,phone_number FROM events WHERE phone_number IS NOT NULL').all();
    const byNum = Object.fromEntries(events.map(e => [e.phone_number, e]));
    res.json({ numbers: nums.map(n => ({
      sid:n.sid, phoneNumber:n.phoneNumber, friendlyName:n.friendlyName,
      configured: !!(n.smsUrl?.includes(appUrl) && n.voiceUrl?.includes(appUrl)),
      assignedEvent: byNum[n.phoneNumber]||null,
    })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: manage event phone numbers ─────────────────────
// Manual assign (if number was bought outside the portal)
r.post('/event/:id/assign-number', (req, res) => {
  const { phoneNumber, expiresAt } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });
  db.prepare('UPDATE events SET phone_number=?,phone_number_expires=?,phone_number_notified=0,sms_ivr_enabled=1 WHERE id=?')
    .run(phoneNumber, expiresAt||null, req.params.id);
  res.json({ ok: true });
});

// ── Per-event phone number management ────────────────────

r.post('/event/:id/remove-number', (req, res) => {
  db.prepare('UPDATE events SET phone_number=NULL,phone_number_expires=NULL,sms_ivr_enabled=0,phone_number_notified=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

r.post('/event/:id/toggle-sms', (req, res) => {
  const { enabled } = req.body;
  const ev = db.prepare('SELECT phone_number FROM events WHERE id=?').get(req.params.id);
  if (!ev?.phone_number) return res.status(400).json({ error: 'No number assigned to this event.' });
  db.prepare('UPDATE events SET sms_ivr_enabled=? WHERE id=?').run(enabled ? 1 : 0, req.params.id);
  res.json({ ok: true, enabled: !!enabled });
});

// Manual trigger (also runs automatically every 6h via index.js)
r.post('/check-expiry', async (req, res) => {
  const now  = new Date().toISOString();
  const in24 = new Date(Date.now() + 24*60*60*1000).toISOString();

  const expired = db.prepare(`SELECT e.*, a.email as owner_email, a.name as owner_name FROM events e JOIN accounts a ON a.id=e.account_id WHERE e.phone_number IS NOT NULL AND e.phone_number_expires IS NOT NULL AND e.phone_number_expires < ?`).all(now);
  for (const ev of expired) {
    const num = ev.phone_number;
    db.prepare('UPDATE events SET phone_number=NULL,phone_number_expires=NULL,sms_ivr_enabled=0,phone_number_notified=0 WHERE id=?').run(ev.id);
    try { await sendMail({ to: ev.owner_email, subject: `Phone number for "${ev.name}" has expired`, html: `<p>Hi ${ev.owner_name},</p><p>The SMS/IVR number <strong>${num}</strong> for <strong>${ev.name}</strong> has expired and been automatically deactivated. Contact us to renew.</p>` }); } catch {}
  }

  const expiring = db.prepare(`SELECT e.*, a.email as owner_email, a.name as owner_name FROM events e JOIN accounts a ON a.id=e.account_id WHERE e.phone_number IS NOT NULL AND e.phone_number_expires IS NOT NULL AND e.phone_number_expires > ? AND e.phone_number_expires <= ? AND e.phone_number_notified=0`).all(now, in24);
  let notified = 0;
  for (const ev of expiring) {
    const expDate = new Date(ev.phone_number_expires).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    try {
      await sendMail({ to: ev.owner_email, subject: `Phone number for "${ev.name}" expires tomorrow`, html: `<p>Hi ${ev.owner_name},</p><p>The SMS/IVR number <strong>${ev.phone_number}</strong> for <strong>${ev.name}</strong> expires tomorrow (${expDate}) and will be automatically deactivated. Contact us to renew.</p>` });
      db.prepare('UPDATE events SET phone_number_notified=1 WHERE id=?').run(ev.id);
      notified++;
    } catch {}
  }
  res.json({ expired: expired.length, notified });
});

// ── Admin: phone orders log ───────────────────────────────
r.get('/orders', async (req, res) => {
  const orders = db.prepare(`SELECT po.*,e.name as event_name,l.name as level_name
    FROM phone_orders po
    LEFT JOIN events e ON e.id=po.event_id
    LEFT JOIN ticket_levels l ON l.id=po.level_id
    ORDER BY po.created_at DESC LIMIT 500`).all();
  res.json({ orders });
});

export default r;
