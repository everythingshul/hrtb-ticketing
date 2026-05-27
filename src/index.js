import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync } from 'fs';
import { initMail } from './services/mail.js';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import attendeeRoutes from './routes/attendees.js';
import staffRoutes from './routes/staff.js';
import adminRoutes from './routes/admin.js';
import salesRoutes from './routes/sales.js';
import connectRoutes from './routes/connect.js';
import phoneRoutes from './routes/sms-ivr.js';
import { sendDailyReports } from './services/dailyReport.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Seed default site content file if missing
const siteContentPath = join(process.env.DATA_DIR || '/data', 'site_content.json');
if (!existsSync(siteContentPath)) {
  try {
    const defaults = {
      'home.hero_title': 'Effortless Event Ticketing for Your Community',
      'home.hero_subtitle': 'Sell tickets online, manage attendees, scan at the door — all in one place.',
      'home.cta_primary': 'Get Started Free',
      'home.cta_secondary': 'See Pricing',
      'home.feature1_title': 'Sell Tickets Online',
      'home.feature1_body': 'Beautiful sale pages with Stripe payments, promo codes, and real-time capacity tracking.',
      'home.feature2_title': 'Manage Attendees',
      'home.feature2_body': 'Upload lists, assign seating, send tickets via email with professional PDF attachments.',
      'home.feature3_title': 'Scan at the Door',
      'home.feature3_body': 'QR code scanner on any phone. Multiple entrances, staff tickets, real-time counts.',
      'home.feature4_title': 'Staff & Access Control',
      'home.feature4_body': 'Separate staff ticket system with ID badge PDFs. Restrict scanners to specific levels.',
      'pricing.title': 'Simple, Transparent Pricing',
      'pricing.subtitle': 'Start free with a demo event. Upgrade when you\'re ready to go live.',
      'pricing.tier1_name': 'Demo', 'pricing.tier1_price': 'Free', 'pricing.tier1_desc': 'Try everything with a demo event. No credit card.',
      'pricing.tier1_features': 'Full portal access\nDemo event with sample data\nAll features unlocked\nNo live events',
      'pricing.tier2_name': 'Starter', 'pricing.tier2_price': '$49', 'pricing.tier2_period': 'per event',
      'pricing.tier2_desc': 'Everything you need for a single event.',
      'pricing.tier2_features': '1 live event\nOnline ticket sales\nEmail delivery\nDoor scanner',
      'pricing.tier3_name': 'Pro', 'pricing.tier3_price': '$99', 'pricing.tier3_period': 'per month',
      'pricing.tier3_desc': 'For organizations running events regularly.',
      'pricing.tier3_features': 'Unlimited events\nAll features\nPriority support',
      'faq.title': 'Frequently Asked Questions',
      'faq.items': JSON.stringify([
        { q: 'Do I need a credit card to sign up?', a: 'No. You can explore the full system with a demo event at no cost.' },
        { q: 'How does payment processing work?', a: 'You connect your own Stripe account. All funds go directly to you.' },
        { q: 'Can I import my existing attendee list?', a: 'Yes. Upload a CSV or Excel file and the system imports and sends tickets automatically.' },
        { q: 'How does the door scanner work?', a: 'Any phone or tablet with a camera can scan QR codes. Create a PIN per entrance.' },
        { q: 'What is a staff ticket?', a: 'Staff tickets use a business card ID badge format and are tracked separately from guests.' }
      ]),
      'terms.title': 'Terms and Conditions',
      'terms.last_updated': new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }),
      'terms.content': '<h2>1. Acceptance</h2><p>By using EverythingShul Ticket System you agree to these terms.</p><h2>2. Service</h2><p>We provide event ticketing software. Edit this content in Admin → Site Content.</p>'
    };
    writeFileSync(siteContentPath, JSON.stringify(defaults, null, 2));
    console.log('[startup] site_content.json created');
  } catch(e) { console.warn('[startup] could not write site_content.json:', e.message); }
}

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 }));

initMail();

// Maintenance mode — shows message to regular users, allows admin API through
app.use((req, res, next) => {
  if (process.env.MAINTENANCE_MODE !== '1') return next();
  // Always allow API calls through (so admin can restore and turn off maintenance)
  if (req.path.startsWith('/api/')) return next();
  // Serve a simple maintenance page to all website visitors
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HRTB Ticketing</title>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Arial,sans-serif;background:#0a0a0a;color:#f0ede8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .box{text-align:center;max-width:400px}.ico{font-size:48px;margin-bottom:20px}.h1{font-size:24px;font-weight:700;margin-bottom:10px}.p{font-size:14px;color:#888;line-height:1.7}
  .note{margin-top:24px;font-size:12px;color:#444}</style></head>
  <body><div class="box"><div class="ico">🎟</div><div class="h1">HRTB Ticketing</div>
  <div class="p">We're doing a quick update.<br>Please try again in a few minutes.<br>Your account and data are safe.</div>
  <div class="note">If you need access, contact your event organiser.</div>
  <div class="note" style="margin-top:32px"><a href="/admin.html" style="color:#444;font-size:11px">Admin access</a></div>
  </div></body></html>`);
});

// API routes
// Stripe webhook needs raw body
app.use('/api/sales/webhook', express.raw({ type: 'application/json' }));

app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/attendees', attendeeRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/connect', connectRoutes);
app.use('/api/phone', phoneRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sales', salesRoutes);

// Public event sales page — serve HTML for /events/:slug
app.get('/events/:slug', (req, res) => {
  res.sendFile('sale.html', { root: join(__dirname, '../frontend') });
});
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Serve the static HTML frontend from /frontend folder
const FRONTEND = join(__dirname, '../frontend');
app.use(express.static(FRONTEND));

// Any unknown route → serve index.html (so page refreshes work)
app.get('*', (_, res) => res.sendFile(join(FRONTEND, 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🎟  HRTB Ticketing running on http://localhost:${PORT}`);
  console.log(`   First time? Go to the URL and register — first account is auto-admin.\n`);

  // Daily report at midnight EST (America/New_York)
  function scheduleNextReport() {
    const nowEST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const nextMidnight = new Date(nowEST);
    nextMidnight.setHours(24, 0, 0, 0);
    const msUntil = nextMidnight - nowEST;
    console.log(`[report] Next daily report in ${Math.round(msUntil/60000)} minutes (midnight EST)`);
    setTimeout(() => {
      sendDailyReports().catch(e => console.error('[report]', e.message));
      scheduleNextReport();
    }, msUntil);
  }
  scheduleNextReport();

  // Automatic phone number expiry check — runs every 6 hours
  // No manual action needed. Sends 1-day warning emails, auto-cancels expired numbers.
  async function runExpiryCheck() {
    try {
      const db = (await import('./db.js')).default;
      const { sendMail } = await import('./services/mail.js');
      const now  = new Date().toISOString();
      const in24 = new Date(Date.now() + 24*60*60*1000).toISOString();

      // Auto-cancel AND release expired event phone numbers back to Twilio (stops billing)
      const expiredEvents = db.prepare(
        "SELECT e.*, a.email as owner_email, a.name as owner_name FROM events e JOIN accounts a ON a.id=e.account_id WHERE e.phone_number IS NOT NULL AND e.phone_number_expires IS NOT NULL AND e.phone_number_expires < ?"
      ).all(now);
      for (const ev of expiredEvents) {
        const num = ev.phone_number;
        // Release from Twilio first so billing stops
        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
          try {
            const twilioMod = await import('twilio');
            const client = twilioMod.default(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            const sid = ev.twilio_sid || (await client.incomingPhoneNumbers.list({ phoneNumber: num, limit:1 }).then(r => r[0]?.sid).catch(() => null));
            if (sid) {
              await client.incomingPhoneNumbers(sid).remove();
              console.log(`[expiry] Released ${num} (${sid}) back to Twilio`);
            }
          } catch(twilioErr) {
            console.warn(`[expiry] Could not release ${num} from Twilio:`, twilioErr.message);
          }
        }
        db.prepare("UPDATE events SET phone_number=NULL,phone_number_expires=NULL,sms_ivr_enabled=0,phone_number_notified=0,twilio_sid=NULL WHERE id=?").run(ev.id);
        sendMail({
          to: ev.owner_email,
          subject: `Phone number for "${ev.name}" has expired and been released`,
          html: `<p>Hi ${ev.owner_name},</p><p>The SMS/IVR phone number <strong>${num}</strong> for your event <strong>${ev.name}</strong> has expired. The number has been automatically released — Twilio billing for it has stopped. Contact us to get a new number.</p>`
        }).catch(() => {});
        console.log(`[expiry] Cancelled number ${num} for event ${ev.id} (${ev.name})`);
      }

      // Send 1-day expiry warning for event numbers expiring within 24h
      const expiringEvents = db.prepare(
        "SELECT e.*, a.email as owner_email, a.name as owner_name FROM events e JOIN accounts a ON a.id=e.account_id WHERE e.phone_number IS NOT NULL AND e.phone_number_expires IS NOT NULL AND e.phone_number_expires > ? AND e.phone_number_expires <= ? AND e.phone_number_notified=0"
      ).all(now, in24);
      for (const ev of expiringEvents) {
        const expDate = new Date(ev.phone_number_expires).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
        sendMail({
          to: ev.owner_email,
          subject: `Phone number for "${ev.name}" expires tomorrow — action required`,
          html: `<p>Hi ${ev.owner_name},</p><p>The SMS/IVR phone number <strong>${ev.phone_number}</strong> for your event <strong>${ev.name}</strong> expires <strong>tomorrow (${expDate})</strong>.</p><p>After expiry it will be automatically deactivated. Contact us today to renew.</p>`
        }).catch(() => {});
        db.prepare("UPDATE events SET phone_number_notified=1 WHERE id=?").run(ev.id);
        console.log(`[expiry] Sent 1-day warning for event ${ev.id} (${ev.name})`);
      }
    } catch(e) { console.error('[expiry check]', e.message); }
  }

  // Run immediately on startup, then every 6 hours
  runExpiryCheck();
  setInterval(runExpiryCheck, 6 * 60 * 60 * 1000);
});
