import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { auth } from '../middleware/auth.js';

const r = Router();

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
  let events = req.user.role === 'admin'
    ? db.prepare('SELECT e.*,a.name as account_name FROM events e JOIN accounts a ON a.id=e.account_id ORDER BY e.created_at DESC').all()
    : db.prepare(`SELECT DISTINCT e.*,a.name as account_name FROM events e JOIN accounts a ON a.id=e.account_id
        WHERE e.account_id=? OR e.account_id IN (SELECT account_id FROM account_members WHERE user_id=?)
        ORDER BY e.created_at DESC`).all(req.user.id, req.user.id);
  events = events.map(e => {
    const rows = db.prepare('SELECT status,COUNT(*) c FROM attendees WHERE event_id=? GROUP BY status').all(e.id);
    const s = Object.fromEntries(rows.map(r => [r.status, r.c]));
    return { ...e, stats: { total: Object.values(s).reduce((a,b)=>a+b,0), ...s } };
  });
  res.json({ events });
});

r.post('/', (req, res) => {
  const { name, date, time, venue, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Event name required' });
  if (!date) return res.status(400).json({ error: 'Event date required' });
  if (!venue) return res.status(400).json({ error: 'Venue required' });

  // Enforce max_events limit for non-admin users
  if (req.user.role !== 'admin') {
    const account = db.prepare('SELECT max_events FROM accounts WHERE id=?').get(req.user.id);
    const maxEvents = account?.max_events ?? 1;
    const currentCount = db.prepare('SELECT COUNT(*) c FROM events WHERE account_id=?').get(req.user.id).c;
    if (currentCount >= maxEvents) {
      return res.status(403).json({
        error: `EVENT_LIMIT`,
        max: maxEvents,
        current: currentCount
      });
    }
  }

  const dateTime = time ? `${date} · ${time}` : date;
  const id = uuid();
  db.prepare('INSERT INTO events (id,account_id,name,date,venue,description) VALUES (?,?,?,?,?,?)').run(id, req.user.id, name, dateTime, venue, description||null);
  res.json({ event: db.prepare('SELECT * FROM events WHERE id=?').get(id) });
});

// Admin: create event under any account
r.post('/admin', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, date, venue, description, accountId } = req.body;
  if (!name || !date || !venue) return res.status(400).json({ error: 'Name, date and venue required' });
  if (!accountId) return res.status(400).json({ error: 'Account required' });
  const account = db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const id = uuid();
  db.prepare('INSERT INTO events (id,account_id,name,date,venue,description) VALUES (?,?,?,?,?,?)').run(id, accountId, name, date, venue, description||null);
  res.json({ event: db.prepare('SELECT * FROM events WHERE id=?').get(id) });
});

r.put('/:id', (req, res) => {
  const ev = db.prepare("SELECT * FROM events WHERE id=? AND deleted_at IS NULL").get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && ev.account_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  const { name, date, venue, description } = req.body;
  db.prepare('UPDATE events SET name=?,date=?,venue=?,description=? WHERE id=?').run(name||ev.name, date??ev.date, venue??ev.venue, description??ev.description, ev.id);
  res.json({ event: db.prepare('SELECT * FROM events WHERE id=?').get(ev.id) });
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
