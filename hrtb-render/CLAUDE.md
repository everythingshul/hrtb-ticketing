# Mamudem — Event Ticketing Platform

## What this is
A full SaaS ticketing platform for synagogues and community organizations. Live at **mamudem.com**. Built and maintained iteratively with Claude.

## Stack
- **Backend:** Node.js + Express (ES modules), SQLite via `better-sqlite3`
- **Frontend:** Vanilla HTML/CSS/JS (no framework)
- **Hosting:** Render.com (single web service, $7/month)
- **Database:** SQLite file at `/data/db.sqlite` on Render's persistent disk
- **Payments:** Stripe (platform account for plan purchases + per-account Stripe Connect for online ticket sales)
- **Email:** Gmail SMTP via Nodemailer (`mamudemtickets@gmail.com`)
- **SMS/IVR:** Twilio (toll-free numbers, SMS inbound/outbound, IVR phone ordering)
- **PDF tickets:** `pdf-lib`

## Project structure
```
hrtb-render/
├── src/
│   ├── index.js              — Express app entry point, middleware, route mounting
│   ├── db.js                 — SQLite schema, migrations (ALTER TABLE tries)
│   ├── middleware/auth.js    — JWT auth middleware
│   └── routes/
│       ├── auth.js           — Login, signup, Google OAuth, update-profile
│       ├── events.js         — Events CRUD, plan limit enforcement
│       ├── attendees.js      — Attendees, ticket levels, bulk import
│       ├── sales.js          — Public sale page, Stripe checkout, settings
│       ├── connect.js        — Pricing plans, event payment/paywall
│       ├── admin.js          — Admin portal: accounts, events, CRM, site content, logos
│       ├── sms-ivr.js        — Twilio SMS + IVR phone ordering, number purchase
│       └── demo.js           — Demo event seeding for new accounts
│   └── services/
│       ├── mail.js           — All transactional emails via Gmail SMTP
│       ├── ticketPDF.js      — PDF ticket generation with QR codes
│       └── dailyReport.js    — Nightly event stats emails
└── frontend/
    ├── css/style.css         — Single stylesheet, CSS variables, dark navy theme
    ├── js/app.js             — Shared JS: Auth, api object, renderSidebar, toast
    ├── logo.png              — Mamudem logo (dark navy + red, transparent bg)
    ├── favicon.ico           — White background baked in
    ├── icons/                — PWA icons (192px, 512px) with white background
    ├── manifest.json         — PWA manifest
    ├── index.html            — Public homepage (all content editable via admin)
    ├── login.html / signup.html
    ├── dashboard.html        — User event dashboard
    ├── events.html           — Event list + create form + pricing paywall
    ├── event-detail.html     — Attendees tab
    ├── event-levels.html     — Ticket levels management
    ├── event-sales.html      — Online sale page settings + toggle
    ├── event-stats.html      — Stats + plan usage meters
    ├── event-staff.html      — Staff tickets
    ├── scanner.html          — QR code door scanner
    ├── sale.html             — PUBLIC ticket sale page (/events/:slug)
    ├── admin.html            — Admin dashboard
    ├── admin-events.html     — Admin all events
    ├── admin-accounts.html   — Admin accounts management
    ├── admin-crm.html        — CRM: transactions, refunds, phone orders
    ├── admin-content.html    — Site content editor (homepage, logos, pricing plans, IVR/SMS)
    ├── admin-phone.html      — Per-event phone/SMS/IVR settings
    ├── pricing.html          — Public pricing page
    ├── faq.html / terms.html / sms-terms.html
    └── sw.js                 — Service worker for PWA
```

## Render environment variables needed
```
APP_URL=https://mamudem.com
JWT_SECRET=<long random string>
DATA_DIR=/data
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
SMTP_USER=mamudemtickets@gmail.com
SMTP_PASS=<gmail app password>
SUPPORT_EMAIL=mamudemtickets@gmail.com
ADMIN_NOTIFY_EMAIL=mamudemtickets@gmail.com
GOOGLE_CLIENT_ID=...apps.googleusercontent.com  (optional)
MAINTENANCE_MODE=1  (optional, login page always accessible even when set)
```

## Key architecture decisions
- **SQLite on persistent disk** — db at `/data/db.sqlite`. Schema migrations are `try { ALTER TABLE ... } catch {}` at startup in db.js. Never destructive.
- **ES modules** — all `.js` files use `import/export`. Use `await import()` for dynamic imports inside route handlers (multer, path, fs).
- **JWT tokens** — `{ userId, tokenVersion }` format. Auth middleware reads `decoded.userId || decoded.id` (handles both formats for backwards compat).
- **Site content** — flat JSON at `/data/site_content.json`. All homepage text, IVR/SMS messages, logos stored here. Editable via Admin → Site Content.
- **Demo mode** — new accounts start with `demo_mode=1` and a seeded demo event. Paying for a plan flips `demo_mode=0` and sets `plan_id`.
- **Plan limits** — `pricing_plans.max_events`, `max_attendees`, `max_levels` enforced in events.js and attendees.js. Null = unlimited.
- **Uploaded files** — logos at `/data/logos/`, IVR audio at `/data/ivr-audio/`. Served via `express.static` at `/uploads/logos/` and `/uploads/ivr-audio/`.
- **Public sale page** — `/events/:slug` served by index.js → `frontend/sale.html` which fetches `/api/sales/event/:slug`.
- **auth middleware** — must be explicitly added to each route handler. Not applied at router level. Always check routes that reference `req.user` have `auth` in their signature.

## Deployment workflow
1. Edit code locally
2. `git add . && git commit -m "description" && git push`
3. Render auto-deploys on push to main branch
4. Live at mamudem.com within ~2 minutes

## Currently working
- Full ticketing: events, levels, attendees, promo codes, Stripe online payments
- PDF tickets with QR codes, email delivery
- Door scanner (any device, multiple entrances)
- Staff tickets with ID badge PDFs
- Admin portal: accounts, events, CRM, refunds, daily reports
- Pricing plans with limits + paywall
- SMS/IVR phone ordering via Twilio (toll-free numbers)
- Customer logo upload + scrolling homepage strip
- PWA install prompt, mobile sidebar with hamburger menu
- Maintenance mode (login page always accessible)

## Open issues
- Online sale page `sale_enabled` toggle — has had save issues, verify after changes to sales.js
- IVR "no tickets available" — needs test call after Twilio fully configured
- TTS voice preview — browser Web Speech API unreliable, 150ms delay after cancel() required
- Toll-free verification submitted to Twilio, awaiting approval (SMS blocked until approved)
- Google Sign-In needs GOOGLE_CLIENT_ID in Render env vars

## Critical gotchas
- `express.urlencoded()` must be before route handlers for Twilio webhooks (form-encoded bodies)
- Twilio IVR Gather callbacks send `Called` (not `To`) for the destination number
- `sendFile()` requires absolute paths
- `online_orders` table may not exist on older deploys — always wrap queries in try/catch
- Browser `synth.cancel()` needs 150ms before new `synth.speak()` or Chrome ignores it
- Email clients don't support flexbox — use HTML tables for row layouts in emails
- Logo images need absolute URLs in emails — relative paths don't load in Gmail/Outlook
- Base64 data URLs for logos won't work in large quantities — use file upload to /data/logos/
- The `auth` middleware must be added explicitly to every route that reads `req.user`
