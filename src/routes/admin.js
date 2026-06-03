import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import * as XLSX from 'xlsx';
import db from '../db.js';
import { auth, adminOnly } from '../middleware/auth.js';
import { sendMail, inviteEmail } from '../services/mail.js';

const r = Router();
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
      ['HRTB TICKETING SYSTEM — FULL EXPORT'],
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
        memberOf || '—',
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
          ev.date || '—',
          ev.venue || '—',
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
          [`Account: ${acc.name}   |   Date: ${ev.date||'—'}   |   Venue: ${ev.venue||'—'}`],
          [`Total: ${evAtt.length}   |   Checked In: ${evAtt.filter(a=>a.status==='checked').length}   |   Sent: ${evAtt.filter(a=>a.status==='sent').length}   |   Pending: ${evAtt.filter(a=>a.status==='pending').length}`],
          [''],
          ['ATTENDEES'],
          ['Ticket ID', 'First Name', 'Last Name', 'Phone', 'Email', 'Table', 'Seat', 'Status', 'Ticket Sent', 'Checked In At', 'Added On'],
        ];
        const statusLabel = { pending: 'Pending', preprint: 'Pre-printed', sent: 'Sent', checked: 'Checked In', deactivated: 'Deactivated' };
        for (const a of evAtt) {
          evRows.push([
            a.ticket_id,
            a.first_name || '—',
            a.last_name || '—',
            a.phone || '—',
            a.email || '—',
            a.table_number || '—',
            a.seat_number || '—',
            statusLabel[a.status] || a.status,
            a.sent_at?.slice(0,16).replace('T',' ') || '—',
            a.checked_in_at?.slice(0,16).replace('T',' ') || '—',
            a.created_at?.slice(0,10) || '—',
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

r.get('/backup', (req, res) => {
  try {
    const backup = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      accounts: db.prepare('SELECT * FROM accounts').all(),
      events: db.prepare('SELECT * FROM events').all(),
      attendees: db.prepare('SELECT * FROM attendees').all(),
      account_members: db.prepare('SELECT * FROM account_members').all(),
      scanner_pins: db.prepare('SELECT * FROM scanner_pins').all(),
      invite_tokens: db.prepare('SELECT * FROM invite_tokens WHERE used=0 AND expires_at > datetime("now")').all(),
    };
    const json = JSON.stringify(backup);
    const date = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="hrtb-backup-${date}.json"`);
    res.send(json);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RESTORE — imports a backup JSON, merges without duplicates ─
r.post('/restore', (req, res) => {
  try {
    const { accounts=[], events=[], attendees=[], account_members=[], scanner_pins=[], invite_tokens=[] } = req.body;

    let restored = { accounts:0, events:0, attendees:0, members:0, pins:0 };

    db.transaction(() => {
      // Accounts — restore including password hashes (logins preserved)
      for (const a of accounts) {
        const exists = db.prepare('SELECT id FROM accounts WHERE id=?').get(a.id);
        if (!exists) {
          db.prepare('INSERT INTO accounts (id,name,email,password_hash,role,created_at,is_active) VALUES (?,?,?,?,?,?,?)').run(a.id, a.name, a.email, a.password_hash, a.role, a.created_at, a.is_active ?? 1);
          restored.accounts++;
        }
      }
      // Events
      for (const e of events) {
        const exists = db.prepare('SELECT id FROM events WHERE id=?').get(e.id);
        if (!exists) {
          db.prepare('INSERT INTO events (id,account_id,name,date,venue,description,created_at) VALUES (?,?,?,?,?,?,?)').run(e.id, e.account_id, e.name, e.date||null, e.venue||null, e.description||null, e.created_at);
          restored.events++;
        }
      }
      // Attendees
      for (const a of attendees) {
        const exists = db.prepare('SELECT id FROM attendees WHERE id=?').get(a.id);
        if (!exists) {
          db.prepare(`INSERT INTO attendees (id,event_id,account_id,first_name,last_name,phone,email,table_number,seat_number,ticket_id,status,sent_at,checked_in_at,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(a.id, a.event_id, a.account_id, a.first_name||'', a.last_name||'', a.phone||null, a.email||null, a.table_number||null, a.seat_number||null, a.ticket_id, a.status||'pending', a.sent_at||null, a.checked_in_at||null, a.created_at, a.updated_at||a.created_at);
          restored.attendees++;
        }
      }
      // Members
      for (const m of account_members) {
        const exists = db.prepare('SELECT id FROM account_members WHERE account_id=? AND user_id=?').get(m.account_id, m.user_id);
        if (!exists) {
          db.prepare('INSERT INTO account_members (id,account_id,user_id,role,added_at) VALUES (?,?,?,?,?)').run(m.id, m.account_id, m.user_id, m.role, m.added_at);
          restored.members++;
        }
      }
      // Scanner pins
      for (const p of scanner_pins) {
        const exists = db.prepare('SELECT id FROM scanner_pins WHERE id=?').get(p.id);
        if (!exists) {
          db.prepare('INSERT INTO scanner_pins (id,account_id,event_id,pin,label,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(p.id, p.account_id, p.event_id, p.pin, p.label, p.created_by, p.created_at);
          restored.pins++;
        }
      }
    })();

    res.json({ ok: true, restored });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MAINTENANCE MODE — shows "login lost" message to users ─
r.post('/maintenance', (req, res) => {
  process.env.MAINTENANCE_MODE = req.body.enabled ? '1' : '';
  res.json({ ok: true, maintenance: !!req.body.enabled });
});

r.get('/maintenance', (req, res) => {
  res.json({ maintenance: process.env.MAINTENANCE_MODE === '1' });
});

r.get('/stats', (req, res) => {
  try {
    res.json({ stats: {
      accounts: db.prepare("SELECT COUNT(*) c FROM accounts WHERE role != 'scanner'").get().c,
      events: db.prepare('SELECT COUNT(*) c FROM events').get().c,
      attendees: db.prepare('SELECT COUNT(*) c FROM attendees').get().c,
      sent: db.prepare("SELECT COUNT(*) c FROM attendees WHERE status='sent'").get().c,
      checkedIn: db.prepare("SELECT COUNT(*) c FROM attendees WHERE status='checked'").get().c,
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
      subject: `You're invited to EverythingShul.com Ticket System`,
      html: inviteEmail({ fromName: req.user.name, accountName: 'EverythingShul.com Ticket System', url, role })
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
  // Soft delete — mark deleted_at, keep data for 30 days
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
    const events = db.prepare(`SELECT e.*, a.name as account_name,
      (SELECT COUNT(*) FROM attendees WHERE event_id=e.id AND deleted_at IS NULL) as attendee_count,
      (SELECT COUNT(*) FROM staff WHERE event_id=e.id AND deleted_at IS NULL AND status!='deactivated') as staff_count
      FROM events e JOIN accounts a ON a.id=e.account_id WHERE e.deleted_at IS NULL ORDER BY e.created_at DESC`).all();
    res.json({ events });
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

// Contact admin — sends email from SMTP to admin address, user sees a form
r.post('/contact', async (req, res) => {
  const { from_name, from_email, subject, message, event_name, event_id } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
  try {
    const { sendMail } = await import('../services/mail.js');
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || process.env.SUPPORT_EMAIL || 'everythingshul@gmail.com';
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
      subject: `[EverythingShul Support] ${subject||'Support Request'}`,
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

// ── Feature locks ────────────────────────────────────────────

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

// ── Site content (CMS) — stored as JSON file, not DB ───────
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

r.get('/site-content', (req, res) => {
  const content = readSiteContent();
  // Always inject default FAQ and terms if not set (handles fresh deploys)
  if (!content['faq.items'] || content['faq.items'] === '[]') {
    content['faq.items'] = JSON.stringify([
      { q: 'Do I need a credit card to sign up?', a: 'No. You can sign up and explore every feature with a full demo event at no cost. A payment is only required when you create your first real live event.' },
      { q: 'How does ticket payment processing work?', a: 'You connect your own Stripe account. When guests buy tickets online, the money goes directly into your Stripe account — we never touch it.' },
      { q: 'Can guests buy tickets by phone or SMS?', a: 'Yes! EverythingShul supports fully automated IVR phone ordering (guests call a dedicated number and pay by keypad) and SMS text ordering (guests text to buy). Contact us to get a number assigned to your event.' },
      { q: 'Can I import my existing guest list?', a: 'Yes. Upload a CSV or Excel file and the system will import everyone, match any existing records, and optionally email tickets automatically.' },
      { q: 'How does the door scanner work?', a: 'Any phone or tablet with a camera can scan QR codes. Create a scanner PIN for each entrance — staff open the scanner page on any device. No app download required. Multiple entrances can run simultaneously.' },
      { q: 'Can different entrances admit different ticket types?', a: 'Yes. Each scanner PIN can be restricted to specific ticket levels. Your VIP entrance only admits VIP tickets, your general entrance admits general tickets, and staff always scan through.' },
      { q: 'What is a staff ticket?', a: 'Staff tickets are completely separate from guest tickets. They use a business card-size ID badge PDF, are tracked on their own Staff page, do not count toward capacity, and always scan as Access Granted.' },
      { q: 'Can I set a capacity limit per event?', a: 'Yes. Set a maximum per event or per ticket level, with optional email alerts when you are getting close to selling out. Online sales stop automatically when capacity is reached.' },
      { q: 'What happens when my event ends?', a: 'Events automatically close 48 hours after the end date you set. A closed event becomes read-only — you can still view all stats and attendee info, but no changes can be made. Admins can reopen any time.' },
      { q: 'Can I run multiple events at the same time?', a: 'Yes, there is no limit. Each event has its own ticket levels, sale page, scanner PINs, promo codes, and attendee list.' },
      { q: 'What are promo codes?', a: 'Promo codes let you offer discounts — percentage off, fixed dollar amount, expiry date, maximum uses, spending cap, or restriction to specific emails. Buyers enter the code at checkout.' },
      { q: 'Is my data secure?', a: 'Yes. All data is stored on your private server. Passwords are hashed. Stripe handles all payment card data — we never store card numbers. For phone and SMS orders, card digits go directly from Twilio to Stripe in memory and are never written anywhere.' },
    ]);
  }
  if (!content['terms.content'] || content['terms.content'].length < 200) {
    content['terms.content'] = `<h2>1. Acceptance of Terms</h2>
<p>By creating an account and using the EverythingShul Ticket System, you agree to these Terms and Conditions in full. If you do not agree, do not use the Service.</p>
<h2>2. Description of Service</h2>
<p>EverythingShul Ticket System is a software platform for selling event tickets, managing attendees, processing check-ins, and collecting payments. We are a software provider — we do not organize events or sell tickets on behalf of users.</p>
<h2>3. Account Registration</h2>
<p>You must provide accurate information when registering. You are responsible for all activity under your account. Notify us of any unauthorized access at <a href="mailto:everythingshul@gmail.com">everythingshul@gmail.com</a>.</p>
<h2>4. Demo Accounts</h2>
<p>New accounts start in Demo Mode with a free demo event. Demo accounts cannot process real payments. Purchase a plan to run live events. Your demo event remains free indefinitely.</p>
<h2>5. Payments and Billing</h2>
<p>Creating live events requires a one-time fee per event. Fees are non-refundable except where required by law. All payments are processed via Stripe. You agree to Stripe's Terms of Service.</p>
<h2>6. Ticket Sales and Payment Processing</h2>
<p>Online ticket sales are processed through your own connected Stripe account. All ticket revenue goes directly to you — we never hold your funds. You are responsible for refunds, disputes, and compliance with consumer protection laws.</p>
<p>Phone and SMS orders are processed through our platform Stripe account under MOTO approval. You are responsible for compliance with card network rules when enabling phone ordering.</p>
<h2>7. Your Data and Attendee Information</h2>
<p>You own your event data and attendee information. We process it only to provide the Service. We do not sell or share your data. You are responsible for obtaining consent from attendees as required by applicable privacy laws.</p>
<h2>8. Acceptable Use</h2>
<p>You agree not to use the Service for unlawful purposes including fraud, phishing, or spam. We may suspend accounts that violate these terms without notice.</p>
<h2>9. Service Availability</h2>
<p>We aim for maximum uptime but do not guarantee uninterrupted availability. We recommend exporting your attendee list before major events as a precaution.</p>
<h2>10. Limitation of Liability</h2>
<p>The Service is provided "as is" without warranty. To the maximum extent permitted by law, EverythingShul is not liable for indirect, incidental, or consequential damages from your use of the platform.</p>
<h2>11. Changes to These Terms</h2>
<p>We may update these Terms at any time. Continued use constitutes acceptance. Check this page periodically.</p>
<h2>12. Contact Us</h2>
<p>For questions about these Terms, use the <a href="/index.html#contact">Contact Us</a> form on our website.</p>`;
  }
  if (!content['terms.title']) content['terms.title'] = 'Terms and Conditions';
  if (!content['faq.title']) content['faq.title'] = 'Frequently Asked Questions';
  res.json({ content });
});

r.patch('/site-content', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { updates } = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'updates object required' });
  const current = readSiteContent();
  for (const [key, value] of Object.entries(updates)) current[key] = String(value);
  writeSiteContent(current);
  res.json({ ok: true });
});


export default r;
