// Staff ticket PDF — portrait ID badge style (2.5" x 3.5" at 72dpi)
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

// Portrait ID badge: 2.5" x 3.5" at 72dpi
const W = 180;  // 2.5 * 72
const H = 252;  // 3.5 * 72

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
  const topBandH = 52;
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
        // Cover the top band
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
          const lh = 22, lw = Math.min(lh * aspect, W - 24);
          page.drawImage(logoImg, {
            x: (W - lw) / 2,
            y: H - topBandH + (topBandH - lh) / 2,
            width: lw, height: lh
          });
        }
      } catch {}
    }
  }

  // ── STAFF level badge (large, below top band) ─────────────
  const label = safe(attendee.level_name || 'STAFF').toUpperCase();
  const labelFz = label.length > 9 ? 14 : label.length > 6 ? 16 : 18;
  const labelW  = fontB.widthOfTextAtSize(label, labelFz) + 20;
  const badgeH  = 26;
  const badgeY  = H - topBandH - badgeH - 8;
  const badgeX  = (W - labelW) / 2;

  page.drawRectangle({ x: badgeX, y: badgeY, width: labelW, height: badgeH, color: levelColor, borderRadius: 5 });
  page.drawText(label, {
    x: badgeX + (labelW - fontB.widthOfTextAtSize(label, labelFz)) / 2,
    y: badgeY + 7,
    size: labelFz, font: fontB, color: white
  });

  // ── Divider ──────────────────────────────────────────────
  const divY = badgeY - 10;
  page.drawLine({
    start: { x: 10, y: divY }, end: { x: W - 10, y: divY },
    thickness: 0.5, color: rgb(0.85, 0.85, 0.88)
  });

  // ── Name ─────────────────────────────────────────────────
  const name = safe(`${attendee.first_name || ''} ${attendee.last_name || ''}`.trim() || 'Staff Member');
  const nameFz = name.length > 20 ? 11 : name.length > 14 ? 12 : 14;
  const nameW  = fontB.widthOfTextAtSize(name, nameFz);
  page.drawText(name, {
    x: (W - nameW) / 2,
    y: divY - nameFz - 4,
    size: nameFz, font: fontB, color: navy
  });

  // ── Event name ────────────────────────────────────────────
  const eventLines = wrapText(event.name || '', W - 20, font, 8);
  let ey = divY - nameFz - 18;
  for (const line of eventLines.slice(0, 2)) {
    const lw = font.widthOfTextAtSize(line, 8);
    page.drawText(line, { x: (W - lw) / 2, y: ey, size: 8, font, color: rgb(0.35, 0.35, 0.4) });
    ey -= 11;
  }

  // ── Date ─────────────────────────────────────────────────
  if (event.date) {
    const dateStr = safe(event.date);
    const dw = font.widthOfTextAtSize(dateStr, 7.5);
    page.drawText(dateStr, { x: (W - dw) / 2, y: ey - 2, size: 7.5, font, color: rgb(0.5, 0.5, 0.55) });
  }

  // ── QR code (centered, large) ─────────────────────────────
  const qrSize = 70;
  const qrX = (W - qrSize) / 2;
  const qrY = 28;
  try {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(attendee.ticket_id)}`;
    const qrBuf = await fetchImg(qrUrl);
    const qrImg = await pdfDoc.embedPng(qrBuf).catch(() => null);
    if (qrImg) {
      page.drawRectangle({ x: qrX - 4, y: qrY - 4, width: qrSize + 8, height: qrSize + 8, color: offWhite, borderRadius: 4 });
      page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });
    }
  } catch {}

  // ── Ticket ID ─────────────────────────────────────────────
  const tid = safe(attendee.ticket_id);
  const tidW = font.widthOfTextAtSize(tid, 6.5);
  page.drawText(tid, { x: (W - tidW) / 2, y: 10, size: 6.5, font, color: rgb(0.65, 0.65, 0.68) });

  // ── Bottom color bar ──────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width: W, height: 5, color: levelColor });

  return await pdfDoc.save();
}
