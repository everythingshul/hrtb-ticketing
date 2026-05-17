import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use DATA_DIR env var if set, else try /data (Render disk), else /tmp/hrtb-data (free tier)
function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try { mkdirSync('/data', { recursive: true }); return '/data'; } catch {}
  return '/tmp/hrtb-data';
}
const DATA_DIR = resolveDataDir();
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'hrtb.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    token_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    date TEXT,
    venue TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attendees (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    phone TEXT,
    email TEXT,
    table_number TEXT,
    seat_number TEXT,
    ticket_id TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    sent_at TEXT,
    checked_in_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invite_tokens (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    email TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS account_members (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE(account_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS scanner_pins (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    pin TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'Door Scanner',
    allow_lookup INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    UNIQUE(pin, event_id)
  );
`);

// ── Migrations (safe — run every time, no-op if already done) ──
try { db.exec('ALTER TABLE accounts ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE scanner_pins ADD COLUMN allow_lookup INTEGER NOT NULL DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE scanner_pins ADD COLUMN allowed_levels TEXT'); } catch {}

// Promo codes
db.exec(`CREATE TABLE IF NOT EXISTS promo_codes (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'percent', -- 'percent' or 'fixed'
  value INTEGER NOT NULL, -- percent (0-100) or cents
  expires_at TEXT,
  max_uses INTEGER, -- null = unlimited total uses
  max_tickets_per_level TEXT, -- JSON {levelId: maxTickets}
  max_money INTEGER, -- max total cents given away
  max_total_tickets INTEGER, -- max total tickets across all levels
  allowed_emails TEXT, -- JSON array of emails, null = all
  uses INTEGER NOT NULL DEFAULT 0,
  money_given INTEGER NOT NULL DEFAULT 0,
  tickets_given INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);`);
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS promo_code_event ON promo_codes (event_id, code)'); } catch {}
try { db.exec('ALTER TABLE accounts ADD COLUMN first_name TEXT'); } catch {}
try { db.exec('ALTER TABLE accounts ADD COLUMN last_name TEXT'); } catch {}
try { db.exec('ALTER TABLE accounts ADD COLUMN phone TEXT'); } catch {}
try { db.exec('ALTER TABLE accounts ADD COLUMN company TEXT'); } catch {}
try { db.exec('ALTER TABLE accounts ADD COLUMN reply_to TEXT'); } catch {}
try { db.exec('ALTER TABLE accounts ADD COLUMN max_events INTEGER NOT NULL DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE ticket_levels ADD COLUMN description TEXT'); } catch {}
try { db.exec('ALTER TABLE attendees ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE attendees ADD COLUMN level_id TEXT'); } catch {}
try { db.exec('ALTER TABLE events ADD COLUMN allow_unconfirmed_checkin INTEGER NOT NULL DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE accounts ADD COLUMN can_sell_online INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE ticket_levels ADD COLUMN price INTEGER NOT NULL DEFAULT 0'); } catch {} // price in cents
try { db.exec('ALTER TABLE ticket_levels ADD COLUMN online_sale INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE events ADD COLUMN slug TEXT'); } catch {}
try { db.exec('ALTER TABLE events ADD COLUMN sale_image TEXT'); } catch {}
try { db.exec('ALTER TABLE events ADD COLUMN sale_enabled INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE events ADD COLUMN stripe_key TEXT'); } catch {} // per-event stripe secret key
try { db.exec('ALTER TABLE events ADD COLUMN expires_at TEXT'); } catch {}
// Source column — add without NOT NULL constraint first (safer for migration)
try { db.exec("ALTER TABLE attendees ADD COLUMN source TEXT DEFAULT 'offline'"); } catch {}
// Fix any bad values from previous migration attempts
try { db.exec("UPDATE attendees SET source='offline' WHERE source IS NULL OR source='' OR (source!='online' AND source!='offline')"); } catch {}
try { db.exec('ALTER TABLE attendees ADD COLUMN checkout_data TEXT'); } catch {} // JSON: billing info

// Online orders table
db.exec(`CREATE TABLE IF NOT EXISTS online_orders (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  stripe_session_id TEXT,
  stripe_payment_intent TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  email TEXT,
  total_cents INTEGER NOT NULL DEFAULT 0,
  line_items TEXT NOT NULL DEFAULT '[]',
  checkout_data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (event_id) REFERENCES events(id)
);`);
try { db.exec('ALTER TABLE attendees ADD COLUMN deleted_at TEXT'); } catch {}
try { db.exec('ALTER TABLE events ADD COLUMN deleted_at TEXT'); } catch {}
try { db.exec('ALTER TABLE accounts ADD COLUMN deleted_at TEXT'); } catch {}

// Trash / soft-delete table — stores deleted events, attendees, accounts for 30 days
db.exec(`
  CREATE TABLE IF NOT EXISTS deleted_items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_data TEXT NOT NULL,
    deleted_by TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    event_id TEXT,
    account_id TEXT
  );
`);

// Ticket levels table
db.exec(`
  CREATE TABLE IF NOT EXISTS ticket_levels (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#6366f1',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  );
`);

// Safe migrations for capacity columns
try { db.exec("ALTER TABLE events ADD COLUMN max_tickets INTEGER"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN capacity_alert_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN capacity_alert_email TEXT"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN capacity_count_unconfirmed INTEGER"); } catch {}
try { db.exec("UPDATE events SET capacity_count_unconfirmed=1 WHERE capacity_count_unconfirmed IS NULL"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN allow_activation INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE ticket_levels ADD COLUMN max_tickets INTEGER"); } catch {}
try { db.exec("ALTER TABLE ticket_levels ADD COLUMN alert_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE ticket_levels ADD COLUMN show_availability INTEGER"); } catch {}
try { db.exec("UPDATE ticket_levels SET show_availability=0 WHERE show_availability IS NULL"); } catch {}
try { db.exec("ALTER TABLE ticket_levels ADD COLUMN is_staff INTEGER NOT NULL DEFAULT 0"); } catch {}
// attendees: add staff as a valid source value (already stored in source field, no migration needed)

// Verify columns exist (log on startup)
const eventCols = db.prepare("PRAGMA table_info(events)").all().map(c=>c.name);
const attendeeCols = db.prepare("PRAGMA table_info(attendees)").all().map(c=>c.name);
console.log('[DB] events cols with capacity:', eventCols.filter(c=>c.includes('capacity')||c.includes('max_ticket')));
console.log('[DB] attendees has source:', attendeeCols.includes('source'));
// Fix source values on startup
try { db.exec("UPDATE attendees SET source='offline' WHERE source IS NULL OR (source!='online' AND source!='offline')"); } catch {}

export default db;
