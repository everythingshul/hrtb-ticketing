// Staff ticket PDF - CR80 ID badge (3.375" × 2.125" portrait = standard credit card / ID badge size)
// At 72dpi: 243pt wide × 153pt tall  (portrait = tall card)
// Actually portrait means taller than wide: 2.125" wide × 3.375" tall
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

// CR80 portrait: 2.125" × 3.375" at 72dpi
const W = 153;  // 2.125 * 72 = 153pt
const H = 243;  // 3.375 * 72 = 243pt

function safe(s) { return String(s || '').replace(/[^\x20-\x7E]/g, '').trim(); }

function hexToRgb(hex) {
  const h = (hex || '#1a3a6b').replace('#', '').padEnd(6, '0');
  return rgb(
    parseInt(h.slice(0,2),16)/255,
    parseInt(h.slice(2,4),16)/255,
    parseInt(h.slice(4,6),16)/255
  );
}

function fetchImg(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const r = proto.get(url, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve(Buffer.concat(c)));
    });
    r.on('error', reject);
    r.setTimeout(8000, () => { r.destroy(); reject(new Error('timeout')); });
  });
}

function wrapText(text, maxW, font, size) {
  const words = safe(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(test, size) <= maxW) { cur = test; }
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

export async function generateStaffTicketPDF({ attendee, event, eventDesignPath }) {
  const pdfDoc = await PDFDocument.create();
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([W, H]);

  const levelColor = hexToRgb(attendee.level_color || '#1a3a6b');
  const navy       = hexToRgb('#1a3a6b');
  const white      = rgb(1, 1, 1);
  const offWhite   = rgb(0.97, 0.97, 0.98);

  // ── Full white background ────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: white });

  // ── Top color band ───────────────────────────────────────
  const topBandH = 42;
  page.drawRectangle({ x: 0, y: H - topBandH, width: W, height: topBandH, color: levelColor });

  // ── Event design image (inside top band) ─────────────────
  let designLoaded = false;
  if (eventDesignPath && existsSync(eventDesignPath)) {
    try {
      const imgBytes = readFileSync(eventDesignPath);
      const ext = eventDesignPath.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      const img = ext === 'png'
        ? await pdfDoc.embedPng(imgBytes).catch(() => null)
        : await pdfDoc.embedJpg(imgBytes).catch(() => null);
      if (img) {
        const aspect = img.width / img.height;
        const imgH = topBandH;
        const imgW = imgH * aspect;
        const imgX = (W - imgW) / 2;
        page.drawImage(img, { x: imgX, y: H - topBandH, width: imgW, height: imgH });
        designLoaded = true;
      }
    } catch {}
  }

  // If no design, show platform logo in top band
  if (!designLoaded) {
    const logoPath = join(FRONTEND, 'logo.png');
    if (existsSync(logoPath)) {
      try {
        const logoBytes = readFileSync(logoPath);
        const logoImg = await pdfDoc.embedPng(logoBytes).catch(() => null);
        if (logoImg) {
          const aspect = logoImg.width / logoImg.height;
          const lh = 18, lw = Math.min(lh * aspect, W - 16);
          page.drawImage(logoImg, { x: (W - lw) / 2, y: H - topBandH + (topBandH - lh) / 2, width: lw, height: lh });
        }
      } catch {}
    }
  }

  // ── STAFF level badge ─────────────────────────────────────
  const label = safe(attendee.level_name || 'STAFF').toUpperCase();
  const labelFz = label.length > 9 ? 11 : label.length > 6 ? 12 : 14;
  const labelW  = fontB.widthOfTextAtSize(label, labelFz) + 14;
  const badgeH  = 20;
  const badgeY  = H - topBandH - badgeH - 6;
  const badgeX  = (W - labelW) / 2;

  page.drawRectangle({ x: badgeX, y: badgeY, width: labelW, height: badgeH, color: levelColor, borderRadius: 4 });
  page.drawText(label, { x: badgeX + (labelW - fontB.widthOfTextAtSize(label, labelFz)) / 2, y: badgeY + 5, size: labelFz, font: fontB, color: white });

  // ── Divider ──────────────────────────────────────────────
  const divY = badgeY - 7;
  page.drawLine({ start: { x: 8, y: divY }, end: { x: W - 8, y: divY }, thickness: 0.4, color: rgb(0.85, 0.85, 0.88) });

  // ── Name ─────────────────────────────────────────────────
  const name = safe(`${attendee.first_name || ''} ${attendee.last_name || ''}`.trim() || 'Staff Member');
  const nameFz = name.length > 18 ? 9 : name.length > 12 ? 10 : 11;
  const nameW  = fontB.widthOfTextAtSize(name, nameFz);
  page.drawText(name, { x: Math.max(4, (W - nameW) / 2), y: divY - nameFz - 3, size: nameFz, font: fontB, color: navy });

  // ── Event name ────────────────────────────────────────────
  const eventLines = wrapText(event.name || '', W - 12, font, 7);
  let ey = divY - nameFz - 14;
  for (const line of eventLines.slice(0, 2)) {
    const lw = font.widthOfTextAtSize(line, 7);
    page.drawText(line, { x: (W - lw) / 2, y: ey, size: 7, font, color: rgb(0.35, 0.35, 0.4) });
    ey -= 9;
  }

  // ── Date ─────────────────────────────────────────────────
  if (event.date) {
    const dateStr = safe(event.date);
    const dw = font.widthOfTextAtSize(dateStr, 6.5);
    page.drawText(dateStr, { x: (W - dw) / 2, y: ey - 2, size: 6.5, font, color: rgb(0.5, 0.5, 0.55) });
  }

  // ── QR code (centered) ────────────────────────────────────
  const qrSize = 58;
  const qrX = (W - qrSize) / 2;
  const qrY = 22;
  try {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(attendee.ticket_id)}`;
    const qrBuf = await fetchImg(qrUrl);
    const qrImg = await pdfDoc.embedPng(qrBuf).catch(() => null);
    if (qrImg) {
      page.drawRectangle({ x: qrX - 3, y: qrY - 3, width: qrSize + 6, height: qrSize + 6, color: offWhite, borderRadius: 3 });
      page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });
    }
  } catch {}

  // ── Ticket ID ─────────────────────────────────────────────
  const tid = safe(attendee.ticket_id);
  const tidW = font.widthOfTextAtSize(tid, 5.5);
  page.drawText(tid, { x: (W - tidW) / 2, y: 8, size: 5.5, font, color: rgb(0.65, 0.65, 0.68) });

  // ── Bottom color bar ──────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width: W, height: 4, color: levelColor });

  return await pdfDoc.save();
}
