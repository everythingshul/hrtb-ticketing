import express from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import XLSX from 'xlsx';
import { existsSync, mkdirSync } from 'fs';
import { readFileSync } from 'fs';
import { join } from 'path';
import db from '../db.js';
import { auth, requireEvent, blockIfClosed } from '../middleware/auth.js';
import { sendMail, ticketEmail, digestEmail } from '../services/mail.js';
import { generateStaffTicketPDF } from '../services/staffTicketPDF.js';

const r = express.Router();

const tid = () => 'TKT-' + Math.random().toString(36).substr(2,8).toUpperCase();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });

function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try { mkdirSync('/data', { recursive: true }); return '/data'; } catch {}
  return '/tmp/hrtb-data';
}
function getEventDesignPath(eventId) {
  const dir = join(getDataDir(), 'designs');
  for (const ext of ['png','jpg']) { const p = join(dir,`${eventId}.${ext}`); if (existsSync(p)) return p; }
  return null;
}

// ── Single ticket PDF (no auth — linked from individual email) ─
r.get('/ticket-pdf/:ticketId', async (req, res) => {
  const s = db.prepare('SELECT st.*, l.name as level_name, l.color as level_color FROM staff st LEFT JOIN ticket_levels l ON l.id=st.level_id WHERE st.ticket_id=? AND st.deleted_at IS NULL').get(req.params.ticketId.toUpperCase());
  if (!s) return res.status(404).send('Ticket not found');
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(s.event_id);
  const pdfBytes = await generateStaffTicketPDF({ attendee: s, event, eventDesignPath: getEventDesignPath(s.event_id) });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ticket-${s.ticket_id}.pdf"`);
  res.send(Buffer.from(pdfBytes));
});

// ── Bulk PDF download — NO AUTH — linked from digest email ─
r.get('/tickets-bulk-pdf', async (req, res) => {
  const { createRequire } = await import('module');
  const require2 = createRequire(import.meta.url);
  const { PDFDocument } = require2('pdf-lib');
  const rawIds = (req.query.ids || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!rawIds.length) return res.status(400).send('No ticket IDs provided');
  try {
    const merged = await PDFDocument.create();
    for (const ticketId of rawIds) {
      const s = db.prepare('SELECT st.*, l.name as level_name, l.color as level_color FROM staff st LEFT JOIN ticket_levels l ON l.id=st.level_id WHERE st.ticket_id=? AND st.deleted_at IS NULL').get(ticketId);
      if (!s) continue;
      const event = db.prepare('SELECT * FROM events WHERE id=?').get(s.event_id);
      try {
        const pdfBytes = await generateStaffTicketPDF({ attendee: s, event, eventDesignPath: getEventDesignPath(s.event_id) });
        const src = await PDFDocument.load(pdfBytes);
        const [page] = await merged.copyPages(src, [0]);
        merged.addPage(page);
      } catch(e) { console.warn('[staff-bulk-pdf] skip', ticketId, e.message); }
    }
    const finalBytes = await merged.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="staff-tickets.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(finalBytes));
  } catch(e) { res.status(500).send('Could not generate PDF: ' + e.message); }
});

// All routes below require auth
r.use(auth);

// ── List staff for event ─────────────────────────────────
r.get('/event/:eventId', requireEvent, (req, res) => {
  const staffList = db.prepare(`
    SELECT s.*, l.name as level_name, l.color as level_color, l.is_staff
    FROM staff s
    LEFT JOIN ticket_levels l ON l.id = s.level_id
    WHERE s.event_id = ? AND s.deleted_at IS NULL
    ORDER BY s.last_name, s.first_name
  `).all(req.params.eventId);
  const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=? AND is_staff=1').all(req.params.eventId);
  const event = req.event;
  res.json({ staff: staffList, levels, event });
});

// ── Create staff member ──────────────────────────────────
r.post('/event/:eventId', requireEvent, blockIfClosed, (req, res) => {
  const { first_name, last_name, phone, email, level_id } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name required' });
  const id = uuid(), ticketId = tid();
  db.prepare(`INSERT INTO staff (id,event_id,account_id,first_name,last_name,phone,email,ticket_id,status,level_id) VALUES (?,?,?,?,?,?,?,?,'pending',?)`)
    .run(id, req.params.eventId, req.event.account_id, first_name, last_name, phone||null, email||null, ticketId, level_id||null);
  const member = db.prepare('SELECT s.*, l.name as level_name, l.color as level_color FROM staff s LEFT JOIN ticket_levels l ON l.id=s.level_id WHERE s.id=?').get(id);
  res.json({ attendee: member });
});

// ── Pre-print blank staff tickets ────────────────────────
r.post('/event/:eventId/preprint', requireEvent, blockIfClosed, (req, res) => {
  const { count=1, level_id } = req.body;
  const qty = Math.min(parseInt(count)||1, 500);
  const ins = db.prepare(`INSERT INTO staff (id,event_id,account_id,first_name,last_name,ticket_id,status,level_id) VALUES (?,?,?,?,?,?,'preprint',?)`);
  const tickets = [];
  db.transaction(() => {
    for (let i=0; i<qty; i++) {
      const id = uuid(), ticketId = tid();
      ins.run(id, req.params.eventId, req.event.account_id, '', '', ticketId, level_id||null);
      tickets.push({ id, ticket_id: ticketId });
    }
  })();
  res.json({ ok: true, tickets });
});

// ── Update staff member ──────────────────────────────────
r.patch('/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM staff WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const { first_name, last_name, phone, email, level_id, status, confirmed } = req.body;
  db.prepare(`UPDATE staff SET first_name=?,last_name=?,phone=?,email=?,level_id=?,updated_at=datetime('now') WHERE id=?`)
    .run(first_name??s.first_name, last_name??s.last_name, phone??s.phone, email??s.email, level_id!==undefined?level_id:s.level_id, s.id);
  if (status !== undefined) db.prepare(`UPDATE staff SET status=?,updated_at=datetime('now') WHERE id=?`).run(status, s.id);
  if (confirmed !== undefined) db.prepare(`UPDATE staff SET confirmed=?,updated_at=datetime('now') WHERE id=?`).run(confirmed?1:0, s.id);
  const updated = db.prepare('SELECT s.*, l.name as level_name, l.color as level_color FROM staff s LEFT JOIN ticket_levels l ON l.id=s.level_id WHERE s.id=?').get(s.id);
  res.json({ attendee: updated });
});

// ── Set status ───────────────────────────────────────────
r.post('/:id/status', (req, res) => {
  const { status } = req.body;
  const s = db.prepare('SELECT * FROM staff WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const extra = status === 'checked' ? `,checked_in_at=datetime('now')` : '';
  db.prepare(`UPDATE staff SET status=?${extra},updated_at=datetime('now') WHERE id=?`).run(status, s.id);
  res.json({ ok: true });
});

// ── Confirm/activate ─────────────────────────────────────
r.post('/:id/confirm', (req, res) => {
  const confirmed = req.body.confirmed ? 1 : 0;
  db.prepare(`UPDATE staff SET confirmed=?,updated_at=datetime('now') WHERE id=?`).run(confirmed, req.params.id);
  res.json({ ok: true, confirmed: !!confirmed });
});

// ── Send ticket ──────────────────────────────────────────
r.post('/:id/send', async (req, res) => {
  const s = db.prepare('SELECT st.*, l.name as level_name, l.color as level_color FROM staff st LEFT JOIN ticket_levels l ON l.id=st.level_id WHERE st.id=? AND st.deleted_at IS NULL').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.status === 'deactivated') return res.status(400).json({ error: 'Ticket deactivated' });
  const toEmail = req.body.email || s.email;
  if (!toEmail) return res.status(400).json({ error: 'No email address' });
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(s.event_id);
  const owner = db.prepare('SELECT email,reply_to,can_send_email,role FROM accounts WHERE id=?').get(event.account_id);
  if (owner?.role !== 'admin' && !owner?.can_send_email) return res.status(403).json({ error: 'EMAIL_NOT_ALLOWED' });
  try {
    const designPath = getEventDesignPath(event.id);
    const pdfBytes = await generateStaffTicketPDF({ attendee: s, event, eventDesignPath: designPath });
    await sendMail({ to: toEmail, subject: `Your ticket for ${event.name}`, html: ticketEmail({ attendee: s, event, pdfUrl: `${process.env.APP_URL || 'https://tickets.everythingshul.com'}/api/staff/ticket-pdf/${s.ticket_id}` }), attachments: [{ filename: `ticket-${s.ticket_id}.pdf`, content: pdfBytes, contentType: 'application/pdf' }], replyTo: owner?.reply_to||owner?.email });
    db.prepare(`UPDATE staff SET status='sent',sent_at=datetime('now'),email=?,updated_at=datetime('now') WHERE id=?`).run(toEmail, s.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Send all ─────────────────────────────────────────────
r.post('/event/:eventId/send-all', requireEvent, blockIfClosed, async (req, res) => {
  const { ids } = req.body;
  const event = req.event;
  const owner = db.prepare('SELECT email,reply_to,can_send_email,role FROM accounts WHERE id=?').get(event.account_id);
  if (owner?.role !== 'admin' && !owner?.can_send_email) return res.status(403).json({ error: 'EMAIL_NOT_ALLOWED' });
  const list = ids?.length
    ? db.prepare(`SELECT st.*, l.name as level_name, l.color as level_color FROM staff st LEFT JOIN ticket_levels l ON l.id=st.level_id WHERE st.event_id=? AND st.id IN (${ids.map(()=>'?').join(',')}) AND st.status='pending'`).all(event.id, ...ids)
    : db.prepare(`SELECT st.*, l.name as level_name, l.color as level_color FROM staff st LEFT JOIN ticket_levels l ON l.id=st.level_id WHERE st.event_id=? AND st.status='pending' AND st.email IS NOT NULL`).all(event.id);
  const designPath = getEventDesignPath(event.id);
  let sent=0, failed=0;
  for (const s of list) {
    if (!s.email) { failed++; continue; }
    try {
      const pdfBytes = await generateStaffTicketPDF({ attendee: s, event, eventDesignPath: designPath });
      await sendMail({ to: s.email, subject: `Your ticket for ${event.name}`, html: ticketEmail({ attendee: s, event, pdfUrl: `${process.env.APP_URL || 'https://tickets.everythingshul.com'}/api/staff/ticket-pdf/${s.ticket_id}` }), attachments: [{ filename: `ticket-${s.ticket_id}.pdf`, content: pdfBytes, contentType: 'application/pdf' }], replyTo: owner?.reply_to||owner?.email });
      db.prepare(`UPDATE staff SET status='sent',sent_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(s.id);
      sent++;
    } catch(e) { console.error('[staff/send-all]', e.message); failed++; }
  }
  res.json({ ok: true, sent, failed });
});

// ── Digest (bulk to one email) ────────────────────────────
r.post('/event/:eventId/digest', requireEvent, blockIfClosed, async (req, res) => {
  const { toEmail, ids, subject } = req.body;
  if (!toEmail) return res.status(400).json({ error: 'toEmail required' });
  const event = req.event;
  const owner = db.prepare('SELECT email,reply_to FROM accounts WHERE id=?').get(event.account_id);
  const rawList = ids?.length
    ? db.prepare(`SELECT st.*, l.name as level_name, l.color as level_color FROM staff st LEFT JOIN ticket_levels l ON l.id=st.level_id WHERE st.event_id=? AND st.id IN (${ids.map(()=>'?').join(',')})`).all(event.id, ...ids)
    : db.prepare(`SELECT st.*, l.name as level_name, l.color as level_color FROM staff st LEFT JOIN ticket_levels l ON l.id=st.level_id WHERE st.event_id=? AND st.status='pending'`).all(event.id);
  if (!rawList.length) return res.status(400).json({ error: 'No tickets to send' });
  const designPath = getEventDesignPath(event.id);
  const attachments = [];
  for (const s of rawList) {
    try {
      const pdfBytes = await generateStaffTicketPDF({ attendee: s, event, eventDesignPath: designPath });
      attachments.push({ filename: `ticket-${s.ticket_id}.pdf`, content: pdfBytes, contentType: 'application/pdf' });
    } catch(e) { console.error('[staff/digest pdf]', e.message); }
  }

  const appUrl = process.env.APP_URL || 'https://tickets.everythingshul.com';
  const batchSize = 100;
  const ticketIds = rawList.map(s => s.ticket_id);
  const batches = [];
  for (let i=0; i<ticketIds.length; i+=batchSize) batches.push(ticketIds.slice(i, i+batchSize));

  const batchButtons = batches.map((batch, idx) => {
    const url = `${appUrl}/api/staff/tickets-bulk-pdf?ids=${encodeURIComponent(batch.join(','))}`;
    const label = batches.length === 1
      ? `Download All ${batch.length} Staff Ticket(s) — One PDF`
      : `Download Staff Tickets ${idx*batchSize+1}–${idx*batchSize+batch.length} (PDF ${idx+1} of ${batches.length})`;
    return `<a href="${url}" style="display:inline-block;background:#1a3a6b;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;margin:4px 0">${label}</a>`;
  }).join('<br>');

  const NAVY = '#1a3a6b';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;margin:0;padding:24px 12px">
<div style="max-width:540px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  <div style="background:${NAVY};padding:18px 24px;text-align:center">
    <div style="color:#fff;font-size:18px;font-weight:700">EverythingShul Ticket System</div>
  </div>
  <div style="padding:20px">
    <div style="background:#f0f4f8;border-radius:8px;padding:11px 14px;margin-bottom:18px;font-size:13px;color:${NAVY};border:1px solid #dde6f0">
      <strong>${rawList.length} staff ticket(s)</strong> for <strong>${event.name}</strong>
    </div>
    <div style="text-align:center;margin-bottom:24px">
      ${batchButtons}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f0f4f8">
        <th style="padding:8px 10px;text-align:left;color:${NAVY}">Name</th>
        <th style="padding:8px 10px;text-align:left;color:${NAVY}">Level</th>
        <th style="padding:8px 10px;text-align:left;color:${NAVY}">Ticket ID</th>
      </tr></thead>
      <tbody>
        ${rawList.map((s,i) => `<tr style="background:${i%2?'#f8f9fb':'#fff'}">
          <td style="padding:8px 10px">${s.first_name||''} ${s.last_name||''}</td>
          <td style="padding:8px 10px">${s.level_name||'—'}</td>
          <td style="padding:8px 10px;font-family:monospace;font-size:11px">${s.ticket_id}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
  <div style="background:#f0f4f8;padding:14px 24px;text-align:center;font-size:11px;color:#888">
    EverythingShul.com · Staff Tickets
  </div>
</div></body></html>`;

  await sendMail({ to: toEmail, subject: subject||`${rawList.length} staff ticket(s) — ${event.name}`, html, attachments, replyTo: owner?.reply_to||owner?.email });
  db.transaction(() => rawList.forEach(s => db.prepare(`UPDATE staff SET status='sent',sent_at=datetime('now') WHERE id=?`).run(s.id)))();
  res.json({ ok: true, sent: rawList.length });
});

// ── Assign ticket ─────────────────────────────────────────
r.post('/assign', (req, res) => {
  const { ticketId, first_name, last_name, phone, email } = req.body;
  if (!ticketId || !first_name || !last_name) return res.status(400).json({ error: 'ticketId and name required' });
  const s = db.prepare("SELECT * FROM staff WHERE ticket_id=? AND deleted_at IS NULL").get(ticketId.toUpperCase());
  if (!s) return res.status(404).json({ error: 'Ticket not found' });
  db.prepare(`UPDATE staff SET first_name=?,last_name=?,phone=?,email=?,status='pending',updated_at=datetime('now') WHERE id=?`)
    .run(first_name, last_name, phone||null, email||null, s.id);
  res.json({ ok: true });
});

// ── Lookup ticket ────────────────────────────────────────
r.get('/lookup/:ticketId', (req, res) => {
  const s = db.prepare('SELECT st.*, l.name as level_name FROM staff st LEFT JOIN ticket_levels l ON l.id=st.level_id WHERE st.ticket_id=? AND st.deleted_at IS NULL').get(req.params.ticketId.toUpperCase());
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ attendee: s });
});

// ── Bulk status ───────────────────────────────────────────
r.post('/event/:eventId/bulk-status', requireEvent, blockIfClosed, (req, res) => {
  const { ids, status } = req.body;
  const allowed = ['pending','sent','checked','deactivated','preprint'];
  if (!ids?.length || !allowed.includes(status)) return res.status(400).json({ error: 'Invalid' });
  const stmt = db.prepare(`UPDATE staff SET status=?,updated_at=datetime('now') WHERE id=? AND event_id=?`);
  db.transaction(() => ids.forEach(id => stmt.run(status, id, req.params.eventId)))();
  res.json({ ok: true, updated: ids.length });
});

// ── Bulk level ────────────────────────────────────────────
r.post('/event/:eventId/bulk-level', requireEvent, blockIfClosed, (req, res) => {
  const { ids, level_id } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'No IDs' });
  const lvl = (level_id && level_id !== '__none') ? level_id : null;
  const stmt = db.prepare(`UPDATE staff SET level_id=?,updated_at=datetime('now') WHERE id=? AND event_id=?`);
  db.transaction(() => ids.forEach(id => stmt.run(lvl, id, req.params.eventId)))();
  res.json({ ok: true, updated: ids.length });
});

// ── Bulk delete ───────────────────────────────────────────
r.post('/event/:eventId/bulk-delete', requireEvent, blockIfClosed, (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'No IDs' });
  const stmt = db.prepare(`UPDATE staff SET deleted_at=datetime('now') WHERE id=? AND event_id=?`);
  db.transaction(() => ids.forEach(id => stmt.run(id, req.params.eventId)))();
  res.json({ ok: true });
});

// ── Delete single ─────────────────────────────────────────
r.delete('/:id', (req, res) => {
  db.prepare(`UPDATE staff SET deleted_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Upload preview ────────────────────────────────────────
r.post('/event/:eventId/preview', requireEvent, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const wb = XLSX.read(req.file.buffer, { type:'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });
    const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=? AND is_staff=1').all(req.params.eventId);
    const levelMap = Object.fromEntries(levels.map(l=>[l.name.toLowerCase().trim(), l.id]));
    const parsed = rows.map(row => {
      const fn = (row['First Name']||row['first_name']||row['FirstName']||'').toString().trim();
      const ln = (row['Last Name']||row['last_name']||row['LastName']||'').toString().trim();
      const ph = (row['Phone']||row['phone']||'').toString().trim().replace(/\D/g,'');
      const em = (row['Email']||row['email']||'').toString().trim();
      const lvlName = (row['Ticket Level']||row['Level']||row['ticket_level']||'').toString().trim().toLowerCase();
      const level_id = levelMap[lvlName] || null;
      return { first_name:fn, last_name:ln, phone:ph, email:em, level_id };
    }).filter(r=>r.first_name && r.last_name);
    // Check conflicts
    const existing = db.prepare('SELECT * FROM staff WHERE event_id=? AND deleted_at IS NULL').all(req.params.eventId);
    const conflicts=[], newRows=[];
    for (const p of parsed) {
      const dup = existing.find(e=>(p.phone&&e.phone&&p.phone===e.phone)||(p.email&&e.email&&p.email.toLowerCase()===e.email?.toLowerCase()));
      if (dup) { const changes={}; ['first_name','last_name','phone','email','level_id'].forEach(f=>{if(p[f]!==dup[f])changes[f]={old:dup[f],new:p[f]};}); if(Object.keys(changes).length) conflicts.push({existing:dup,incoming:p,changes}); }
      else newRows.push(p);
    }
    res.json({ new: newRows, conflicts });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ── Upload commit ─────────────────────────────────────────
r.post('/event/:eventId/commit', requireEvent, blockIfClosed, (req, res) => {
  const { newRows=[], resolved=[] } = req.body;
  let added=0, updated=0;
  db.transaction(() => {
    for (const row of newRows) {
      const id=uuid(), ticketId=tid();
      db.prepare(`INSERT INTO staff (id,event_id,account_id,first_name,last_name,phone,email,ticket_id,status,level_id) VALUES (?,?,?,?,?,?,?,?,'pending',?)`)
        .run(id, req.params.eventId, req.event.account_id, row.first_name, row.last_name, row.phone||null, row.email||null, ticketId, row.level_id||null);
      added++;
    }
    for (const r2 of resolved) {
      if (!r2.override) continue;
      const inc = r2.incoming;
      db.prepare(`UPDATE staff SET first_name=?,last_name=?,phone=?,email=?,level_id=?,updated_at=datetime('now') WHERE id=?`)
        .run(inc.first_name, inc.last_name, inc.phone||null, inc.email||null, inc.level_id||null, r2.existing.id);
      updated++;
    }
  })();
  res.json({ ok: true, added, updated });
});

// ── Confirm bulk (by ticket IDs) ──────────────────────────
r.post('/event/:eventId/confirm-bulk', requireEvent, blockIfClosed, (req, res) => {
  const { ticketIds } = req.body;
  if (!ticketIds?.length) return res.status(400).json({ error: 'No ticket IDs' });
  let confirmed=0, notFound=0;
  for (const tid of ticketIds) {
    const s = db.prepare("SELECT * FROM staff WHERE ticket_id=? AND event_id=? AND deleted_at IS NULL").get(tid.toUpperCase(), req.params.eventId);
    if (!s) { notFound++; continue; }
    db.prepare("UPDATE staff SET confirmed=1,updated_at=datetime('now') WHERE id=?").run(s.id);
    confirmed++;
  }
  res.json({ ok: true, confirmed, notFound });
});

// ── Ticket PDF download ───────────────────────────────────
r.get('/ticket-pdf/:ticketId', async (req, res) => {
  const s = db.prepare('SELECT st.*, l.name as level_name, l.color as level_color FROM staff st LEFT JOIN ticket_levels l ON l.id=st.level_id WHERE st.ticket_id=? AND st.deleted_at IS NULL').get(req.params.ticketId.toUpperCase());
  if (!s) return res.status(404).json({ error: 'Not found' });
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(s.event_id);
  const designPath = getEventDesignPath(event.id);
  const pdfBytes = await generateStaffTicketPDF({ attendee: s, event, eventDesignPath: designPath });
  res.setHeader('Content-Type','application/pdf').setHeader('Content-Disposition',`attachment;filename=ticket-${s.ticket_id}.pdf`).send(Buffer.from(pdfBytes));
});

// ── Stats for event (for dashboard/stats page) ────────────
r.get('/event/:eventId/stats', requireEvent, (req, res) => {
  const all = db.prepare("SELECT s.*, l.name as level_name, l.color as level_color FROM staff s LEFT JOIN ticket_levels l ON l.id=s.level_id WHERE s.event_id=? AND s.deleted_at IS NULL").all(req.params.eventId);
  const levels = db.prepare('SELECT * FROM ticket_levels WHERE event_id=? AND is_staff=1').all(req.params.eventId);
  const byLevel = levels.map(l=>({ id:l.id, name:l.name, color:l.color, total:all.filter(s=>s.level_id===l.id).length, checked:all.filter(s=>s.level_id===l.id&&s.status==='checked').length }));
  res.json({ total: all.filter(s=>s.status!=='deactivated').length, byLevel });
});

export default r;
