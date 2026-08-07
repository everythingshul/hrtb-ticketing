import nodemailer from 'nodemailer';
import db from '../db.js';

let transport = null;

function getSetting(key, fallback = '') {
  try { const row = db.prepare('SELECT value FROM platform_settings WHERE key=?').get(key); return row?.value || fallback; }
  catch { return fallback; }
}

// ── Rate limiter - spacing depends on provider (Gmail throttles hard, Brevo doesn't) ─
let lastSentAt = 0;
async function pace(minIntervalMs) {
  const now = Date.now();
  const wait = Math.max(0, minIntervalMs - (now - lastSentAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSentAt = Date.now();
}

export function initMail() {
  const { SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) { console.log('[mail] No SMTP config - Gmail fallback unavailable (Brevo can still be configured in Admin)'); return; }
  transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false }
  });
  transport.verify()
    .then(() => console.log('[mail] Gmail ready'))
    .catch(e => console.error('[mail] Gmail error:', e.message));
}

async function sendViaBrevo({ to, subject, html, attachments = [], replyTo }) {
  const apiKey      = getSetting('brevo.api_key');
  const senderEmail = getSetting('brevo.sender_email');
  const senderName  = getSetting('brevo.sender_name', 'Mamudem Tickets');
  if (!apiKey || !senderEmail) { console.log(`[mail] Brevo not fully configured, MOCK -> ${to} | ${subject}`); return; }

  const payload = {
    sender: { email: senderEmail, name: senderName },
    to: [{ email: to }],
    subject, htmlContent: html,
  };
  if (replyTo) payload.replyTo = { email: replyTo };
  if (attachments.length) {
    payload.attachment = attachments.map(a => ({
      name: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(a.content).toString('base64'),
    }));
  }

  await pace(300); // Brevo has no hard per-second limit, but stay well-behaved
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Brevo send failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  return res.json();
}

async function sendViaGmail({ to, subject, html, attachments = [], replyTo }) {
  const from = `"Mamudem Tickets" <${process.env.SMTP_USER}>`;
  if (!transport) { console.log(`[mail] MOCK -> ${to} | ${subject}`); return; }
  const msg = { from, to, subject, html, attachments };
  if (replyTo) msg.replyTo = replyTo;
  await pace(6000); // Gmail SMTP throttles aggressively - never exceed 1/6s
  return transport.sendMail(msg);
}

export async function sendMail({ to, subject, html, attachments = [], replyTo }) {
  const provider = getSetting('mail.provider', 'gmail');
  if (provider === 'brevo') return sendViaBrevo({ to, subject, html, attachments, replyTo });
  return sendViaGmail({ to, subject, html, attachments, replyTo });
}

const NAVY = '#1a3a6b';
const CYAN = '#00aadd';
const APP_URL = process.env.APP_URL || '';

const qr = id => `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(id)}&margin=8`;

// Always use absolute URL evaluated at send time - email clients cannot load relative URLs
const emailHeader = () => {
  const url = (process.env.APP_URL || 'https://mamudem.com').replace(/\/$/, '');
  // White background behind logo so it's always visible regardless of colors
  return `<div style="text-align:center;padding:16px 20px;background:${NAVY}">
  <div style="background:#ffffff;display:inline-block;border-radius:10px;padding:10px 20px">
    <img src="${url}/logo.png" alt="Mamudem" style="width:180px;height:auto;display:block">
  </div>
</div>`;
};

const emailFooter = `
<div style="text-align:center;padding:14px 20px;font-size:11px;color:#aaa;border-top:1px solid #eee">
  © Mamudem &nbsp;·&nbsp; <a href="${APP_URL}/terms.html" style="color:${CYAN};text-decoration:none">Terms &amp; Conditions</a> &nbsp;·&nbsp; <a href="${APP_URL}" style="color:${CYAN};text-decoration:none">mamudem.com</a>
</div>`;

// Ticket card: QR code UNDER name and phone number
const ticketCard = (a, ev) => `
<div style="background:#fff;border:1px solid #e8e8e8;border-radius:12px;overflow:hidden;margin-bottom:22px;box-shadow:0 2px 12px rgba(0,0,0,.07);page-break-inside:avoid">
  <div style="background:${NAVY};color:#fff;padding:14px 18px">
    <div style="font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:${CYAN};margin-bottom:4px">Mamudem</div>
    <div style="font-size:17px;font-weight:700">${ev.name}</div>
    <div style="font-size:11px;opacity:.6;margin-top:2px">${ev.date||''} ${ev.venue ? '&nbsp;&middot;&nbsp;' + ev.venue : ''}</div>
  </div>
  <div style="padding:16px 18px">
    <div style="font-size:17px;font-weight:700;color:${NAVY};margin-bottom:3px">${a.first_name||'-'} ${a.last_name||''}</div>
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

export function ticketEmail({ attendee, event, pdfUrl }) {
  const appUrl = process.env.APP_URL || '';
  const downloadUrl = pdfUrl || `${appUrl}/api/attendees/ticket-pdf/${attendee.ticket_id}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;margin:0;padding:24px 12px">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  ${emailHeader()}
  <div style="padding:20px">
    ${ticketCard(attendee, event)}
    <div style="background:#f8f9fb;border:1px solid #e0e8f0;border-radius:8px;padding:12px 14px;font-size:12px;color:#444;line-height:1.7;margin-bottom:14px">
      <strong style="color:${NAVY}">Please present this ticket at the entrance.</strong><br>
      A printable PDF version is attached to this email. You can print the attachment and bring it with you, or simply show this email on your phone.
    </div>
    <div style="text-align:center;padding:4px 0 8px">
      <a href="${downloadUrl}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;padding:10px 22px;border-radius:7px;font-size:13px;font-weight:700">Download Ticket PDF</a>
    </div>
  </div>
  ${emailFooter}
</div></body></html>`;
}

export function digestEmail({ attendees, event }) {
  const appUrl = process.env.APP_URL || 'https://mamudem.com';
  const ticketIds = attendees.map(a => a.ticket_id);

  // Split into batches of 100 - one download button per batch
  const batchSize = 100;
  const batches = [];
  for (let i = 0; i < ticketIds.length; i += batchSize) {
    batches.push(ticketIds.slice(i, i + batchSize));
  }

  const batchButtons = batches.map((batch, idx) => {
    const url = `${appUrl}/api/attendees/tickets-bulk-pdf?ids=${encodeURIComponent(batch.join(','))}`;
    const label = batches.length === 1
      ? `Download All ${batch.length} Ticket(s) - One PDF`
      : `Download Tickets ${idx * batchSize + 1}-${idx * batchSize + batch.length} (PDF ${idx + 1} of ${batches.length})`;
    return `<a href="${url}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;margin:4px 0">
      ${label}
    </a>`;
  }).join('<br>');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;margin:0;padding:24px 12px">
<div style="max-width:540px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  ${emailHeader()}
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
  ${emailHeader()}
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

// ── Admin + user notification emails ──────────────────────
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'mamudemtickets@gmail.com';
const ADMIN_NOTIFY  = process.env.ADMIN_NOTIFY_EMAIL || process.env.SMTP_USER; // where to send admin copies

export function notifyEmailBase(title, bodyHtml) {
  const appUrl = (process.env.APP_URL || 'https://mamudem.com').replace(/\/$/, '');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;margin:0;padding:24px 12px">
<div style="max-width:540px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  <div style="background:#1a3a6b;padding:16px 24px;text-align:center">
    <div style="background:#ffffff;display:inline-block;border-radius:10px;padding:10px 20px">
      <img src="${appUrl}/logo.png" alt="Mamudem" style="height:44px;width:auto;display:block">
    </div>
  </div>
  <div style="padding:24px">
    <h2 style="color:#1a3a6b;font-size:18px;font-weight:800;margin-bottom:14px">${title}</h2>
    ${bodyHtml}
    <div style="margin-top:24px;padding:14px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;font-size:12px;color:#6b7280">
      Questions? <a href="mailto:${SUPPORT_EMAIL}?subject=Support%20Request" style="color:#1a3a6b;font-weight:600">Contact us</a> &nbsp;·&nbsp;
      <a href="${appUrl}" style="color:#1a3a6b">mamudem.com</a> &nbsp;·&nbsp;
      <a href="${appUrl}/terms.html" style="color:#1a3a6b">Terms &amp; Conditions</a>
    </div>
  </div>
</div></body></html>`;
}

function row(label, value) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0">
    <tr>
      <td style="padding:9px 12px 9px 0;font-size:13px;color:#6b7280;font-weight:600;white-space:nowrap;width:40%">${label}</td>
      <td style="padding:9px 0;font-size:13px;color:#1a1a2e;font-weight:500;text-align:right">${value||'-'}</td>
    </tr>
  </table>`;
}

export async function notifySignup({ account }) {
  const appUrl = process.env.APP_URL || 'https://mamudem.com';
  const body = `
    <p style="font-size:14px;color:#4a5568;margin-bottom:16px">Welcome to Mamudem! Your account has been created in <strong>Demo Mode</strong>. Explore all features with your preloaded demo event.</p>
    <div style="background:#f8fafc;border-radius:8px;padding:14px;border:1px solid #e2e8f0;margin-bottom:16px">
      ${row('Account Name', account.name)}
      ${row('Email', account.email)}
      ${row('Phone', account.phone||'-')}
      ${row('Account Type', 'Demo (Free)')}
    </div>
    <div style="text-align:center;margin-bottom:8px">
      <a href="${appUrl}/dashboard.html" style="display:inline-block;background:#c8960c;color:#000;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700">Go to Your Dashboard</a>
    </div>
    <p style="font-size:12px;color:#6b7280;text-align:center;margin-top:12px">To run live events with real ticket sales, contact us to upgrade your account.</p>`;

  const html = notifyEmailBase('Welcome to Mamudem!', body);
  const promises = [
    sendMail({ to: account.email, subject: 'Welcome to Mamudem', html }).catch(e => console.error('[notify/signup user]', e.message))
  ];
  if (ADMIN_NOTIFY) promises.push(
    sendMail({ to: ADMIN_NOTIFY, subject: `[New Signup] ${account.name} - ${account.email}`, html: notifyEmailBase('New Account Created', `<div style="background:#f8fafc;border-radius:8px;padding:14px;border:1px solid #e2e8f0">${row('Name',account.name)}${row('Email',account.email)}${row('Phone',account.phone||'-')}${row('Company',account.company||'-')}${row('Time',new Date().toLocaleString())}</div>`) }).catch(e => console.error('[notify/signup admin]', e.message))
  );
  await Promise.all(promises);
}

export async function notifyEventCreated({ account, event }) {
  const appUrl = process.env.APP_URL || 'https://mamudem.com';
  const detailUrl = `${appUrl}/event-detail.html?id=${event.id}`;
  const body = `
    <p style="font-size:14px;color:#4a5568;margin-bottom:16px">Your new event has been created successfully.</p>
    <div style="background:#f8fafc;border-radius:8px;padding:14px;border:1px solid #e2e8f0;margin-bottom:16px">
      ${row('Event Name', event.name)}
      ${row('Date', event.date)}
      ${row('Venue', event.venue)}
      ${row('Timezone', event.timezone||'America/New_York')}
      ${row('Closes', event.expires_at ? new Date(event.expires_at).toLocaleString('en-US',{timeZone:event.timezone||'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}) : 'Not set')}
    </div>
    <div style="text-align:center">
      <a href="${detailUrl}" style="display:inline-block;background:#1a3a6b;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700">Manage Event</a>
    </div>`;

  const adminBody = `<div style="background:#f8fafc;border-radius:8px;padding:14px;border:1px solid #e2e8f0">${row('Event',event.name)}${row('Account',account.name)}${row('Email',account.email)}${row('Date',event.date)}${row('Venue',event.venue)}${row('Event ID',event.id)}${row('Time',new Date().toLocaleString())}</div>`;

  const promises = [
    sendMail({ to: account.email, subject: `Event Created: ${event.name}`, html: notifyEmailBase('Your Event is Ready 🎉', body) }).catch(e => console.error('[notify/event user]', e.message))
  ];
  if (ADMIN_NOTIFY) promises.push(
    sendMail({ to: ADMIN_NOTIFY, subject: `[New Event] ${event.name} - ${account.name}`, html: notifyEmailBase('New Event Created', adminBody) }).catch(e => console.error('[notify/event admin]', e.message))
  );
  await Promise.all(promises);
}
