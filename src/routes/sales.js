import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { createRequire } from 'module';
import multer from 'multer';
import db from '../db.js';
import { auth } from '../middleware/auth.js';
import { sendMail, ticketEmail } from '../services/mail.js';
import { generateTicketPDF } from '../services/ticketPDF.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { promises as fs } from 'fs';

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dir, '../../frontend');

// ── Centralised directories ───────────────────────────────
function getDesignsDir() {
  const dir = join(process.env.DATA_DIR || '/data', 'designs');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function getSaleTmpDir() {
  const dir = '/tmp/hrtb-sale';
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

// Multer: disk storage for sale images
const upload = multer({ dest: getSaleTmpDir(), limits: { fileSize: 5*1024*1024 } });

const r = Router();

// ── Capacity check (inline) ────────────────────────────────
function checkCapacity(eventId, levelId) {
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  if (!event) return { ok: false, blocked: true, warnings: ['Event not found'] };

  // Decide whether unconfirmed count toward capacity
  const countAll = event.capacity_count_unconfirmed !== 0; // 0=OFF; 1/null=ON
  const countClause = countAll
    ? "deleted_at IS NULL AND status!='deactivated'"
    : "deleted_at IS NULL AND status!='deactivated' AND confirmed=1";

  const total = db.prepare(`SELECT COUNT(*) c FROM attendees WHERE event_id=? AND ${countClause}`).get(eventId).c;
  const level = levelId ? db.prepare('SELECT * FROM ticket_levels WHERE id=?').get(levelId) : null;
  const levelCount = level
    ? db.prepare(`SELECT COUNT(*) c FROM attendees WHERE event_id=? AND level_id=? AND ${countClause}`).get(eventId, levelId).c
    : 0;

  const warnings = [];
  let blocked = false;

  if (event.max_tickets && total >= event.max_tickets) {
    blocked = true;
    warnings.push(`This event is sold out (${total}/${event.max_tickets} tickets)`);
  }
  if (level?.max_tickets && levelCount >= level.max_tickets) {
    blocked = true;
    warnings.push(`${level.name} is sold out (${levelCount}/${level.max_tickets})`);
  }

  console.log(`[checkCapacity] event=${eventId} level=${level?.name||'—'} total=${total}/${event.max_tickets||'∞'} levelCount=${levelCount}/${level?.max_tickets||'∞'} countAll=${countAll} blocked=${blocked}`);
  return { ok: !blocked, blocked, warnings };
}

// ── Helpers ───────────────────────────────────────────────
function getStripe(event) {
  // Priority: account Stripe Connect key > per-event key > platform key
  const account = db.prepare('SELECT stripe_connect_key, stripe_key FROM accounts WHERE id=?').get(event.account_id);
  const key = account?.stripe_connect_key || event.stripe_key || process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Stripe not configured. Connect your Stripe account in your profile settings.');
  return require('stripe')(key);
}

function getStripePublishable(event) {
  const account = db.prepare('SELECT stripe_connect_pub FROM accounts WHERE id=?').get(event.account_id);
  return account?.stripe_connect_pub || process.env.STRIPE_PUBLISHABLE_KEY || '';
}

function getEventDesignPath(eventId) {
  const DESIGNS_DIR = getDesignsDir();
  for (const ext of ['png','jpg']) {
    const p = join(DESIGNS_DIR, `${eventId}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

function tid() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = 'TKT-';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ── Public: get event sales page info ─────────────────────
r.get('/event/:slug', (req, res) => {
  // Load event — no sale_enabled filter so activation works even when sales closed
  const event = db.prepare(`
    SELECT e.*, a.name as account_name
    FROM events e JOIN accounts a ON a.id = e.account_id
    WHERE e.slug=? AND e.deleted_at IS NULL
  `).get(req.params.slug);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const salesOpen = event.sale_enabled &&
    (!event.expires_at || new Date(event.expires_at) >= new Date());

  // If sales closed AND activation not enabled — nothing to show
  if (!salesOpen && !event.allow_activation) {
    if (!event.sale_enabled) {
      return res.status(410).json({ error: 'Ticket sales are not yet open for this event.' });
    }
    if (event.expires_at && new Date(event.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Ticket sales have closed for this event.' });
    }
    return res.status(410).json({ error: 'Ticket sales are not available for this event.' });
  }

  // Only show purchasable levels when sales are open
  const levels = salesOpen ? db.prepare(`
    SELECT id, name, color, description, price, online_sale, max_tickets, show_availability
    FROM ticket_levels WHERE event_id=? AND online_sale=1 ORDER BY price ASC
  `).all(event.id) : [];

  // Add availability data per level — respect the count_unconfirmed toggle
  const saleCountAll = event.capacity_count_unconfirmed !== 0;
  const saleClause = saleCountAll
    ? "deleted_at IS NULL AND status!='deactivated'"
    : "deleted_at IS NULL AND status!='deactivated' AND confirmed=1";

  const levelsWithAvail = levels.map(l => {
    const sold = db.prepare(`SELECT COUNT(*) c FROM attendees WHERE event_id=? AND level_id=? AND ${saleClause}`).get(event.id, l.id).c;
    const available = l.max_tickets ? Math.max(0, l.max_tickets - sold) : null;
    const soldOut = l.max_tickets ? sold >= l.max_tickets : false;
    return { ...l, sold, available, soldOut };
  });

  // Sales image URL
  const DESIGNS_DIR = getDesignsDir();
  const saleImagePath = event.sale_image
    ? (existsSync(join(DESIGNS_DIR, `sale_${event.id}.png`)) ? `/api/sales/image/${event.slug}` : null)
    : null;

  const eventTotal = db.prepare(`SELECT COUNT(*) c FROM attendees WHERE event_id=? AND ${saleClause}`).get(event.id).c;
  const eventSoldOut = event.max_tickets ? eventTotal >= event.max_tickets : false;
  console.log(`[sales/event] slug=${req.params.slug} max_tickets=${event.max_tickets} total=${eventTotal} soldOut=${eventSoldOut} levels:`, levelsWithAvail.map(l=>`${l.name}:sold=${l.sold}/max=${l.max_tickets||'∞'}/soldOut=${l.soldOut}`).join(', '));

  res.json({
    id: event.id,
    name: event.name,
    date: event.date,
    venue: event.venue,
    description: event.description,
    levels: levelsWithAvail,
    saleImage: saleImagePath,
    accountName: event.account_name,
    publishableKey: getStripePublishable(event),
    eventSoldOut,
    allowActivation: event.allow_activation === 1,
    salesOpen
  });
});

// ── Public: serve sale image ───────────────────────────────
r.get('/image/:slug', (req, res) => {
  const event = db.prepare('SELECT id FROM events WHERE slug=?').get(req.params.slug);
  if (!event) return res.status(404).end();
  const DESIGNS_DIR = getDesignsDir();
  for (const ext of ['png','jpg']) {
    const p = join(DESIGNS_DIR, `sale_${event.id}.${ext}`);
    if (existsSync(p)) return res.sendFile(p);
  }
  res.status(404).end();
});

// ── Public: create PaymentIntent for Payment Element ──────
r.post('/event/:slug/checkout', async (req, res) => {
  try {
    const event = db.prepare(`SELECT * FROM events WHERE slug=? AND sale_enabled=1 AND deleted_at IS NULL`).get(req.params.slug);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.expires_at && new Date(event.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Ticket sales have closed' });
    }

    const { items, attendees: checkoutAttendees, email } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'No items selected' });

    const levels = db.prepare(`SELECT * FROM ticket_levels WHERE event_id=? AND online_sale=1`).all(event.id);
    const levelMap = Object.fromEntries(levels.map(l => [l.id, l]));

    let totalCents = 0;
    for (const item of items) {
      const lvl = levelMap[item.levelId];
      if (!lvl) return res.status(400).json({ error: 'Invalid ticket level' });
      if (item.quantity < 1 || item.quantity > 20) return res.status(400).json({ error: 'Invalid quantity' });
      const cap = checkCapacity(event.id, lvl.id);
      console.log(`[sales/checkout] level=${lvl.name} cap=`, JSON.stringify(cap));
      if (!cap.ok) return res.status(400).json({ error: cap.warnings[0] || 'Tickets unavailable' });
      totalCents += lvl.price * item.quantity;
    }

    // Apply promo discount if provided
    let discountCents = 0;
    let promoRecord = null;
    if (req.body.promoCode) {
      promoRecord = db.prepare('SELECT * FROM promo_codes WHERE event_id=? AND code=? AND active=1').get(event.id, req.body.promoCode.trim().toUpperCase());
      if (promoRecord) {
        if (promoRecord.type === 'percent') {
          discountCents = Math.round(totalCents * promoRecord.value / 100);
        } else {
          discountCents = Math.min(promoRecord.value, totalCents);
        }
        if (promoRecord.max_money) discountCents = Math.min(discountCents, promoRecord.max_money - promoRecord.money_given);
        discountCents = Math.max(0, discountCents);
      }
    }
    totalCents = Math.max(0, totalCents - discountCents);

    const orderId = uuid();

    // Free tickets — fulfill immediately without Stripe (no API key needed)
    if (totalCents === 0) {
      db.prepare(`INSERT INTO online_orders (id,event_id,stripe_session_id,status,email,total_cents,line_items,checkout_data) VALUES (?,?,?,?,?,?,?,?)`)
        .run(orderId, event.id, 'free-' + orderId, 'pending', email||null, 0, JSON.stringify(items), JSON.stringify(checkoutAttendees||[]));
      await fulfillOrder({ metadata: { order_id: orderId, event_id: event.id, event_name: event.name, event_slug: event.slug }, payment_intent: null, customer_details: { email }, payment_status: 'paid' });
      if (promoRecord) db.prepare('UPDATE promo_codes SET uses=uses+1, tickets_given=tickets_given+?, money_given=money_given+? WHERE id=?').run(items.reduce((s,i)=>s+i.quantity,0), discountCents, promoRecord.id);
      return res.json({ free: true, orderId });
    }

    // Paid — need Stripe
    const stripe = getStripe(event);

    // Create PaymentIntent — works with Payment Element, no iframes, no ad-blocker issues
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalCents,
      currency: 'usd',
      receipt_email: email || undefined,
      description: `Tickets — ${event.name}`,
      metadata: {
        order_id: orderId,
        event_id: event.id,
        event_name: event.name,
        event_slug: event.slug,
      }
    });

    // Save pending order
    db.prepare(`INSERT INTO online_orders (id,event_id,stripe_session_id,status,email,total_cents,line_items,checkout_data) VALUES (?,?,?,?,?,?,?,?)`)
      .run(orderId, event.id, paymentIntent.id, 'pending', email||null, totalCents,
        JSON.stringify(items), JSON.stringify(checkoutAttendees||[]));

    res.json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: getStripePublishable(event),
      orderId
    });
  } catch(e) {
    console.error('[sales/checkout]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Stripe webhook — fulfill order ────────────────────────
r.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = req.body;
    }
  } catch(e) {
    return res.status(400).json({ error: e.message });
  }

  if (event.type === 'checkout.session.completed') {
    await fulfillOrder(event.data.object);
  }
  if (event.type === 'payment_intent.succeeded') {
    await fulfillFromPaymentIntent(event.data.object);
  }

  res.json({ received: true });
});

// Fulfill from PaymentIntent (Payment Element flow)
async function fulfillFromPaymentIntent(paymentIntent) {
  const orderId = paymentIntent.metadata?.order_id;
  if (!orderId) return;
  const order = db.prepare('SELECT * FROM online_orders WHERE id=?').get(orderId);
  if (!order || order.status !== 'pending') return;

  // Get billing details from payment method
  let customerDetails = {};
  try {
    const ev = db.prepare('SELECT * FROM events WHERE id=?').get(order.event_id);
    const stripe = getStripe(ev);
    const pi = await stripe.paymentIntents.retrieve(paymentIntent.id, {
      expand: ['payment_method']
    });
    const pm = pi.payment_method;
    if (pm?.billing_details) {
      customerDetails = {
        name: pm.billing_details.name,
        email: pm.billing_details.email || order.email,
        phone: pm.billing_details.phone,
        address: pm.billing_details.address
      };
    }
  } catch(e) { console.warn('[fulfillFromPaymentIntent] billing fetch:', e.message); }

  await fulfillOrder({
    metadata: paymentIntent.metadata,
    payment_intent: paymentIntent.id,
    customer_details: customerDetails,
    payment_status: 'paid'
  }, order);
}
r.get('/order/:orderId/status', async (req, res) => {
  const order = db.prepare('SELECT * FROM online_orders WHERE id=?').get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'pending' && order.stripe_session_id) {
    try {
      const ev = db.prepare('SELECT * FROM events WHERE id=?').get(order.event_id);
      const stripe = getStripe(ev);
      // stripe_session_id now stores a PaymentIntent ID (pi_...)
      const pi = await stripe.paymentIntents.retrieve(order.stripe_session_id);
      if (pi.status === 'succeeded') {
        await fulfillFromPaymentIntent(pi);
      }
    } catch(e) { console.warn('[order status]', e.message); }
  }

  const fresh = db.prepare('SELECT status,completed_at FROM online_orders WHERE id=?').get(req.params.orderId);
  res.json(fresh);
});

// ── Fulfill order: create attendees + send tickets ─────────
async function fulfillOrder(session, existingOrder) {
  const orderId = session.metadata?.order_id;
  if (!orderId) return;

  const order = existingOrder || db.prepare('SELECT * FROM online_orders WHERE id=?').get(orderId);
  if (!order || order.status !== 'pending') return;

  // Mark as processing immediately to prevent double-fulfillment
  db.prepare("UPDATE online_orders SET status='processing',stripe_payment_intent=? WHERE id=?")
    .run(session.payment_intent || null, orderId);

  try {
    const dbEvent = db.prepare('SELECT * FROM events WHERE id=?').get(order.event_id);
    const items = JSON.parse(order.line_items || '[]');
    const checkoutPeople = JSON.parse(order.checkout_data || '[]');
    const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=?').all(order.event_id);
    const levelMap = Object.fromEntries(levels.map(l => [l.id, l]));
    const designPath = getEventDesignPath(order.event_id);

    const createdAttendees = [];
    let personIdx = 0;

    for (const item of items) {
      const lvl = levelMap[item.levelId];
      for (let i = 0; i < item.quantity; i++) {
        const person = checkoutPeople[personIdx++] || {};
        const firstName = person.first_name || 'Guest';
        const lastName  = person.last_name || '';
        const phone     = person.phone || '';
        const email     = person.email || order.email || '';

        const ticketId = tid();
        const attendeeId = uuid();

        db.prepare(`INSERT INTO attendees
          (id,event_id,account_id,first_name,last_name,phone,email,ticket_id,level_id,status,confirmed,source,checkout_data)
          VALUES (?,?,?,?,?,?,?,?,?,'pending',1,'online',?)`)
          .run(attendeeId, order.event_id, dbEvent.account_id,
            firstName, lastName, phone, email,
            ticketId, lvl?.id || null,
            JSON.stringify({ billing: session.customer_details || {} }));

        const attendee = db.prepare('SELECT * FROM attendees WHERE id=?').get(attendeeId);
        const attendeeWithLevel = { ...attendee, level_name: lvl?.name, level_color: lvl?.color };
        createdAttendees.push({ attendee: attendeeWithLevel, email });
      }
    }

    // Send tickets
    const owner = db.prepare('SELECT email, reply_to, can_send_email, role FROM accounts WHERE id=?').get(dbEvent.account_id);
    const replyTo = owner?.reply_to || owner?.email || null;
    const buyerEmail = order.email;

    // Collect all tickets for buyer summary
    const allTicketsForBuyer = [];

    for (const { attendee, email: toEmail } of createdAttendees) {
      if (!toEmail) continue;
      allTicketsForBuyer.push({ attendee, toEmail });
      try {
        let attachments = [];
        try {
          const pdfBytes = await generateTicketPDF({ attendee, event: dbEvent, eventDesignPath: designPath });
          attachments = [{ filename: `ticket-${attendee.ticket_id}.pdf`, content: pdfBytes, contentType: 'application/pdf' }];
        } catch(e) { console.warn('[sales] PDF error:', e.message); }

        await sendMail({
          to: toEmail,
          subject: `Your ticket for ${dbEvent.name}`,
          html: ticketEmail({ attendee, event: dbEvent }),
          attachments,
          replyTo
        });
        db.prepare("UPDATE attendees SET status='sent',sent_at=datetime('now') WHERE id=?").run(attendee.id);
      } catch(e) { console.error('[sales] send error:', e.message); }
    }

    // If any tickets were sent to different emails, also send all tickets to buyer
    if (buyerEmail && allTicketsForBuyer.some(t => t.toEmail.toLowerCase() !== buyerEmail.toLowerCase())) {
      try {
        const allPdfs = [];
        for (const { attendee } of allTicketsForBuyer) {
          try {
            const pdfBytes = await generateTicketPDF({ attendee, event: dbEvent, eventDesignPath: designPath });
            allPdfs.push({ filename: `ticket-${attendee.ticket_id}.pdf`, content: pdfBytes, contentType: 'application/pdf' });
          } catch {}
        }
        await sendMail({
          to: buyerEmail,
          subject: `Your tickets for ${dbEvent.name} — all ${allTicketsForBuyer.length} ticket(s)`,
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
            <h2 style="color:#1a3a6b">Your Tickets — ${dbEvent.name}</h2>
            <p>Hi! Here are all ${allTicketsForBuyer.length} ticket(s) from your order. Each ticket has also been sent to the individual attendee's email.</p>
            <p style="color:#555">Event: <strong>${dbEvent.name}</strong><br>${dbEvent.date||''} ${dbEvent.venue?'· '+dbEvent.venue:''}</p>
            <p style="color:#aaa;font-size:12px">Powered by EverythingShul.com</p>
          </div>`,
          attachments: allPdfs,
          replyTo
        });
      } catch(e) { console.warn('[sales] buyer summary email error:', e.message); }
    }

    db.prepare("UPDATE online_orders SET status='completed',completed_at=datetime('now') WHERE id=?").run(orderId);
    console.log(`[sales] Order ${orderId} fulfilled — ${createdAttendees.length} tickets`);
  } catch(e) {
    console.error('[sales] fulfillment error:', e.message);
    db.prepare("UPDATE online_orders SET status='failed' WHERE id=?").run(orderId);
  }
}

// ── Authenticated routes ───────────────────────────────────
r.use(auth);

// Get sales settings for event
r.get('/settings/:eventId', (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  // Only admin or accounts with can_sell_online
  if (req.user.role !== 'admin') {
    const acc = db.prepare('SELECT can_sell_online FROM accounts WHERE id=?').get(req.user.id);
    if (!acc?.can_sell_online) return res.status(403).json({ error: 'Online sales not enabled for your account' });
  }
  const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=?').all(ev.id);
  const orders = db.prepare("SELECT COUNT(*) c FROM online_orders WHERE event_id=? AND status='completed'").get(ev.id);
  res.json({
    slug: ev.slug, sale_enabled: ev.sale_enabled, sale_image: ev.sale_image,
    stripe_key: ev.stripe_key ? '***configured***' : null,
    expires_at: ev.expires_at, levels,
    total_online_sales: orders.c,
    allow_activation: ev.allow_activation || 0
  });
});

// Update sales settings (user-facing — no Stripe key access)
r.patch('/settings/:eventId', (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  const { slug, sale_enabled, expires_at, allow_activation } = req.body;

  if (slug !== undefined) {
    // Once a slug is set, only admin can change it
    if (ev.slug && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'SLUG_LOCKED: The event URL has already been set. Contact an Administrator to change it.' });
    }
    const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,60);
    if (!clean) return res.status(400).json({ error: 'Invalid slug — use letters, numbers and hyphens only' });
    const existing = db.prepare('SELECT id FROM events WHERE slug=? AND id!=?').get(clean, ev.id);
    if (existing) return res.status(400).json({ error: 'This URL is already taken — choose another' });
    db.prepare('UPDATE events SET slug=? WHERE id=?').run(clean, ev.id);
  }
  if (sale_enabled !== undefined) db.prepare('UPDATE events SET sale_enabled=? WHERE id=?').run(sale_enabled?1:0, ev.id);
  if (expires_at !== undefined) db.prepare('UPDATE events SET expires_at=? WHERE id=?').run(expires_at||null, ev.id);
  if (allow_activation !== undefined) db.prepare('UPDATE events SET allow_activation=? WHERE id=?').run(allow_activation?1:0, ev.id);

  res.json({ ok: true });
});

// Admin-only: set Stripe key per event + toggle which key source to use
r.patch('/settings/:eventId/stripe', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  const { stripe_key, use_event_key } = req.body;
  if (stripe_key !== undefined && stripe_key !== '***') {
    db.prepare('UPDATE events SET stripe_key=? WHERE id=?').run(stripe_key || null, ev.id);
  }
  res.json({ ok: true, has_key: !!(stripe_key || ev.stripe_key) });
});

// Update level pricing + online availability
r.patch('/level/:levelId', (req, res) => {
  const lvl = db.prepare('SELECT * FROM ticket_levels WHERE id=?').get(req.params.levelId);
  if (!lvl) return res.status(404).json({ error: 'Not found' });
  const { price, online_sale } = req.body;
  if (price !== undefined) db.prepare('UPDATE ticket_levels SET price=? WHERE id=?').run(Math.max(0, parseInt(price)||0), lvl.id);
  if (online_sale !== undefined) db.prepare('UPDATE ticket_levels SET online_sale=? WHERE id=?').run(online_sale?1:0, lvl.id);
  res.json({ ok: true, level: db.prepare('SELECT * FROM ticket_levels WHERE id=?').get(lvl.id) });
});

// Admin: toggle can_sell_online per account
r.patch('/account/:accountId/enable', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { enabled } = req.body;
  db.prepare('UPDATE accounts SET can_sell_online=? WHERE id=?').run(enabled?1:0, req.params.accountId);
  res.json({ ok: true });
});

// Upload sale image


r.post('/image/:eventId', auth, upload.single('image'), async (req, res) => {
  try {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  const DESIGNS_DIR = getDesignsDir();
  try { mkdirSync(DESIGNS_DIR, { recursive: true }); } catch {}
  // Detect extension from mimetype
  const mime = req.file.mimetype || '';
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
  // Remove old sale image
  for (const oldExt of ['png','jpg']) {
    try { await fs.unlink(join(DESIGNS_DIR, `sale_${ev.id}.${oldExt}`)); } catch {}
  }
  const dest = join(DESIGNS_DIR, `sale_${ev.id}.${ext}`);
  // copyFile + unlink avoids EXDEV across filesystems (same fix as ticket design)
  await fs.copyFile(req.file.path, dest);
  await fs.unlink(req.file.path).catch(() => {});
  db.prepare('UPDATE events SET sale_image=1 WHERE id=?').run(ev.id);
  res.json({ ok: true });
  } catch(e) { console.error('[sale image]', e.message); await fs.unlink(req.file?.path).catch(()=>{}); res.status(500).json({ error: e.message }); }
});

// Get online orders for event (for admin/user portal)
r.get('/orders/:eventId', (req, res) => {
  const orders = db.prepare(`SELECT * FROM online_orders WHERE event_id=? ORDER BY created_at DESC`).all(req.params.eventId);
  res.json({ orders });
});

export default r;

// ── Portal sell: get event + levels for portal sale (auth required) ─
r.get('/portal/:eventId', auth, async (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=? AND deleted_at IS NULL').get(req.params.eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  // Check account has can_sell_online
  if (req.user.role !== 'admin') {
    const acc = db.prepare('SELECT can_sell_online FROM accounts WHERE id=?').get(req.user.id);
    if (!acc?.can_sell_online) return res.status(403).json({ error: 'Online sales not enabled for your account' });
  }

  const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=? ORDER BY created_at').all(ev.id);
  const levelsWithCap = levels.map(l => {
    const sold = db.prepare("SELECT COUNT(*) c FROM attendees WHERE event_id=? AND level_id=? AND deleted_at IS NULL AND status!='deactivated'").get(ev.id, l.id).c;
    const available = l.max_tickets ? Math.max(0, l.max_tickets - sold) : null;
    const overLimit = l.max_tickets ? sold >= l.max_tickets : false;
    return { ...l, sold, available, overLimit };
  });

  const totalSold = db.prepare("SELECT COUNT(*) c FROM attendees WHERE event_id=? AND deleted_at IS NULL AND status!='deactivated'").get(ev.id).c;
  const eventOverLimit = ev.max_tickets ? totalSold >= ev.max_tickets : false;

  res.json({
    event: { id: ev.id, name: ev.name, date: ev.date, venue: ev.venue, slug: ev.slug, stripe_key: ev.stripe_key ? '***' : null, max_tickets: ev.max_tickets },
    levels: levelsWithCap,
    totalSold,
    eventOverLimit,
    publishableKey: getStripePublishable(ev||event)
  });
});

// ── Portal sell: create PaymentIntent (bypasses sale_enabled/expires checks) ─
r.post('/portal/:eventId/checkout', auth, async (req, res) => {
  try {
    const ev = db.prepare('SELECT * FROM events WHERE id=? AND deleted_at IS NULL').get(req.params.eventId);
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    if (req.user.role !== 'admin') {
      const acc = db.prepare('SELECT can_sell_online FROM accounts WHERE id=?').get(req.user.id);
      if (!acc?.can_sell_online) return res.status(403).json({ error: 'Online sales not enabled' });
    }

    const { items, attendees: checkoutAttendees, email, bypassCapacity } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'No items selected' });

    const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=?').all(ev.id);
    const levelMap = Object.fromEntries(levels.map(l => [l.id, l]));

    let totalCents = 0;
    const warnings = [];

    for (const item of items) {
      const lvl = levelMap[item.levelId];
      if (!lvl) return res.status(400).json({ error: 'Invalid ticket level' });
      if (item.quantity < 1 || item.quantity > 100) return res.status(400).json({ error: 'Invalid quantity' });

      // Check capacity — warn but don't block (portal override)
      if (!bypassCapacity) {
        const cap = checkCapacity(ev.id, lvl.id);
        if (!cap.ok) {
          warnings.push(...cap.warnings);
          // Return warning for frontend to confirm bypass
          return res.status(409).json({ error: 'CAPACITY_WARNING', warnings: cap.warnings });
        }
      }
      totalCents += lvl.price * item.quantity;
    }

    // Free order — fulfill immediately
    if (totalCents === 0) {
      const orderId = uuid();
      db.prepare(`INSERT INTO online_orders (id,event_id,stripe_session_id,status,email,total_cents,line_items,checkout_data) VALUES (?,?,?,?,?,?,?,?)`)
        .run(orderId, ev.id, 'free-' + orderId, 'pending', email||null, 0, JSON.stringify(items), JSON.stringify(checkoutAttendees||[]));
      await fulfillOrder({ metadata: { order_id: orderId, event_id: ev.id, event_name: ev.name, event_slug: ev.slug||'' }, payment_intent: null, customer_details: { email }, payment_status: 'paid' });
      return res.json({ free: true, orderId });
    }

    if (totalCents < 50) return res.status(400).json({ error: 'Total must be at least $0.50' });

    const orderId = uuid();
    const stripe = getStripe(ev);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalCents,
      currency: 'usd',
      receipt_email: email || undefined,
      description: `[Portal Sale] Tickets — ${ev.name}`,
      metadata: { order_id: orderId, event_id: ev.id, event_name: ev.name, event_slug: ev.slug || '' }
    });

    db.prepare(`INSERT INTO online_orders (id,event_id,stripe_session_id,status,email,total_cents,line_items,checkout_data) VALUES (?,?,?,?,?,?,?,?)`)
      .run(orderId, ev.id, paymentIntent.id, 'pending', email||null, totalCents, JSON.stringify(items), JSON.stringify(checkoutAttendees||[]));

    res.json({ clientSecret: paymentIntent.client_secret, publishableKey: getStripePublishable(event), orderId });
  } catch(e) {
    console.error('[portal/checkout]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Promo code routes ─────────────────────────────────────

// Validate promo code (public — called from sale page)
r.post('/event/:slug/promo', (req, res) => {
  const { code, items, email } = req.body;
  if (!code || !items?.length) return res.status(400).json({ error: 'Code and items required' });

  const event = db.prepare('SELECT * FROM events WHERE slug=? AND deleted_at IS NULL').get(req.params.slug);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const promo = db.prepare('SELECT * FROM promo_codes WHERE event_id=? AND code=? AND active=1').get(event.id, code.trim().toUpperCase());
  if (!promo) return res.status(404).json({ error: 'Invalid promo code' });
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) return res.status(400).json({ error: 'This promo code has expired' });

  // Check email restriction
  if (promo.allowed_emails) {
    const allowed = JSON.parse(promo.allowed_emails).map(e => e.toLowerCase().trim());
    if (email && !allowed.includes(email.toLowerCase().trim())) {
      return res.status(403).json({ error: 'This promo code is not valid for your email address' });
    }
  }

  // Check limits
  if (promo.max_uses && promo.uses >= promo.max_uses) return res.status(400).json({ error: 'This promo code has reached its usage limit' });
  if (promo.max_money && promo.money_given >= promo.max_money) return res.status(400).json({ error: 'This promo code has reached its discount limit' });

  const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=?').all(event.id);
  const levelMap = Object.fromEntries(levels.map(l => [l.id, l]));
  const perLevelLimits = promo.max_tickets_per_level ? JSON.parse(promo.max_tickets_per_level) : {};

  // Calculate discount
  let originalCents = 0, discountCents = 0;
  const lineDiscounts = [];

  for (const item of items) {
    const lvl = levelMap[item.levelId];
    if (!lvl) continue;
    const qty = item.quantity;
    const subtotal = lvl.price * qty;
    originalCents += subtotal;

    // Check per-level limit
    if (perLevelLimits[item.levelId]) {
      const maxForLevel = perLevelLimits[item.levelId];
      const usedForLevel = db.prepare("SELECT COUNT(*) c FROM attendees WHERE event_id=? AND level_id=? AND source='online' AND deleted_at IS NULL").get(event.id, item.levelId).c;
      if (usedForLevel >= maxForLevel) {
        lineDiscounts.push({ levelId: item.levelId, discount: 0, note: 'Level limit reached' });
        continue;
      }
    }

    const lineDiscount = promo.type === 'percent' ? Math.round(subtotal * promo.value / 100) : Math.min(promo.value * qty, subtotal);
    discountCents += lineDiscount;
    lineDiscounts.push({ levelId: item.levelId, discount: lineDiscount });
  }

  // Cap by max_money remaining
  if (promo.max_money) {
    const remaining = promo.max_money - promo.money_given;
    discountCents = Math.min(discountCents, remaining);
  }

  const finalCents = Math.max(0, originalCents - discountCents);
  res.json({ valid: true, promo: { id: promo.id, code: promo.code, type: promo.type, value: promo.value }, originalCents, discountCents, finalCents, lineDiscounts });
});

// List promos for event (auth required)
r.get('/event/:eventId/promos', auth, (req, res) => {
  const promos = db.prepare('SELECT * FROM promo_codes WHERE event_id=? ORDER BY created_at DESC').all(req.params.eventId);
  res.json({ promos });
});

// Create promo (auth required)
r.post('/event/:eventId/promos', auth, (req, res) => {
  const { code, type, value, expires_at, max_uses, max_tickets_per_level, max_money, max_total_tickets, allowed_emails } = req.body;
  if (!code || !type || value === undefined) return res.status(400).json({ error: 'code, type, and value required' });
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  const existing = db.prepare('SELECT id FROM promo_codes WHERE event_id=? AND code=?').get(ev.id, code.trim().toUpperCase());
  if (existing) return res.status(400).json({ error: 'Promo code already exists for this event' });

  const id = uuid();
  db.prepare(`INSERT INTO promo_codes (id,event_id,code,type,value,expires_at,max_uses,max_tickets_per_level,max_money,max_total_tickets,allowed_emails)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, ev.id, code.trim().toUpperCase(), type, parseInt(value), expires_at||null, max_uses||null,
      max_tickets_per_level ? JSON.stringify(max_tickets_per_level) : null,
      max_money||null, max_total_tickets||null,
      allowed_emails ? JSON.stringify(allowed_emails.split(',').map(e=>e.trim()).filter(Boolean)) : null);
  res.json({ ok: true, id });
});

// Update promo
r.patch('/event/:eventId/promos/:promoId', auth, (req, res) => {
  const { active, expires_at, max_uses, allowed_emails, max_money, max_total_tickets, max_tickets_per_level } = req.body;
  const promo = db.prepare('SELECT * FROM promo_codes WHERE id=? AND event_id=?').get(req.params.promoId, req.params.eventId);
  if (!promo) return res.status(404).json({ error: 'Promo not found' });
  if (active !== undefined) db.prepare('UPDATE promo_codes SET active=? WHERE id=?').run(active?1:0, promo.id);
  if (expires_at !== undefined) db.prepare('UPDATE promo_codes SET expires_at=? WHERE id=?').run(expires_at||null, promo.id);
  if (max_uses !== undefined) db.prepare('UPDATE promo_codes SET max_uses=? WHERE id=?').run(max_uses||null, promo.id);
  if (max_money !== undefined) db.prepare('UPDATE promo_codes SET max_money=? WHERE id=?').run(max_money||null, promo.id);
  if (max_total_tickets !== undefined) db.prepare('UPDATE promo_codes SET max_total_tickets=? WHERE id=?').run(max_total_tickets||null, promo.id);
  if (max_tickets_per_level !== undefined) db.prepare('UPDATE promo_codes SET max_tickets_per_level=? WHERE id=?').run(max_tickets_per_level?JSON.stringify(max_tickets_per_level):null, promo.id);
  if (allowed_emails !== undefined) db.prepare('UPDATE promo_codes SET allowed_emails=? WHERE id=?').run(allowed_emails?JSON.stringify(allowed_emails.split(',').map(e=>e.trim()).filter(Boolean)):null, promo.id);
  res.json({ ok: true });
});

// Delete promo
r.delete('/event/:eventId/promos/:promoId', auth, (req, res) => {
  db.prepare('DELETE FROM promo_codes WHERE id=? AND event_id=?').run(req.params.promoId, req.params.eventId);
  res.json({ ok: true });
});
