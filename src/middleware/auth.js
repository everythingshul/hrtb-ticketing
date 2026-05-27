import jwt from 'jsonwebtoken';
import db from '../db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'hrtb-change-this-secret';

export function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    const { userId, tokenVersion } = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id,name,email,role,is_active,token_version FROM accounts WHERE id=?').get(userId);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Account not found or disabled' });
    // Only enforce token_version if both sides have it
    if (tokenVersion !== undefined && user.token_version !== undefined && user.token_version !== tokenVersion)
      return res.status(401).json({ error: 'Your role has changed. Please log in again.', forceLogout: true });
    req.user = user;
    next();
  } catch { res.status(401).json({ error: 'Session expired, please log in again' }); }
}

export function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

export function requireEvent(req, res, next) {
  const id = req.params.eventId || req.body.eventId;
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  // Scanner role: only allow access to their specific event
  if (req.user.role === 'scanner') {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    try {
      const jwt = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      if (jwt.scannerEventId && jwt.scannerEventId !== id)
        return res.status(403).json({ error: 'Access denied for this event' });
    } catch {}
    req.event = event;
    return next();
  }
  const isOwner = event.account_id === req.user.id;
  const isMember = db.prepare('SELECT id FROM account_members WHERE account_id=? AND user_id=?').get(event.account_id, req.user.id);
  if (req.user.role !== 'admin' && !isOwner && !isMember) return res.status(403).json({ error: 'Access denied' });
  // Closed events: allow read-only access, flag it so routes can block writes
  req.eventClosed = !!(req.user.role !== 'admin' && event.closed_at);
  req.event = event;
  next();
}

// Blocks write operations on closed events for non-admins
export function blockIfClosed(req, res, next) {
  if (req.eventClosed) return res.status(403).json({ error: 'EVENT_CLOSED_READONLY', message: 'This event has ended and is now read-only.' });
  next();
}
