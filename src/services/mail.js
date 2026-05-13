import nodemailer from 'nodemailer';

let transport = null;

// ── 6-second email rate limiter ───────────────────────────
// Never sends more than 1 email per 6 seconds, across all calls
let lastSentAt = 0;
async function rateLimitedSend(msg) {
  const now = Date.now();
  const wait = Math.max(0, 6000 - (now - lastSentAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSentAt = Date.now();
  return transport.sendMail(msg);
}

export function initMail() {
  const { SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) { console.log('[mail] No SMTP config — emails logged only'); return; }
  transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false }
  });
  transport.verify()
    .then(() => console.log('[mail] Gmail ready'))
    .catch(e => console.error('[mail] Gmail error:', e.message));
}

export async function sendMail({ to, subject, html, attachments = [], replyTo }) {
  const from = `"EverythingShul.com Tickets" <${process.env.SMTP_USER}>`;
  if (!transport) { console.log(`[mail] MOCK -> ${to} | ${subject}`); return; }
  const msg = { from, to, subject, html, attachments };
  if (replyTo) msg.replyTo = replyTo;
  return rateLimitedSend(msg);
}

const NAVY = '#1a3a6b';
const CYAN = '#00aadd';
const APP_URL = process.env.APP_URL || '';

const qr = id => `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(id)}&margin=8`;

const logoImg = `<img src="${APP_URL}/logo.png" alt="EverythingShul.com" style="width:160px;height:auto;display:block;margin:0 auto">`;

const emailHeader = `
<div style="text-align:center;padding:22px 20px 14px;background:${NAVY}">
  ${logoImg}
  <div style="font-size:10px;text-transform:uppercase;letter-spacing:.16em;color:${CYAN};margin-top:8px">Ticket System</div>
</div>`;

const emailFooter = `
<div style="text-align:center;padding:14px 20px;font-size:11px;color:#aaa;border-top:1px solid #eee">
  © EverythingShul.com Ticket System &nbsp;·&nbsp; <a href="https://everythingshul.com" style="color:${CYAN};text-decoration:none">everythingshul.com</a>
</div>`;

// Ticket card: QR code UNDER name and phone number
const ticketCard = (a, ev) => `
<div style="background:#fff;border:1px solid #e8e8e8;border-radius:12px;overflow:hidden;margin-bottom:22px;box-shadow:0 2px 12px rgba(0,0,0,.07);page-break-inside:avoid">
  <div style="background:${NAVY};color:#fff;padding:14px 18px">
    <div style="font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:${CYAN};margin-bottom:4px">EverythingShul.com Ticket System</div>
    <div style="font-size:17px;font-weight:700">${ev.name}</div>
    <div style="font-size:11px;opacity:.6;margin-top:2px">${ev.date||''} ${ev.venue ? '&nbsp;&middot;&nbsp;' + ev.venue : ''}</div>
  </div>
  <div style="padding:16px 18px">
    <div style="font-size:17px;font-weight:700;color:${NAVY};margin-bottom:3px">${a.first_name||'—'} ${a.last_name||''}</div>
    ${a.phone ? `<div style="font-size:12px;color:#666;margin-bottom:6px">${a.phone}</div>` : '<div style="margin-bottom:6px"></div>'}
    ${a.level_name ? `<div style="display:inline-block;background:${a.level_color||CYAN};color:#fff;border-radius:99px;padding:2px 12px;font-size:11px;font-weight:700;letter-spacing:.05em;margin-bottom:8px">${a.level_name}</div>` : ''}
    ${(a.table_number||a.seat_number) ? `
    <div style="font-size:13px;font-weight:700;color:${NAVY};margin-bottom:12px">
      ${[a.table_number?`Table ${a.table_number}`:'', a.seat_number?`Seat ${a.seat_number}`:''].filter(Boolean).join(' &nbsp;/&nbsp; ')}
    </div>` : ''}
    <div style="text-align:center;background:#f8f9fb;border-radius:8px;padding:14px 10px;border:1px solid #e8e8e8">
      <img src="${qr(a.ticket_id)}" width="150" height="150" style="border-radius:6px;border:2px solid ${CYAN}" />
      <div style="font-size:10px;color:#111;font-family:monospace;margin-top:7px;font-weight:700;letter-spacing:.06em">${a.ticket_id}</div>
      ${a.level_name ? `<div style="margin-top:5px;background:${a.level_color||CYAN};border-radius:3px;padding:3px 8px;display:inline-block;min-width:130px;text-align:center">
        <span style="font-size:10px;font-weight:700;color:#fff;text-shadow:-0.3px 0 #000,0 0.3px #000,0.3px 0 #000,0 -0.3px #000;letter-spacing:.06em;text-transform:uppercase">${a.level_name}</span>
      </div>` : ''}
    </div>
  </div>
</div>`;

export function ticketEmail({ attendee, event }) {
  const appUrl = process.env.APP_URL || '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;margin:0;padding:24px 12px">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  ${emailHeader}
  <div style="padding:20px">
    ${ticketCard(attendee, event)}
    <div style="background:#f8f9fb;border:1px solid #e0e8f0;border-radius:8px;padding:12px 14px;font-size:12px;color:#444;line-height:1.7;margin-bottom:14px">
      <strong style="color:${NAVY}">Please present this ticket at the entrance.</strong><br>
      A printable PDF version is attached to this email. You can print the attachment and bring it with you, or simply show this email on your phone.
    </div>
    <div style="text-align:center;padding:4px 0 8px">
      <a href="${appUrl}/api/attendees/ticket-pdf/${attendee.ticket_id}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;padding:10px 22px;border-radius:7px;font-size:13px;font-weight:700">Download Ticket PDF</a>
    </div>
  </div>
  ${emailFooter}
</div></body></html>`;
}

export function digestEmail({ attendees, event }) {
  const appUrl = process.env.APP_URL || 'https://tickets.everythingshul.com';
  const ticketIds = attendees.map(a => a.ticket_id);

  // Split into batches of 100 — one download button per batch
  const batchSize = 100;
  const batches = [];
  for (let i = 0; i < ticketIds.length; i += batchSize) {
    batches.push(ticketIds.slice(i, i + batchSize));
  }

  const batchButtons = batches.map((batch, idx) => {
    const url = `${appUrl}/api/attendees/tickets-bulk-pdf?ids=${encodeURIComponent(batch.join(','))}`;
    const label = batches.length === 1
      ? `Download All ${batch.length} Ticket(s) — One PDF`
      : `Download Tickets ${idx * batchSize + 1}–${idx * batchSize + batch.length} (PDF ${idx + 1} of ${batches.length})`;
    return `<a href="${url}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;margin:4px 0">
      ${label}
    </a>`;
  }).join('<br>');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;margin:0;padding:24px 12px">
<div style="max-width:540px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  ${emailHeader}
  <div style="padding:20px">
    <div style="background:#f0f4f8;border-radius:8px;padding:11px 14px;margin-bottom:18px;font-size:13px;color:${NAVY};border:1px solid #dde6f0">
      <strong>${attendees.length} ticket(s)</strong> for <strong>${event.name}</strong>
    </div>
    <div style="background:#f8f9fb;border:1px solid #e0e8f0;border-radius:8px;padding:11px 14px;font-size:12px;color:#444;line-height:1.7;margin-bottom:18px">
      <strong style="color:${NAVY}">Printing instructions:</strong> Download the PDF(s) below. Print and cut along the ticket borders. Each ticket is 5.5" x 2".
    </div>
    <div style="text-align:center;margin-bottom:24px">
      ${batchButtons}
    </div>
    ${attendees.map(a => ticketCard(a, event)).join('')}
  </div>
  ${emailFooter}
</div></body></html>`;
}

export function inviteEmail({ fromName, accountName, url, role }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;margin:0;padding:40px 16px">
<div style="max-width:440px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  ${emailHeader}
  <div style="padding:28px 32px">
    <h2 style="margin:0 0 10px;color:${NAVY};font-size:20px">You have been invited</h2>
    <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:8px">
      <strong>${fromName}</strong> has invited you to join <strong>${accountName}</strong> as <strong>${role || 'a member'}</strong>.
    </p>
    <p style="color:#888;font-size:13px;line-height:1.7;margin-bottom:20px">
      Click the button below to set up your account. You will choose your own password.
    </p>
    <a href="${url}" style="display:block;background:${NAVY};color:#fff;text-decoration:none;padding:13px 24px;border-radius:8px;font-size:14px;font-weight:700;margin-bottom:20px;text-align:center">Set Up My Account</a>
    <p style="font-size:11px;color:#bbb;border-top:1px solid #eee;padding-top:14px;margin:0">This invitation expires in 48 hours. If you did not expect this email, you can safely ignore it.</p>
  </div>
  ${emailFooter}
</div></body></html>`;
}
