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
try { db.exec('ALTER TABLE events ADD COLUMN closed_at TEXT'); } catch {} // set 48h after event end; users lose access, admin keeps it
try { db.exec('ALTER TABLE accounts ADD COLUMN demo_mode INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE accounts ADD COLUMN account_tier TEXT NOT NULL DEFAULT \'demo\''); } catch {} // demo | starter | pro | enterprise
try { db.exec('ALTER TABLE events ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0'); } catch {}

// Site content table for editable public pages
db.exec(`CREATE TABLE IF NOT EXISTS site_content (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

// Seed default site content if not present
const defaultContent = {
  'home.hero_title': 'Effortless Event Ticketing for Your Community',
  'home.hero_subtitle': 'Sell tickets online, manage attendees, scan at the door — all in one place. Built for synagogues, community organizations, and private events.',
  'home.cta_primary': 'Get Started Free',
  'home.cta_secondary': 'See Pricing',
  'home.feature1_title': 'Sell Tickets Online',
  'home.feature1_body': 'Beautiful ticket sale pages with Stripe payments, promo codes, and real-time capacity tracking.',
  'home.feature2_title': 'Manage Attendees',
  'home.feature2_body': 'Upload lists, assign seating, send individual or bulk tickets via email with professional PDF attachments.',
  'home.feature3_title': 'Scan at the Door',
  'home.feature3_body': 'QR code scanner works on any phone or tablet. Multiple entrances, staff tickets, and real-time check-in counts.',
  'home.feature4_title': 'Staff & Access Control',
  'home.feature4_body': 'Separate staff ticket system with ID badge PDFs. Restrict scanners to specific ticket levels.',
  'pricing.title': 'Simple, Transparent Pricing',
  'pricing.subtitle': 'Start free with a demo event. Upgrade when you\'re ready to go live.',
  'pricing.tier1_name': 'Demo',
  'pricing.tier1_price': 'Free',
  'pricing.tier1_desc': 'Try everything with a pre-loaded demo event. No credit card required.',
  'pricing.tier1_features': 'Full portal access\nDemo event with sample data\nAll features unlocked\nNo live events or payments',
  'pricing.tier2_name': 'Starter',
  'pricing.tier2_price': '$49',
  'pricing.tier2_period': 'per event',
  'pricing.tier2_desc': 'Everything you need for a single event.',
  'pricing.tier2_features': '1 live event\nOnline ticket sales\nEmail delivery\nAttendee management\nDoor scanner',
  'pricing.tier3_name': 'Pro',
  'pricing.tier3_price': '$99',
  'pricing.tier3_period': 'per month',
  'pricing.tier3_desc': 'For organizations running events regularly.',
  'pricing.tier3_features': 'Unlimited events\nOnline ticket sales\nEmail delivery\nAll features\nPriority support',
  'faq.title': 'Frequently Asked Questions',
  'faq.items': JSON.stringify([
    { q: 'Do I need a credit card to sign up?', a: 'No. You can sign up and explore the full system with a demo event at no cost. A credit card is only needed when you\'re ready to run a live event with ticket sales.' },
    { q: 'How does payment processing work?', a: 'You connect your own Stripe account to collect payments directly. EverythingShul does not handle your money — all funds go straight to your Stripe account.' },
    { q: 'Can I import my existing attendee list?', a: 'Yes. Upload a CSV or Excel file with your attendee list and the system will match, import, and send tickets automatically.' },
    { q: 'How does the door scanner work?', a: 'Any phone or tablet with a camera can scan QR codes. Create a PIN for each entrance, open the scanner page, and you\'re ready. Works offline too.' },
    { q: 'Can I have multiple entrances with different access levels?', a: 'Yes. Each door scanner PIN can be restricted to specific ticket levels, so VIP entrances only let through VIP tickets.' },
    { q: 'What is a staff ticket?', a: 'Staff tickets use a business card ID badge format and are tracked separately from guest attendees. They don\'t count toward your event capacity.' },
    { q: 'Is my data secure?', a: 'Yes. All data is stored on your private Render deployment. Passwords are hashed. Stripe handles all payment data — we never store card numbers.' }
  ]),
  'terms.title': 'Terms and Conditions',
  'terms.last_updated': new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
  'terms.content': `<h2>1. Acceptance of Terms</h2>
<p>By creating an account and using EverythingShul Ticket System, you agree to these Terms and Conditions. If you do not agree, do not use the service.</p>

<h2>2. Service Description</h2>
<p>EverythingShul Ticket System provides event ticketing software allowing you to sell tickets, manage attendees, and process check-ins. We are a software platform — we do not organize events or sell tickets on your behalf.</p>

<h2>3. Account Responsibilities</h2>
<p>You are responsible for maintaining the security of your account credentials and for all activity that occurs under your account. You must provide accurate information when registering.</p>

<h2>4. Demo Accounts</h2>
<p>Free demo accounts are provided for evaluation purposes only. Demo events cannot process real payments or send emails to attendees. Upgrade to a paid plan to run live events.</p>

<h2>5. Payment Processing</h2>
<p>Ticket sales are processed through your own Stripe account. EverythingShul is not responsible for payment disputes, refunds, or chargebacks. You must comply with Stripe's Terms of Service.</p>

<h2>6. Event Data</h2>
<p>You retain ownership of your event data and attendee information. By using our platform, you grant us a limited license to store and process this data solely to provide the service.</p>

<h2>7. Prohibited Uses</h2>
<p>You may not use the platform for illegal activities, fraud, spam, or any purpose that violates applicable law. We reserve the right to suspend accounts for violations.</p>

<h2>8. Limitation of Liability</h2>
<p>The service is provided "as is." EverythingShul is not liable for any indirect, incidental, or consequential damages arising from your use of the platform.</p>

<h2>9. Changes to Terms</h2>
<p>We may update these terms at any time. Continued use of the service after changes constitutes acceptance of the revised terms.</p>

<h2>10. Contact</h2>
<p>For questions about these terms, contact us at <a href="mailto:hello@everythingshul.com">hello@everythingshul.com</a>.</p>`
};
for (const [key, value] of Object.entries(defaultContent)) {
  try { db.prepare('INSERT OR IGNORE INTO site_content (key, value) VALUES (?,?)').run(key, value); } catch {}
}
try { db.exec('ALTER TABLE scanner_pins ADD COLUMN allowed_levels TEXT'); } catch {}

// Staff table — completely separate from attendees
db.exec(`CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  email TEXT,
  ticket_id TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  confirmed INTEGER NOT NULL DEFAULT 0,
  level_id TEXT,
  sent_at TEXT,
  checked_in_at TEXT,
  checkout_data TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);`);
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
try { db.exec("UPDATE attendees SET source='offline' WHERE source IS NULL OR source='' OR (source NOT IN ('online','offline','staff'))"); } catch {}
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

// Stripe Connect per-account
try { db.exec('ALTER TABLE accounts ADD COLUMN stripe_connect_id TEXT'); } catch {}        // Stripe account ID (acct_...)
try { db.exec('ALTER TABLE accounts ADD COLUMN stripe_connect_key TEXT'); } catch {}       // access_token
try { db.exec('ALTER TABLE accounts ADD COLUMN stripe_connect_refresh TEXT'); } catch {}   // refresh_token
try { db.exec('ALTER TABLE accounts ADD COLUMN stripe_connect_pub TEXT'); } catch {}       // stripe_publishable_key
try { db.exec('ALTER TABLE accounts ADD COLUMN stripe_connect_livemode INTEGER'); } catch {}
try { db.exec('ALTER TABLE events ADD COLUMN platform_order_id TEXT'); } catch {}          // order ID for event creation payment

// Platform settings — single-row config table
db.exec(`CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`);
// Seed defaults
const settingDefaults = {
  'platform_fee_percent': '0',        // % cut on ticket sales via Connect (0-100)
  'event_creation_fee_cents': '4900', // cents charged to create a live event ($49)
  'currency': 'usd',
};
for (const [key, value] of Object.entries(settingDefaults)) {
  try { db.prepare('INSERT OR IGNORE INTO platform_settings (key,value) VALUES (?,?)').run(key, value); } catch {}
}

// Pricing plans — shown at event creation paywall
db.exec(`CREATE TABLE IF NOT EXISTS pricing_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  features TEXT,       -- JSON array of feature strings
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
// Seed a default plan if none exist
if (!db.prepare('SELECT id FROM pricing_plans LIMIT 1').get()) {
  try {
    db.prepare(`INSERT INTO pricing_plans (id,name,description,price_cents,features,sort_order)
      VALUES (?,?,?,?,?,0)`).run(
      'plan_default', 'Single Event', 'Everything you need to run one live event',
      4900,
      JSON.stringify(['Online ticket sales','Email delivery with PDF tickets','Door scanner PINs','Attendee management','Staff tickets','Promo codes'])
    );
  } catch {}
}
// attendees: add staff as a valid source value (already stored in source field, no migration needed)

// Verify columns exist (log on startup)
const eventCols = db.prepare("PRAGMA table_info(events)").all().map(c=>c.name);
const attendeeCols = db.prepare("PRAGMA table_info(attendees)").all().map(c=>c.name);
console.log('[DB] events cols with capacity:', eventCols.filter(c=>c.includes('capacity')||c.includes('max_ticket')));
console.log('[DB] attendees has source:', attendeeCols.includes('source'));
// Fix source values on startup — preserve 'staff', only reset truly invalid values
try { db.exec("UPDATE attendees SET source='offline' WHERE source IS NULL OR (source NOT IN ('online','offline','staff'))"); } catch {}
// Backfill: any attendee with a staff level should have source='staff'
try { db.exec("UPDATE attendees SET source='staff' WHERE deleted_at IS NULL AND source!='staff' AND level_id IN (SELECT id FROM ticket_levels WHERE is_staff=1)"); } catch {}

// ── SMS/IVR — per-event phone numbers (platform Stripe only) ─
// Each event gets its own Twilio number — customers call/text that number for that event
try { db.exec("ALTER TABLE events ADD COLUMN phone_number TEXT"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN phone_number_expires TEXT"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN phone_number_notified INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE events ADD COLUMN sms_ivr_enabled INTEGER NOT NULL DEFAULT 0"); } catch {}
// Keep account-level columns for backward compat (don't remove existing data)
try { db.exec("ALTER TABLE accounts ADD COLUMN sms_ivr_enabled INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE accounts ADD COLUMN phone_number TEXT"); } catch {}
try { db.exec("ALTER TABLE accounts ADD COLUMN phone_number_expires TEXT"); } catch {}
try { db.exec("ALTER TABLE accounts ADD COLUMN phone_number_notified INTEGER DEFAULT 0"); } catch {}

db.exec(`CREATE TABLE IF NOT EXISTS phone_orders (
  id TEXT PRIMARY KEY,
  event_id TEXT, account_id TEXT, channel TEXT NOT NULL,
  from_number TEXT NOT NULL, attendee_name TEXT, attendee_email TEXT,
  level_id TEXT, quantity INTEGER NOT NULL DEFAULT 1,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  stripe_payment_intent_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
  ticket_ids TEXT, error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

db.exec(`CREATE TABLE IF NOT EXISTS sms_sessions (
  phone TEXT PRIMARY KEY, account_id TEXT, event_slug TEXT,
  step TEXT NOT NULL DEFAULT 'welcome', data TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

const smsDefaults = {
  'sms.enabled':'0','ivr.enabled':'0',
  // SAQ-D / PCI compliance info (editable in admin, reference only)
  'pci.merchant_name':'','pci.merchant_dba':'','pci.contact_name':'','pci.contact_title':'',
  'pci.contact_phone':'','pci.contact_email':'','pci.merchant_url':'',
  'pci.merchant_category_code':'7922','pci.business_type':'Event Ticketing Platform',
  'pci.processor':'Stripe','pci.acquirer_bank':'','pci.merchant_id':'',
  'pci.annual_transactions':'','pci.saq_version':'SAQ-D v4.0',
  'pci.last_assessment_date':'','pci.next_assessment_due':'',
  'pci.asv_vendor':'','pci.last_scan_date':'','pci.next_scan_due':'','pci.notes':'',
  'sms.welcome':'Welcome to EverythingShul Tickets! Text an event code to buy tickets, or HELP for help.',
  'sms.help':'EverythingShul Tickets: Text an event code to buy. Text CANCEL to start over.',
  'sms.invalid_code':'Sorry, that event code was not found. Please check and try again.',
  'sms.no_levels':'Sorry, no tickets are available for this event.',
  'sms.select_level':'{{event_name}}\n{{event_date}}\n\nSelect a ticket level:\n{{levels}}\n\nReply with a number or CANCEL.',
  'sms.select_quantity':'{{level_name}} - ${{price}} each.\nHow many tickets? (1-10)\nReply with a number or CANCEL.',
  'sms.get_name':'{{quantity}} x {{level_name}} = ${{total}}\nYour full name? (First and Last)',
  'sms.get_email':'Thanks {{first_name}}! Email address for your tickets?',
  'sms.confirm':'Order Summary:\n{{quantity}} x {{level_name}}\nTotal: ${{total}}\nEmail: {{email}}\n\nText YES to confirm and pay, or CANCEL to stop.',
  'sms.get_card':'To pay, enter your card number (digits only, no spaces). This is a secure MOTO transaction.',
  'sms.get_expiry':'Card ending {{last4}} received.\nEnter expiry in MMYY format (e.g. 1228 for Dec 2028):',
  'sms.get_cvv':'Enter the 3 or 4 digit security code from the back of your card:',
  'sms.processing':'Processing your payment...',
  'sms.success':'Payment confirmed! ${{total}} charged. {{quantity}} ticket(s) for {{event_name}}. Tickets sent to {{email}}. Thank you!',
  'sms.declined':'Payment declined. Please check your card and try again, or text CANCEL.',
  'sms.cancelled':'Order cancelled. Text an event code anytime to start again.',
  'sms.session_expired':'Your session timed out. Text an event code to start a new order.',
  'sms.error':'Something went wrong. Please try again or text HELP.',
  'ivr.tts_voice':'Polly.Joanna',
  'ivr.welcome':'Welcome to EverythingShul Tickets. Press 1 to buy tickets. Press 9 to repeat.',
  'ivr.welcome_recording':'',
  'ivr.select_event':'Select your event. {{event_list}} Press 0 to go back.',
  'ivr.select_event_recording':'',
  'ivr.select_level':'{{event_name}} ticket options. {{level_list}} Press 0 to go back.',
  'ivr.select_level_recording':'',
  'ivr.select_quantity':'{{level_name}} at {{price}} dollars each. How many tickets? Press 1 through 10 then pound.',
  'ivr.select_quantity_recording':'',
  'ivr.confirm':'Your order: {{quantity}} ticket at {{total}} dollars total. Press 1 to confirm and pay. Press 2 to cancel.',
  'ivr.confirm_recording':'',
  'ivr.get_card':'Please enter your 16 digit card number followed by the pound key.',
  'ivr.get_card_recording':'',
  'ivr.get_expiry':'Card ending {{last4}} received. Enter your 4 digit expiration date, month then year, followed by pound.',
  'ivr.get_expiry_recording':'',
  'ivr.get_cvv':'Enter your 3 or 4 digit security code from the back of your card, followed by pound.',
  'ivr.get_cvv_recording':'',
  'ivr.processing':'Processing your payment. Please hold.',
  'ivr.processing_recording':'',
  'ivr.success':'Payment confirmed. {{quantity}} ticket for {{event_name}}. Your tickets will be emailed shortly. Thank you, goodbye.',
  'ivr.success_recording':'',
  'ivr.declined':'Your payment was declined. Please call back to try again. Goodbye.',
  'ivr.declined_recording':'',
  'ivr.invalid':'I did not receive your input. Please try again.',
  'ivr.error':'An error occurred. Please call back. Goodbye.',
  'ivr.no_available':'No events are available for phone ordering. Please try again later. Goodbye.',
};
for (const [k,v] of Object.entries(smsDefaults)) {
  try { db.prepare('INSERT OR IGNORE INTO platform_settings (key,value) VALUES (?,?)').run(k,v); } catch {}
}

export default db;
