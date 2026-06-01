<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ticket Levels</title>
<link rel="stylesheet" href="/css/style.css">
</head>
<body>
<div class="shell">
  <aside class="sidebar" id="sidebar"></aside>
  <main class="main"><div class="page">
    <div class="ph mb22">
      <div class="ph-left">
        <h1 id="ev-title">Ticket Levels</h1>
        <p id="ev-sub" class="text2"></p>
      </div>
    </div>

    <!-- Ticket Levels panel -->
    <div class="card mb16" id="levels-panel"></div>

    <!-- Capacity Settings panel -->
    <div class="card mb16" id="capacity-panel">
      <div class="section-title mb12">Ticket Capacity Limits</div>
      <p class="sm text2 mb16">Set a maximum ticket count. When the limit is reached, the portal warns before adding and online sales stop automatically. Alerts send an email when the threshold is hit.</p>

      <div class="form-row mb12">
        <div class="fg" style="margin:0">
          <label>Max tickets <span class="xs text2">(blank = unlimited)</span></label>
          <input type="number" id="cap-max" min="1" placeholder="e.g. 500" oninput="this.value=this.value.replace(/[^0-9]/g,'')">
        </div>
        <div class="fg" style="margin:0">
          <label>Alert when sold ≥</label>
          <input type="number" id="cap-alert" min="1" placeholder="e.g. 450" oninput="this.value=this.value.replace(/[^0-9]/g,'')">
        </div>
      </div>
      <div class="fg mb16">
        <label>Alert email <span class="xs text2">(blank = account email)</span></label>
        <input type="email" id="cap-email" placeholder="alerts@example.com">
      </div>

      <div class="row-between mb16" style="padding:12px 14px;background:var(--bg3);border-radius:var(--r);border:1px solid var(--border)">
        <div>
          <div style="font-size:13px;font-weight:600">Count unconfirmed tickets toward capacity</div>
          <div class="xs text2 mt4">When OFF — only confirmed tickets count. Unconfirmed are ignored.</div>
        </div>
        <button id="cap-toggle-btn" onclick="toggleCapCount()"
          style="min-width:64px;padding:6px 14px;border-radius:20px;border:2px solid var(--navy);font-size:13px;font-weight:700;cursor:pointer;background:var(--navy);color:#fff;transition:.15s">
          ON
        </button>
      </div>

      <button class="btn btn-primary" onclick="saveCapacity()">Save Capacity Settings</button>

      <div id="level-capacity-wrap" style="margin-top:24px;display:none">
        <div class="section-title mb12" style="font-size:11px">Per-Level Limits</div>
        <div id="level-capacity-list"></div>
      </div>
    </div>

    <!-- Event Settings panel -->
    <div class="card mt16" id="settings-panel">
      <div class="section-title mb12">Event Settings</div>
      <div class="row-between">
        <div>
          <div style="font-size:13px;font-weight:600">Allow check-in for unconfirmed guests</div>
          <div class="sm text2">When off, only guests who confirmed attendance can check in at the door</div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="toggle-unconfirmed" onchange="toggleUnconfirmedCheckin(this.checked)" style="width:18px;height:18px;cursor:pointer">
          <span class="sm" id="toggle-unconfirmed-label">On</span>
        </label>
      </div>
    </div>

  </div></main>
</div>
<script src="/js/app.js"></script>
<script>
if (!Auth.require()) throw 0;
renderSidebar();

const params = new URLSearchParams(location.search);
const eventId = params.get('id');
if (!eventId) window.location = '/events.html';

let eventData = null;
let attendees = [];
let levels = [];

const LEVEL_PALETTE = ['#00aadd','#27a85f','#d97706','#7c5cbe','#d93535','#1a3a6b','#e11d48','#0891b2','#65a30d','#9333ea'];

// ── Capacity Settings ────────────────────────────────────
let capacityData = null;
let capCountUnconfirmed = true; // JS state — never read from DOM

function setCapToggle(val) {
  capCountUnconfirmed = val;
  const btn = document.getElementById('cap-toggle-btn');
  if (!btn) return;
  if (val) {
    btn.textContent = 'ON';
    btn.style.background = 'var(--navy)';
    btn.style.color = '#fff';
  } else {
    btn.textContent = 'OFF';
    btn.style.background = '#fff';
    btn.style.color = 'var(--navy)';
  }
}

function toggleCapCount() {
  setCapToggle(!capCountUnconfirmed);
}

async function loadCapacity() {
  try {
    const res = await fetch(`/api/attendees/event/${eventId}/capacity`, {
      headers: { 'Authorization': `Bearer ${Auth.token()}` }
    });
    if (!res.ok) return;
    capacityData = await res.json();
    document.getElementById('cap-max').value = capacityData.max_tickets || '';
    if (eventData) {
      document.getElementById('cap-alert').value = eventData.capacity_alert_at || '';
      document.getElementById('cap-email').value = eventData.capacity_alert_email || '';
    }
    // Set toggle from server — 0 = OFF, anything else = ON
    const raw = capacityData.capacity_count_unconfirmed;
    setCapToggle(raw !== 0);

    if (levels.length) {
      document.getElementById('level-capacity-wrap').style.display = 'block';
      document.getElementById('level-capacity-list').innerHTML = levels.map(l => {
        const ld = (capacityData.levels||[]).find(x => x.id === l.id) || {};
        return `<div style="padding:12px 14px;background:var(--bg3);border-radius:var(--r);border:1px solid var(--border);margin-bottom:8px">
          <div class="row mb10" style="gap:8px;align-items:center">
            <span class="badge" style="background:${l.color}22;color:${l.color};border:1px solid ${l.color}44">${esc(l.name)}</span>
            <span class="xs text2">Sold: ${ld.sold||0}${ld.max_tickets ? ' / ' + ld.max_tickets : ' / unlimited'}</span>
          </div>
          <div class="form-row mb8">
            <div class="fg" style="margin:0"><label>Max tickets</label>
              <input type="number" id="lmax-${l.id}" min="1" placeholder="unlimited" value="${ld.max_tickets||''}"></div>
            <div class="fg" style="margin:0"><label>Alert at</label>
              <input type="number" id="lalert-${l.id}" min="1" placeholder="—" value="${l.alert_at||''}"></div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="lshow-${l.id}" ${l.show_availability?'checked':''} style="width:15px;height:15px">
            Show available count on sale page
          </label>
          <button class="btn btn-sm btn-primary" style="margin-top:10px" onclick="saveLevelCapacity('${l.id}')">Save Level</button>
        </div>`;
      }).join('');
    }
  } catch(e) { console.warn('[loadCapacity]', e.message); }
}

async function saveCapacity() {
  const max      = parseInt(document.getElementById('cap-max').value) || null;
  const alert_at = parseInt(document.getElementById('cap-alert').value) || null;
  const email    = document.getElementById('cap-email').value.trim() || null;
  const sendVal  = capCountUnconfirmed ? 1 : 0;
  console.log('[saveCapacity] capCountUnconfirmed=', capCountUnconfirmed, '=> sending', sendVal);
  try {
    const res = await fetch(`/api/attendees/event/${eventId}/capacity`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Auth.token()}` },
      body: JSON.stringify({ max_tickets: max, capacity_alert_at: alert_at, capacity_alert_email: email, capacity_count_unconfirmed: sendVal })
    });
    if (!res.ok) { const d = await res.json().catch(()=>({})); toast('Error: ' + (d.error||res.status), 'error'); return; }
    // Re-load from server so the button reflects what was actually saved
    await loadCapacity();
    toast('Saved — unconfirmed count: ' + (capCountUnconfirmed ? 'ON' : 'OFF'));
  } catch(e) { toast(e.message, 'error'); }
}

async function saveLevelCapacity(levelId) {
  const max = parseInt(document.getElementById(`lmax-${levelId}`).value) || null;
  const alert_at = parseInt(document.getElementById(`lalert-${levelId}`).value) || null;
  const show = document.getElementById(`lshow-${levelId}`).checked;
  try {
    await fetch(`/api/attendees/event/${eventId}/level-capacity/${levelId}`, {
      method: 'PATCH', headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${Auth.token()}` },
      body: JSON.stringify({ max_tickets: max, alert_at, show_availability: show })
    });
    toast('Level capacity saved');
  } catch(e) { toast(e.message, 'error'); }
}

async function load() {
  const attData = await api.attendees.list(eventId);
  attendees = attData.attendees || [];
  levels = attData.levels || [];
  eventData = attData.event;
  if (!eventData) { window.location = '/events.html'; return; }
  document.getElementById('ev-title').textContent = eventData.name + ' — Ticket Levels';
  document.getElementById('ev-sub').textContent = [eventData.date, eventData.venue].filter(Boolean).join(' · ');
  document.title = `Ticket Levels — ${eventData.name}`;
  localStorage.setItem('hrtb_current_event_name', eventData.name);
  renderSidebar();
  renderLevelsPanel();
  loadCapacity();
  const toggle = document.getElementById('toggle-unconfirmed');
  if (toggle) {
    const allowed = eventData.allow_unconfirmed_checkin !== 0;
    toggle.checked = allowed;
    document.getElementById('toggle-unconfirmed-label').textContent = allowed ? 'On' : 'Off';
  }
}

function renderLevelsPanel() {
  const el = document.getElementById('levels-panel');
  if (!el) return;

  const levelRows = levels.map(l => {
    const count = attendees.filter(a=>a.level_id===l.id).length;
    return `
      <details class="level-accordion" id="level-acc-${l.id}">
        <summary style="display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;list-style:none;border-radius:var(--r);background:var(--bg3);border:1px solid var(--border);user-select:none" onclick="this.parentElement.open=!this.parentElement.open;return false">
          <div style="width:12px;height:12px;border-radius:3px;background:${l.color};flex-shrink:0"></div>
          <div style="flex:1;font-size:13px;font-weight:700">${esc(l.name)} ${l.is_staff?'<span class="badge" style="font-size:9px;background:#1a3a6b22;color:#1a3a6b;border:1px solid #1a3a6b44">STAFF</span>':''}</div>
          <span class="text2 xs">${count} ticket${count!==1?'s':''}</span>
          <svg id="acc-arrow-${l.id}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" stroke-width="2.5" stroke-linecap="round" style="transition:transform .2s"><polyline points="6 9 12 15 18 9"/></svg>
        </summary>
        <div style="padding:14px;border:1px solid var(--border);border-top:none;border-radius:0 0 var(--r) var(--r);background:#fff">
          ${l.description?`<div class="sm text2 mb10">${esc(l.description)}</div>`:''}
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;font-weight:600">
              <input type="checkbox" ${l.is_staff?'checked':''} onchange="toggleStaffLevel('${l.id}',this.checked)" style="width:14px;height:14px;accent-color:var(--navy)"> Staff level
            </label>
            <button class="btn btn-sm btn-danger" onclick="deleteLevel('${l.id}')">Remove Level</button>
          </div>
        </div>
      </details>`;
  }).join('');

  el.innerHTML = `
    <div class="section-title mb8">Ticket Levels</div>
    <p class="sm text2 mb12">Create labels like VIP, Gold, Silver. Max <strong>11 characters</strong>. Mark a level as <strong>Staff</strong> to issue staff passes — excluded from guest counts.</p>
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">${levelRows||'<p class="sm text2">No levels yet. Add one below.</p>'}</div>
    <details id="add-level-acc" style="border:1.5px dashed var(--border);border-radius:var(--r)">
      <summary style="display:flex;align-items:center;gap:8px;padding:12px 14px;cursor:pointer;list-style:none;font-size:13px;font-weight:600;color:var(--navy)" onclick="this.parentElement.open=!this.parentElement.open;return false">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--navy)" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add New Level
      </summary>
      <div style="padding:14px;border-top:1px solid var(--border)">
        <div class="form-row mb8">
          <div class="fg" style="margin:0">
            <label>Level name * <span class="tip-icon" data-tip="Max 11 characters — fits on the ticket badge.">i</span></label>
            <input id="new-level-name" placeholder="VIP" maxlength="11" oninput="updateLevelCounter(this)">
            <div class="hint" id="level-char-count">0 / 11 characters</div>
          </div>
          <div class="fg" style="margin:0">
            <label>Color</label>
            <input id="new-level-color" type="color" value="${LEVEL_PALETTE[levels.length % LEVEL_PALETTE.length]}" style="width:100%;height:38px;padding:2px 4px;border:1.5px solid var(--border);border-radius:var(--r);cursor:pointer">
          </div>
        </div>
        <div class="fg mb8">
          <label>Description <span style="font-weight:400;color:var(--text3)">(optional)</span></label>
          <input id="new-level-desc" placeholder="e.g. Front row seats, complimentary dinner included">
        </div>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px;cursor:pointer;font-size:13px;font-weight:600">
          <input type="checkbox" id="new-level-staff" style="width:15px;height:15px;accent-color:var(--navy)"> Staff level
          <span class="tip-icon" data-tip="Staff tickets use a business card ID badge and are separate from guests.">i</span>
        </label>
        <button class="btn btn-gold" onclick="addLevel()">+ Add Level</button>
      </div>
    </details>`;
}

function updateLevelCounter(input) {
  const count = input.value.length;
  const counter = document.getElementById('level-char-count');
  if (counter) { counter.textContent = `${count} / 11 characters`; counter.style.color = count > 11 ? 'var(--red)' : count >= 9 ? 'var(--orange)' : 'var(--text3)'; }
}

async function addLevel() {
  const name = document.getElementById('new-level-name').value.trim();
  const color = document.getElementById('new-level-color').value;
  const description = document.getElementById('new-level-desc')?.value.trim() || null;
  const is_staff = document.getElementById('new-level-staff')?.checked ? 1 : 0;
  if (!name) { toast('Enter a level name', 'error'); return; }
  if (name.length > 11) { toast('Level name must be 11 characters or less', 'error'); return; }
  try {
    const { level } = await api.attendees.addLevel(eventId, { name, color, description, is_staff });
    levels.push(level);
    document.getElementById('new-level-name').value = '';
    if (document.getElementById('new-level-desc')) document.getElementById('new-level-desc').value = '';
    if (document.getElementById('new-level-staff')) document.getElementById('new-level-staff').checked = false;
    renderLevelsPanel();
    toast(`Level "${name}" added${is_staff ? ' (Staff)' : ''}`);
  } catch(e) { toast(e.message, 'error'); }
}

async function toggleStaffLevel(id, isStaff) {
  try {
    await api.attendees.updateLevel(eventId, id, { is_staff: isStaff ? 1 : 0 });
    const lvl = levels.find(l => l.id === id);
    if (lvl) lvl.is_staff = isStaff ? 1 : 0;
    renderLevelsPanel();
    toast(isStaff ? 'Marked as staff level' : 'Removed staff designation');
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteLevel(id) {
  const lvl = levels.find(l => l.id === id);
  if (!confirm(`Remove level "${lvl?.name}"? Attendees assigned this level will have no level.`)) return;
  try {
    await api.attendees.deleteLevel(eventId, id);
    levels = levels.filter(l => l.id !== id);
    attendees.forEach(a => { if (a.level_id === id) a.level_id = null; });
    renderLevelsPanel();
    toast('Level removed');
  } catch(e) { toast(e.message, 'error'); }
}

async function toggleUnconfirmedCheckin(val) {
  try {
    await api.attendees.updateEventSettings(eventId, { allow_unconfirmed_checkin: val });
    document.getElementById('toggle-unconfirmed-label').textContent = val ? 'On' : 'Off';
    toast(val ? 'Unconfirmed check-in allowed' : 'Only confirmed guests can check in');
  } catch(e) { toast(e.message, 'error'); }
}

load();
</script>
</body>
</html>
