import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import * as XLSX from 'xlsx';
import db from '../db.js';
import { auth, adminOnly } from '../middleware/auth.js';
import { sendMail, inviteEmail } from '../services/mail.js';

const r = Router();

// Public: homepage/FAQ/terms/pricing content is read by anonymous visitors
// (landing, pricing, faq, terms pages) - must stay ahead of the auth gate below.
r.get('/site-content', (req, res) => {
  const content = readSiteContent();

  // ── Homepage defaults (shown when admin hasn't customized yet) ──
  const homeDefaults = {
    'home.hero_title':        'Event Ticketing That *Works the Way You Do*',
    'home.hero_subtitle':     'Sell tickets online, manage attendees, scan at the door - and let guests buy by phone or SMS. No tech skills needed.',
    'home.cta_primary':       'Get Started Free',
    'home.cta_secondary':     'View Pricing',
    'home.channels_eyebrow':  'Multiple ways to sell',
    'home.channels_title':    'Meet your guests where they are',
    'home.channels_sub':      'Not everyone buys tickets online. Mamudem lets guests purchase the way they prefer.',
    'home.ch1_title':         'Online Sales Page',
    'home.ch1_desc':          'A beautiful, mobile-friendly ticket page with Stripe payments, promo codes, and real-time availability.',
    'home.ch2_title':         'IVR Phone Ordering',
    'home.ch2_desc':          'Guests call a dedicated number, navigate a menu by keypad, and pay with their card - fully automated, no staff needed.',
    'home.ch3_title':         'SMS Ordering',
    'home.ch3_desc':          'Guests text your number, get a conversational checkout experience, and pay by card - no app, no login required.',
    'home.ch4_title':         'Staff Portal Sale',
    'home.ch4_desc':          'Sell tickets manually through the admin portal - no payment required from the buyer, great for at-the-door sales.',
    'home.features_eyebrow':  'Everything included',
    'home.features_title':    'All the tools you need',
    'home.f1_title': 'Attendee Management', 'home.f1_desc': 'Upload lists, assign seating, send individual or bulk tickets with professional PDF attachments.',
    'home.f2_title': 'Door Scanner',         'home.f2_desc': 'Any phone or tablet scans QR codes. Multiple entrances, staff tickets, live check-in counts.',
    'home.f3_title': 'Staff Tickets',        'home.f3_desc': 'Separate staff system with ID badge PDFs. Restrict scanners to ticket levels per entrance.',
    'home.f4_title': 'Promo Codes',          'home.f4_desc': 'Percentage or fixed discounts with usage limits, expiry dates, and email restrictions.',
    'home.f5_title': 'Your Own Stripe',      'home.f5_desc': 'Connect your Stripe account. All funds go directly to you - we never touch your money.',
    'home.f6_title': 'Reports & Stats',      'home.f6_desc': 'Real-time dashboard with check-in rates, revenue, level breakdowns, and daily email reports.',
    'home.f7_title': 'Demo Mode',            'home.f7_desc': 'Every account starts with a full demo event loaded with sample data - explore everything before going live.',
    'home.f8_title': 'Capacity Control',     'home.f8_desc': 'Set max tickets per event or per level, with automatic alerts when getting close.',
    'home.how_eyebrow':  'Simple setup',
    'home.how_title':    'Up and running in minutes',
    'home.step1_title':  'Create your account', 'home.step1_desc': 'Sign up free. Your demo event is ready instantly with sample data to explore.',
    'home.step2_title':  'Connect Stripe',       'home.step2_desc': 'Link your own Stripe account. All ticket revenue goes directly to you.',
    'home.step3_title':  'Create your event',    'home.step3_desc': 'Add details, set ticket levels, enable online sales, phone ordering, or both.',
    'home.step4_title':  'Sell & scan',          'home.step4_desc': 'Share your ticket link, scan QR codes at the door, track everything in real time.',
    'home.cta_band_title': 'Ready to run a better event?',
    'home.cta_band_sub':   'Start free with a full demo - no credit card required.',
    'home.cta_band_btn':   'Create Your Free Account',
    'home.logos_eyebrow':  'Our customers',
    'home.logos_title':    'Organizations that trust us',
    'home.logos_sub':      'Contact us to have your organization featured here.',
  };
  for (const [k, v] of Object.entries(homeDefaults)) {
    if (!content[k]) content[k] = v;
  }
  // Always inject default FAQ and terms if not set (handles fresh deploys)
  if (!content['faq.items'] || content['faq.items'] === '[]') {
    content['faq.items'] = JSON.stringify([
      { q: 'Do I need a credit card to sign up?', a: 'No. You can sign up and explore every feature with a full demo event at no cost. A payment is only required when you create your first real live event.' },
      { q: 'How does ticket payment processing work?', a: 'You connect your own Stripe account. When guests buy tickets online, the money goes directly into your Stripe account - we never touch it.' },
      { q: 'Can guests buy tickets by phone or SMS?', a: 'Yes! Mamudem supports fully automated IVR phone ordering (guests call a dedicated number and pay by keypad) and SMS text ordering (guests text to buy). Contact us to get a number assigned to your event.' },
      { q: 'Can I import my existing guest list?', a: 'Yes. Upload a CSV or Excel file and the system will import everyone, match any existing records, and optionally email tickets automatically.' },
      { q: 'How does the door scanner work?', a: 'Any phone or tablet with a camera can scan QR codes. Create a scanner PIN for each entrance - staff open the scanner page on any device. No app download required. Multiple entrances can run simultaneously.' },
      { q: 'Can different entrances admit different ticket types?', a: 'Yes. Each scanner PIN can be restricted to specific ticket levels. Your VIP entrance only admits VIP tickets, your general entrance admits general tickets, and staff always scan through.' },
      { q: 'What is a staff ticket?', a: 'Staff tickets are completely separate from guest tickets. They use a business card-size ID badge PDF, are tracked on their own Staff page, do not count toward capacity, and always scan as Access Granted.' },
      { q: 'Can I set a capacity limit per event?', a: 'Yes. Set a maximum per event or per ticket level, with optional email alerts when you are getting close to selling out. Online sales stop automatically when capacity is reached.' },
      { q: 'What happens when my event ends?', a: 'Events automatically close 48 hours after the end date you set. A closed event becomes read-only - you can still view all stats and attendee info, but no changes can be made. Admins can reopen any time.' },
      { q: 'Can I run multiple events at the same time?', a: 'Yes, there is no limit. Each event has its own ticket levels, sale page, scanner PINs, promo codes, and attendee list.' },
      { q: 'What are promo codes?', a: 'Promo codes let you offer discounts - percentage off, fixed dollar amount, expiry date, maximum uses, spending cap, or restriction to specific emails. Buyers enter the code at checkout.' },
      { q: 'Is my data secure?', a: 'Yes. All data is stored on your private server. Passwords are hashed. Stripe handles all payment card data - we never store card numbers. For phone and SMS orders, card digits go directly from Twilio to Stripe in memory and are never written anywhere.' },
    ]);
  }
  if (!content['terms.content'] || content['terms.content'].length < 200) {
    content['terms.content'] = `<h2>1. Acceptance of Terms</h2>
<p>By creating an account and using the Mamudem, you agree to these Terms and Conditions in full. If you do not agree, do not use the Service.</p>
<h2>2. Description of Service</h2>
<p>Mamudem is a software platform for selling event tickets, managing attendees, processing check-ins, and collecting payments. We are a software provider - we do not organize events or sell tickets on behalf of users.</p>
<h2>3. Account Registration</h2>
<p>You must provide accurate information when registering. You are responsible for all activity under your account. Notify us of any unauthorized access at <a href="mailto:mamudem@gmail.com">mamudem@gmail.com</a>.</p>
<h2>4. Demo Accounts</h2>
<p>New accounts start in Demo Mode with a free demo event. Demo accounts cannot process real payments. Purchase a plan to run live events. Your demo event remains free indefinitely.</p>
<h2>5. Payments and Billing</h2>
<p>Creating live events requires a one-time fee per event. Fees are non-refundable except where required by law. All payments are processed via Stripe. You agree to Stripe's Terms of Service.</p>
<h2>6. Ticket Sales and Payment Processing</h2>
<p>Online ticket sales are processed through your own connected Stripe account. All ticket revenue goes directly to you - we never hold your funds. You are responsible for refunds, disputes, and compliance with consumer protection laws.</p>
<p>Phone and SMS orders are processed through our platform Stripe account under MOTO approval. You are responsible for compliance with card network rules when enabling phone ordering.</p>
<h2>7. Your Data and Attendee Information</h2>
<p>You own your event data and attendee information. We process it only to provide the Service. We do not sell or share your data. You are responsible for obtaining consent from attendees as required by applicable privacy laws.</p>
<h2>8. Acceptable Use</h2>
<p>You agree not to use the Service for unlawful purposes including fraud, phishing, or spam. We may suspend accounts that violate these terms without notice.</p>
<h2>9. Service Availability</h2>
<p>We aim for maximum uptime but do not guarantee uninterrupted availability. We recommend exporting your attendee list before major events as a precaution.</p>
<h2>10. Limitation of Liability</h2>
<p>The Service is provided "as is" without warranty. To the maximum extent permitted by law, Mamudem is not liable for indirect, incidental, or consequential damages from your use of the platform.</p>
<h2>11. Changes to These Terms</h2>
<p>We may update these Terms at any time. Continued use constitutes acceptance. Check this page periodically.</p>
<h2>12. Contact Us</h2>
<p>For questions about these Terms, use the <a href="/index.html#contact">Contact Us</a> form on our website.</p>`;
  }
  if (!content['terms.title']) content['terms.title'] = 'Terms and Conditions';
  if (!content['faq.title']) content['faq.title'] = 'Frequently Asked Questions';
  res.json({ content });
});

r.use(auth, adminOnly);

// ── FULL EXCEL EXPORT ─────────────────────────────────────
// One workbook per account, one sheet per event + logins sheet
r.get('/export-excel', (req, res) => {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const accounts = db.prepare("SELECT * FROM accounts WHERE role != 'scanner' AND deleted_at IS NULL ORDER BY name").all();
    const allEvents = db.prepare('SELECT * FROM events ORDER BY name').all();
    const allAttendees = db.prepare('SELECT * FROM attendees ORDER BY last_name, first_name').all();
    const allMembers = db.prepare(`SELECT m.*, u.name as member_name, u.email as member_email, u.role as member_role
      FROM account_members m JOIN accounts u ON u.id = m.user_id ORDER BY u.name`).all();

    // Build one giant workbook with clear sections
    const wb = XLSX.utils.book_new();

    // ── SHEET 1: Master Summary ──────────────────────────
    const summaryRows = [
      ['HRTB TICKETING SYSTEM - FULL EXPORT'],
      [`Exported on: ${new Date().toLocaleString()}`],
      [''],
      ['ACCOUNT SUMMARY'],
      ['Account Name', 'Email', 'Role', 'Active', 'Total Events', 'Total Attendees', 'Checked In', 'Joined'],
    ];
    for (const acc of accounts) {
      const events = allEvents.filter(e => e.account_id === acc.id);
      const attendees = allAttendees.filter(a => a.account_id === acc.id);
      const checkedIn = attendees.filter(a => a.status === 'checked').length;
      summaryRows.push([
        acc.name,
        acc.email,
        acc.role.toUpperCase(),
        acc.is_active ? 'Yes' : 'No',
        events.length,
        attendees.length,
        checkedIn,
        acc.created_at?.slice(0, 10) || ''
      ]);
    }
    summaryRows.push(['']);
    summaryRows.push(['SYSTEM TOTALS']);
    summaryRows.push(['Total Accounts', accounts.length]);
    summaryRows.push(['Total Events', allEvents.length]);
    summaryRows.push(['Total Attendees', allAttendees.length]);
    summaryRows.push(['Total Checked In', allAttendees.filter(a => a.status === 'checked').length]);
    summaryRows.push(['Total Tickets Sent', allAttendees.filter(a => a.status === 'sent').length]);
    summaryRows.push(['Total Pre-printed', allAttendees.filter(a => a.status === 'preprint').length]);

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSummary['!cols'] = [{ wch: 28 }, { wch: 32 }, { wch: 12 }, { wch: 8 }, { wch: 14 }, { wch: 18 }, { wch: 12 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, '📊 Summary');

    // ── SHEET 2: All Logins ──────────────────────────────
    const loginRows = [
      ['ALL ACCOUNT LOGINS'],
      ['Note: Passwords are encrypted and cannot be shown. Users must use their own passwords.'],
      [''],
      ['Name', 'Email', 'Role', 'Active', 'Account Type', 'Member Of', 'Joined Date'],
    ];
    for (const acc of accounts) {
      const memberOf = allMembers.filter(m => m.user_id === acc.id).map(m => {
        const ownerAcc = accounts.find(a => a.id === m.account_id);
        return ownerAcc ? ownerAcc.name : '';
      }).filter(Boolean).join(', ');
      loginRows.push([
        acc.name,
        acc.email,
        acc.role.toUpperCase(),
        acc.is_active ? 'Yes' : 'No',
        acc.role === 'admin' ? 'System Admin' : 'User',
        memberOf || '-',
        acc.created_at?.slice(0, 10) || ''
      ]);
    }
    const wsLogins = XLSX.utils.aoa_to_sheet(loginRows);
    wsLogins['!cols'] = [{ wch: 24 }, { wch: 32 }, { wch: 10 }, { wch: 8 }, { wch: 16 }, { wch: 24 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsLogins, '👤 All Logins');

    // ── PER-ACCOUNT SHEETS ───────────────────────────────
    for (const acc of accounts) {
      const accEvents = allEvents.filter(e => e.account_id === acc.id);
      const accMembers = allMembers.filter(m => m.account_id === acc.id);

      // Account overview rows
      const accRows = [
        [`ACCOUNT: ${acc.name.toUpperCase()}`],
        [`Email: ${acc.email}   |   Role: ${acc.role.toUpperCase()}   |   Active: ${acc.is_active ? 'Yes' : 'No'}   |   Joined: ${acc.created_at?.slice(0,10)||''}`],
        [''],
        ['ACCOUNT MEMBERS'],
        ['Name', 'Email', 'Role', 'Added'],
      ];
      if (accMembers.length) {
        for (const m of accMembers) {
          accRows.push([m.member_name, m.member_email, m.role, m.added_at?.slice(0,10)||'']);
        }
      } else {
        accRows.push(['No team members']);
      }
      accRows.push(['']);
      accRows.push(['EVENTS OVERVIEW']);
      accRows.push(['Event Name', 'Date', 'Venue', 'Total', 'Pending', 'Sent', 'Checked In', 'Pre-printed', 'Deactivated']);

      for (const ev of accEvents) {
        const evAtt = allAttendees.filter(a => a.event_id === ev.id);
        accRows.push([
          ev.name,
          ev.date || '-',
          ev.venue || '-',
          evAtt.length,
          evAtt.filter(a => a.status === 'pending').length,
          evAtt.filter(a => a.status === 'sent').length,
          evAtt.filter(a => a.status === 'checked').length,
          evAtt.filter(a => a.status === 'preprint').length,
          evAtt.filter(a => a.status === 'deactivated').length,
        ]);
      }

      // Safe sheet name (max 31 chars, no special chars)
      const sheetName = ('🏢 ' + acc.name).slice(0, 31).replace(/[\/\\*\[\]?:]/g, '');
      const wsAcc = XLSX.utils.aoa_to_sheet(accRows);
      wsAcc['!cols'] = [{ wch: 28 }, { wch: 20 }, { wch: 20 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, wsAcc, sheetName);

      // ── One sheet per event under this account ────────
      for (const ev of accEvents) {
        const evAtt = allAttendees.filter(a => a.event_id === ev.id);
        const evRows = [
          [`EVENT: ${ev.name.toUpperCase()}`],
          [`Account: ${acc.name}   |   Date: ${ev.date||'-'}   |   Venue: ${ev.venue||'-'}`],
          [`Total: ${evAtt.length}   |   Checked In: ${evAtt.filter(a=>a.status==='checked').length}   |   Sent: ${evAtt.filter(a=>a.status==='sent').length}   |   Pending: ${evAtt.filter(a=>a.status==='pending').length}`],
          [''],
          ['ATTENDEES'],
          ['Ticket ID', 'First Name', 'Last Name', 'Phone', 'Email', 'Table', 'Seat', 'Status', 'Ticket Sent', 'Checked In At', 'Added On'],
        ];
        const statusLabel = { pending: 'Pending', preprint: 'Pre-printed', sent: 'Sent', checked: 'Checked In', deactivated: 'Deactivated' };
        for (const a of evAtt) {
          evRows.push([
            a.ticket_id,
            a.first_name || '-',
            a.last_name || '-',
            a.phone || '-',
            a.email || '-',
            a.table_number || '-',
            a.seat_number || '-',
            statusLabel[a.status] || a.status,
            a.sent_at?.slice(0,16).replace('T',' ') || '-',
            a.checked_in_at?.slice(0,16).replace('T',' ') || '-',
            a.created_at?.slice(0,10) || '-',
          ]);
        }
        if (!evAtt.length) evRows.push(['No attendees yet']);

        // Event sheet name: first 28 chars of event name
        const evSheetName = ('  📅 ' + ev.name).slice(0, 31).replace(/[\/\\*\[\]?:]/g, '');
        const wsEv = XLSX.utils.aoa_to_sheet(evRows);
        wsEv['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 26 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 12 }];
        XLSX.utils.book_append_sheet(wb, wsEv, evSheetName);
      }
    }

    // Write and send
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="HRTB-Full-Export-${date}.xlsx"`);
    res.send(buf);
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});
// ── Update reply-to for an account ───────────────────────
r.patch('/accounts/:id/reply-to', (req, res) => {
  const { reply_to } = req.body;
  const a = db.prepare('SELECT id FROM accounts WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Account not found' });
  db.prepare('UPDATE accounts SET reply_to=? WHERE id=?').run(reply_to || null, req.params.id);
  res.json({ ok: true });
});

r.patch('/accounts/:id/max-events', (req, res) => {
  const { max_events } = req.body;
  const val = parseInt(max_events);
  if (isNaN(val) || val < 1) return res.status(400).json({ error: 'Must be at least 1' });
  db.prepare('UPDATE accounts SET max_events=? WHERE id=?').run(val, req.params.id);
  res.json({ ok: true });
});

// ── BACKUP - full raw SQLite snapshot (every table, always complete) ─
// Uses better-sqlite3's built-in WAL-safe backup API rather than a hand-rolled
// table-by-table JSON export, which silently drops data whenever a new table
// is added and someone forgets to update this route.
r.get('/backup', async (req, res) => {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpPath = path.join(os.tmpdir(), `hrtb-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    await db.backup(tmpPath);
    const date = new Date().toISOString().slice(0,10);
    res.download(tmpPath, `hrtb-backup-${date}.db`, (err) => {
      fs.unlink(tmpPath, () => {});
      if (err && !res.headersSent) res.status(500).json({ error: err.message });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RESTORE - replaces the live database file with an uploaded .db backup ─
// Live connections can't be hot-swapped (every route module holds its own
// reference to the open db object), so this writes the file and requires a
// server restart to take effect - the response says so explicitly.
r.post('/restore', async (req, res) => {
  try {
    const multer   = (await import('multer')).default;
    const fs       = await import('fs');
    const path     = await import('path');
    const Database = (await import('better-sqlite3')).default;
    const dataDir  = process.env.DATA_DIR || '/data';
    const upload   = multer({ dest: dataDir, limits: { fileSize: 500 * 1024 * 1024 } });

    upload.single('backup')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const uploadedPath = req.file.path;

      const cleanup = () => {
        for (const p of [uploadedPath, uploadedPath + '-wal', uploadedPath + '-shm']) {
          try { fs.unlinkSync(p); } catch {}
        }
      };

      // Validate SQLite file header
      const header = Buffer.alloc(16);
      const fd = fs.openSync(uploadedPath, 'r');
      fs.readSync(fd, header, 0, 16, 0);
      fs.closeSync(fd);
      if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
        cleanup();
        return res.status(400).json({ error: 'Not a valid SQLite database file' });
      }

      // Sanity check: does it look like a Mamudem backup?
      try {
        const testDb = new Database(uploadedPath, { readonly: true });
        const hasAccounts = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get();
        testDb.close();
        if (!hasAccounts) throw new Error('missing accounts table');
      } catch(e) {
        cleanup();
        return res.status(400).json({ error: 'File does not look like a Mamudem backup: ' + e.message });
      }

      const liveDbPath = path.join(dataDir, 'hrtb.db');
      const preRestoreBackup = path.join(dataDir, `hrtb-pre-restore-${Date.now()}.db`);
      try { fs.copyFileSync(liveDbPath, preRestoreBackup); } catch {}
      fs.copyFileSync(uploadedPath, liveDbPath);
      // Clear any stale WAL/SHM sidecar files so the next startup reads the
      // restored file cleanly instead of trying to replay the old session's WAL
      for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(liveDbPath + suffix); } catch {}
      }
      cleanup();

      res.json({ ok: true, message: 'Backup restored. Restart the server for the changes to take effect.' });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MAINTENANCE MODE - shows "login lost" message to users ─
r.post('/maintenance', (req, res) => {
  process.env.MAINTENANCE_MODE = req.body.enabled ? '1' : '';
  res.json({ ok: true, maintenance: !!req.body.enabled });
});

r.get('/maintenance', (req, res) => {
  res.json({ maintenance: process.env.MAINTENANCE_MODE === '1' });
});

// ── Send a test email using whichever provider is currently configured ─
r.post('/test-email', async (req, res) => {
  const to = req.body.to || req.user.email;
  try {
    await sendMail({
      to,
      subject: 'Mamudem test email',
      html: `<p>This is a test email from your Mamudem admin panel.</p><p>If you received this, your email delivery is configured correctly.</p>`,
    });
    res.json({ ok: true, to });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

r.get('/stats', (req, res) => {
  try {
    res.json({ stats: {
      accounts:  db.prepare("SELECT COUNT(*) c FROM accounts WHERE role != 'scanner' AND demo_mode=0").get().c,
      events:    db.prepare("SELECT COUNT(*) c FROM events e JOIN accounts a ON a.id=e.account_id WHERE a.demo_mode=0 AND e.deleted_at IS NULL").get().c,
      attendees: db.prepare("SELECT COUNT(*) c FROM attendees att JOIN events e ON e.id=att.event_id JOIN accounts a ON a.id=e.account_id WHERE a.demo_mode=0").get().c,
      sent:      db.prepare("SELECT COUNT(*) c FROM attendees att JOIN events e ON e.id=att.event_id JOIN accounts a ON a.id=e.account_id WHERE a.demo_mode=0 AND att.status='sent'").get().c,
      checkedIn: db.prepare("SELECT COUNT(*) c FROM attendees att JOIN events e ON e.id=att.event_id JOIN accounts a ON a.id=e.account_id WHERE a.demo_mode=0 AND att.status='checked'").get().c,
    }});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin invite new account (no password set by admin) ──
r.post('/invite-account', async (req, res) => {
  try {
    const { email, role = 'user', name = '' } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!name.trim()) return res.status(400).json({ error: 'Name required' });

    // Only block if an ACTIVE account already exists
    const activeExists = db.prepare('SELECT id FROM accounts WHERE email=? AND is_active=1').get(email.toLowerCase());
    if (activeExists) return res.status(409).json({ error: 'An active account already exists for this email' });

    // Remove any old provisional (unaccepted) account for this email so we start fresh
    const oldProvisional = db.prepare('SELECT id FROM accounts WHERE email=? AND is_active=0').get(email.toLowerCase());
    if (oldProvisional) {
      db.prepare('DELETE FROM invite_tokens WHERE account_id=?').run(oldProvisional.id);
      db.prepare('DELETE FROM accounts WHERE id=?').run(oldProvisional.id);
    }

    const token = uuid().replace(/-/g,'') + uuid().replace(/-/g,'');
    const expires = new Date(Date.now() + 48*60*60*1000).toISOString();

    // Create provisional account with the name the admin entered
    const tempId = uuid();
    const tempHash = await bcrypt.hash(uuid(), 8);
    db.prepare('INSERT INTO accounts (id,name,email,password_hash,role,is_active) VALUES (?,?,?,?,?,0)')
      .run(tempId, name.trim(), email.toLowerCase(), tempHash, role);

    db.prepare('INSERT INTO invite_tokens (id,account_id,email,token,role,expires_at) VALUES (?,?,?,?,?,?)')
      .run(uuid(), tempId, email.toLowerCase(), token, role, expires);

    const appUrl = process.env.APP_URL || 'http://localhost:3001';
    const url = `${appUrl}/register.html?token=${token}&email=${encodeURIComponent(email)}`;

    await sendMail({
      to: email,
      subject: `You're invited to Mamudem`,
      html: inviteEmail({ fromName: req.user.name, accountName: 'Mamudem', url, role })
    });

    res.json({ ok: true });
  } catch(e) { console.error('[invite-account]', e); res.status(500).json({ error: e.message }); }
});

r.get('/accounts', (req, res) => {
  try {
    const accounts = db.prepare("SELECT * FROM accounts WHERE role != 'scanner' AND deleted_at IS NULL ORDER BY created_at DESC").all();
    const enriched = accounts.map(a => {
      const { password_hash, ...safe } = a;
      return {
        ...safe,
        eventCount: db.prepare('SELECT COUNT(*) c FROM events WHERE account_id=?').get(a.id).c,
        members: db.prepare('SELECT u.id,u.name,u.email,m.role FROM account_members m JOIN accounts u ON u.id=m.user_id WHERE m.account_id=?').all(a.id)
      };
    });
    res.json({ accounts: enriched });
  } catch(e) { console.error('[admin/accounts]', e.message); res.status(500).json({ error: e.message }); }
});

r.post('/accounts', async (req, res) => {
  try {
    const { name, email, password, role='user' } = req.body;
    if (!name||!email||!password) return res.status(400).json({ error: 'Name, email and password required' });
    if (db.prepare('SELECT id FROM accounts WHERE email=?').get(email.toLowerCase())) return res.status(409).json({ error: 'Email already exists' });
    const hash = await bcrypt.hash(password, 12);
    const id = uuid();
    db.prepare('INSERT INTO accounts (id,name,email,password_hash,role) VALUES (?,?,?,?,?)').run(id, name, email.toLowerCase(), hash, role);
    res.json({ account: db.prepare('SELECT id,name,email,role,is_active,created_at FROM accounts WHERE id=?').get(id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

r.patch('/accounts/:id/toggle', (req, res) => {
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.id === req.user.id) return res.status(400).json({ error: 'Cannot disable yourself' });
  db.prepare('UPDATE accounts SET is_active=? WHERE id=?').run(a.is_active?0:1, a.id);
  res.json({ ok: true, is_active: !a.is_active });
});

// Delete account permanently
r.delete('/accounts/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  // Soft delete - mark deleted_at, keep data for 30 days
  db.prepare("UPDATE accounts SET deleted_at=datetime('now'),is_active=0 WHERE id=?").run(a.id);
  db.prepare('DELETE FROM account_members WHERE user_id=? OR account_id=?').run(a.id, a.id);
  db.prepare('DELETE FROM invite_tokens WHERE account_id=?').run(a.id);
  res.json({ ok: true });
});

r.patch('/accounts/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['admin','user'].includes(role)) return res.status(400).json({ error: 'Role must be admin or user' });
  if (req.params.id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'Cannot demote yourself' });
  // Bump token_version to invalidate all existing sessions for this user
  db.prepare('UPDATE accounts SET role=?, token_version=token_version+1 WHERE id=?').run(role, req.params.id);
  res.json({ ok: true });
});

r.delete('/accounts/:accountId/members/:userId', (req, res) => {
  db.prepare('DELETE FROM account_members WHERE account_id=? AND user_id=?').run(req.params.accountId, req.params.userId);
  res.json({ ok: true });
});

r.get('/events', (req, res) => {
  try {
    const showDemo = req.query.demo === '1'; // ?demo=1 to include demo events
    const events = db.prepare(`
      SELECT e.*,
        COALESCE(a.name, '(deleted account)') as account_name,
        a.demo_mode,
        (SELECT COUNT(*) FROM attendees WHERE event_id=e.id AND deleted_at IS NULL AND (source IS NULL OR source!='staff')) as attendee_count,
        (SELECT COUNT(*) FROM attendees WHERE event_id=e.id AND deleted_at IS NULL AND source='staff') as staff_count
      FROM events e
      LEFT JOIN accounts a ON a.id=e.account_id
      WHERE e.deleted_at IS NULL ${showDemo ? '' : 'AND (a.demo_mode=0 OR a.demo_mode IS NULL)'}
      ORDER BY e.created_at DESC
    `).all();
    res.json({ events });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Single event by ID (used by admin-phone and others)
r.get('/events/:id', (req, res) => {
  try {
    const ev = db.prepare(`
      SELECT e.*,
        COALESCE(a.name, '(deleted account)') as account_name,
        a.email as account_email,
        (SELECT COUNT(*) FROM attendees WHERE event_id=e.id AND deleted_at IS NULL AND (source IS NULL OR source!='staff')) as attendee_count
      FROM events e
      LEFT JOIN accounts a ON a.id=e.account_id
      WHERE e.id=?
    `).get(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: ev });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug: check staff data
r.get('/debug-staff/:eventId', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).end();
  const levels = db.prepare('SELECT id, name, is_staff FROM ticket_levels WHERE event_id=?').all(req.params.eventId);
  const staffLevelIds = levels.filter(l=>l.is_staff).map(l=>l.id);
  const allAtt = db.prepare('SELECT id, first_name, last_name, source, level_id, status FROM attendees WHERE event_id=? AND deleted_at IS NULL').all(req.params.eventId);
  res.json({ levels, staffLevelIds, attendees: allAtt, staffAttendees: allAtt.filter(a=>a.source==='staff'), offlineWithStaffLevel: allAtt.filter(a=>a.source!=='staff'&&staffLevelIds.includes(a.level_id)) });
});

// Contact admin - sends email from SMTP to admin address, user sees a form
r.post('/contact', async (req, res) => {
  const { from_name, from_email, subject, message, event_name, event_id } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
  try {
    const { sendMail } = await import('../services/mail.js');
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || process.env.SUPPORT_EMAIL || 'mamudem@gmail.com';
    const body = `
      <p><strong>From:</strong> ${from_name||'Unknown'} &lt;${from_email||'no email'}&gt;</p>
      ${event_name ? `<p><strong>Event:</strong> ${event_name}${event_id ? ` (ID: ${event_id})` : ''}</p>` : ''}
      <p><strong>Subject:</strong> ${subject||'Support Request'}</p>
      <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
      <p style="white-space:pre-wrap">${message.replace(/</g,'&lt;')}</p>
    `;
    await sendMail({
      to: adminEmail,
      replyTo: from_email || undefined,
      subject: `[Mamudem Support] ${subject||'Support Request'}`,
      html: body
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

r.patch('/accounts/:id/email', (req, res) => {
  const { enabled } = req.body;
  db.prepare('UPDATE accounts SET can_send_email=? WHERE id=?').run(enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
r.patch('/accounts/:id/online-sales', (req, res) => {
  const { enabled } = req.body;
  db.prepare('UPDATE accounts SET can_sell_online=? WHERE id=?').run(enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// Admin: grant full access (bypass payment requirement)
r.post('/accounts/:id/grant-access', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare("UPDATE accounts SET demo_mode=0, can_sell_online=1, can_send_email=1 WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ── Transactions / CRM ───────────────────────────────────

// All account-level payments (event creation fees via Stripe)
r.get('/transactions/accounts', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    // Get all payment intents from account_transactions table if exists
    const rows = db.prepare(`
      SELECT at.*, a.name as account_name, a.email as account_email, e.name as event_name
      FROM account_transactions at
      LEFT JOIN accounts a ON a.id=at.account_id
      LEFT JOIN events e ON e.id=at.event_id
      ORDER BY at.created_at DESC LIMIT 500
    `).all();
    res.json({ transactions: rows });
  } catch(e) {
    // Table may not exist yet
    res.json({ transactions: [] });
  }
});

// ── Logo file upload ──────────────────────────────────────
r.post('/logos/upload', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const multer  = (await import('multer')).default;
    const pathMod = await import('path');
    const fs      = await import('fs');
    const logoDir = pathMod.join(process.env.DATA_DIR || '/data', 'logos');
    if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });
    const storage = multer.diskStorage({
      destination: logoDir,
      filename: (_req, file, cb) => {
        const ext = pathMod.extname(file.originalname).toLowerCase() || '.png';
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
      }
    });
    const upload = multer({
      storage,
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ok = file.mimetype.startsWith('image/');
        cb(ok ? null : new Error('Images only'), ok);
      }
    });
    upload.single('logo')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      // Return a simple static URL served by express.static
      const url = '/uploads/logos/' + req.file.filename;
      const name = (req.body.name || req.file.originalname).replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      res.json({ ok: true, url, name, filename: req.file.filename });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── IVR Audio Recording Upload ────────────────────────────
r.post('/ivr-audio/upload', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const multer  = (await import('multer')).default;
    const pathMod = await import('path');
    const fs      = await import('fs');
    const audioDir = pathMod.join(process.env.DATA_DIR || '/data', 'ivr-audio');
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
    const storage = multer.diskStorage({
      destination: audioDir,
      filename: (req, file, cb) => {
        const ext = pathMod.extname(file.originalname).toLowerCase() || '.mp3';
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
      }
    });
    const upload = multer({
      storage, limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (req, file, cb) => {
        const ok = /audio\//.test(file.mimetype) || /\.(mp3|wav|ogg|m4a|aac)$/i.test(file.originalname);
        cb(ok ? null : new Error('Audio files only (MP3, WAV, OGG, M4A)'), ok);
      }
    });
    upload.single('audio')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const url = `/api/admin/ivr-audio/file/${req.file.filename}`;
      res.json({ ok: true, url, filename: req.file.filename });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

r.get('/ivr-audio/file/:filename', async (req, res) => {
  const pathMod = await import('path');
  const file = pathMod.join(process.env.DATA_DIR || '/data', 'ivr-audio', req.params.filename.replace(/[^a-zA-Z0-9._-]/g, ''));
  res.sendFile(file, err => { if (err) res.status(404).end(); });
});

r.get('/ivr-audio/download/:filename', auth, async (req, res) => {
  const pathMod = await import('path');
  const file = pathMod.join(process.env.DATA_DIR || '/data', 'ivr-audio', req.params.filename.replace(/[^a-zA-Z0-9._-]/g, ''));
  res.download(file, req.query.name || req.params.filename, err => { if (err) res.status(404).end(); });
});

r.post('/transactions/cancel/:attendeeId', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    db.prepare("UPDATE attendees SET status='deactivated', updated_at=datetime('now') WHERE id=?").run(req.params.attendeeId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Refund by payment intent ID (for phone orders without attendee ID)
r.post('/transactions/refund-pi', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { payment_intent_id, amount_cents } = req.body;
  if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id required' });
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const params = {};
    if (amount_cents) params.amount = amount_cents;
    const refund = await stripe.refunds.create({ payment_intent: payment_intent_id, ...params });
    res.json({ ok: true, refund_id: refund.id, amount: refund.amount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
r.get('/transactions/tickets', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const page = parseInt(req.query.page)||1;
    const limit = 100;
    const offset = (page-1)*limit;
    const q = req.query.q ? `%${req.query.q}%` : null;
    const eventFilter = req.query.event_id || null;
    const channelFilter = req.query.channel || null;

    let where = "1=1";
    const args = [];
    if (q) { where += " AND (a.first_name LIKE ? OR a.last_name LIKE ? OR a.email LIKE ? OR a.ticket_id LIKE ?)"; args.push(q,q,q,q); }
    if (eventFilter) { where += " AND a.event_id=?"; args.push(eventFilter); }
    if (channelFilter === 'phone') { where += " AND a.source='phone'"; }
    else if (channelFilter === 'online') { where += " AND (a.source='online' OR a.source IS NULL)"; }

    const rows = db.prepare(`
      SELECT a.id, a.event_id, a.first_name, a.last_name, a.email, a.phone,
             a.ticket_id, a.status, a.source, a.level_id, a.created_at, a.sent_at, a.checked_in_at,
             a.checkout_data,
             e.name as event_name,
             acc.name as account_name, acc.email as account_email,
             tl.name as level_name, tl.price as level_price_cents,
             po.amount_cents as phone_amount_cents, po.channel, po.from_number,
             po.stripe_payment_intent_id as phone_pi_id
      FROM attendees a
      LEFT JOIN events e ON e.id=a.event_id
      LEFT JOIN accounts acc ON acc.id=e.account_id
      LEFT JOIN ticket_levels tl ON tl.id=a.level_id
      LEFT JOIN phone_orders po ON po.event_id=a.event_id AND po.attendee_email=a.email AND po.status='paid'
      WHERE a.deleted_at IS NULL AND ${where}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset);

    const total = db.prepare(`
      SELECT COUNT(*) c FROM attendees a
      LEFT JOIN events e ON e.id=a.event_id
      WHERE a.deleted_at IS NULL AND ${where}
    `).get(...args).c;

    // Parse checkout_data for amount
    const enriched = rows.map(r => {
      let amount = r.phone_amount_cents || r.level_price_cents || 0;
      let pi_id = r.phone_pi_id;
      if (!pi_id && r.checkout_data) {
        try {
          const cd = JSON.parse(r.checkout_data);
          pi_id = cd.payment_intent_id || cd.paymentIntentId;
          if (cd.amount) amount = cd.amount;
        } catch {}
      }
      return { ...r, amount_cents: amount, payment_intent_id: pi_id, channel: r.channel || (r.source==='online'?'online':'portal') };
    });

    res.json({ transactions: enriched, total, page, pages: Math.ceil(total/limit) });
  } catch(e) { console.error('[transactions/tickets]', e.message); res.status(500).json({ error: e.message }); }
});

// Refund a ticket
r.post('/transactions/refund/:attendeeId', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { cancel_ticket, amount_cents } = req.body;
  try {
    const att = db.prepare(`
      SELECT a.*, e.account_id, e.name as event_name, acc.stripe_connect_key,
             tl.price as level_price
      FROM attendees a
      LEFT JOIN events e ON e.id=a.event_id
      LEFT JOIN accounts acc ON acc.id=e.account_id
      LEFT JOIN ticket_levels tl ON tl.id=a.level_id
      WHERE a.id=?
    `).get(req.params.attendeeId);
    if (!att) return res.status(404).json({ error: 'Attendee not found' });

    // Find payment intent
    let piId = null;
    if (att.checkout_data) {
      try { const cd = JSON.parse(att.checkout_data); piId = cd.payment_intent_id || cd.paymentIntentId; } catch {}
    }
    // Also check phone_orders
    if (!piId) {
      const po = db.prepare("SELECT stripe_payment_intent_id FROM phone_orders WHERE event_id=? AND attendee_email=? AND status='paid' LIMIT 1").get(att.event_id, att.email);
      if (po) piId = po.stripe_payment_intent_id;
    }

    let refundResult = null;
    if (piId) {
      const stripeKey = att.stripe_connect_key || process.env.STRIPE_SECRET_KEY;
      const stripe = (await import('stripe')).default(stripeKey);
      const pi = await stripe.paymentIntents.retrieve(piId);
      const chargeId = pi.latest_charge;
      if (chargeId) {
        const refundParams = { charge: chargeId };
        if (amount_cents) refundParams.amount = parseInt(amount_cents);
        refundResult = await stripe.refunds.create(refundParams);
      }
    }

    if (cancel_ticket) {
      db.prepare("UPDATE attendees SET status='deactivated', deleted_at=datetime('now') WHERE id=?").run(att.id);
    }

    res.json({ ok: true, refund: refundResult, cancelled: !!cancel_ticket });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get all platform feature flags
r.get('/features', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const rows = db.prepare("SELECT key, value FROM platform_settings WHERE key LIKE 'feature.%'").all();
  res.json({ features: Object.fromEntries(rows.map(r => [r.key, r.value === '1'])) });
});

// Update platform feature flags
r.patch('/features', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { updates } = req.body;
  for (const [key, val] of Object.entries(updates || {})) {
    if (!key.startsWith('feature.')) continue;
    db.prepare('INSERT OR REPLACE INTO platform_settings (key,value) VALUES (?,?)').run(key, val ? '1' : '0');
  }
  res.json({ ok: true });
});

// Get feature overrides for an event
r.get('/events/:id/features', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const ev = db.prepare('SELECT features_locked FROM events WHERE id=?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  res.json({ features: JSON.parse(ev.features_locked || '{}') });
});

// Set feature overrides for an event (null = inherit platform default)
r.patch('/events/:id/features', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const ev = db.prepare('SELECT features_locked FROM events WHERE id=?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const current = JSON.parse(ev.features_locked || '{}');
  const { updates } = req.body;
  for (const [key, val] of Object.entries(updates || {})) {
    if (val === null || val === undefined) delete current[key];
    else current[key] = val ? 1 : 0;
  }
  db.prepare('UPDATE events SET features_locked=? WHERE id=?').run(JSON.stringify(current), req.params.id);
  res.json({ ok: true });
});

// Get feature overrides for an account
r.get('/accounts/:id/features', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const acct = db.prepare('SELECT features_locked FROM accounts WHERE id=?').get(req.params.id);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  res.json({ features: JSON.parse(acct.features_locked || '{}') });
});

// Set feature overrides for an account
r.patch('/accounts/:id/features', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const acct = db.prepare('SELECT features_locked FROM accounts WHERE id=?').get(req.params.id);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  const current = JSON.parse(acct.features_locked || '{}');
  const { updates } = req.body;
  for (const [key, val] of Object.entries(updates || {})) {
    if (val === null || val === undefined) delete current[key];
    else current[key] = val ? 1 : 0;
  }
  db.prepare('UPDATE accounts SET features_locked=? WHERE id=?').run(JSON.stringify(current), req.params.id);
  res.json({ ok: true });
});

// ── Trash & Restore (admin only) ─────────────────────────
// List deleted items within 30 days

r.get('/trash/attendees', (req, res) => {
  const items = db.prepare(`
    SELECT a.*, e.name as event_name, acc.name as account_name
    FROM attendees a
    JOIN events e ON e.id = a.event_id
    JOIN accounts acc ON acc.id = a.account_id
    WHERE a.deleted_at IS NOT NULL
    AND datetime(a.deleted_at,'+30 days') > datetime('now')
    ORDER BY a.deleted_at DESC
  `).all();
  res.json({ items });
});

r.get('/trash/events', (req, res) => {
  const items = db.prepare(`
    SELECT e.*, a.name as account_name,
      (SELECT COUNT(*) FROM attendees WHERE event_id=e.id AND deleted_at IS NULL) as live_attendees,
      (SELECT COUNT(*) FROM attendees WHERE event_id=e.id AND deleted_at IS NOT NULL) as deleted_attendees
    FROM events e
    JOIN accounts a ON a.id = e.account_id
    WHERE e.deleted_at IS NOT NULL
    AND datetime(e.deleted_at,'+30 days') > datetime('now')
    ORDER BY e.deleted_at DESC
  `).all();
  res.json({ items });
});

r.get('/trash/accounts', (req, res) => {
  const items = db.prepare(`
    SELECT * FROM accounts
    WHERE deleted_at IS NOT NULL
    AND datetime(deleted_at,'+30 days') > datetime('now')
    ORDER BY deleted_at DESC
  `).all().map(a => { const {password_hash, ...safe} = a; return safe; });
  res.json({ items });
});

// Restore a deleted attendee
r.post('/trash/attendees/:id/restore', (req, res) => {
  const a = db.prepare('SELECT * FROM attendees WHERE id=? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found or already restored' });
  db.prepare('UPDATE attendees SET deleted_at=NULL WHERE id=?').run(a.id);
  res.json({ ok: true, attendee: db.prepare('SELECT * FROM attendees WHERE id=?').get(a.id) });
});

// Restore a deleted event (and its attendees)
r.post('/trash/events/:id/restore', (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Not found or already restored' });
  db.prepare('UPDATE events SET deleted_at=NULL WHERE id=?').run(ev.id);
  // Restore attendees that were deleted at the same time as the event (within 1 minute)
  db.prepare(`UPDATE attendees SET deleted_at=NULL WHERE event_id=? AND deleted_at IS NOT NULL AND abs(strftime('%s',deleted_at)-strftime('%s',?)) < 120`).run(ev.id, ev.deleted_at);
  res.json({ ok: true });
});

// Restore a deleted account
r.post('/trash/accounts/:id/restore', (req, res) => {
  const a = db.prepare('SELECT * FROM accounts WHERE id=? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found or already restored' });
  db.prepare('UPDATE accounts SET deleted_at=NULL, is_active=1 WHERE id=?').run(a.id);
  res.json({ ok: true });
});

// Permanently delete (purge) from trash
r.delete('/trash/attendees/:id', (req, res) => {
  db.prepare('DELETE FROM attendees WHERE id=? AND deleted_at IS NOT NULL').run(req.params.id);
  res.json({ ok: true });
});

r.delete('/trash/events/:id', (req, res) => {
  const ev = db.prepare('SELECT id FROM events WHERE id=? AND deleted_at IS NOT NULL').get(req.params.id);
  if (ev) {
    db.prepare('DELETE FROM attendees WHERE event_id=?').run(ev.id);
    db.prepare('DELETE FROM events WHERE id=?').run(ev.id);
  }
  res.json({ ok: true });
});

r.delete('/trash/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id=? AND deleted_at IS NOT NULL').run(req.params.id);
  res.json({ ok: true });
});

// Debug: check staff data
r.get('/debug-staff/:eventId', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).end();
  const levels = db.prepare('SELECT id, name, is_staff FROM ticket_levels WHERE event_id=?').all(req.params.eventId);
  const staffLevelIds = levels.filter(l=>l.is_staff).map(l=>l.id);
  const allAtt = db.prepare('SELECT id, first_name, last_name, source, level_id, status FROM attendees WHERE event_id=? AND deleted_at IS NULL').all(req.params.eventId);
  const staffRows = db.prepare('SELECT id, first_name, last_name, level_id, status FROM staff WHERE event_id=? AND deleted_at IS NULL').all(req.params.eventId);
  res.json({ levels, staffLevelIds, attendees: allAtt, staffRows });
});

// ── Site content (CMS) - stored as JSON file, not DB ───────
import { readFileSync as rfs, writeFileSync as wfs, existsSync as efs } from 'fs';
import { join as pjoin } from 'path';

function getSiteContentPath() {
  const d = process.env.DATA_DIR || '/data';
  return pjoin(d, 'site_content.json');
}
function readSiteContent() {
  try { const p=getSiteContentPath(); if(efs(p)) return JSON.parse(rfs(p,'utf8')); } catch {}
  try { return Object.fromEntries(db.prepare('SELECT key,value FROM site_content').all().map(r=>[r.key,r.value])); } catch {}
  return {};
}
function writeSiteContent(c) { try { wfs(getSiteContentPath(), JSON.stringify(c, null, 2)); } catch(e) { console.error('site-content write error:', e.message); } }

r.patch('/site-content', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { updates } = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'updates object required' });
  const current = readSiteContent();
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      delete current[key]; // null means remove the key
    } else {
      current[key] = String(value); // always store as string
    }
  }
  writeSiteContent(current);
  res.json({ ok: true });
});


export default r;
