// Seeds a demo event with sample attendees, levels, and scanner PIN
import { v4 as uuid } from 'uuid';
import db from '../db.js';

const tid = () => 'TKT-' + Math.random().toString(36).substr(2,8).toUpperCase();

const DEMO_ATTENDEES = [
  { first_name:'Sarah', last_name:'Cohen',   phone:'5551001001', email:'sarah.cohen@example.com',   level:0, status:'sent',    confirmed:1 },
  { first_name:'David', last_name:'Levy',    phone:'5551001002', email:'david.levy@example.com',    level:0, status:'checked', confirmed:1 },
  { first_name:'Rachel',last_name:'Katz',    phone:'5551001003', email:'rachel.katz@example.com',   level:1, status:'sent',    confirmed:1 },
  { first_name:'Moshe', last_name:'Shapiro', phone:'5551001004', email:'moshe.shapiro@example.com', level:1, status:'pending', confirmed:0 },
  { first_name:'Miriam',last_name:'Schwartz', phone:'5551001005', email:'miriam@example.com',       level:0, status:'sent',    confirmed:1 },
  { first_name:'Yosef', last_name:'Goldberg', phone:'5551001006', email:'yosef@example.com',        level:2, status:'checked', confirmed:1 },
  { first_name:'Leah',  last_name:'Weiss',   phone:'5551001007', email:'leah.weiss@example.com',    level:0, status:'pending', confirmed:0 },
  { first_name:'Aaron', last_name:'Stein',   phone:'5551001008', email:'aaron.stein@example.com',   level:1, status:'sent',    confirmed:1 },
  { first_name:'Rivka', last_name:'Blum',    phone:'5551001009', email:'rivka.blum@example.com',    level:2, status:'checked', confirmed:1 },
  { first_name:'Chaim', last_name:'Rosen',   phone:'5551001010', email:'chaim.rosen@example.com',   level:0, status:'pending', confirmed:0 },
  { first_name:'Dina',  last_name:'Friedman',phone:'5551001011', email:'dina@example.com',          level:1, status:'checked', confirmed:1 },
  { first_name:'Noam',  last_name:'Levi',    phone:'5551001012', email:'noam.levi@example.com',     level:0, status:'sent',    confirmed:1 },
];

const DEMO_STAFF = [
  { first_name:'Jake',  last_name:'Green',   phone:'5551009001', email:'jake@example.com',  level_name:'Security' },
  { first_name:'Maria', last_name:'Torres',  phone:'5551009002', email:'maria@example.com', level_name:'Volunteer' },
];

export async function seedDemoEvent(accountId) {
  const eventId = uuid();
  const eventDate = new Date();
  eventDate.setDate(eventDate.getDate() + 30); // 30 days from now
  const dateFmt = eventDate.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });

  db.prepare(`INSERT INTO events (id,account_id,name,date,venue,description,timezone,is_demo,slug,sale_enabled)
    VALUES (?,?,?,?,?,?,?,1,?,1)`).run(
    eventId, accountId,
    'Annual Gala — Demo Event',
    dateFmt + ' · 7:00 PM',
    'Grand Ballroom, 123 Main Street',
    'This is a demo event to help you explore all features. No emails are sent and no payments are processed.',
    'America/New_York',
    `demo-${accountId.slice(0,8)}`
  );

  // Ticket levels
  const levels = [
    { id: uuid(), name:'General',  color:'#4f46e5', price:5000,  is_staff:0 },
    { id: uuid(), name:'VIP',      color:'#b45309', price:10000, is_staff:0 },
    { id: uuid(), name:'Platinum', color:'#7c3aed', price:18000, is_staff:0 },
  ];
  const staffLevels = [
    { id: uuid(), name:'Security',  color:'#1a3a6b', is_staff:1 },
    { id: uuid(), name:'Volunteer', color:'#065f46', is_staff:1 },
  ];

  for (const l of [...levels, ...staffLevels]) {
    db.prepare('INSERT INTO ticket_levels (id,event_id,name,color,price,online_sale,is_staff) VALUES (?,?,?,?,?,1,?)')
      .run(l.id, eventId, l.name, l.color, l.price||0, l.is_staff||0);
  }

  // Attendees
  for (const a of DEMO_ATTENDEES) {
    const lvl = levels[a.level];
    db.prepare(`INSERT INTO attendees (id,event_id,account_id,first_name,last_name,phone,email,ticket_id,status,confirmed,level_id,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'online')`)
      .run(uuid(), eventId, accountId, a.first_name, a.last_name, a.phone, a.email, tid(), a.status, a.confirmed, lvl.id);
  }

  // Staff
  for (const s of DEMO_STAFF) {
    const staffLvl = staffLevels.find(l => l.name === s.level_name);
    db.prepare(`INSERT INTO staff (id,event_id,account_id,first_name,last_name,phone,email,ticket_id,status,confirmed,level_id)
      VALUES (?,?,?,?,?,?,?,?,'sent',1,?)`)
      .run(uuid(), eventId, accountId, s.first_name, s.last_name, s.phone, s.email, tid(), staffLvl?.id||null);
  }

  // Promo code
  db.prepare('INSERT INTO promo_codes (id,event_id,code,type,value,active) VALUES (?,?,?,?,?,1)')
    .run(uuid(), eventId, 'DEMO20', 'percent', 20);

  // Scanner PIN
  db.prepare(`INSERT INTO scanner_pins (id,account_id,event_id,pin,label,allow_lookup,created_by) VALUES (?,?,?,?,?,1,?)`)
    .run(uuid(), accountId, eventId, '123456', 'Demo Entrance', accountId);

  return eventId;
}
