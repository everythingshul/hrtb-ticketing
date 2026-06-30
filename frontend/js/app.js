// ── API base ──────────────────────────────────────────────
const API = window.location.hostname === 'localhost' ? '' : '';

async function req(path, opts = {}) {
  const headers = { ...opts.headers };
  if (!(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const token = localStorage.getItem('hrtb_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API + '/api' + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // If the server says role changed, log out cleanly with a message
    if (data.forceLogout) {
      Auth.clear();
      sessionStorage.setItem('hrtb_logout_msg', data.error || 'Your role has changed. Please log in again.');
      window.location = '/login.html';
      throw new Error(data.error);
    }
    throw new Error(data.error || `Error ${res.status}`);
  }
  return data;
}

// ── Auth helpers ──────────────────────────────────────────
const Auth = {
  user: () => { try { return JSON.parse(localStorage.getItem('hrtb_user') || 'null'); } catch { return null; } },
  token: () => localStorage.getItem('hrtb_token'),
  set: (token, user) => { localStorage.setItem('hrtb_token', token); localStorage.setItem('hrtb_user', JSON.stringify(user)); },
  clear: () => { localStorage.removeItem('hrtb_token'); localStorage.removeItem('hrtb_user'); },
  require: () => { if (!Auth.token()) { window.location = '/login.html'; return false; } return true; },
  requireAdmin: () => { const u = Auth.user(); if (!u || u.role !== 'admin') { window.location = '/dashboard.html'; return false; } return true; }
};

// ── API methods ───────────────────────────────────────────
const api = {
  auth: {
    login: b => req('/auth/login', { method: 'POST', body: JSON.stringify(b) }),
    signup: b => req('/auth/signup', { method: 'POST', body: JSON.stringify(b) }),
    pinLogin: b => req('/auth/pin-login', { method: 'POST', body: JSON.stringify(b) }),
    register: b => req('/auth/register', { method: 'POST', body: JSON.stringify(b) }),
    me: () => req('/auth/me'),
    invite: b => req('/auth/invite', { method: 'POST', body: JSON.stringify(b) }),
    inviteInfo: token => req(`/auth/invite/${token}`),
    resetPassword: (userId, newPassword) => req('/auth/reset-password', { method: 'POST', body: JSON.stringify({ userId, newPassword }) }),
    getProfile: () => req('/auth/profile'),
    updateProfile: b => req('/auth/profile', { method: 'PUT', body: JSON.stringify(b) }),
    changePassword: b => req('/auth/change-password', { method: 'POST', body: JSON.stringify(b) }),
    updateUserProfile: (id, b) => req(`/auth/users/${id}/profile`, { method: 'PUT', body: JSON.stringify(b) }),
    updateScannerLookup: (id, allow) => req(`/auth/scanner-pin/${id}/lookup`, { method: 'PATCH', body: JSON.stringify({ allow_lookup: allow }) }),
    updateScannerPin: (id, b) => req(`/auth/scanner-pin/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    createScannerPin: b => req('/auth/scanner-pin', { method: 'POST', body: JSON.stringify(b) }),
    getScannerPins: eventId => req(`/auth/scanner-pins/${eventId}`),
    deleteScannerPin: id => req(`/auth/scanner-pin/${id}`, { method: 'DELETE' }),
  },
  events: {
    list: () => req('/events'),
    create: b => req('/events', { method: 'POST', body: JSON.stringify(b) }),
    listPublic: () => fetch('/api/events/public').then(r=>r.json()),
    getPublic: id => fetch(`/api/events/public/${id}`).then(r=>r.json()),
    close: id => req(`/events/${id}/close`, { method: 'POST' }),
    reopen: id => req(`/events/${id}/reopen`, { method: 'POST' }),
    update: (id, b) => req(`/events/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
    patch: (id, b) => req(`/events/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    delete: id => req(`/events/${id}`, { method: 'DELETE' }),
  },
  attendees: {
    list: eventId => req(`/attendees/event/${eventId}`),
    create: (eventId, b) => req(`/attendees/event/${eventId}`, { method: 'POST', body: JSON.stringify(b) }),
    update: (id, b) => req(`/attendees/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
    delete: id => req(`/attendees/${id}`, { method: 'DELETE' }),
    previewUpload: (eventId, file) => {
      const fd = new FormData(); fd.append('file', file);
      const headers = {}; if (Auth.token()) headers['Authorization'] = `Bearer ${Auth.token()}`;
      return fetch(`/api/attendees/event/${eventId}/preview`, { method: 'POST', headers, body: fd }).then(r => r.json());
    },
    commit: (eventId, b) => req(`/attendees/event/${eventId}/commit`, { method: 'POST', body: JSON.stringify(b) }),
    preprint: (eventId, b) => req(`/attendees/event/${eventId}/preprint`, { method: 'POST', body: JSON.stringify(b) }),
    assign: b => req('/attendees/assign', { method: 'POST', body: JSON.stringify(b) }),
    lookup: id => req(`/attendees/lookup/${id}`),
    send: (id, b) => req(`/attendees/${id}/send`, { method: 'POST', body: JSON.stringify(b) }),
    sendAll: (eventId, b) => req(`/attendees/event/${eventId}/send-all`, { method: 'POST', body: JSON.stringify(b) }),
    digest: (eventId, b) => req(`/attendees/event/${eventId}/digest`, { method: 'POST', body: JSON.stringify(b) }),
    scan: ticketId => req('/attendees/scan', { method: 'POST', body: JSON.stringify({ ticketId }) }),
    exportUrl: eventId => `/api/attendees/event/${eventId}/export?token=${Auth.token()}`,
    hasDesign: eventId => req(`/attendees/event/${eventId}/design`),
    confirm: (id, confirmed) => req(`/attendees/${id}/confirm`, { method: 'POST', body: JSON.stringify({ confirmed }) }),
    confirmBulk: (eventId, ticket_ids) => req(`/attendees/event/${eventId}/confirm-bulk`, { method: 'POST', body: JSON.stringify({ ticket_ids }) }),
    getUploadBatches: eventId => req(`/attendees/event/${eventId}/upload-batches`),
    undoUpload: (eventId, batchId) => req(`/attendees/event/${eventId}/undo-upload/${batchId}`, { method: 'DELETE' }),
    getLevels: eventId => req(`/attendees/event/${eventId}/levels`),
    addLevel: (eventId, b) => req(`/attendees/event/${eventId}/levels`, { method: 'POST', body: JSON.stringify(b) }),
    updateLevel: (eventId, levelId, b) => req(`/attendees/event/${eventId}/levels/${levelId}`, { method: 'PATCH', body: JSON.stringify(b) }),
    updateLevel: (eventId, id, b) => req(`/attendees/event/${eventId}/levels/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    deleteLevel: (eventId, id) => req(`/attendees/event/${eventId}/levels/${id}`, { method: 'DELETE' }),
    getStats: eventId => req(`/attendees/event/${eventId}/stats`),
    updateEventSettings: (eventId, b) => req(`/attendees/event/${eventId}/settings`, { method: 'PATCH', body: JSON.stringify(b) }),
    getSalesSettings: eventId => req(`/sales/settings/${eventId}`),
    updateSalesSettings: (eventId, b) => req(`/sales/settings/${eventId}`, { method: 'PATCH', body: JSON.stringify(b) }),
    updateLevelSales: (levelId, b) => req(`/sales/level/${levelId}`, { method: 'PATCH', body: JSON.stringify(b) }),
    uploadSaleImage: (eventId, file) => {
      const fd = new FormData(); fd.append('image', file);
      return fetch(`/api/sales/image/${eventId}`, { method: 'POST', headers: { 'Authorization': `Bearer ${Auth.token()}` }, body: fd }).then(r => r.json());
    },
    bulkStatus: (eventId, b) => req(`/attendees/event/${eventId}/bulk-status`, { method: 'POST', body: JSON.stringify(b) }),
    bulkLevel: (eventId, b) => req(`/attendees/event/${eventId}/bulk-level`, { method: 'POST', body: JSON.stringify(b) }),
    getPromos: eventId => req(`/sales/event/${eventId}/promos`),
    createPromo: (eventId, b) => req(`/sales/event/${eventId}/promos`, { method: 'POST', body: JSON.stringify(b) }),
    updatePromo: (eventId, promoId, b) => req(`/sales/event/${eventId}/promos/${promoId}`, { method: 'PATCH', body: JSON.stringify(b) }),
    deletePromo: (eventId, promoId) => req(`/sales/event/${eventId}/promos/${promoId}`, { method: 'DELETE' }),
  },
  staff: {
    list:        eventId => req(`/staff/event/${eventId}`),
    create:      (eventId, b) => req(`/staff/event/${eventId}`, { method:'POST', body:JSON.stringify(b) }),
    update:      (id, b) => req(`/staff/${id}`, { method:'PATCH', body:JSON.stringify(b) }),
    setStatus:   (id, status) => req(`/staff/${id}/status`, { method:'POST', body:JSON.stringify({status}) }),
    confirm:     (id, val) => req(`/staff/${id}/confirm`, { method:'POST', body:JSON.stringify({confirmed:val}) }),
    send:        (id, b) => req(`/staff/${id}/send`, { method:'POST', body:JSON.stringify(b) }),
    sendAll:     (eventId, b) => req(`/staff/event/${eventId}/send-all`, { method:'POST', body:JSON.stringify(b) }),
    digest:      (eventId, b) => req(`/staff/event/${eventId}/digest`, { method:'POST', body:JSON.stringify(b) }),
    preprint:    (eventId, b) => req(`/staff/event/${eventId}/preprint`, { method:'POST', body:JSON.stringify(b) }),
    assign:      b => req(`/staff/assign`, { method:'POST', body:JSON.stringify(b) }),
    lookup:      ticketId => req(`/staff/lookup/${ticketId}`),
    bulkStatus:  (eventId, b) => req(`/staff/event/${eventId}/bulk-status`, { method:'POST', body:JSON.stringify(b) }),
    bulkLevel:   (eventId, b) => req(`/staff/event/${eventId}/bulk-level`, { method:'POST', body:JSON.stringify(b) }),
    bulkDelete:  (eventId, ids) => req(`/staff/event/${eventId}/bulk-delete`, { method:'POST', body:JSON.stringify({ids}) }),
    delete:      id => req(`/staff/${id}`, { method:'DELETE' }),
    previewUpload:(eventId, file) => { const fd=new FormData(); fd.append('file',file); const h={}; if(Auth.token()) h['Authorization']=`Bearer ${Auth.token()}`; return fetch(`/api/staff/event/${eventId}/preview`,{method:'POST',headers:h,body:fd}).then(r=>r.json()); },
    commit:      (eventId, b) => req(`/staff/event/${eventId}/commit`, { method:'POST', body:JSON.stringify(b) }),
    confirmBulk: (eventId, ticketIds) => req(`/staff/event/${eventId}/confirm-bulk`, { method:'POST', body:JSON.stringify({ticketIds}) }),
    stats:       eventId => req(`/staff/event/${eventId}/stats`),
  },
  admin: {
    stats: () => req('/admin/stats'),
    accounts: () => req('/admin/accounts'),
    inviteNewAccount: b => req('/admin/invite-account', { method: 'POST', body: JSON.stringify(b) }),
    createAccount: b => req('/admin/accounts', { method: 'POST', body: JSON.stringify(b) }),
    toggleAccount: id => req(`/admin/accounts/${id}/toggle`, { method: 'PATCH' }),
    deleteAccount: id => req(`/admin/accounts/${id}`, { method: 'DELETE' }),
    setRole: (id, role) => req(`/admin/accounts/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    setReplyTo: (id, reply_to) => req(`/admin/accounts/${id}/reply-to`, { method: 'PATCH', body: JSON.stringify({ reply_to }) }),
    setMaxEvents: (id, max_events) => req(`/admin/accounts/${id}/max-events`, { method: 'PATCH', body: JSON.stringify({ max_events }) }),
    getTrashAttendees: () => req('/admin/trash/attendees'),
    getTrashEvents: () => req('/admin/trash/events'),
    getTrashAccounts: () => req('/admin/trash/accounts'),
    getTrash: type => req(`/admin/trash/${type}`),
    restoreTrash: (type, id) => req(`/admin/trash/${type}/${id}/restore`, { method: 'POST' }),
    purgeTrash: (type, id) => req(`/admin/trash/${type}/${id}`, { method: 'DELETE' }),
    restoreAttendee: id => req(`/admin/trash/attendees/${id}/restore`, { method: 'POST' }),
    restoreEvent: id => req(`/admin/trash/events/${id}/restore`, { method: 'POST' }),
    restoreAccount: id => req(`/admin/trash/accounts/${id}/restore`, { method: 'POST' }),
    purgeAttendee: id => req(`/admin/trash/attendees/${id}`, { method: 'DELETE' }),
    purgeEvent: id => req(`/admin/trash/events/${id}`, { method: 'DELETE' }),
    purgeAccount: id => req(`/admin/trash/accounts/${id}`, { method: 'DELETE' }),
    removeMember: (accountId, userId) => req(`/admin/accounts/${accountId}/members/${userId}`, { method: 'DELETE' }),
    events: () => req('/admin/events'),
    getEvent: id => req(`/admin/events/${id}`),
    getTransactionsAccounts: () => req('/admin/transactions/accounts'),
    getTransactionsTickets: (params={}) => req('/admin/transactions/tickets?' + new URLSearchParams(params)),
    refundTicket: (id, body) => req(`/admin/transactions/refund/${id}`, { method:'POST', body:JSON.stringify(body) }),
    getFeatures: () => req('/admin/features'),
    updateFeatures: updates => req('/admin/features', { method: 'PATCH', body: JSON.stringify({ updates }) }),
    getAccountFeatures: id => req(`/admin/accounts/${id}/features`),
    updateAccountFeatures: (id, updates) => req(`/admin/accounts/${id}/features`, { method: 'PATCH', body: JSON.stringify({ updates }) }),
    getEventFeatures: id => req(`/admin/events/${id}/features`),
    updateEventFeatures: (id, updates) => req(`/admin/events/${id}/features`, { method: 'PATCH', body: JSON.stringify({ updates }) }),
    restore: data => req('/admin/restore', { method: 'POST', body: JSON.stringify(data) }),
    maintenanceStatus: () => req('/admin/maintenance'),
    setMaintenance: enabled => req('/admin/maintenance', { method: 'POST', body: JSON.stringify({ enabled }) }),
    contactAdmin: data => req('/admin/contact', { method: 'POST', body: JSON.stringify(data) }),
    getSiteContent: () => req('/admin/site-content'),
    updateSiteContent: updates => req('/admin/site-content', { method: 'PATCH', body: JSON.stringify({ updates }) }),
  },
  connect: {
    startOAuth:       () => req('/connect/connect/start'),
    disconnect:       () => req('/connect/connect/disconnect', { method: 'POST' }),
    status:           () => req('/connect/connect/status'),
    pricingPlans:     () => req('/connect/pricing-plans'),
    pricingPlansAdmin:() => req('/connect/pricing-plans/admin'),
    createPlan:       b  => req('/connect/pricing-plans', { method:'POST', body:JSON.stringify(b) }),
    updatePlan:       (id,b)=>req(`/connect/pricing-plans/${id}`, { method:'PATCH', body:JSON.stringify(b) }),
    deletePlan:       id => req(`/connect/pricing-plans/${id}`, { method:'DELETE' }),
    getSettings:      () => req('/connect/settings'),
    updateSettings:   u  => req('/connect/settings', { method:'PATCH', body:JSON.stringify({ updates:u }) }),
    createPaymentIntent: b => req('/connect/event-payment/intent', { method:'POST', body:JSON.stringify(b) }),
    confirmPayment:   b  => req('/connect/event-payment/confirm', { method:'POST', body:JSON.stringify(b) }),
  },
};

// ── Toast notifications ───────────────────────────────────
function toast(msg, type = 'ok') {
  let wrap = document.getElementById('toasts');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toasts'; wrap.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  const colors = { ok: 'rgba(76,175,121,.9)', error: 'rgba(224,80,80,.9)', info: 'rgba(80,144,224,.9)' };
  t.style.cssText = `background:${colors[type]||colors.ok};color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;font-family:var(--font);box-shadow:0 4px 16px rgba(0,0,0,.4);animation:su .2s;pointer-events:auto;max-width:320px`;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Modal helpers ─────────────────────────────────────────
function showModal(id) { document.getElementById(id).style.display = 'flex'; }
function hideModal(id) { document.getElementById(id).style.display = 'none'; }
function makeModal(id, title, bodyHTML, footHTML) {
  const m = document.createElement('div');
  m.id = id; m.className = 'backdrop'; m.style.display = 'none';
  m.innerHTML = `<div class="modal"><div class="modal-hd"><h2>${title}</h2><button class="modal-x" onclick="hideModal('${id}')"></button></div>${bodyHTML}<div class="modal-ft">${footHTML}</div></div>`;
  m.addEventListener('click', e => { if (e.target === m) hideModal(id); });
  document.body.appendChild(m);
  return m;
}

// ── Sidebar renderer ──────────────────────────────────────
function renderSidebar(activePage) {
  const user = Auth.user();
  if (!user) return;
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const memberships = JSON.parse(localStorage.getItem('hrtb_memberships') || '[]');
  const params = new URLSearchParams(window.location.search);
  const currentEventId = params.get('id');
  const currentEventName = localStorage.getItem('hrtb_current_event_name') || '';

  const nav = (href, label) => {
    const active = window.location.pathname.includes(href.split('?')[0]);
    return `<a href="/${href}" class="sb-item${active?' active':''}">${label}</a>`;
  };

  const switcherHTML = memberships.length > 0 ? `
    <div class="sb-group">
      <div class="sb-group-label">Account</div>
      <div style="padding:0 10px;font-size:12px;color:rgba(255,255,255,.8);font-weight:500;margin-bottom:4px">${esc(user.name)}</div>
      ${memberships.map(m => `<button class="sb-item" onclick="switchAccount('${m.accountId}')" style="font-size:11px;opacity:.7">${esc(m.accountName)} (${m.role})</button>`).join('')}
    </div>` : '';

  // Event submenu — shown when inside an event page
  const eventPages = ['event-detail.html','event-stats.html','event-levels.html','event-sales.html','event-sell.html','event-staff.html'];
  const inEventPage = eventPages.some(p => window.location.pathname.includes(p));
  const eventSubmenuHTML = (inEventPage && currentEventId) ? `
    <div class="sb-group">
      <div class="sb-group-label" style="font-size:9px;letter-spacing:.08em">EVENT</div>
      <div style="padding:4px 12px 6px;font-size:11px;color:rgba(255,255,255,.9);font-weight:700;line-height:1.3">${esc(currentEventName)}</div>
      ${nav(`event-detail.html?id=${currentEventId}`, '↳ Attendees')}
      ${nav(`event-staff.html?id=${currentEventId}`, '↳ Staff')}
      ${nav(`event-stats.html?id=${currentEventId}`, '↳ Stats')}
      ${nav(`event-levels.html?id=${currentEventId}`, '↳ Ticket Levels')}
      ${nav(`event-sales.html?id=${currentEventId}`, '↳ Online Sales')}
      ${nav(`event-sell.html?id=${currentEventId}`, '↳ Sell Ticket')}
    </div>` : '';

  // Mobile hamburger menu button + overlay (only visible on mobile via CSS)
  if (!document.getElementById('mobile-menu-btn')) {
    const btn = document.createElement('button');
    btn.id = 'mobile-menu-btn';
    btn.className = 'mobile-menu-btn';
    btn.setAttribute('aria-label', 'Open menu');
    btn.innerHTML = '<span></span>';
    btn.onclick = toggleMobileSidebar;
    document.body.appendChild(btn);
  }
  if (!document.getElementById('mobile-overlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'mobile-overlay';
    overlay.className = 'mobile-overlay';
    overlay.onclick = closeMobileSidebar;
    document.body.appendChild(overlay);
  }

  sidebar.innerHTML = `
    <div class="sb-logo" style="padding:12px 16px 10px;border-bottom:1px solid rgba(255,255,255,.1)">
      <a href="/dashboard.html" style="display:block">
        <img src="/logo.png" alt="Mamudem" style="width:100%;max-width:180px;height:auto;display:block;filter:brightness(0) invert(1)" id="sb-logo-img">
      </a>
    </div>
    <nav class="sb-nav" id="sb-nav-content">
      ${switcherHTML}
      <div class="sb-group">
        <div class="sb-group-label">Menu</div>
        ${nav('dashboard.html','Dashboard')}
        ${nav('events.html','Events')}
        ${nav('scanner.html','Scanner')}
      </div>
      ${eventSubmenuHTML}
      ${user.role === 'admin' ? `<div class="sb-group"><div class="sb-group-label">Admin</div>
        ${nav('admin.html','Dashboard')}
        ${nav('admin-accounts.html','Accounts')}
        ${nav('admin-events.html','All Events')}
        ${nav('admin-crm.html','Transactions & CRM')}
        ${nav('admin-phone.html','Phone & SMS/IVR')}
        ${nav('admin-numbers.html','Phone Numbers')}
        ${nav('admin-content.html','Site Content')}
        ${nav('admin-backup.html','Backup &amp; Trash')}
      </div>` : ''}
    </nav>
    <div class="sb-foot" id="sb-foot">
      <div class="sb-user">
        <div class="sb-avatar" style="cursor:pointer" onclick="window.location='/profile.html'">${(user.name||'U')[0].toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div class="sb-uname" style="cursor:pointer" onclick="window.location='/profile.html'">${user.name}</div>
          <div class="sb-urole" style="color:${user.role==='admin'?'var(--cyan)':'rgba(255,255,255,.45)'}">${user.role==='admin'?'System Admin':'User'}</div>
        </div>
        <button class="sb-logout" onclick="logout()" style="font-size:11px;padding:4px 7px">Exit</button>
      </div>
    </div>`;

  setTimeout(applySidebarState, 0);
}

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const collapsed = sidebar.classList.toggle('collapsed');
  localStorage.setItem('hrtb_sb_collapsed', collapsed ? '1' : '0');
  const btn = document.getElementById('sb-toggle');
  if (btn) btn.textContent = collapsed ? '☰' : '✕';
}

function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('mobile-overlay');
  const isOpen = sidebar.classList.toggle('mobile-open');
  if (overlay) overlay.classList.toggle('show', isOpen);
  document.body.style.overflow = isOpen ? 'hidden' : '';
}

function closeMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('mobile-overlay');
  sidebar.classList.remove('mobile-open');
  if (overlay) overlay.classList.remove('show');
  document.body.style.overflow = '';
}

// Auto-close mobile sidebar when a nav link is tapped
document.addEventListener('click', (e) => {
  if (window.innerWidth <= 720) {
    const link = e.target.closest('.sidebar a, .sidebar .sb-nav a');
    if (link) closeMobileSidebar();
  }
});

// Apply on load
function applySidebarState() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  if (localStorage.getItem('hrtb_sb_collapsed') === '1') {
    sidebar.classList.add('collapsed');
    const btn = document.getElementById('sb-toggle');
    if (btn) btn.textContent = '☰';
  }
}

function switchAccount(accountId) {
  localStorage.setItem('hrtb_context_account', accountId);
  window.location = '/dashboard.html';
}

function logout() { Auth.clear(); window.location = '/login.html'; }

// ── English-only input restriction ───────────────────────
// Blocks non-ASCII characters from being typed or pasted into any input/textarea
function enforceEnglishOnly(el) {
  if (el._englishOnly) return; // prevent double-binding on same element
  el._englishOnly = true;
  const clean = v => v.replace(/[^\x20-\x7E\n\r\t]/g, '');
  el.addEventListener('input', function() {
    const pos = this.selectionStart;
    const cleaned = clean(this.value);
    if (cleaned !== this.value) {
      this.value = cleaned;
      try { this.setSelectionRange(pos - 1, pos - 1); } catch {}
    }
  });
  el.addEventListener('paste', function(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    const cleaned = clean(text);
    const start = this.selectionStart;
    const end = this.selectionEnd;
    this.value = this.value.slice(0, start) + cleaned + this.value.slice(end);
    const newPos = start + cleaned.length;
    try { this.setSelectionRange(newPos, newPos); } catch {}
  });
}

// Apply to all current and future inputs/textareas
function applyEnglishOnly() {
  document.querySelectorAll('input:not([type=file]):not([type=date]):not([type=time]):not([type=checkbox]):not([type=radio]), textarea').forEach(enforceEnglishOnly);
}

// Run on page load and observe for new elements
window.addEventListener('DOMContentLoaded', () => {
  applyEnglishOnly();
  new MutationObserver(() => applyEnglishOnly()).observe(document.body, { childList: true, subtree: true });
});
// Keeps TKT- prefix in place for manual typing
// USB/Bluetooth scanners send full IDs rapidly — they overwrite the prefix naturally
function enforceTktPrefix(input) {
  let val = input.value.toUpperCase();
  // If scanner pasted a full ID (fast input), keep it as-is
  if (val.startsWith('TKT-') && val.length > 12) { return; }
  // Ensure prefix is always there for manual typing
  if (!val.startsWith('TKT-')) {
    // If user typed something without prefix, prepend it
    val = 'TKT-' + val.replace(/^TKT-?/i, '');
  }
  input.value = val;
}

// Set TKT- as initial value on focus if empty
function initTktInput(input) {
  if (!input.value) input.value = 'TKT-';
}

// ── Sortable tables ───────────────────────────────────────
function makeSortable(table) {
  if (!table) return;
  const headers = table.querySelectorAll('thead th');
  headers.forEach((th, col) => {
    if (th.dataset.nosort !== undefined) return;
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    th.title = 'Click to sort';
    th._sortDir = 0;
    th.addEventListener('click', () => {
      const dir = th._sortDir === 1 ? -1 : 1;
      headers.forEach(h => {
        h._sortDir = 0;
        h.textContent = h.textContent.replace(/\s[▲▼]$/, '');
      });
      th._sortDir = dir;
      th.textContent = th.textContent + (dir === 1 ? ' ▲' : ' ▼');
      const tbody = table.querySelector('tbody');
      if (!tbody) return;
      const rows = [...tbody.querySelectorAll('tr')];
      rows.sort((a, b) => {
        const av = (a.cells[col]?.textContent || '').trim().toLowerCase();
        const bv = (b.cells[col]?.textContent || '').trim().toLowerCase();
        const an = parseFloat(av), bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return dir * (an - bn);
        return dir * av.localeCompare(bv);
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });
}

// ── Real-time updates ─────────────────────────────────────
// Polls for changes every 15 seconds so all open tabs/devices stay in sync
const RealtimeSync = {
  _timers: [],
  _callbacks: [],
  register(fn, intervalMs = 15000) {
    this._callbacks.push(fn);
    const t = setInterval(fn, intervalMs);
    this._timers.push(t);
    return t;
  },
  stop() { this._timers.forEach(t => clearInterval(t)); }
};

// ── Copyright footer injector ─────────────────────────────
function injectCopyright() {
  const year = new Date().getFullYear();
  const footer = document.createElement('div');
  footer.style.cssText = 'text-align:center;padding:18px;font-size:11px;color:var(--text3);border-top:1px solid var(--border);margin-top:32px';
  footer.innerHTML = `© ${year} <a href="https://mamudem.com" style="color:var(--cyan,#00aadd);text-decoration:none">Mamudem</a> Mamudem. All rights reserved.`;
  const main = document.querySelector('.main');
  if (main) main.appendChild(footer);
}
window.addEventListener('load', injectCopyright);
const statusLabel = { pending:'Pending', preprint:'Pre-printed', sent:'Sent', checked:'Checked In', deactivated:'Deactivated' };
function badgeHTML(status) { return `<span class="badge badge-${status}">${statusLabel[status]||status}</span>`; }
function qrUrl(id) { return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(id)}&margin=8`; }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(d) { return d ? new Date(d).toLocaleString() : '—'; }

function downloadCSV(url, filename) {
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
}

// ── Info tooltips ─────────────────────────────────────────
// Usage: <span class="tip-icon" data-tip="Explanation">i</span>
(function initTooltips() {
  const style = document.createElement('style');
  style.textContent = `.tip-icon{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:#e8edf5;color:#1a3a6b;font-size:9px;font-weight:700;font-style:italic;cursor:help;border:1px solid #c5d0e0;margin-left:5px;vertical-align:middle;flex-shrink:0;user-select:none;transition:background .15s}.tip-icon:hover{background:#1a3a6b;color:#fff;border-color:#1a3a6b}.tip-bubble{position:fixed;z-index:9990;max-width:260px;background:#1a3a6b;color:#fff;border-radius:8px;padding:9px 13px;font-size:12px;line-height:1.55;font-weight:400;box-shadow:0 4px 18px rgba(0,0,0,.22);pointer-events:none;opacity:0;transition:opacity .12s}.tip-bubble.visible{opacity:1}`;
  document.head.appendChild(style);
  const bubble = document.createElement('div');
  bubble.className = 'tip-bubble';
  document.body.appendChild(bubble);
  let ht;
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('.tip-icon');
    if (!el?.dataset.tip) return;
    clearTimeout(ht);
    bubble.textContent = el.dataset.tip;
    const r = el.getBoundingClientRect();
    let top = r.bottom + 8, left = r.left;
    if (top + 100 > window.innerHeight) top = r.top - 108;
    if (left + 270 > window.innerWidth) left = window.innerWidth - 275;
    bubble.style.top = top + 'px'; bubble.style.left = Math.max(8,left) + 'px';
    bubble.classList.add('visible');
  });
  document.addEventListener('mouseout', e => { if (!e.target.closest('.tip-icon')) return; ht = setTimeout(() => bubble.classList.remove('visible'), 80); });
})();
