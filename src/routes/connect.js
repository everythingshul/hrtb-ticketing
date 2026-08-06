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

// Validate an account-level promo code against a price and compute the discount.
// Throws with a user-facing message on any invalid/expired/exhausted code.
function applyAccountPromo(code, priceCents) {
  const promo = db.prepare('SELECT * FROM account_promo_codes WHERE code=? AND active=1').get(code.trim().toUpperCase());
  if (!promo) throw new Error('Invalid promo code');
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) throw new Error('This promo code has expired');
  if (promo.max_uses && promo.uses >= promo.max_uses) throw new Error('This promo code has reached its usage limit');
  if (promo.max_money && promo.money_given >= promo.max_money) throw new Error('This promo code has reached its discount limit');
  let discountCents = promo.type === 'percent' ? Math.round(priceCents * promo.value / 100) : promo.value;
  if (promo.max_money) discountCents = Math.min(discountCents, promo.max_money - promo.money_given);
  discountCents = Math.max(0, Math.min(discountCents, priceCents));
  return { promo, discountCents };
}

// ── Stripe Connect OAuth ──────────────────────────────────

// Step 1: redirect to Stripe OAuth
r.get('/connect/start', auth, (req, res) => {
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Stripe Connect not configured. Set STRIPE_CONNECT_CLIENT_ID.' });
  const appUrl = process.env.APP_URL || 'https://mamudem.com';
  const redirectUri = `${appUrl}/api/connect/callback`;
  const state = Buffer.from(JSON.stringify({ userId: req.user.id, ts: Date.now() })).toString('base64');
  const url = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=${clientId}&scope=read_write&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.json({ url });
});

// Step 2: OAuth callback - exchange code for tokens
r.get('/connect/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const appUrl = process.env.APP_URL || 'https://mamudem.com';
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

// ── Pricing plans (public - shown at paywall) ─────────────
r.get('/pricing-plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM pricing_plans WHERE is_active=1 AND show_on_pricing=1 ORDER BY sort_order,price_cents').all();
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
  const { name, description, price_cents, features, sort_order, show_on_pricing, max_events, max_attendees, max_levels } = req.body;
  if (!name || price_cents === undefined) return res.status(400).json({ error: 'name and price_cents required' });
  const id = uuid();
  db.prepare('INSERT INTO pricing_plans (id,name,description,price_cents,features,sort_order,show_on_pricing,max_events,max_attendees,max_levels) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    id, name, description||null, Math.round(parseFloat(price_cents)),
    JSON.stringify(features||[]), parseInt(sort_order||0),
    show_on_pricing!==undefined?(show_on_pricing?1:0):1,
    max_events||null, max_attendees||null, max_levels||null
  );
  res.json({ ok: true, id });
});

r.patch('/pricing-plans/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, description, price_cents, features, is_active, sort_order, show_on_pricing, max_events, max_attendees, max_levels } = req.body;
  const plan = db.prepare('SELECT * FROM pricing_plans WHERE id=?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  db.prepare(`UPDATE pricing_plans SET name=?,description=?,price_cents=?,features=?,is_active=?,sort_order=?,show_on_pricing=?,max_events=?,max_attendees=?,max_levels=? WHERE id=?`)
    .run(
      name??plan.name,
      description!==undefined?description:plan.description,
      price_cents!==undefined?Math.round(parseFloat(price_cents)):plan.price_cents,
      features?JSON.stringify(features):plan.features,
      is_active!==undefined?is_active:plan.is_active,
      sort_order!==undefined?parseInt(sort_order):plan.sort_order,
      show_on_pricing!==undefined?(show_on_pricing?1:0):(plan.show_on_pricing??1),
      max_events!==undefined?(max_events||null):plan.max_events,
      max_attendees!==undefined?(max_attendees||null):plan.max_attendees,
      max_levels!==undefined?(max_levels||null):plan.max_levels,
      plan.id
    );
  res.json({ ok: true });
});

r.delete('/pricing-plans/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM pricing_plans WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Account-level promo codes (plan purchases, not ticket sales) ──

// Check a code against a plan before payment (auth - buyer must be signed in)
r.post('/account-promos/validate', auth, (req, res) => {
  try {
    const { code, planId } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const plan = db.prepare('SELECT * FROM pricing_plans WHERE id=? AND is_active=1').get(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const { promo, discountCents } = applyAccountPromo(code, plan.price_cents);
    res.json({ valid: true, code: promo.code, type: promo.type, value: promo.value, discountCents, finalCents: plan.price_cents - discountCents });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Admin: list/create/update/delete account promo codes
r.get('/account-promos', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const promos = db.prepare('SELECT * FROM account_promo_codes ORDER BY created_at DESC').all();
  res.json({ promos });
});

r.post('/account-promos', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { code, type, value, expires_at, max_uses, max_money } = req.body;
  if (!code || !type || value === undefined) return res.status(400).json({ error: 'code, type, and value required' });
  const normalized = code.trim().toUpperCase();
  const existing = db.prepare('SELECT id FROM account_promo_codes WHERE code=?').get(normalized);
  if (existing) return res.status(400).json({ error: 'Promo code already exists' });
  const id = uuid();
  db.prepare(`INSERT INTO account_promo_codes (id,code,type,value,expires_at,max_uses,max_money)
    VALUES (?,?,?,?,?,?,?)`).run(
    id, normalized, type === 'fixed' ? 'fixed' : 'percent', Math.round(parseFloat(value)),
    expires_at || null, max_uses || null, max_money || null
  );
  res.json({ ok: true, id });
});

r.patch('/account-promos/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { active, expires_at, max_uses, max_money } = req.body;
  const promo = db.prepare('SELECT * FROM account_promo_codes WHERE id=?').get(req.params.id);
  if (!promo) return res.status(404).json({ error: 'Promo not found' });
  if (active !== undefined) db.prepare('UPDATE account_promo_codes SET active=? WHERE id=?').run(active?1:0, promo.id);
  if (expires_at !== undefined) db.prepare('UPDATE account_promo_codes SET expires_at=? WHERE id=?').run(expires_at||null, promo.id);
  if (max_uses !== undefined) db.prepare('UPDATE account_promo_codes SET max_uses=? WHERE id=?').run(max_uses||null, promo.id);
  if (max_money !== undefined) db.prepare('UPDATE account_promo_codes SET max_money=? WHERE id=?').run(max_money||null, promo.id);
  res.json({ ok: true });
});

r.delete('/account-promos/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM account_promo_codes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Event creation payment ────────────────────────────────

// Step 1: Create a PaymentIntent for the event creation fee
r.post('/event-payment/intent', auth, async (req, res) => {
  try {
    const { planId, promoCode } = req.body;
    if (!planId) return res.status(400).json({ error: 'planId required' });
    const plan = db.prepare('SELECT * FROM pricing_plans WHERE id=? AND is_active=1').get(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    let discountCents = 0, appliedCode = null;
    if (promoCode) {
      try {
        const result = applyAccountPromo(promoCode, plan.price_cents);
        discountCents = result.discountCents;
        appliedCode = result.promo.code;
      } catch(e) { return res.status(400).json({ error: e.message }); }
    }
    const finalCents = Math.max(0, plan.price_cents - discountCents);
    const planOut = { ...plan, features: JSON.parse(plan.features||'[]') };

    if (finalCents === 0) return res.json({ free: true, planId, plan: planOut, promoCode: appliedCode, discountCents });

    const stripe = getPlatformStripe();
    const acct = db.prepare('SELECT name,email FROM accounts WHERE id=?').get(req.user.id);
    const orderId = uuid();
    const intent = await stripe.paymentIntents.create({
      amount: finalCents,
      currency: getSetting('currency', 'usd'),
      receipt_email: acct.email,
      description: `Mamudem - ${plan.name} - ${acct.name}`,
      metadata: { order_id: orderId, account_id: req.user.id, plan_id: planId, type: 'event_creation', promo_code: appliedCode||'' }
    });
    res.json({ clientSecret: intent.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, orderId, plan: planOut, promoCode: appliedCode, discountCents, finalCents });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Step 2: Confirm payment succeeded and create the event
r.post('/event-payment/confirm', auth, async (req, res) => {
  try {
    const { paymentIntentId, planId, eventData, promoCode } = req.body;
    if (!eventData?.name || !eventData?.date || !eventData?.venue) return res.status(400).json({ error: 'Event details required' });
    const plan = db.prepare('SELECT * FROM pricing_plans WHERE id=?').get(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    let discountCents = 0, appliedPromo = null;
    if (promoCode) {
      try {
        const result = applyAccountPromo(promoCode, plan.price_cents);
        discountCents = result.discountCents;
        appliedPromo = result.promo;
      } catch(e) { return res.status(400).json({ error: e.message }); }
    }
    const finalCents = Math.max(0, plan.price_cents - discountCents);

    // Verify payment if not fully covered by the promo code
    if (finalCents > 0) {
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
    // Remove demo_mode, store plan info, enable features
    db.prepare("UPDATE accounts SET demo_mode=0, can_sell_online=1, can_send_email=1, plan_id=? WHERE id=?").run(planId, req.user.id);
    const newEvent = db.prepare('SELECT * FROM events WHERE id=?').get(id);
    // Store transaction record + redeem the promo code
    try {
      db.prepare("INSERT INTO account_transactions (id,account_id,plan_id,event_id,stripe_payment_intent_id,amount_cents,status,promo_code,discount_cents) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(uuid(), req.user.id, planId, id, paymentIntentId||null, finalCents, 'paid', appliedPromo?.code||null, discountCents);
      if (appliedPromo) db.prepare('UPDATE account_promo_codes SET uses=uses+1, money_given=money_given+? WHERE id=?').run(discountCents, appliedPromo.id);
    } catch(e) { console.error('[connect] transaction record failed:', e.message); }
    const acct = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id);
    if (acct) notifyEventCreated({ account: acct, event: newEvent }).catch(() => {});
    res.json({ ok: true, event: newEvent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Upgrade plan for specific event (prorate) ─────────────
r.post('/event-payment/upgrade-intent', auth, async (req, res) => {
  try {
    const { planId, fromPlanId, promoCode } = req.body;
    if (!planId) return res.status(400).json({ error: 'planId required' });
    const newPlan  = db.prepare('SELECT * FROM pricing_plans WHERE id=? AND is_active=1').get(planId);
    const fromPlan = fromPlanId ? db.prepare('SELECT * FROM pricing_plans WHERE id=?').get(fromPlanId) : null;
    if (!newPlan) return res.status(404).json({ error: 'Plan not found' });
    // Calculate prorate amount
    const alreadyPaid   = fromPlan?.price_cents || 0;
    const upgradeAmount = Math.max(0, newPlan.price_cents - alreadyPaid);

    let discountCents = 0, appliedCode = null;
    if (promoCode && upgradeAmount > 0) {
      try {
        const result = applyAccountPromo(promoCode, upgradeAmount);
        discountCents = result.discountCents;
        appliedCode = result.promo.code;
      } catch(e) { return res.status(400).json({ error: e.message }); }
    }
    const finalAmount = Math.max(0, upgradeAmount - discountCents);

    if (finalAmount === 0) {
      // Free upgrade (downgrade not allowed this way)
      return res.json({ free: true, planId, amount_cents: 0, already_paid: alreadyPaid, upgrade_cost: 0, promoCode: appliedCode, discountCents });
    }
    const stripe   = getPlatformStripe();
    const acct     = db.prepare('SELECT name,email FROM accounts WHERE id=?').get(req.user.id);
    const orderId  = uuid();
    const intent   = await stripe.paymentIntents.create({
      amount: finalAmount,
      currency: getSetting('currency', 'usd'),
      receipt_email: acct.email,
      description: `Mamudem - Upgrade to ${newPlan.name} - ${acct.name}`,
      metadata: { order_id: orderId, account_id: req.user.id, plan_id: planId, from_plan_id: fromPlanId||'', type: 'plan_upgrade', promo_code: appliedCode||'' }
    });
    res.json({
      clientSecret: intent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      orderId, plan: { ...newPlan, features: JSON.parse(newPlan.features||'[]') },
      already_paid: alreadyPaid,
      upgrade_cost: upgradeAmount,
      total_cost: newPlan.price_cents,
      promoCode: appliedCode,
      discountCents
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

r.post('/event-payment/upgrade-confirm', auth, async (req, res) => {
  try {
    const { paymentIntentId, planId, eventId, promoCode } = req.body;
    const newPlan = db.prepare('SELECT * FROM pricing_plans WHERE id=?').get(planId);
    if (!newPlan) return res.status(404).json({ error: 'Plan not found' });

    let discountCents = 0, appliedPromo = null;
    if (promoCode) {
      try {
        const result = applyAccountPromo(promoCode, newPlan.price_cents);
        discountCents = result.discountCents;
        appliedPromo = result.promo;
      } catch(e) { return res.status(400).json({ error: e.message }); }
    }
    // Verify payment
    if (newPlan.price_cents - discountCents > 0 && paymentIntentId) {
      const stripe = getPlatformStripe();
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (intent.status !== 'succeeded') return res.status(400).json({ error: `Payment not confirmed (status: ${intent.status})` });
    }
    // Update account plan
    db.prepare("UPDATE accounts SET plan_id=? WHERE id=?").run(planId, req.user.id);
    // Record transaction + redeem the promo code
    try {
      db.prepare("INSERT INTO account_transactions (id,account_id,plan_id,event_id,stripe_payment_intent_id,amount_cents,status,promo_code,discount_cents) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(uuid(), req.user.id, planId, eventId||null, paymentIntentId||null, Math.max(0, newPlan.price_cents - discountCents), 'upgrade', appliedPromo?.code||null, discountCents);
      if (appliedPromo) db.prepare('UPDATE account_promo_codes SET uses=uses+1, money_given=money_given+? WHERE id=?').run(discountCents, appliedPromo.id);
    } catch(e) { console.error('[connect] transaction record failed:', e.message); }
    res.json({ ok: true });
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
