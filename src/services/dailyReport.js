import db from '../db.js';
import { sendMail } from './mail.js';

export async function sendDailyReports() {
  const now = new Date();

  // Get all active events that haven't expired (or expire in the future)
  const events = db.prepare(`
    SELECT e.*, a.email as owner_email, a.name as owner_name, a.reply_to, a.can_send_email, a.role
    FROM events e JOIN accounts a ON a.id = e.account_id
    WHERE e.deleted_at IS NULL
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

      const html = `
        <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <img src="${process.env.APP_URL||''}/logo.png" style="height:48px;margin-bottom:20px" alt="EverythingShul">
          <h2 style="color:#1a3a6b;margin-bottom:4px">Daily Event Report</h2>
          <p style="color:#666;margin-bottom:20px">${ev.name} — ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <tr style="background:#f5f7fa"><td style="padding:10px 14px;font-weight:700">Total Attendees</td><td style="padding:10px 14px;font-weight:800;color:#1a3a6b;font-size:20px">${total}</td></tr>
            <tr><td style="padding:10px 14px">Tickets Sent</td><td style="padding:10px 14px;font-weight:700;color:#00aadd">${sent}</td></tr>
            <tr style="background:#f5f7fa"><td style="padding:10px 14px">Checked In</td><td style="padding:10px 14px;font-weight:700;color:#27a85f">${checked}</td></tr>
            <tr><td style="padding:10px 14px">Pending</td><td style="padding:10px 14px;font-weight:700;color:#d97706">${pending}</td></tr>
            <tr style="background:#f5f7fa"><td style="padding:10px 14px">Confirmed</td><td style="padding:10px 14px;font-weight:700;color:#27a85f">${confirmed}</td></tr>
            <tr><td style="padding:10px 14px">Online Sales</td><td style="padding:10px 14px;font-weight:700;color:#7c5cbe">${online}</td></tr>
          </table>
          <p style="color:#aaa;font-size:12px">Daily reports are sent until the day after the event. — EverythingShul.com Ticket System</p>
        </div>`;

      await sendMail({
        to: ev.owner_email,
        subject: `Daily Report: ${ev.name} — ${checked}/${total} checked in`,
        html,
        replyTo
      });
      console.log(`[report] Sent daily report for ${ev.name} to ${ev.owner_email}`);
    } catch(e) {
      console.error(`[report] Error for event ${ev.id}:`, e.message);
    }
  }
}
