// Stripe Connect OAuth + platform billing (event creation fees)
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import Stripe from 'stripe';
import db from '../db.js';
import { auth } from '../middleware/auth.js';
import { notifyEventCreated } from '../services/mail.js';

const r = Router();

function getPlatformStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Platform Stripe key not configured');
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM platform_settings WHERE key=?').get(key);
  return row?.value ?? fallback;
}

// ── Stripe Connect OAuth ──────────────────────────────────

// Step 1: redirect to Stripe OAuth
r.get('/connect/start', auth, (req, res) => {
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Stripe Connect not configured. Set STRIPE_CONNECT_CLIENT_ID.' });
  const appUrl = process.env.APP_URL || 'https://tickets.everythingshul.com';
  const redirectUri = `${appUrl}/api/connect/callback`;
  const state = Buffer.from(JSON.stringify({ userId: req.user.id, ts: Date.now() })).toString('base64');
  const url = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=${clientId}&scope=read_write&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.json({ url });
});

// Step 2: OAuth callback — exchange code for tokens
r.get('/connect/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const appUrl = process.env.APP_URL || 'https://tickets.everythingshul.com';
  if (error) return res.redirect(`${appUrl}/profile.html?connect_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${appUrl}/profile.html?connect_error=missing_params`);
  try {
    const { userId } = JSON.parse(Buffer.from(state, 'base64').toString());
    const stripe = getPlatformStripe();
    const response = await stripe.oauth.token({ grant_type: 'authorization_code', code });
    const { access_token, refresh_token, stripe_user_id, stripe_publishable_key, livemode } = response;
    db.prepare(`UPDATE accounts SET stripe_connect_id=?,stripe_connect_key=?,stripe_connect_refresh=?,stripe_connect_pub=?,stripe_connect_livemode=? WHERE id=?`)
      .run(stripe_user_id, access_token, refresh_token||null, stripe_publishable_key||null, livemode?1:0, userId);
    res.redirect(`${appUrl}/profile.html?connect_success=1`);
  } catch(e) {
    console.error('[connect/callback]', e.message);
    res.redirect(`${appUrl}/profile.html?connect_error=${encodeURIComponent(e.message)}`);
  }
});

// Disconnect Stripe
r.post('/connect/disconnect', auth, (req, res) => {
  db.prepare('UPDATE accounts SET stripe_connect_id=NULL,stripe_connect_key=NULL,stripe_connect_refresh=NULL,stripe_connect_pub=NULL WHERE id=?').run(req.user.id);
  res.json({ ok: true });
});

// Get connection status
r.get('/connect/status', auth, (req, res) => {
  const acct = db.prepare('SELECT stripe_connect_id, stripe_connect_pub, stripe_connect_livemode FROM accounts WHERE id=?').get(req.user.id);
  if (!acct?.stripe_connect_id) return res.json({ connected: false });
  res.json({ connected: true, accountId: acct.stripe_connect_id, livemode: !!acct.stripe_connect_livemode, publishableKey: acct.stripe_connect_pub });
});

// ── Pricing plans (public — shown at paywall) ─────────────
r.get('/pricing-plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM pricing_plans WHERE is_active=1 ORDER BY sort_order,price_cents').all();
  res.json({ plans: plans.map(p => ({ ...p, features: JSON.parse(p.features||'[]') })) });
});

// ── Admin: manage platform settings ──────────────────────
r.get('/settings', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const rows = db.prepare('SELECT key,value FROM platform_settings').all();
  res.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
});

r.patch('/settings', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { updates } = req.body;
  if (!updates) return res.status(400).json({ error: 'updates required' });
  for (const [key, value] of Object.entries(updates)) {
    db.prepare('INSERT OR REPLACE INTO platform_settings (key,value) VALUES (?,?)').run(key, String(value));
  }
  res.json({ ok: true });
});

// Admin: manage pricing plans
r.get('/pricing-plans/admin', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const plans = db.prepare('SELECT * FROM pricing_plans ORDER BY sort_order,price_cents').all();
  res.json({ plans: plans.map(p => ({ ...p, features: JSON.parse(p.features||'[]') })) });
});

r.post('/pricing-plans', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, description, price_cents, features, sort_order } = req.body;
  if (!name || price_cents === undefined) return res.status(400).json({ error: 'name and price_cents required' });
  const id = uuid();
  db.prepare('INSERT INTO pricing_plans (id,name,description,price_cents,features,sort_order) VALUES (?,?,?,?,?,?)').run(id, name, description||null, parseInt(price_cents), JSON.stringify(features||[]), parseInt(sort_order||0));
  res.json({ ok: true, id });
});

r.patch('/pricing-plans/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, description, price_cents, features, is_active, sort_order } = req.body;
  const plan = db.prepare('SELECT * FROM pricing_plans WHERE id=?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  db.prepare('UPDATE pricing_plans SET name=?,description=?,price_cents=?,features=?,is_active=?,sort_order=? WHERE id=?')
    .run(name??plan.name, description??plan.description, price_cents!==undefined?parseInt(price_cents):plan.price_cents, features?JSON.stringify(features):plan.features, is_active!==undefined?is_active:plan.is_active, sort_order!==undefined?parseInt(sort_order):plan.sort_order, plan.id);
  res.json({ ok: true });
});

r.delete('/pricing-plans/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM pricing_plans WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Event creation payment ────────────────────────────────

// Step 1: Create a PaymentIntent for the event creation fee
r.post('/event-payment/intent', auth, async (req, res) => {
  try {
    const { planId } = req.body;
    if (!planId) return res.status(400).json({ error: 'planId required' });
    const plan = db.prepare('SELECT * FROM pricing_plans WHERE id=? AND is_active=1').get(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.price_cents === 0) return res.json({ free: true, planId, plan: { ...plan, features: JSON.parse(plan.features||'[]') } });
    const stripe = getPlatformStripe();
    const acct = db.prepare('SELECT name,email FROM accounts WHERE id=?').get(req.user.id);
    const orderId = uuid();
    const intent = await stripe.paymentIntents.create({
      amount: plan.price_cents,
      currency: getSetting('currency', 'usd'),
      receipt_email: acct.email,
      description: `EverythingShul — ${plan.name} — ${acct.name}`,
      metadata: { order_id: orderId, account_id: req.user.id, plan_id: planId, type: 'event_creation' }
    });
    res.json({ clientSecret: intent.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, orderId, plan: { ...plan, features: JSON.parse(plan.features||'[]') } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Step 2: Confirm payment succeeded and create the event
r.post('/event-payment/confirm', auth, async (req, res) => {
  try {
    const { paymentIntentId, planId, eventData } = req.body;
    if (!eventData?.name || !eventData?.date || !eventData?.venue) return res.status(400).json({ error: 'Event details required' });
    const plan = db.prepare('SELECT * FROM pricing_plans WHERE id=?').get(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    // Verify payment if not free
    if (plan.price_cents > 0) {
      if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required for paid plans' });
      const stripe = getPlatformStripe();
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (intent.status !== 'succeeded') return res.status(400).json({ error: `Payment not confirmed (status: ${intent.status})` });
      if (intent.metadata.account_id !== req.user.id) return res.status(403).json({ error: 'Payment mismatch' });
    }
    // Create the event
    const id = uuid();
    const { name, date, time, venue, description, timezone, expires_at } = eventData;
    const dateTime = time ? `${date} · ${time}` : date;
    const tz = timezone || 'America/New_York';
    db.prepare('INSERT INTO events (id,account_id,name,date,venue,description,timezone,expires_at,platform_order_id) VALUES (?,?,?,?,?,?,?,?,?)').run(id, req.user.id, name, dateTime, venue, description||null, tz, expires_at||null, paymentIntentId||null);
    // Remove demo_mode if this is their first live event
    db.prepare("UPDATE accounts SET demo_mode=0 WHERE id=? AND demo_mode=1").run(req.user.id);
    const newEvent = db.prepare('SELECT * FROM events WHERE id=?').get(id);
    // Send notifications
    const acct = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id);
    if (acct) notifyEventCreated({ account: acct, event: newEvent }).catch(() => {});
    res.json({ ok: true, event: newEvent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stripe webhook for platform payments ──────────────────
r.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_PLATFORM_WEBHOOK_SECRET;
  let event;
  try {
    const stripe = getPlatformStripe();
    event = secret ? stripe.webhooks.constructEvent(req.body, sig, secret) : JSON.parse(req.body);
  } catch(e) { return res.status(400).send('Webhook error: ' + e.message); }
  // Handle successful platform payments
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    if (pi.metadata?.type === 'event_creation') {
      console.log('[platform webhook] event creation payment confirmed:', pi.id, 'account:', pi.metadata.account_id);
    }
  }
  res.json({ received: true });
});

export default r;
