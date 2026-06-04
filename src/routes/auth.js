import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { auth, JWT_SECRET } from '../middleware/auth.js';
import { sendMail, inviteEmail, notifySignup } from '../services/mail.js';
import { OAuth2Client } from 'google-auth-library';

const r = Router();

// ── Register (first-ever user becomes admin, otherwise invite required) ──
// ── Public self-signup — creates demo account ─────────────
r.post('/signup', async (req, res) => {
  try {
    const { name, email, password, first_name, last_name, phone, company } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const exists = db.prepare('SELECT id FROM accounts WHERE email=?').get(email.toLowerCase().trim());
    if (exists) return res.status(409).json({ error: 'An account with this email already exists' });

    const hash = await bcrypt.hash(password, 12);
    const id = uuid();
    db.prepare('INSERT INTO accounts (id,name,email,password_hash,role,is_active,demo_mode,account_tier,first_name,last_name,phone,company,can_sell_online,can_send_email) VALUES (?,?,?,?,?,1,1,\'demo\',?,?,?,?,0,0)')
      .run(id, name.trim(), email.toLowerCase().trim(), hash, 'user', first_name||null, last_name||null, phone||null, company||null);

    // Seed demo event
    const { seedDemoEvent } = await import('./demo.js');
    await seedDemoEvent(id);

    // Send welcome notification emails (non-blocking)
    const newAccount = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    notifySignup({ account: newAccount }).catch(() => {});

    const tv = 1;
    const jwtToken = jwt.sign({ userId: id, tokenVersion: tv }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: jwtToken, user: { id, name: name.trim(), email: email.toLowerCase().trim(), role: 'user', demo_mode: 1 } });
  } catch(e) {
    console.error('[signup]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.post('/register', async (req, res) => {
  try {
    const { password, token } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Must have invite token (except first ever user)
    if (!token) {
      const total = db.prepare('SELECT COUNT(*) as c FROM accounts WHERE is_active=1').get().c;
      if (total > 0) return res.status(403).json({ error: 'An invite link is required to register' });
      // First ever user — needs name and email
      const { name, email } = req.body;
      if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
      const exists = db.prepare('SELECT id FROM accounts WHERE email=? AND is_active=1').get(email.toLowerCase());
      if (exists) return res.status(409).json({ error: 'Email already registered' });
      const hash = await bcrypt.hash(password, 12);
      const id = uuid();
      db.prepare('INSERT INTO accounts (id,name,email,password_hash,role) VALUES (?,?,?,?,?)').run(id, name, email.toLowerCase(), hash, 'admin');
      const jwtToken = jwt.sign({ userId: id, tokenVersion: 1 }, JWT_SECRET, { expiresIn: '30d' });
      return res.json({ token: jwtToken, user: { id, name, email: email.toLowerCase(), role: 'admin' } });
    }

    // Validate invite token
    const invite = db.prepare("SELECT * FROM invite_tokens WHERE token=? AND used=0 AND expires_at>datetime('now')").get(token);
    if (!invite) return res.status(400).json({ error: 'Invite link is invalid or expired' });

    // Find the provisional account created when invite was sent
    const provisional = db.prepare('SELECT * FROM accounts WHERE id=? AND is_active=0').get(invite.account_id);
    if (!provisional) return res.status(400).json({ error: 'Invite link is invalid or has already been used' });

    // Activate it with the password — name was already set by admin
    const hash = await bcrypt.hash(password, 12);
    const { first_name, last_name, phone, company } = req.body;
    db.prepare('UPDATE accounts SET password_hash=?,is_active=1,first_name=?,last_name=?,phone=?,company=? WHERE id=?').run(hash, first_name||null, last_name||null, phone||null, company||null, provisional.id);
    db.prepare('UPDATE invite_tokens SET used=1 WHERE id=?').run(invite.id);

    // If this is a sub-user invite (account_id != user's own id), add membership
    // For top-level invites, the provisional account IS their account
    const user = db.prepare('SELECT id,name,email,role,token_version FROM accounts WHERE id=?').get(provisional.id);
    const tv = user.token_version || 1;
    const jwtToken = jwt.sign({ userId: user.id, tokenVersion: tv }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: jwtToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    console.error('[register error]', e.message, e.stack);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Login — detects multiple roles and returns context choices ──
r.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = db.prepare('SELECT * FROM accounts WHERE email=? AND is_active=1').get(email.toLowerCase());
    if (!user || !await bcrypt.compare(password, user.password_hash))
      return res.status(401).json({ error: 'Wrong email or password' });

    // Find all event memberships (dual-role support)
    const memberships = db.prepare(`
      SELECT m.role as member_role, m.account_id,
             a.name as account_name, a.email as account_email
      FROM account_members m
      JOIN accounts a ON a.id = m.account_id
      WHERE m.user_id = ?`).all(user.id);

    const token = jwt.sign({ userId: user.id, tokenVersion: user.token_version }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      memberships
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

r.get('/google-client-id', (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || null });
});

// Update profile (used after Google sign-up to collect missing info)
r.patch('/update-profile', auth, (req, res) => {
  const { company, phone, first_name, last_name } = req.body;
  const updates = [];
  const vals = [];
  if (company !== undefined) { updates.push('company=?'); vals.push(company); }
  if (phone !== undefined) { updates.push('phone=?'); vals.push(phone); }
  if (first_name !== undefined) { updates.push('first_name=?'); vals.push(first_name); }
  if (last_name !== undefined) { updates.push('last_name=?'); vals.push(last_name); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.user.id);
  db.prepare(`UPDATE accounts SET ${updates.join(',')} WHERE id=?`).run(...vals);
  res.json({ ok: true });
});

// ── Google Sign-In ────────────────────────────────────────
r.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'credential required' });
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(503).json({ error: 'Google login not configured. Set GOOGLE_CLIENT_ID in environment variables.' });
  try {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const { sub: googleId, email, name, picture } = ticket.getPayload();
    if (!email) return res.status(400).json({ error: 'No email in Google token' });
    const emailLower = email.toLowerCase();

    // Find by Google ID, then by email (to link existing accounts)
    let account = db.prepare('SELECT * FROM accounts WHERE google_id=?').get(googleId)
      || db.prepare('SELECT * FROM accounts WHERE email=?').get(emailLower);

    const isNew = !account; // capture before we create

    if (account) {
      if (!account.is_active) return res.status(403).json({ error: 'Account is disabled' });
      // Link Google ID if not already linked
      if (!account.google_id) {
        db.prepare('UPDATE accounts SET google_id=?, avatar_url=? WHERE id=?')
          .run(googleId, picture || null, account.id);
      }
    } else {
      // Create new demo account
      const id = uuid();
      const parts = (name || emailLower.split('@')[0]).split(' ');
      db.prepare(`INSERT INTO accounts
        (id,name,email,password_hash,role,is_active,demo_mode,account_tier,first_name,last_name,can_sell_online,can_send_email,google_id,avatar_url)
        VALUES (?,?,?,?,?,1,1,'demo',?,?,0,0,?,?)`)
        .run(id, name||emailLower.split('@')[0], emailLower, '', 'user',
          parts[0]||'', parts.slice(1).join(' ')||'', googleId, picture||null);
      account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
      // Seed demo event
      try { const { seedDemoEvent } = await import('./demo.js'); await seedDemoEvent(id); } catch(e) { console.error('[google/demo]', e.message); }
    }

    const token = jwt.sign(
      { id: account.id, email: account.email, role: account.role, v: account.token_version || 0 },
      JWT_SECRET, { expiresIn: '90d' }
    );
    res.json({
      token,
      new_account: isNew,
      user: { id: account.id, name: account.name, email: account.email, role: account.role,
              demo_mode: account.demo_mode, avatar_url: account.avatar_url,
              company: account.company || null }
    });
  } catch(e) {
    console.error('[google-auth]', e.message);
    res.status(401).json({ error: 'Google sign-in failed: ' + e.message });
  }
});

r.post('/pin-login', async (req, res) => {
  try {
    const { pin, eventId } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN required' });
    const sc = db.prepare(`SELECT a.*, sp.allow_lookup, sp.id as pin_id, sp.allowed_levels FROM scanner_pins sp
      JOIN accounts a ON a.id = sp.account_id
      WHERE sp.pin = ? AND sp.event_id = ? AND a.is_active = 1`).get(pin, eventId || '');
    if (!sc) return res.status(401).json({ error: 'Invalid PIN' });
    const token = jwt.sign({ userId: sc.id, scannerEventId: eventId, pinId: sc.pin_id }, JWT_SECRET, { expiresIn: '12h' });
    const event = db.prepare('SELECT id,name,date,venue FROM events WHERE id=?').get(eventId);
    const allowedLevels = sc.allowed_levels ? JSON.parse(sc.allowed_levels) : [];
    res.json({ token, user: { id: sc.id, name: sc.name, email: sc.email, role: 'scanner' }, event, allow_lookup: sc.allow_lookup === 1, allowed_levels: allowedLevels });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

r.get('/me', auth, (req, res) => res.json({ user: req.user }));

// ── Validate invite token (GET) ──
r.get('/invite/:token', (req, res) => {
  const inv = db.prepare(`SELECT i.*,a.name as account_name,a.name as invited_name FROM invite_tokens i
    JOIN accounts a ON a.id=i.account_id
    WHERE i.token=? AND i.used=0 AND i.expires_at>datetime('now')`).get(req.params.token);
  if (!inv) return res.status(400).json({ error: 'Invalid or expired invite link' });
  res.json({ email: inv.email, accountName: inv.account_name, role: inv.role, name: inv.invited_name });
});

// ── Send invite — user sets their OWN password on first login ──
r.post('/invite', auth, async (req, res) => {
  try {
    const { email, accountId, role = 'member' } = req.body;
    if (!email || !accountId) return res.status(400).json({ error: 'Email and accountId required' });

    const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    if (req.user.role !== 'admin' && account.id !== req.user.id) {
      const m = db.prepare('SELECT role FROM account_members WHERE account_id=? AND user_id=?').get(accountId, req.user.id);
      if (!m || m.role !== 'owner') return res.status(403).json({ error: 'No permission to invite' });
    }

    // Cancel any existing unused invite for same email+account
    db.prepare('UPDATE invite_tokens SET used=1 WHERE email=? AND account_id=? AND used=0').run(email.toLowerCase(), accountId);

    const token = uuid().replace(/-/g,'') + uuid().replace(/-/g,'');
    const expires = new Date(Date.now() + 48*60*60*1000).toISOString();
    db.prepare('INSERT INTO invite_tokens (id,account_id,email,token,role,expires_at) VALUES (?,?,?,?,?,?)').run(uuid(), accountId, email.toLowerCase(), token, role, expires);

    const appUrl = process.env.APP_URL || 'http://localhost:3001';
    // Link goes to set-password page, not register — user only needs to set name + password
    const url = `${appUrl}/register.html?token=${token}&email=${encodeURIComponent(email)}`;

    await sendMail({
      to: email,
      subject: `You're invited to join ${account.name} — EverythingShul.com Tickets`,
      html: inviteEmail({ fromName: req.user.name, accountName: account.name, url, role })
    });

    res.json({ ok: true, message: `Invite sent to ${email}` });
  } catch (e) {
    console.error('[invite error]', e);
    res.status(500).json({ error: 'Failed to send invite: ' + e.message });
  }
});

// ── Admin: reset a user's password ──
r.post('/reset-password', auth, async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (!userId || !newPassword) return res.status(400).json({ error: 'userId and newPassword required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE accounts SET password_hash=? WHERE id=?').run(hash, userId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Get/update own profile ──
r.get('/profile', auth, (req, res) => {
  const user = db.prepare('SELECT id,name,email,role,first_name,last_name,phone,company,created_at FROM accounts WHERE id=?').get(req.user.id);
  res.json({ user });
});

r.put('/profile', auth, async (req, res) => {
  try {
    const { first_name, last_name, phone, company, name } = req.body;
    db.prepare('UPDATE accounts SET first_name=?,last_name=?,phone=?,company=?,name=COALESCE(?,name) WHERE id=?')
      .run(first_name||null, last_name||null, phone||null, company||null, name||null, req.user.id);
    const user = db.prepare('SELECT id,name,email,role,first_name,last_name,phone,company FROM accounts WHERE id=?').get(req.user.id);
    // Update stored user in client
    res.json({ ok: true, user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

r.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const user = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id);
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE accounts SET password_hash=? WHERE id=?').run(hash, req.user.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: update any user profile ──
r.put('/users/:id/profile', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { first_name, last_name, phone, company, name, email, role } = req.body;
    const user = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare('UPDATE accounts SET first_name=?,last_name=?,phone=?,company=?,name=COALESCE(?,name),email=COALESCE(?,email) WHERE id=?')
      .run(first_name??user.first_name, last_name??user.last_name, phone??user.phone, company??user.company, name||null, email||null, user.id);
    if (role && ['admin','user'].includes(role) && role !== user.role) {
      db.prepare('UPDATE accounts SET role=?,token_version=token_version+1 WHERE id=?').run(role, user.id);
    }
    res.json({ ok: true, user: db.prepare('SELECT id,name,email,role,first_name,last_name,phone,company,is_active FROM accounts WHERE id=?').get(user.id) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Update scanner PIN allow_lookup after creation ──
r.patch('/scanner-pin/:id/lookup', auth, (req, res) => {
  const { allow_lookup } = req.body;
  db.prepare('UPDATE scanner_pins SET allow_lookup=? WHERE id=?').run(allow_lookup ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

r.patch('/scanner-pin/:id', auth, (req, res) => {
  const { label, allow_lookup, allowed_levels } = req.body;
  const pin = db.prepare('SELECT * FROM scanner_pins WHERE id=?').get(req.params.id);
  if (!pin) return res.status(404).json({ error: 'PIN not found' });
  if (label !== undefined) db.prepare('UPDATE scanner_pins SET label=? WHERE id=?').run(label, req.params.id);
  if (allow_lookup !== undefined) db.prepare('UPDATE scanner_pins SET allow_lookup=? WHERE id=?').run(allow_lookup ? 1 : 0, req.params.id);
  if (allowed_levels !== undefined) db.prepare('UPDATE scanner_pins SET allowed_levels=? WHERE id=?').run(allowed_levels, req.params.id);
  res.json({ ok: true });
});
r.post('/scanner-pin', auth, async (req, res) => {
  try {
    const { eventId, label, allow_lookup = 1, allowed_levels = null } = req.body;
    if (!eventId) return res.status(400).json({ error: 'eventId required' });
    const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (req.user.role !== 'admin' && event.account_id !== req.user.id) {
      const m = db.prepare('SELECT role FROM account_members WHERE account_id=? AND user_id=?').get(event.account_id, req.user.id);
      if (!m) return res.status(403).json({ error: 'Access denied' });
    }
    let pin, exists = true;
    while (exists) {
      pin = String(Math.floor(100000 + Math.random() * 900000));
      exists = db.prepare('SELECT id FROM scanner_pins WHERE pin=? AND event_id=?').get(pin, eventId);
    }
    const id = uuid();
    const scannerEmail = `scanner-${id.slice(0,8)}@es.internal`;
    const hash = await bcrypt.hash(pin, 8);
    const accountId = uuid();
    db.prepare('INSERT INTO accounts (id,name,email,password_hash,role) VALUES (?,?,?,?,?)').run(accountId, label || `Scanner — ${event.name}`, scannerEmail, hash, 'scanner');
    db.prepare('INSERT INTO scanner_pins (id,account_id,event_id,pin,label,allow_lookup,allowed_levels,created_by) VALUES (?,?,?,?,?,?,?,?)').run(id, accountId, eventId, pin, label || 'Door Scanner', allow_lookup ? 1 : 0, allowed_levels || null, req.user.id);
    res.json({ ok: true, pin, label: label || 'Door Scanner', allow_lookup: !!allow_lookup, allowed_levels, id });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

r.get('/scanner-pins/:eventId', auth, (req, res) => {
  const pins = db.prepare('SELECT sp.*,a.name as account_name FROM scanner_pins sp JOIN accounts a ON a.id=sp.account_id WHERE sp.event_id=? ORDER BY sp.created_at DESC').all(req.params.eventId);
  res.json({ pins });
});

r.delete('/scanner-pin/:id', auth, (req, res) => {
  const sp = db.prepare('SELECT * FROM scanner_pins WHERE id=?').get(req.params.id);
  if (!sp) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM scanner_pins WHERE id=?').run(sp.id);
  db.prepare('DELETE FROM accounts WHERE id=?').run(sp.account_id);
  res.json({ ok: true });
});

export default r;
