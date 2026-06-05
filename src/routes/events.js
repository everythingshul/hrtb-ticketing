import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { auth } from '../middleware/auth.js';
import { notifyEventCreated } from '../services/mail.js';

const r = Router();

// Auto-close events 48h after expires_at — runs on every list request (lightweight)
function autoCloseEvents() {
  try {
    db.prepare(`UPDATE events SET closed_at=datetime('now')
      WHERE closed_at IS NULL
      AND deleted_at IS NULL
      AND expires_at IS NOT NULL
      AND datetime(expires_at, '+48 hours') < datetime('now')`).run();
  } catch {}
}

// Public — for scanner PIN login page (shows event names only)
r.get('/public', (req, res) => {
  const events = db.prepare('SELECT id,name,date,venue FROM events ORDER BY created_at DESC LIMIT 50').all();
  res.json({ events });
});

// Public single event — for scanner URL like /scanner-login.html?event=EVENT_ID
r.get('/public/:id', (req, res) => {
  const event = db.prepare('SELECT id,name,date,venue FROM events WHERE id=?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json({ event });
});

r.use(auth);

r.get('/', (req, res) => {
  autoCloseEvents(); // lightweight check on every list
  const isAdmin = req.user.role === 'admin';
  let events = isAdmin
    ? db.prepare('SELECT e.*,a.name as account_name FROM events e JOIN accounts a ON a.id=e.account_id WHERE e.deleted_at IS NULL ORDER BY e.created_at DESC').all()
    : db.prepare(`SELECT DISTINCT e.*,a.name as account_name FROM events e JOIN accounts a ON a.id=e.account_id
        WHERE (e.account_id=? OR e.account_id IN (SELECT account_id FROM account_members WHERE user_id=?))
        AND e.deleted_at IS NULL
        ORDER BY e.created_at DESC`).all(req.user.id, req.user.id);
  events = events.map(e => {
    const rows = db.prepare(`SELECT status, COUNT(*) c FROM attendees WHERE event_id=? AND deleted_at IS NULL GROUP BY status`).all(e.id);
    const s = Object.fromEntries(rows.map(r => [r.status, r.c]));
    const attendee_count = rows.reduce((a,r)=>a+r.c,0);
    const staff_count = db.prepare(`SELECT COUNT(*) c FROM staff WHERE event_id=? AND deleted_at IS NULL AND status!='deactivated'`).get(e.id).c;
    return { ...e, attendee_count, staff_count, stats: { total: attendee_count, ...s } };
  });
  res.json({ events });
});

r.post('/', (req, res) => {
  const { name, date, time, venue, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Event name required' });
  if (!date) return res.status(400).json({ error: 'Event date required' });
  if (!venue) return res.status(400).json({ error: 'Venue required' });

  // Demo accounts cannot create live events — show pricing paywall
  if (req.user.role !== 'admin') {
    const account = db.prepare('SELECT demo_mode, account_tier, plan_id FROM accounts WHERE id=?').get(req.user.id);
    if (account?.demo_mode) {
      return res.status(403).json({ error: 'DEMO_MODE', message: 'Upgrade to create live events.' });
    }
    // Check plan event limits
    if (account?.plan_id) {
      const plan = db.prepare('SELECT * FROM pricing_plans WHERE id=?').get(account.plan_id);
      if (plan?.max_events) {
        const eventCount = db.prepare("SELECT COUNT(*) c FROM events WHERE account_id=? AND deleted_at IS NULL").get(req.user.id).c;
        if (eventCount >= plan.max_events) {
          return res.status(403).json({
            error: 'PLAN_LIMIT',
            message: `Your current plan (${plan.name}) allows ${plan.max_events} event${plan.max_events!==1?'s':''}. Upgrade to create more.`,
            plan_id: plan.id,
            plan_name: plan.name,
            limit: plan.max_events,
            current: eventCount
          });
        }
      }
    }
  }

  const dateTime = time ? `${date} · ${time}` : date;
  const id = uuid();
  const tz = req.body.timezone || 'America/New_York';
  const expires_at = req.body.expires_at || null;
  db.prepare('INSERT INTO events (id,account_id,name,date,venue,description,timezone,expires_at) VALUES (?,?,?,?,?,?,?,?)').run(id, req.user.id, name, dateTime, venue, description||null, tz, expires_at);
  const newEvent = db.prepare('SELECT * FROM events WHERE id=?').get(id);
  // Send notification emails (non-blocking)
  const acct = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id);
  if (acct && !newEvent.is_demo) notifyEventCreated({ account: acct, event: newEvent }).catch(() => {});
  res.json({ event: newEvent });
});

// Admin: create event under any account
r.post('/admin', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, date, venue, description, accountId, timezone } = req.body;
  if (!name || !date || !venue) return res.status(400).json({ error: 'Name, date and venue required' });
  if (!accountId) return res.status(400).json({ error: 'Account required' });
  const account = db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const id = uuid();
  db.prepare('INSERT INTO events (id,account_id,name,date,venue,description,timezone) VALUES (?,?,?,?,?,?,?)').run(id, accountId, name, date, venue, description||null, timezone||'America/New_York');
  res.json({ event: db.prepare('SELECT * FROM events WHERE id=?').get(id) });
});

r.put('/:id', (req, res) => {
  const ev = db.prepare("SELECT * FROM events WHERE id=? AND deleted_at IS NULL").get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && ev.account_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  const { name, date, venue, description, timezone } = req.body;
  db.prepare('UPDATE events SET name=?,date=?,venue=?,description=?,timezone=? WHERE id=?').run(name||ev.name, date??ev.date, venue??ev.venue, description??ev.description, timezone||ev.timezone||'America/New_York', ev.id);
  res.json({ event: db.prepare('SELECT * FROM events WHERE id=?').get(ev.id) });
});

r.post('/:id/close', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const ev = db.prepare('SELECT id FROM events WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE events SET closed_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

r.post('/:id/reopen', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const ev = db.prepare('SELECT id FROM events WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE events SET closed_at=NULL WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

r.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'EVENT_DELETE_RESTRICTED' });
  const ev = db.prepare("SELECT * FROM events WHERE id=? AND deleted_at IS NULL").get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  // Soft delete event and all its attendees
  db.prepare("UPDATE events SET deleted_at=datetime('now') WHERE id=?").run(ev.id);
  db.prepare("UPDATE attendees SET deleted_at=datetime('now') WHERE event_id=? AND deleted_at IS NULL").run(ev.id);
  res.json({ ok: true });
});

export default r;
