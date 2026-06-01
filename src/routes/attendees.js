import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { promises as fs, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { auth, requireEvent, blockIfClosed } from '../middleware/auth.js';
import { sendMail, ticketEmail, digestEmail } from '../services/mail.js';
import { generateTicketPDF } from '../services/ticketPDF.js';
import { generateStaffTicketPDF } from '../services/staffTicketPDF.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try { mkdirSync('/data', { recursive: true }); return '/data'; } catch {}
  return '/tmp/hrtb-data';
}
const DESIGNS_DIR = join(getDataDir(), 'designs');

const r = Router();

// ── Public endpoints (no auth) ────────────────────────────
// Ticket PDF download by ticket ID — linked from email
r.get('/ticket-pdf/:ticketId', async (req, res) => {
  const a = db.prepare("SELECT att.*, l.name as level_name, l.color as level_color FROM attendees att LEFT JOIN ticket_levels l ON l.id=att.level_id WHERE att.ticket_id=? AND att.deleted_at IS NULL").get(req.params.ticketId.toUpperCase());
  if (!a) return res.status(404).send('Ticket not found');
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(a.event_id);
  const designPath = getEventDesignPath(a.event_id);
  try {
    const pdfBytes = await generateTicketPDF({ attendee: a, event, eventDesignPath: designPath });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ticket-${a.ticket_id}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdfBytes);
  } catch(e) {
    res.status(500).send('Could not generate ticket: ' + e.message);
  }
});

// Public: bulk PDF — all tickets for a digest/bulk send merged into one file
// URL: /api/attendees/tickets-bulk-pdf?ids=TKT-AAA,TKT-BBB,TKT-CCC
r.get('/tickets-bulk-pdf', async (req, res) => {
  const { createRequire } = await import('module');
  const require2 = createRequire(import.meta.url);
  const { PDFDocument } = require2('pdf-lib');

  const rawIds = (req.query.ids || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!rawIds.length) return res.status(400).send('No ticket IDs provided');

  try {
    const merged = await PDFDocument.create();
    for (const ticketId of rawIds) {
      const a = db.prepare("SELECT att.*, l.name as level_name, l.color as level_color FROM attendees att LEFT JOIN ticket_levels l ON l.id=att.level_id WHERE att.ticket_id=? AND att.deleted_at IS NULL").get(ticketId);
      if (!a) continue;
      const event = db.prepare('SELECT * FROM events WHERE id=?').get(a.event_id);
      const designPath = getEventDesignPath(a.event_id);
      try {
        const pdfBytes = await generateTicketPDF({ attendee: a, event, eventDesignPath: designPath });
        const src = await PDFDocument.load(pdfBytes);
        const [page] = await merged.copyPages(src, [0]);
        merged.addPage(page);
      } catch(e) { console.warn('[bulk-pdf] skip', ticketId, e.message); }
    }
    const finalBytes = await merged.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(finalBytes));
  } catch(e) {
    res.status(500).send('Could not generate PDF: ' + e.message);
  }
});

// All other routes require auth
// ── Public ticket activation ───────────────────────────────
// Allows attendees to self-activate their ticket by entering ticket ID
r.post('/activate', (req, res) => {
  const { ticket_id } = req.body;
  if (!ticket_id) return res.status(400).json({ error: 'Ticket ID required' });

  const clean = ticket_id.toString().trim().toUpperCase().replace(/^TKT-/, '');
  const fullId = 'TKT-' + clean;

  const a = db.prepare(`
    SELECT att.*, e.name as event_name, e.allow_activation,
           l.name as level_name, l.color as level_color
    FROM attendees att
    JOIN events e ON e.id = att.event_id
    LEFT JOIN ticket_levels l ON l.id = att.level_id
    WHERE att.ticket_id=? AND att.deleted_at IS NULL AND att.status!='deactivated'
  `).get(fullId);

  if (!a) return res.status(404).json({ error: 'Ticket not found. Please check the ID and try again.' });
  if (a.confirmed) return res.status(400).json({ error: 'This ticket is already activated.', already: true, attendee: { first_name: a.first_name, last_name: a.last_name, event_name: a.event_name } });
  if (!a.allow_activation) return res.status(403).json({ error: 'Online activation is not enabled for this event.' });

  db.prepare("UPDATE attendees SET confirmed=1, updated_at=datetime('now') WHERE id=?").run(a.id);
  res.json({ ok: true, attendee: { first_name: a.first_name, last_name: a.last_name, ticket_id: fullId, event_name: a.event_name, level_name: a.level_name, level_color: a.level_color } });
});


r.use(auth);
const upload = multer({ dest: '/tmp/hrtb-uploads/' });
// Use memory storage for design uploads — avoids temp dir / EXDEV issues entirely
const designUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Ensure dirs exist
try { mkdirSync('/tmp/hrtb-uploads/', { recursive: true }); } catch {}
try { mkdirSync(DESIGNS_DIR, { recursive: true }); } catch {}

function getEventDesignPath(eventId) {
  for (const ext of ['png', 'jpg']) {
    const p = join(DESIGNS_DIR, `${eventId}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

const tid = () => 'TKT-' + Math.random().toString(36).substr(2,8).toUpperCase();
const qrUrl = id => `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(id)}&margin=10`;

function parseRow(row) {
  const k = Object.keys(row);
  const f = (pats) => { for (const p of pats) { const key = k.find(x => x.toLowerCase().replace(/[\s_]/g,'').includes(p)); if (key) return String(row[key]||'').trim(); } return ''; };
  return {
    first_name: f(['firstname','first']),
    last_name: f(['lastname','last']),
    phone: f(['phone','cell','mobile']),
    email: f(['email','mail']),
    table_number: f(['table']),
    seat_number: f(['seat']),
    ticket_level: f(['ticketlevel','level','levelname','tickettype','type']),
  };
}

// List attendees for an event
r.get('/event/:eventId', requireEvent, (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  // Closed events: return event info only, no attendee data
  if (event.closed_at && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'EVENT_CLOSED', event });
  }

  const attendees = db.prepare(`
    SELECT id, event_id, account_id, first_name, last_name, phone, email,
           table_number, seat_number, ticket_id, status, confirmed, level_id,
           sent_at, checked_in_at, created_at, updated_at, deleted_at, checkout_data,
           CASE WHEN source='online' THEN 'online' ELSE 'offline' END as source
    FROM attendees WHERE event_id=? AND deleted_at IS NULL ORDER BY last_name,first_name
  `).all(req.params.eventId);
  const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=? ORDER BY created_at').all(req.params.eventId);
  res.json({ attendees, levels, event });
});

// Preview CSV/XLS upload — detect conflicts
r.post('/event/:eventId/preview', requireEvent, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    let rows;
    if (file.originalname.match(/\.csv$/i)) {
      const text = await fs.readFile(file.path, 'utf8');
      const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
      const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g,'').trim());
      rows = lines.slice(1).map(line => { const v = line.split(',').map(x => x.replace(/^"|"$/g,'').trim()); return Object.fromEntries(headers.map((h,i) => [h, v[i]||''])); });
    } else {
      const wb = XLSX.readFile(file.path);
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    }

    const parsed = rows.map(parseRow).filter(r => r.first_name || r.last_name);
    const existing = db.prepare('SELECT * FROM attendees WHERE event_id=? AND deleted_at IS NULL').all(req.params.eventId);

    // Normalize: strip all non-digits from phone for comparison
    const normPhone = p => (p||'').replace(/\D/g,'');
    const normEmail = e => (e||'').toLowerCase().trim();

    const conflicts = [], newRows = [], skipped = [];
    for (const row of parsed) {
      // Exact match: phone digits must be identical OR email must be identical
      const match = existing.find(e => {
        const phoneMatch = normPhone(e.phone) && normPhone(row.phone) && normPhone(e.phone) === normPhone(row.phone);
        const emailMatch = normEmail(e.email) && normEmail(row.email) && normEmail(e.email) === normEmail(row.email);
        return phoneMatch || emailMatch;
      });

      if (match) {
        // Check if any meaningful data would actually change
        const changes = {};
        if (row.table_number && row.table_number !== (match.table_number||'')) changes.table_number = { old: match.table_number, new: row.table_number };
        if (row.seat_number && row.seat_number !== (match.seat_number||'')) changes.seat_number = { old: match.seat_number, new: row.seat_number };
        // Name/phone/email changes shown for info but don't auto-overwrite
        if (row.first_name && row.first_name !== match.first_name) changes.first_name = { old: match.first_name, new: row.first_name };
        if (row.last_name && row.last_name !== match.last_name) changes.last_name = { old: match.last_name, new: row.last_name };

        if (Object.keys(changes).length) {
          conflicts.push({ existing: match, incoming: row, changes });
        } else {
          skipped.push(row); // exact duplicate, no changes — silently skip
        }
      } else {
        newRows.push(row);
      }
    }
    res.json({ new: newRows, conflicts, skipped: skipped.length, total: parsed.length });
  } catch(e) { res.status(500).json({ error: e.message }); } finally {
    if (req.file?.path) fs.unlink(req.file.path).catch(()=>{});
  }
});

// Commit upload — stores batch ID for undo
r.post('/event/:eventId/commit', requireEvent, blockIfClosed, (req, res) => {
  try {
    const { newRows=[], resolved=[] } = req.body;
    const allLevels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=?').all(req.params.eventId);
    const eventLevels = allLevels.filter(l => !l.is_staff); // only non-staff levels for attendee upload
    const hasLevels = eventLevels.length > 0;

    // Only validate levels if there are non-staff levels
    if (hasLevels) {
      const levelNames = eventLevels.map(l => l.name.toLowerCase());
      const missing = newRows.filter(r => (r.first_name||r.last_name) && !levelNames.includes((r.ticket_level||'').toLowerCase()));
      if (missing.length > 0) {
        return res.status(400).json({
          error: `${missing.length} row(s) are missing a valid Ticket Level. Valid levels: ${eventLevels.map(l=>l.name).join(', ')}`,
          missingLevel: true
        });
      }
    }

    const ins = db.prepare(`INSERT INTO attendees (id,event_id,account_id,first_name,last_name,phone,email,table_number,seat_number,ticket_id,level_id,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending')`);
    const upd = db.prepare(`UPDATE attendees SET phone=?,email=?,table_number=?,seat_number=?,level_id=?,updated_at=datetime('now') WHERE id=?`);
    let added=0, updated=0;
    const batchId = uuid();
    const addedIds = [];
    const updatedSnapshots = []; // store before-state for each updated row

    db.transaction(() => {
      for (const row of newRows) {
        if (!row.first_name && !row.last_name) continue;
        const lvl = eventLevels.find(l => l.name.toLowerCase() === (row.ticket_level||'').toLowerCase());
        const phone = row.phone ? row.phone.replace(/\D/g,'') : null;
        const newId = uuid();
        ins.run(newId, req.params.eventId, req.event.account_id, row.first_name, row.last_name, phone||null, row.email||null, row.table_number||null, row.seat_number||null, tid(), lvl?.id||null);
        addedIds.push(newId);
        added++;
      }
      for (const c of resolved) {
        if (c.override) {
          // Snapshot the existing row BEFORE overwriting
          const before = db.prepare('SELECT * FROM attendees WHERE id=?').get(c.existing.id);
          if (before) updatedSnapshots.push(before);
          const lvl = eventLevels.find(l => l.name.toLowerCase() === (c.incoming.ticket_level||'').toLowerCase());
          const phone = c.incoming.phone ? c.incoming.phone.replace(/\D/g,'') : null;
          upd.run(phone||null, c.incoming.email||null, c.incoming.table_number||null, c.incoming.seat_number||null, lvl?.id||null, c.existing.id);
          updated++;
        }
      }
      // Store batch record for permanent undo
      db.prepare(`INSERT INTO upload_batches (id,event_id,uploaded_by,added_count,updated_count,added_ids,updated_snapshots) VALUES (?,?,?,?,?,?,?)`)
        .run(batchId, req.params.eventId, req.user.id, addedIds.length, updatedSnapshots.length, JSON.stringify(addedIds), JSON.stringify(updatedSnapshots));
    })();
    res.json({ ok: true, added, updated, batchId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add single attendee
r.post('/event/:eventId', requireEvent, blockIfClosed, (req, res) => {
  const { first_name, last_name, phone, email, table_number, seat_number, level_id } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name required' });
  const lvl = level_id ? db.prepare('SELECT is_staff FROM ticket_levels WHERE id=?').get(level_id) : null;
  const source = lvl?.is_staff ? 'staff' : 'offline';
  const id = uuid(), ticketId = tid();
  db.prepare(`INSERT INTO attendees (id,event_id,account_id,first_name,last_name,phone,email,table_number,seat_number,ticket_id,status,level_id,source) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, req.params.eventId, req.event.account_id, first_name, last_name, phone||null, email||null, table_number||null, seat_number||null, ticketId, level_id||null, source);
  const attendee = db.prepare('SELECT att.*, l.name as level_name, l.color as level_color, l.is_staff FROM attendees att LEFT JOIN ticket_levels l ON l.id=att.level_id WHERE att.id=?').get(id);
  res.json({ attendee });
});

// Generate pre-printed blank tickets
r.post('/event/:eventId/preprint', requireEvent, blockIfClosed, (req, res) => {
  const { count=1, table_number, seat_start, level_id } = req.body;
  const qty = Math.min(parseInt(count)||1, 500);
  const lvl = level_id ? db.prepare('SELECT is_staff FROM ticket_levels WHERE id=?').get(level_id) : null;
  const source = lvl?.is_staff ? 'staff' : 'offline';
  const ins = db.prepare(`INSERT INTO attendees (id,event_id,account_id,first_name,last_name,ticket_id,status,table_number,seat_number,level_id,source) VALUES (?,?,?,?,?,?,'preprint',?,?,?,?)`);
  const tickets = [];
  db.transaction(() => {
    for (let i=0; i<qty; i++) {
      const id = uuid(), ticketId = tid();
      const seat = seat_start ? String(parseInt(seat_start)+i) : null;
      ins.run(id, req.params.eventId, req.event.account_id, '', '', ticketId, table_number||null, seat, level_id||null, source);
      tickets.push({ id, ticket_id: ticketId, table_number: table_number||null, seat_number: seat });
    }
  })();
  res.json({ ok: true, tickets });
});

// Assign a person to a pre-printed ticket
r.post('/assign', (req, res) => {
  const { ticketId, first_name, last_name, phone, email, table_number, seat_number } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'ticketId required' });
  if (!first_name || !last_name) return res.status(400).json({ error: 'Name required' });
  const a = db.prepare("SELECT * FROM attendees WHERE ticket_id=? AND deleted_at IS NULL").get(ticketId.toUpperCase());
  if (!a) return res.status(404).json({ error: 'Ticket not found' });
  if (a.status === 'deactivated') return res.status(400).json({ error: 'Ticket is deactivated' });
  if (a.status === 'checked') return res.status(400).json({ error: 'Ticket already used' });
  db.prepare(`UPDATE attendees SET first_name=?,last_name=?,phone=?,email=?,table_number=COALESCE(?,table_number),seat_number=COALESCE(?,seat_number),status=CASE WHEN status='preprint' THEN 'pending' ELSE status END,updated_at=datetime('now') WHERE ticket_id=?`)
    .run(first_name, last_name, phone||null, email||null, table_number||null, seat_number||null, ticketId.toUpperCase());
  res.json({ attendee: db.prepare("SELECT * FROM attendees WHERE ticket_id=? AND deleted_at IS NULL").get(ticketId.toUpperCase()) });
});

// Look up a ticket by ID
r.get('/lookup/:ticketId', (req, res) => {
  const a = db.prepare("SELECT * FROM attendees WHERE ticket_id=? AND deleted_at IS NULL").get(req.params.ticketId.toUpperCase());
  if (!a) return res.status(404).json({ error: 'Ticket not found' });
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(a.event_id);
  res.json({ attendee: a, event });
});

// Bulk level change
r.post('/event/:eventId/bulk-level', requireEvent, blockIfClosed, (req, res) => {
  const { ids, level_id } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'No attendees selected' });
  const lvl = (level_id && level_id !== '__none') ? level_id : null;
  const stmt = db.prepare('UPDATE attendees SET level_id=?,updated_at=datetime(\'now\') WHERE id=? AND event_id=?');
  let updated = 0;
  db.transaction(() => { for (const id of ids) { stmt.run(lvl, id, req.params.eventId); updated++; } })();
  res.json({ ok: true, updated });
});

// Bulk status change
r.post('/event/:eventId/bulk-status', requireEvent, blockIfClosed, (req, res) => {
  const { ids, status } = req.body;
  const allowed = ['pending','sent','checked','deactivated','preprint'];
  if (!ids?.length) return res.status(400).json({ error: 'No attendees selected' });
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const stmt = db.prepare(`UPDATE attendees SET status=?,updated_at=datetime('now') WHERE id=? AND event_id=?`);
  let updated = 0;
  db.transaction(() => {
    for (const id of ids) {
      const result = stmt.run(status, id, req.params.eventId);
      updated += result.changes;
    }
  })();
  res.json({ ok: true, updated });
});

// Update attendee
r.put('/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM attendees WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const { first_name, last_name, phone, email, table_number, seat_number, status, level_id, confirmed } = req.body;
  db.prepare(`UPDATE attendees SET first_name=?,last_name=?,phone=?,email=?,table_number=?,seat_number=?,status=?,level_id=?,confirmed=?,updated_at=datetime('now') WHERE id=?`)
    .run(first_name??a.first_name, last_name??a.last_name, phone??a.phone, email??a.email, table_number??a.table_number, seat_number??a.seat_number, status??a.status, level_id!==undefined?level_id:a.level_id, confirmed!==undefined?(confirmed?1:0):a.confirmed, a.id);
  res.json({ attendee: db.prepare('SELECT * FROM attendees WHERE id=?').get(a.id) });
});

// Delete attendee — saves to trash for 30 days
r.delete('/:id', (req, res) => {
  const a = db.prepare("SELECT * FROM attendees WHERE id=? AND deleted_at IS NULL").get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE attendees SET deleted_at=datetime('now') WHERE id=?").run(a.id);
  res.json({ ok: true });
});

// Send individual ticket
r.post('/:id/send', async (req, res) => {
  const a = db.prepare('SELECT att.*, l.name as level_name, l.color as level_color, l.is_staff FROM attendees att LEFT JOIN ticket_levels l ON l.id=att.level_id WHERE att.id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.status === 'deactivated') return res.status(400).json({ error: 'Ticket deactivated' });
  const toEmail = req.body.email || a.email;
  if (!toEmail) return res.status(400).json({ error: 'No email address provided' });
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(a.event_id);
  const owner = db.prepare('SELECT email, reply_to, can_send_email, role FROM accounts WHERE id=?').get(event.account_id);
  const replyTo = owner?.reply_to || owner?.email || null;
  if (owner?.role !== 'admin' && !owner?.can_send_email) {
    return res.status(403).json({ error: 'EMAIL_NOT_ALLOWED' });
  }
  try {
    const designPath = getEventDesignPath(event.id);
    const isStaff = a.is_staff === 1;
    let attachments = [];
    try {
      const pdfBytes = isStaff
        ? await generateStaffTicketPDF({ attendee: a, event, eventDesignPath: designPath })
        : await generateTicketPDF({ attendee: a, event, eventDesignPath: designPath });
      attachments = [{ filename: `ticket-${a.ticket_id}.pdf`, content: pdfBytes, contentType: 'application/pdf' }];
    } catch(pdfErr) {
      console.error('[send] PDF generation failed:', pdfErr.message);
    }
    await sendMail({ to: toEmail, subject: `Your ticket for ${event.name}`, html: ticketEmail({ attendee: a, event }), attachments, replyTo });
    const sentToOwn = toEmail.toLowerCase() === (a.email || '').toLowerCase();
    // Staff tickets: mark sent but don't auto-confirm (status stays 'sent', source stays 'staff')
    if (isStaff) {
      db.prepare(`UPDATE attendees SET status='sent',sent_at=datetime('now'),email=? WHERE id=?`).run(toEmail, a.id);
    } else {
      db.prepare(`UPDATE attendees SET status='sent',sent_at=datetime('now'),email=?,confirmed=? WHERE id=?`).run(toEmail, sentToOwn ? 1 : a.confirmed, a.id);
    }
    res.json({ ok: true, hadPdf: attachments.length > 0 });
  } catch(e) {
    console.error('[send] Error:', e.message);
    res.status(500).json({ error: 'Failed to send: ' + e.message });
  }
});

// Send all pending to individual emails
r.post('/event/:eventId/send-all', requireEvent, blockIfClosed, async (req, res) => {
  const { ids } = req.body;
  const event = req.event;
  const owner = db.prepare('SELECT email, reply_to, can_send_email, role FROM accounts WHERE id=?').get(event.account_id);
  const replyTo = owner?.reply_to || owner?.email || null;
  if (owner?.role !== 'admin' && !owner?.can_send_email) {
    return res.status(403).json({ error: 'EMAIL_NOT_ALLOWED' });
  }
  const designPath = getEventDesignPath(event.id);
  const list = ids?.length
    ? db.prepare(`SELECT * FROM attendees WHERE event_id=? AND id IN (${ids.map(()=>'?').join(',')}) AND status='pending'`).all(event.id, ...ids)
    : db.prepare(`SELECT * FROM attendees WHERE event_id=? AND status='pending' AND email IS NOT NULL`).all(event.id);
  let sent=0, failed=0;
  for (const a of list) {
    if (!a.email) { failed++; continue; }
    try {
      const aWithLevel = db.prepare('SELECT att.*, l.name as level_name, l.color as level_color, l.is_staff FROM attendees att LEFT JOIN ticket_levels l ON l.id=att.level_id WHERE att.id=?').get(a.id) || a;
      const isStaff = aWithLevel.is_staff === 1;
      const pdfBytes = isStaff
        ? await generateStaffTicketPDF({ attendee: aWithLevel, event, eventDesignPath: designPath })
        : await generateTicketPDF({ attendee: aWithLevel, event, eventDesignPath: designPath });
      await sendMail({
        to: a.email,
        subject: `Your ticket for ${event.name}`,
        html: ticketEmail({ attendee: aWithLevel, event }),
        attachments: [{ filename: `ticket-${a.ticket_id}.pdf`, content: pdfBytes, contentType: 'application/pdf' }],
        replyTo
      });
      db.prepare(`UPDATE attendees SET status='sent',sent_at=datetime('now'),confirmed=1 WHERE id=?`).run(a.id);
      sent++;
    } catch(e) { console.error('[send-all error]', e.message); failed++; }
  }
  res.json({ ok: true, sent, failed });
});

// Digest: all tickets in one email to one address
r.post('/event/:eventId/digest', requireEvent, blockIfClosed, async (req, res) => {
  const { toEmail, ids, subject } = req.body;
  if (!toEmail) return res.status(400).json({ error: 'toEmail required' });
  const event = req.event;
  const owner = db.prepare('SELECT email, reply_to FROM accounts WHERE id=?').get(event.account_id);
  const replyTo = owner?.reply_to || owner?.email || null;
  const rawList = ids?.length
    ? db.prepare(`SELECT * FROM attendees WHERE event_id=? AND id IN (${ids.map(()=>'?').join(',')})`).all(event.id, ...ids)
    : db.prepare(`SELECT * FROM attendees WHERE event_id=? AND status IN ('pending','preprint')`).all(event.id);
  // Join level info + sort alphabetically by last name
  const list = rawList
    .map(a => db.prepare('SELECT att.*, l.name as level_name, l.color as level_color, l.is_staff FROM attendees att LEFT JOIN ticket_levels l ON l.id=att.level_id WHERE att.id=?').get(a.id) || a)
    .sort((a, b) => (a.last_name||'').localeCompare(b.last_name||'') || (a.first_name||'').localeCompare(b.first_name||''));
  if (!list.length) return res.status(400).json({ error: 'No tickets to send' });

  // Generate PDF attachments — staff get business card PDF, others get regular ticket PDF
  const attachments = [];
  for (const a of list) {
    try {
      const isStaff = a.is_staff === 1;
      const pdfBytes = isStaff
        ? await generateStaffTicketPDF({ attendee: a, event, eventDesignPath: getEventDesignPath(event.id) })
        : await generateTicketPDF({ attendee: a, event, eventDesignPath: getEventDesignPath(event.id) });
      attachments.push({ filename: `ticket-${a.ticket_id}.pdf`, content: pdfBytes, contentType: 'application/pdf' });
    } catch(e) { console.error('[digest pdf]', e.message); }
  }

  await sendMail({ to: toEmail, subject: subject || `${list.length} ticket(s) — ${event.name}`, html: digestEmail({ attendees: list, event }), attachments, replyTo });
  db.transaction(() => list.forEach(a => db.prepare(`UPDATE attendees SET status='sent',sent_at=datetime('now') WHERE id=?`).run(a.id)))();
  res.json({ ok: true, sent: list.length });
});

// Validate / scan ticket — checks both attendees and staff tables
r.post('/scan', (req, res) => {
  const { ticketId } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'ticketId required' });
  const tid = ticketId.trim().toUpperCase();

  // Check attendees table first
  let a = db.prepare(`SELECT att.*, l.name as level_name, l.color as level_color, 0 as is_staff_ticket
    FROM attendees att LEFT JOIN ticket_levels l ON l.id=att.level_id
    WHERE att.ticket_id=? AND att.deleted_at IS NULL`).get(tid);

  // Check staff table if not found in attendees
  let isStaffTicket = false;
  if (!a) {
    a = db.prepare(`SELECT s.*, l.name as level_name, l.color as level_color, 1 as is_staff_ticket
      FROM staff s LEFT JOIN ticket_levels l ON l.id=s.level_id
      WHERE s.ticket_id=? AND s.deleted_at IS NULL`).get(tid);
    if (a) isStaffTicket = true;
  }

  if (!a) return res.json({ valid: false, reason: 'Ticket not found' });

  // Scanner role restrictions
  if (req.user.role === 'scanner') {
    const token = req.headers.authorization?.replace('Bearer ','');
    try {
      const jwt = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      if (jwt.scannerEventId && a.event_id !== jwt.scannerEventId)
        return res.json({ valid: false, reason: 'Ticket is for a different event' });
      if (jwt.pinId) {
        const pin = db.prepare('SELECT allowed_levels FROM scanner_pins WHERE id=?').get(jwt.pinId);
        if (pin?.allowed_levels) {
          const allowed = JSON.parse(pin.allowed_levels);
          if (allowed.length && !allowed.includes(a.level_id))
            return res.json({ valid: false, reason: `Level "${a.level_name||'Unknown'}" not allowed at this entrance`, attendee: a });
        }
      }
    } catch {}
  }

  if (a.status === 'deactivated') return res.json({ valid: false, reason: 'Ticket is deactivated', attendee: a });

  // Staff: always grant access — never block for "already checked in"
  if (isStaffTicket) {
    db.prepare(`UPDATE staff SET status='checked',checked_in_at=datetime('now') WHERE id=?`).run(a.id);
    const updated = db.prepare(`SELECT s.*, l.name as level_name, l.color as level_color FROM staff s LEFT JOIN ticket_levels l ON l.id=s.level_id WHERE s.id=?`).get(a.id);
    const event = db.prepare('SELECT * FROM events WHERE id=?').get(a.event_id);
    return res.json({ valid: true, isStaff: true, attendee: { ...updated, source: 'staff' }, event });
  }

  // Regular attendee
  if (a.status === 'checked') return res.json({ valid: false, reason: 'Already checked in', attendee: a, checkedAt: a.checked_in_at });
  if (a.status === 'preprint') return res.json({ valid: false, reason: 'Not yet assigned', attendee: a, needsAssignment: true });
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(a.event_id);
  if (!a.confirmed && event.allow_unconfirmed_checkin === 0)
    return res.json({ valid: false, reason: 'Guest has not confirmed attendance', attendee: a, needsConfirm: true });
  db.prepare(`UPDATE attendees SET status='checked',checked_in_at=datetime('now') WHERE id=?`).run(a.id);
  const updated = db.prepare(`SELECT att.*, l.name as level_name, l.color as level_color FROM attendees att LEFT JOIN ticket_levels l ON l.id=att.level_id WHERE att.id=?`).get(a.id);
  res.json({ valid: true, isStaff: false, attendee: updated, event });
});

// Export CSV
r.get('/event/:eventId/export', requireEvent, (req, res) => {
  const list = db.prepare(`
    SELECT a.*, l.name as level_name
    FROM attendees a
    LEFT JOIN ticket_levels l ON l.id = a.level_id
    WHERE a.event_id=? AND a.deleted_at IS NULL
    ORDER BY a.last_name, a.first_name
  `).all(req.params.eventId);

  const rows = [
    ['Ticket ID','First Name','Last Name','Phone','Email',
     'Table','Seat','Level','Status','Activated','Source',
     'Sent At','Checked In At','Created At',
     'Billing Name','Billing Email','Billing Phone','Billing Address'],
    ...list.map(a => {
      let billing = {};
      try { billing = JSON.parse(a.checkout_data || '{}').billing || {}; } catch {}
      const addr = billing.address
        ? [billing.address.line1, billing.address.line2, billing.address.city,
           billing.address.state, billing.address.postal_code, billing.address.country]
            .filter(Boolean).join(', ')
        : '';
      return [
        a.ticket_id, a.first_name||'', a.last_name||'',
        a.phone||'', a.email||'',
        a.table_number||'', a.seat_number||'',
        a.level_name||'', a.status,
        a.confirmed ? 'Yes' : 'No',
        a.source||'offline',
        a.sent_at||'', a.checked_in_at||'', a.created_at||'',
        billing.name||'', billing.email||'', billing.phone||'', addr
      ];
    })
  ];
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type','text/csv')
     .setHeader('Content-Disposition','attachment;filename="attendees.csv"')
     .send(csv);
});

// Upload event ticket design image — accepts any image format, any filename
r.post('/event/:eventId/design', requireEvent, blockIfClosed, designUpload.single('design'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Only PNG and JPG — these are the only formats pdf-lib can embed
    const mime = req.file.mimetype || '';
    let ext = null;
    if (mime.includes('png')) ext = 'png';
    else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
    else {
      // Try from filename as fallback
      const fn = (req.file.originalname || '').split('.').pop().toLowerCase();
      if (fn === 'png') ext = 'png';
      else if (fn === 'jpg' || fn === 'jpeg') ext = 'jpg';
    }

    if (!ext) {
      return res.status(400).json({ error: 'Only PNG and JPG images are supported for ticket designs.' });
    }

    // Remove old design files
    for (const oldExt of ['png', 'jpg']) {
      try { await fs.unlink(join(DESIGNS_DIR, `${req.params.eventId}.${oldExt}`)); } catch {}
    }

    const dest = join(DESIGNS_DIR, `${req.params.eventId}.${ext}`);
    await fs.writeFile(dest, req.file.buffer);
    console.log(`[design] Saved ${dest}, ${req.file.buffer.length} bytes`);
    res.json({ ok: true, hasDesign: true });
  } catch(e) {
    console.error('[design upload error]', e.message);
    // memory storage - no temp file to clean up
    res.status(500).json({ error: e.message });
  }
});

// Delete event ticket design
r.delete('/event/:eventId/design', requireEvent, blockIfClosed, async (req, res) => {
  for (const ext of ['png','jpg','jpeg','webp','gif','bmp','tiff','avif']) {
    try { await fs.unlink(join(DESIGNS_DIR, `${req.params.eventId}.${ext}`)); } catch {}
  }
  res.json({ ok: true, hasDesign: false });
});

// Check if event has a design
r.get('/event/:eventId/design', requireEvent, (req, res) => {
  const path = getEventDesignPath(req.params.eventId);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ hasDesign: !!path });
});

// Preview a single ticket as PDF (download)
r.get('/event/:eventId/ticket-preview', requireEvent, async (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId);
  const attendees = db.prepare('SELECT * FROM attendees WHERE event_id=? LIMIT 1').all(req.params.eventId);
  const sampleAttendee = attendees[0] || {
    first_name: 'Sample', last_name: 'Guest', phone: '+1 555 000 0000',
    ticket_id: 'TKT-PREVIEW', table_number: 'A', seat_number: '1', email: ''
  };
  const designPath = getEventDesignPath(req.params.eventId);
  const pdfBytes = await generateTicketPDF({ attendee: sampleAttendee, event, eventDesignPath: designPath });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ticket-preview.pdf"`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(pdfBytes);
});

export default r;


// ── Ticket Levels ─────────────────────────────────────────
r.get('/event/:eventId/levels', requireEvent, (req, res) => {
  const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=? ORDER BY created_at').all(req.params.eventId);
  res.json({ levels });
});

r.post('/event/:eventId/levels', requireEvent, blockIfClosed, (req, res) => {
  const { name, color, description, is_staff } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (name.length > 11) return res.status(400).json({ error: 'Level name must be 11 characters or less (fits on ticket badge)' });
  const id = uuid();
  db.prepare('INSERT INTO ticket_levels (id,event_id,name,color,description,is_staff) VALUES (?,?,?,?,?,?)').run(id, req.params.eventId, name.trim(), color || '#6366f1', description||null, is_staff?1:0);
  res.json({ level: db.prepare('SELECT * FROM ticket_levels WHERE id=?').get(id) });
});

r.patch('/event/:eventId/levels/:id', requireEvent, blockIfClosed, (req, res) => {
  const { name, color, description, is_staff } = req.body;
  const lvl = db.prepare('SELECT * FROM ticket_levels WHERE id=? AND event_id=?').get(req.params.id, req.params.eventId);
  if (!lvl) return res.status(404).json({ error: 'Level not found' });
  if (name && name.length > 11) return res.status(400).json({ error: 'Level name must be 11 characters or less' });
  db.prepare('UPDATE ticket_levels SET name=?,color=?,description=?,is_staff=? WHERE id=?')
    .run(name||lvl.name, color||lvl.color, description!==undefined?description:lvl.description, is_staff!==undefined?is_staff:lvl.is_staff, lvl.id);
  res.json({ level: db.prepare('SELECT * FROM ticket_levels WHERE id=?').get(lvl.id) });
});

r.delete('/event/:eventId/levels/:id', requireEvent, blockIfClosed, (req, res) => {
  db.prepare('UPDATE attendees SET level_id=NULL WHERE level_id=?').run(req.params.id);
  db.prepare('DELETE FROM ticket_levels WHERE id=? AND event_id=?').run(req.params.id, req.params.eventId);
  res.json({ ok: true });
});

// ── Confirm / Unconfirm ───────────────────────────────────
r.post('/:id/confirm', (req, res) => {
  const a = db.prepare('SELECT * FROM attendees WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const confirmed = req.body.confirmed ? 1 : 0;
  db.prepare('UPDATE attendees SET confirmed=?,updated_at=datetime(\'now\') WHERE id=?').run(confirmed, a.id);
  res.json({ ok: true, confirmed: !!confirmed });
});

// ── Event settings ────────────────────────────────────────
r.patch('/event/:eventId/settings', requireEvent, blockIfClosed, (req, res) => {
  const { allow_unconfirmed_checkin } = req.body;
  if (allow_unconfirmed_checkin !== undefined) {
    db.prepare('UPDATE events SET allow_unconfirmed_checkin=? WHERE id=?').run(allow_unconfirmed_checkin ? 1 : 0, req.params.eventId);
  }
  res.json({ ok: true });
});

// ── Stats for event ───────────────────────────────────────
r.get('/event/:eventId/stats', requireEvent, (req, res) => {
  const eid = req.params.eventId;
  // Separate staff from regular attendees
  const allAttendees = db.prepare("SELECT att.*, l.is_staff FROM attendees att LEFT JOIN ticket_levels l ON l.id=att.level_id WHERE att.event_id=? AND att.deleted_at IS NULL").all(eid);
  const attendees = allAttendees.filter(a => !a.is_staff);
  const staffAttendees = allAttendees.filter(a => a.is_staff);
  const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=?').all(eid);

  const byStatus = {
    pending:     attendees.filter(a => a.status === 'pending').length,
    sent:        attendees.filter(a => a.status === 'sent').length,
    checked:     attendees.filter(a => a.status === 'checked').length,
    preprint:    attendees.filter(a => a.status === 'preprint').length,
    deactivated: attendees.filter(a => a.status === 'deactivated').length,
  };

  const confirmed   = attendees.filter(a => a.confirmed).length;
  const unconfirmed = attendees.filter(a => !a.confirmed && a.status !== 'deactivated').length;

  const staffLevels = levels.filter(l => l.is_staff);
  const byLevel = levels.filter(l => !l.is_staff).map(l => ({
    id: l.id, name: l.name, color: l.color,
    total:   attendees.filter(a => a.level_id === l.id).length,
    checked: attendees.filter(a => a.level_id === l.id && a.status === 'checked').length,
    sent:    attendees.filter(a => a.level_id === l.id && a.status === 'sent').length,
  }));

  const byStaffLevel = staffLevels.map(l => ({
    id: l.id, name: l.name, color: l.color,
    total:   staffAttendees.filter(a => a.level_id === l.id).length,
    checked: staffAttendees.filter(a => a.level_id === l.id && a.status === 'checked').length,
  }));

  const noLevel = attendees.filter(a => !a.level_id && a.status !== 'deactivated').length;
  const online  = attendees.filter(a => a.source === 'online').length;
  const offline = attendees.filter(a => a.source === 'offline' || !a.source).length;
  const totalStaff = staffAttendees.filter(a => a.status !== 'deactivated').length;

  res.json({ byStatus, confirmed, unconfirmed, byLevel, byStaffLevel, noLevel, total: attendees.length, levels, online, offline, totalStaff });
});

// ── Bulk confirm by ticket ID list (CSV upload) ───────────
r.post('/event/:eventId/confirm-bulk', requireEvent, blockIfClosed, (req, res) => {
  const { ticket_ids } = req.body;
  if (!Array.isArray(ticket_ids) || !ticket_ids.length)
    return res.status(400).json({ error: 'No ticket IDs provided' });

  let confirmed = 0, notFound = 0;
  db.transaction(() => {
    for (const rawId of ticket_ids) {
      const tid = String(rawId).trim().toUpperCase();
      if (!tid) continue;
      const result = db.prepare(
        `UPDATE attendees SET confirmed=1, updated_at=datetime('now')
         WHERE ticket_id=? AND event_id=?`
      ).run(tid, req.params.eventId);
      if (result.changes > 0) confirmed++;
      else notFound++;
    }
  })();
  res.json({ ok: true, confirmed, notFound });
});

// ── Upload batch history & undo (admin only) ──────────────
r.get('/event/:eventId/upload-batches', requireEvent, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const batches = db.prepare(`
    SELECT b.*, a.name as uploaded_by_name
    FROM upload_batches b LEFT JOIN accounts a ON a.id=b.uploaded_by
    WHERE b.event_id=? ORDER BY b.uploaded_at DESC
  `).all(req.params.eventId);
  res.json({ batches });
});

r.delete('/event/:eventId/undo-upload/:batchId', requireEvent, blockIfClosed, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const batch = db.prepare('SELECT * FROM upload_batches WHERE id=? AND event_id=?').get(req.params.batchId, req.params.eventId);
  if (!batch) return res.status(404).json({ error: 'Upload batch not found' });
  if (batch.undone) return res.status(400).json({ error: 'This upload has already been undone' });

  const addedIds = JSON.parse(batch.added_ids || '[]');
  const updatedSnapshots = JSON.parse(batch.updated_snapshots || '[]');

  db.transaction(() => {
    // Soft-delete all newly added attendees
    for (const id of addedIds) {
      db.prepare("UPDATE attendees SET deleted_at=datetime('now') WHERE id=? AND deleted_at IS NULL").run(id);
    }
    // Restore all updated attendees to their pre-upload state
    for (const snap of updatedSnapshots) {
      db.prepare(`UPDATE attendees SET
        first_name=?, last_name=?, phone=?, email=?,
        table_number=?, seat_number=?, level_id=?,
        status=?, confirmed=?, updated_at=datetime('now')
        WHERE id=? AND deleted_at IS NULL`)
        .run(snap.first_name, snap.last_name, snap.phone, snap.email,
          snap.table_number, snap.seat_number, snap.level_id,
          snap.status, snap.confirmed, snap.id);
    }
    // Mark batch as undone
    db.prepare("UPDATE upload_batches SET undone=1, undone_at=datetime('now') WHERE id=?").run(batch.id);
  })();

  res.json({ ok: true, removed: addedIds.length, restored: updatedSnapshots.length });
});

// ── Capacity check helper ─────────────────────────────────
function checkCapacity(eventId, levelId) {
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  if (!event) return { ok: false, blocked: true, warnings: ['Event not found'] };

  const countAll = event.capacity_count_unconfirmed !== 0; // 0 = OFF; 1/null = ON (count all)
  const clause = countAll
    ? "deleted_at IS NULL AND status!='deactivated'"
    : "deleted_at IS NULL AND status!='deactivated' AND confirmed=1";

  const total = db.prepare(`SELECT COUNT(*) c FROM attendees WHERE event_id=? AND ${clause}`).get(eventId).c;
  const level = levelId ? db.prepare('SELECT * FROM ticket_levels WHERE id=?').get(levelId) : null;
  const levelCount = level
    ? db.prepare(`SELECT COUNT(*) c FROM attendees WHERE event_id=? AND level_id=? AND ${clause}`).get(eventId, levelId).c
    : 0;

  const warnings = [];
  let blocked = false;

  if (event.max_tickets && total >= event.max_tickets) {
    blocked = true;
    warnings.push(`Event capacity reached (${total}/${event.max_tickets})`);
  } else if (event.capacity_alert_at && total >= event.capacity_alert_at) {
    warnings.push(`Approaching capacity: ${total}/${event.max_tickets||'∞'}`);
  }
  if (level?.max_tickets && levelCount >= level.max_tickets) {
    blocked = true;
    warnings.push(`${level.name} is sold out (${levelCount}/${level.max_tickets})`);
  } else if (level?.alert_at && levelCount >= level.alert_at) {
    warnings.push(`${level.name} approaching limit: ${levelCount}/${level.max_tickets||'∞'}`);
  }

  return { ok: !blocked, blocked, warnings };
}

// Capacity check endpoint (for portal warning popup)
r.post('/event/:eventId/capacity-check', requireEvent, blockIfClosed, (req, res) => {
  const { level_id } = req.body;
  res.json(checkCapacity(req.params.eventId, level_id || null));
});

// Get capacity info for event + all levels (for online sales page)
r.get('/event/:eventId/capacity', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.eventId);
  if (!event || event.deleted_at) return res.status(404).json({ error: 'Not found' });

  const countAll2 = event.capacity_count_unconfirmed !== 0; // 0=OFF; 1/null=ON
  const clause2 = countAll2 ? "deleted_at IS NULL AND status!='deactivated'" : "deleted_at IS NULL AND status!='deactivated' AND confirmed=1";
  const total = db.prepare(`SELECT COUNT(*) c FROM attendees WHERE event_id=? AND ${clause2}`).get(req.params.eventId).c;
  const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=?').all(req.params.eventId);

  const levelData = levels.map(l => {
    const sold = db.prepare(`SELECT COUNT(*) c FROM attendees WHERE event_id=? AND level_id=? AND ${clause2}`).get(req.params.eventId, l.id).c;
    const available = l.max_tickets ? Math.max(0, l.max_tickets - sold) : null;
    const soldOut = l.max_tickets ? sold >= l.max_tickets : false;
    return { id: l.id, sold, available, soldOut, max_tickets: l.max_tickets, show_availability: l.show_availability };
  });

  const eventSoldOut = event.max_tickets ? total >= event.max_tickets : false;
  res.json({ total, max_tickets: event.max_tickets, eventSoldOut, levels: levelData, capacity_count_unconfirmed: event.capacity_count_unconfirmed });
});

// Update event capacity settings  
r.patch('/event/:eventId/capacity', (req, res, next) => {
  console.log(`[capacity] PATCH hit - eventId=${req.params.eventId} user=${req.user?.id} body=${JSON.stringify(req.body)}`);
  next();
}, requireEvent, (req, res) => {
  const { max_tickets, capacity_alert_at, capacity_alert_email, capacity_count_unconfirmed } = req.body;
  // Accept any falsy value (0, false, "0", "false") as OFF
  const countVal = ['0','false',0,false].includes(capacity_count_unconfirmed) ? 0 : 1;
  console.log(`[capacity] PATCH event=${req.params.eventId} received=${JSON.stringify(capacity_count_unconfirmed)} type=${typeof capacity_count_unconfirmed} => saving countVal=${countVal}`);
  db.prepare('UPDATE events SET max_tickets=?, capacity_alert_at=?, capacity_alert_email=?, capacity_count_unconfirmed=? WHERE id=?')
    .run(max_tickets||null, capacity_alert_at||null, capacity_alert_email||null, countVal, req.params.eventId);
  const check = db.prepare('SELECT capacity_count_unconfirmed FROM events WHERE id=?').get(req.params.eventId);
  console.log(`[capacity] verified in DB: capacity_count_unconfirmed=${check?.capacity_count_unconfirmed}`);
  res.json({ ok: true, saved: countVal });
});

// Update level capacity settings
r.patch('/event/:eventId/level-capacity/:levelId', requireEvent, blockIfClosed, (req, res) => {
  const { max_tickets, alert_at, show_availability } = req.body;
  db.prepare('UPDATE ticket_levels SET max_tickets=?, alert_at=?, show_availability=? WHERE id=? AND event_id=?')
    .run(max_tickets||null, alert_at||null, show_availability?1:0, req.params.levelId, req.params.eventId);
  res.json({ ok: true });
});
