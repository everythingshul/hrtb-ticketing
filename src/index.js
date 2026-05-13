import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initMail } from './services/mail.js';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import attendeeRoutes from './routes/attendees.js';
import adminRoutes from './routes/admin.js';
import salesRoutes from './routes/sales.js';
import { sendDailyReports } from './services/dailyReport.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

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
    // Get current time in EST
    const nowEST = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    // Next midnight EST
    const nextMidnight = new Date(nowEST);
    nextMidnight.setHours(24, 0, 0, 0);
    const msUntil = nextMidnight - nowEST;
    console.log(`[report] Next daily report in ${Math.round(msUntil/60000)} minutes (midnight EST)`);
    setTimeout(() => {
      sendDailyReports().catch(e => console.error('[report]', e.message));
      scheduleNextReport(); // schedule next one
    }, msUntil);
  }
  scheduleNextReport();
});
