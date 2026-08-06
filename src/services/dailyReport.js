import db from '../db.js';
import { sendMail } from './mail.js';

export async function sendDailyReports() {
  const now = new Date();

  // Get all active events that haven't expired (or expire in the future)
  const events = db.prepare(`
    SELECT e.*, a.email as owner_email, a.name as owner_name, a.reply_to, a.can_send_email, a.role, a.demo_mode
    FROM events e JOIN accounts a ON a.id = e.account_id
    WHERE e.deleted_at IS NULL
    AND a.demo_mode = 0
    AND (e.expires_at IS NULL OR datetime(e.expires_at) > datetime('now', '-2 days'))
  `).all();

  for (const ev of events) {
    try {
      const attendees = db.prepare("SELECT * FROM attendees WHERE event_id=? AND deleted_at IS NULL").all(ev.id);
      if (!attendees.length) continue;

      const total    = attendees.length;
      const sent     = attendees.filter(a => a.status === 'sent').length;
      const checked  = attendees.filter(a => a.status === 'checked').length;
      const pending  = attendees.filter(a => a.status === 'pending').length;
      const confirmed = attendees.filter(a => a.confirmed).length;
      const online   = attendees.filter(a => a.source === 'online').length;

      const replyTo = ev.reply_to || ev.owner_email;

      const appUrl = process.env.APP_URL || 'https://mamudem.com';
      const html = `
        <div style="font-family:-apple-system,Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
          <div style="background:#1a3a6b;padding:16px 24px;text-align:center">
            <div style="background:#ffffff;display:inline-block;border-radius:10px;padding:10px 20px">
              <img src="${appUrl}/logo.png" style="height:44px;width:auto;display:block" alt="Mamudem">
            </div>
          </div>
          <div style="padding:24px">
            <h2 style="color:#1a3a6b;margin-bottom:4px">Daily Event Report</h2>
            <p style="color:#666;margin-bottom:20px">${ev.name} - ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
              <tr style="background:#f5f7fa"><td style="padding:10px 14px;font-weight:700">Total Attendees</td><td style="padding:10px 14px;font-weight:800;color:#1a3a6b;font-size:20px">${total}</td></tr>
              <tr><td style="padding:10px 14px">Tickets Sent</td><td style="padding:10px 14px;font-weight:700;color:#00aadd">${sent}</td></tr>
              <tr style="background:#f5f7fa"><td style="padding:10px 14px">Checked In</td><td style="padding:10px 14px;font-weight:700;color:#27a85f">${checked}</td></tr>
              <tr><td style="padding:10px 14px">Pending</td><td style="padding:10px 14px;font-weight:700;color:#d97706">${pending}</td></tr>
              <tr style="background:#f5f7fa"><td style="padding:10px 14px">Confirmed</td><td style="padding:10px 14px;font-weight:700;color:#27a85f">${confirmed}</td></tr>
              <tr><td style="padding:10px 14px">Online Sales</td><td style="padding:10px 14px;font-weight:700;color:#7c5cbe">${online}</td></tr>
            </table>
            <p style="color:#aaa;font-size:12px;text-align:center">Daily reports are sent until the day after the event. - <a href="${appUrl}" style="color:#1a3a6b">mamudem.com</a></p>
          </div>
        </div>`;

      await sendMail({
        to: ev.owner_email,
        subject: `Daily Report: ${ev.name} - ${checked}/${total} checked in`,
        html,
        replyTo
      });
      console.log(`[report] Sent daily report for ${ev.name} to ${ev.owner_email}`);
    } catch(e) {
      console.error(`[report] Error for event ${ev.id}:`, e.message);
    }
  }
}
