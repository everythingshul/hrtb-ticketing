// Use createRequire — pdf-lib CJS works correctly; ESM build has broken sub-imports
import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const require  = createRequire(import.meta.url);
const pdfLib   = require('pdf-lib');
const { PDFDocument, rgb, degrees, StandardFonts } = pdfLib;

const __dir   = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dir, '../../frontend');

// Ticket: 5.5" x 2"
const W = 396; const H = 144;
const DESIGN_END = 180;  // 2.5"
const INFO_END   = 288;  // +1.5"
const QR_END     = 360;  // +1.0"

function fetchImg(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const r = proto.get(url, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve(Buffer.concat(c)));
      res.on('error', reject);
    });
    r.on('error', reject);
    r.setTimeout(8000, () => { r.destroy(); reject(new Error('QR timeout')); });
  });
}

// Strip non-ASCII so Helvetica never chokes
function safe(s) { return String(s || '').replace(/[^\x20-\x7E]/g, '').trim(); }

// Wrap text into lines that fit within maxPt width
function wrapLines(text, maxPt, font, sz) {
  const words = safe(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(test, sz) <= maxPt) {
      cur = test;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export async function generateTicketPDF({ attendee, event, eventDesignPath }) {
  const pdfDoc = await PDFDocument.create();
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page   = pdfDoc.addPage([W, H]);

  // White bg + border
  page.drawRectangle({ x:0, y:0, width:W, height:H, color:rgb(1,1,1) });
  page.drawRectangle({ x:0.5, y:0.5, width:W-1, height:H-1,
    color:rgb(1,1,1), borderColor:rgb(0,0,0), borderWidth:0.75 });

  // ── LEFT: design image (2.5") ─────────────────────────────
  let designDone = false;

  if (eventDesignPath && existsSync(eventDesignPath)) {
    try {
      const bytes = readFileSync(eventDesignPath);
      const img = eventDesignPath.match(/\.jpe?g$/i)
        ? await pdfDoc.embedJpg(bytes)
        : await pdfDoc.embedPng(bytes);
      const d = img.scaleToFit(DESIGN_END - 8, H - 8);
      page.drawImage(img, {
        x: 4 + (DESIGN_END - 8 - d.width) / 2,
        y: (H - d.height) / 2,
        width: d.width, height: d.height
      });
      designDone = true;
      console.log('[pdf] design image embedded OK');
    } catch(e) {
      console.error('[pdf] design embed ERROR:', e.message);
    }
  }

  if (!designDone) {
    const lp = join(FRONTEND, 'logo.png');
    if (existsSync(lp)) {
      try {
        const img = await pdfDoc.embedPng(readFileSync(lp));
        const d   = img.scaleToFit(DESIGN_END - 20, 44);
        const lx  = 10 + (DESIGN_END - 20 - d.width) / 2;
        const ly  = H / 2 - d.height / 2 + 4;
        page.drawText('Powered By:', { x: lx, y: ly + d.height + 5, size: 6, font, color: rgb(0.5,0.5,0.5) });
        page.drawImage(img, { x: lx, y: ly, width: d.width, height: d.height });
        designDone = true;
      } catch(e) { console.warn('[pdf] logo:', e.message); }
    }
    if (!designDone) {
      page.drawText('EverythingShul.com', { x: 8, y: H/2, size: 9, font: fontB, color: rgb(0.1,0.22,0.42) });
    }
  }

  // Dividers
  const dv = x => page.drawLine({ start:{x,y:4}, end:{x,y:H-4}, thickness:0.5, color:rgb(0.75,0.75,0.75) });
  dv(DESIGN_END); dv(QR_END);

  // ── MIDDLE: event info (1.5") ─────────────────────────────
  const ix = DESIGN_END + 5;
  const iw = INFO_END - DESIGN_END - 8;  // max width for text
  let iy   = H - 11;

  const drawRow = (text, sz, bold, color = rgb(0,0,0)) => {
    if (!text || iy < 10) return;
    const f  = bold ? fontB : font;
    const str = safe(text);
    if (!str) return;
    // Clip single line to fit
    let t = str;
    while (t.length > 1 && f.widthOfTextAtSize(t, sz) > iw) t = t.slice(0, -1);
    page.drawText(t, { x: ix, y: iy, size: sz, font: f, color });
    iy -= sz + 3;
  };

  const drawWrapped = (text, sz, color = rgb(0.4,0.4,0.4)) => {
    if (!text || iy < 10) return;
    const lines = wrapLines(text, iw, font, sz);
    for (const line of lines) {
      if (iy < 10) break;
      page.drawText(line, { x: ix, y: iy, size: sz, font, color });
      iy -= sz + 2;
    }
  };

  drawRow(event.name, 9, true);
  iy -= 1;
  if (event.date)  drawRow(event.date, 6.5, false, rgb(0.2,0.2,0.2));
  // Venue wraps to multiple lines so addresses never get cut off
  if (event.venue) drawWrapped(event.venue, 6.5, rgb(0.2,0.2,0.2));

  if (attendee.table_number || attendee.seat_number) {
    iy -= 1;
    const seat = [
      attendee.table_number && `Table ${attendee.table_number}`,
      attendee.seat_number  && `Seat ${attendee.seat_number}`
    ].filter(Boolean).join('  /  ');
    drawRow(seat, 7, true);
  }

  // Ticket level label
  if (attendee.level_name) {
    iy -= 1;
    const lvlText = `[ ${safe(attendee.level_name)} ]`;
    page.drawText(lvlText, { x: ix, y: iy, size: 7, font: fontB, color: rgb(0.1,0.22,0.42) });
    iy -= 9;
  }

  // Description: wraps onto multiple lines, stays within info column (never past INFO_END)
  if (event.description) {
    iy -= 1;
    drawWrapped(event.description, 5.5);
  }

  page.drawText('Powered By: EverythingShul.com', {
    x: ix, y: 4, size: 4.5, font, color: rgb(0.65,0.65,0.65)
  });

  // ── QR code ───────────────────────────────────────────────
  const qrSz = QR_END - INFO_END - 10;
  const qrX  = INFO_END + 5;
  const qrY  = (H - qrSz) / 2 + 10; // raised to make room for badge+ticketID at bottom

  try {
    const qrBytes = await fetchImg(
      `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(attendee.ticket_id)}&format=png&margin=2`
    );
    page.drawImage(await pdfDoc.embedPng(qrBytes), { x: qrX, y: qrY, width: qrSz, height: qrSz });
  } catch(e) {
    console.warn('[pdf] QR:', e.message);
    page.drawRectangle({ x: qrX, y: qrY, width: qrSz, height: qrSz,
      borderColor: rgb(0.6,0.6,0.6), borderWidth: 0.5, color: rgb(0.96,0.96,0.96) });
  }

  // Ticket ID under QR
  const tid  = safe(attendee.ticket_id);
  const tidSz = 4.8;
  const tidW  = font.widthOfTextAtSize(tid, tidSz);
  page.drawText(tid, {
    x: Math.max(qrX, qrX + qrSz / 2 - tidW / 2),
    y: 14, size: tidSz, font, color: rgb(0,0,0)
  });

  // Colored level badge — square as wide as QR, below ticket ID
  if (attendee.level_name) {
    const badgeH = 10;
    const badgeY = 3;
    // Parse hex color
    const hex = (attendee.level_color || '#6366f1').replace('#','');
    const br = parseInt(hex.slice(0,2),16)/255;
    const bg = parseInt(hex.slice(2,4),16)/255;
    const bb = parseInt(hex.slice(4,6),16)/255;
    page.drawRectangle({ x: qrX, y: badgeY, width: qrSz, height: badgeH, color: rgb(br,bg,bb) });
    const lvlText = safe(attendee.level_name).toUpperCase().slice(0,11);
    const lvlSz = 6;
    const lvlW = fontB.widthOfTextAtSize(lvlText, lvlSz);
    const lvlX = qrX + qrSz/2 - lvlW/2;
    // Black outline (thin, drawn as offset copies) then white text on top
    for (const [ox,oy] of [[-0.3,0],[0.3,0],[0,-0.3],[0,0.3]]) {
      page.drawText(lvlText, { x: lvlX+ox, y: badgeY+2+oy, size: lvlSz, font: fontB, color: rgb(0,0,0) });
    }
    // White text on top
    page.drawText(lvlText, { x: lvlX, y: badgeY+2, size: lvlSz, font: fontB, color: rgb(1,1,1) });
  }

  // ── RIGHT: name + phone strip (rotated 90°) ───────────────
  const sx       = QR_END + (W - QR_END) / 2;
  const fullName = safe(`${attendee.first_name || ''} ${attendee.last_name || ''}`.trim());
  const phone    = safe(attendee.phone || '');

  if (fullName) {
    const nSz = fullName.length > 20 ? 6 : fullName.length > 14 ? 7 : 8;
    page.drawText(fullName, {
      x: sx + 3, y: 8, size: nSz, font: fontB,
      color: rgb(0,0,0), rotate: degrees(90)
    });
  }
  if (phone) {
    page.drawText(phone, {
      x: sx - 7, y: 8, size: 5.5, font,
      color: rgb(0.3,0.3,0.3), rotate: degrees(90)
    });
  }

  return Buffer.from(await pdfDoc.save());
}
