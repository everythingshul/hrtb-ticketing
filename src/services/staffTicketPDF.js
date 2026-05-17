// Staff ticket PDF — business card style (3.5" x 2")
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const require = createRequire(import.meta.url);
const pdfLib  = require('pdf-lib');
const { PDFDocument, rgb, StandardFonts } = pdfLib;

const __dir   = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dir, '../../frontend');

// Business card: 3.5" x 2" at 72dpi
const W = 252; // 3.5 * 72
const H = 144; // 2.0 * 72

function safe(s) { return String(s || '').replace(/[^\x20-\x7E]/g, '').trim(); }

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return rgb(parseInt(h.slice(0,2),16)/255, parseInt(h.slice(2,4),16)/255, parseInt(h.slice(4,6),16)/255);
}

function fetchImg(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const r = proto.get(url, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c)));
    });
    r.on('error', reject);
    r.setTimeout(8000, () => { r.destroy(); reject(new Error('timeout')); });
  });
}

export async function generateStaffTicketPDF({ attendee, event }) {
  const pdfDoc = await PDFDocument.create();
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([W, H]);

  // ── Background ───────────────────────────────────────────
  const levelColor = hexToRgb(attendee.level_color || '#1a3a6b');
  const navy = hexToRgb('#1a3a6b');
  const white = rgb(1, 1, 1);
  const lightGray = rgb(0.96, 0.96, 0.97);

  // Full white background
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: white });

  // Left colored stripe
  const stripeW = 8;
  page.drawRectangle({ x: 0, y: 0, width: stripeW, height: H, color: levelColor });

  // ── Logo ────────────────────────────────────────────────
  const logoPath = join(FRONTEND, 'logo.png');
  let logoY = H - 22;
  if (existsSync(logoPath)) {
    try {
      const logoBytes = readFileSync(logoPath);
      const logoImg = await pdfDoc.embedPng(logoBytes).catch(() => null);
      if (logoImg) {
        const aspect = logoImg.width / logoImg.height;
        const lh = 16, lw = lh * aspect;
        page.drawImage(logoImg, { x: stripeW + 8, y: H - lh - 6, width: Math.min(lw, 80), height: lh });
        logoY = H - lh - 6;
      }
    } catch {}
  }

  // ── STAFF badge ─────────────────────────────────────────
  const staffLabel = safe(attendee.level_name || 'STAFF').toUpperCase();
  const staffFontSize = staffLabel.length > 10 ? 14 : 18;
  const staffW = fontB.widthOfTextAtSize(staffLabel, staffFontSize) + 16;
  const staffX = W - staffW - 8;
  const staffY = H - 28;

  // Badge pill
  page.drawRectangle({ x: staffX, y: staffY, width: staffW, height: 20, color: levelColor, borderRadius: 4 });
  page.drawText(staffLabel, { x: staffX + 8, y: staffY + 5, size: staffFontSize, font: fontB, color: white });

  // ── Divider ─────────────────────────────────────────────
  const divY = H - 34;
  page.drawLine({ start: { x: stripeW + 6, y: divY }, end: { x: W - 6, y: divY }, thickness: 0.5, color: rgb(0.85, 0.85, 0.88) });

  // ── Name ────────────────────────────────────────────────
  const name = safe(`${attendee.first_name || ''} ${attendee.last_name || ''}`.trim() || 'Staff Member');
  const nameFz = name.length > 22 ? 13 : 15;
  page.drawText(name, { x: stripeW + 8, y: divY - 16, size: nameFz, font: fontB, color: navy });

  // ── Event info ──────────────────────────────────────────
  const eventName = safe(event.name || '');
  const eventFz = 9;
  const maxW = W - stripeW - 16 - 52; // leave space for QR

  // Wrap event name
  const words = eventName.split(' ');
  let line1 = '', line2 = '';
  for (const w of words) {
    const test = line1 ? line1 + ' ' + w : w;
    if (font.widthOfTextAtSize(test, eventFz) <= maxW) { line1 = test; }
    else if (!line2) { line2 = w; }
    else { const t2 = line2 + ' ' + w; if (font.widthOfTextAtSize(t2, eventFz) <= maxW) line2 = t2; }
  }
  if (line1) page.drawText(line1, { x: stripeW + 8, y: divY - 30, size: eventFz, font, color: rgb(0.3, 0.3, 0.35) });
  if (line2) page.drawText(line2, { x: stripeW + 8, y: divY - 41, size: eventFz, font, color: rgb(0.3, 0.3, 0.35) });

  if (event.date) {
    const dateY = line2 ? divY - 53 : divY - 41;
    page.drawText(safe(event.date), { x: stripeW + 8, y: dateY, size: 8, font, color: rgb(0.5, 0.5, 0.55) });
  }

  // ── QR code ─────────────────────────────────────────────
  const qrSize = 48;
  const qrX = W - qrSize - 8;
  const qrY = 10;
  try {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=96x96&data=${encodeURIComponent(attendee.ticket_id)}`;
    const qrBuf = await fetchImg(qrUrl);
    const qrImg = await pdfDoc.embedPng(qrBuf).catch(() => null);
    if (qrImg) {
      page.drawRectangle({ x: qrX - 2, y: qrY - 2, width: qrSize + 4, height: qrSize + 4, color: lightGray, borderRadius: 3 });
      page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });
    }
  } catch {}

  // ── Ticket ID ───────────────────────────────────────────
  page.drawText(safe(attendee.ticket_id), {
    x: stripeW + 8, y: 8, size: 7, font,
    color: rgb(0.65, 0.65, 0.68)
  });

  // ── Bottom colored bar ───────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width: W, height: 4, color: levelColor });

  return await pdfDoc.save();
}
