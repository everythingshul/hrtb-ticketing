<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#1a3a6b">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="EShul Tickets">
<link rel="icon" type="image/x-icon" href="/favicon.ico"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EverythingShul.com Tickets — Events</title>
<link rel="stylesheet" href="/css/style.css">
<script src="https://js.stripe.com/v3/"></script>
<style>
  .ev-form { display:none; background:#fff; border:1.5px solid var(--border); border-radius:var(--r-xl); padding:28px; margin-bottom:24px; box-shadow:var(--shadow-lg); }
  .ev-form.open { display:block; }
  .ev-form h2 { font-family:var(--font-d); font-size:18px; font-weight:700; color:var(--navy); margin-bottom:18px; }
  .date-time-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  input[type=date], input[type=time] {
    width:100%; padding:9px 11px;
    background:#fff; color:#111;
    border:1.5px solid var(--border);
    border-radius:var(--r);
    font-family:var(--font); font-size:14px;
    outline:none; color-scheme:light;
  }
  input[type=date]:focus, input[type=time]:focus { border-color:var(--cyan); box-shadow:0 0 0 3px rgba(0,170,221,.1); }
</style>
</head>
<body>
<div class="shell">
  <aside class="sidebar" id="sidebar"></aside>
  <main class="main"><div class="page">

    <div class="ph">
      <div class="ph-left"><h1>Events</h1><p id="sub">Loading…</p></div>
      <div class="ph-actions">
        <button class="btn btn-gold" id="btn-new" onclick="toggleForm()">+ New Event</button>
      </div>
    </div>

    <!-- Inline form — no modal, no backdrop, no conflicts -->
    <div class="ev-form" id="ev-form">
      <h2>New Event</h2>
      <div id="form-err" style="display:none" class="info-box warn mb16"></div>
      <div class="fg">
        <label>Event name *</label>
        <input type="text" id="ev-name" placeholder="Annual Gala 2025" autocomplete="off">
      </div>
      <div class="date-time-row">
        <div class="fg">
          <label>Date *</label>
          <input type="date" id="ev-date">
        </div>
        <div class="fg">
          <label>Time (optional)</label>
          <input type="time" id="ev-time">
        </div>
      </div>
      <div class="fg">
        <label>Timezone</label>
        <select id="ev-tz">
          <optgroup label="United States">
            <option value="America/New_York" selected>Eastern Time (ET) — New York, Miami, Atlanta</option>
            <option value="America/Chicago">Central Time (CT) — Chicago, Dallas, Houston</option>
            <option value="America/Denver">Mountain Time (MT) — Denver, Phoenix</option>
            <option value="America/Los_Angeles">Pacific Time (PT) — Los Angeles, Seattle, Las Vegas</option>
            <option value="America/Anchorage">Alaska Time — Anchorage</option>
            <option value="Pacific/Honolulu">Hawaii Time — Honolulu</option>
          </optgroup>
          <optgroup label="Canada">
            <option value="America/Toronto">Eastern — Toronto</option>
            <option value="America/Winnipeg">Central — Winnipeg</option>
            <option value="America/Edmonton">Mountain — Edmonton, Calgary</option>
            <option value="America/Vancouver">Pacific — Vancouver</option>
          </optgroup>
          <optgroup label="Europe">
            <option value="Europe/London">London (GMT/BST)</option>
            <option value="Europe/Paris">Central European (CET) — Paris, Berlin, Rome</option>
            <option value="Europe/Helsinki">Eastern European (EET) — Helsinki, Kyiv</option>
          </optgroup>
          <optgroup label="Israel / Middle East">
            <option value="Asia/Jerusalem">Israel Standard Time — Jerusalem, Tel Aviv</option>
            <option value="Asia/Dubai">Gulf Time — Dubai, Abu Dhabi</option>
            <option value="Asia/Riyadh">Arabia Time — Riyadh, Beirut</option>
          </optgroup>
          <optgroup label="Other">
            <option value="Asia/Kolkata">India — Mumbai, Delhi</option>
            <option value="Asia/Tokyo">Japan — Tokyo</option>
            <option value="Australia/Sydney">Australia Eastern — Sydney</option>
            <option value="America/Sao_Paulo">Brazil — São Paulo</option>
          </optgroup>
        </select>
      </div>
      <div class="fg">
        <label>Venue *</label>
        <input type="text" id="ev-venue" placeholder="e.g. Grand Ballroom, 123 Main St" autocomplete="off">
      </div>
      <div class="date-time-row">
        <div class="fg">
          <label>Event Ends (Date) * <span class="tip-icon" data-tip="When the event finishes. The sale page auto-closes 48h after this date/time. Required.">i</span></label>
          <input type="date" id="ev-end-date">
        </div>
        <div class="fg">
          <label>Event Ends (Time) *</label>
          <input type="time" id="ev-end-time" value="23:00">
        </div>
      </div>
      <div class="fg">
        <label>Description (optional)</label>
        <textarea id="ev-desc" placeholder="Any notes…"></textarea>
      </div>
      <div class="row" style="gap:10px; margin-top:4px">
        <button class="btn btn-gold" id="btn-submit" onclick="submitEvent()">Create Event</button>
        <button class="btn" onclick="toggleForm()">Cancel</button>
      </div>
    </div>

    <div id="content"></div>

  </div></main>
</div>


<!-- Pricing / Payment Modal -->
<div id="modal-pricing" class="backdrop" style="display:none" onclick="if(event.target===this)hideModal('modal-pricing')">
  <div class="modal modal-lg">
    <div class="modal-hd"><h2>Choose a Plan to Create Your Event</h2><button class="modal-x" onclick="hideModal('modal-pricing')">&#x2715;</button></div>
    <p class="text2 sm mb16">Your demo event stays as-is. Select a plan to create a new live event where real tickets are sold.</p>
    <div id="plan-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:20px">
      <div class="text2">Loading plans…</div>
    </div>
    <div id="payment-section" style="display:none">
      <div style="background:var(--bg3);border-radius:var(--r);padding:14px;margin-bottom:14px">
        <div class="section-title mb8">Selected: <span id="selected-plan-name"></span> — <span id="selected-plan-price"></span></div>
      </div>
      <label>Billing Email</label>
      <input type="email" id="billing-email-plan" placeholder="you@example.com" style="margin-bottom:10px">
      <div id="plan-payment-element" style="margin-bottom:12px"></div>
      <div id="plan-payment-err" class="info-box warn" style="display:none;margin-bottom:10px"></div>
      <button class="btn btn-gold" id="btn-pay-plan" onclick="submitPlanPayment()">Pay & Create Event →</button>
      <button class="btn" style="margin-left:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text)" onclick="document.getElementById('payment-section').style.display='none'">← Change Plan</button>
    </div>
  </div>
</div>

<script src="/js/app.js"></script>
<script>
if (!Auth.require()) throw 0;
renderSidebar();

function toggleForm() {
  const form = document.getElementById('ev-form');
  const isOpen = form.classList.contains('open');
  if (isOpen) {
    form.classList.remove('open');
    document.getElementById('btn-new').textContent = '+ New Event';
  } else {
    // Clear form
    document.getElementById('ev-name').value = '';
    document.getElementById('ev-date').value = '';
    document.getElementById('ev-time').value = '';
    document.getElementById('ev-end-date').value = '';
    document.getElementById('ev-end-time').value = '23:00';
    document.getElementById('ev-venue').value = '';
    document.getElementById('ev-desc').value = '';
    document.getElementById('ev-tz').value = 'America/New_York';
    document.getElementById('form-err').style.display = 'none';
    document.getElementById('btn-submit').disabled = false;
    document.getElementById('btn-submit').textContent = 'Create Event';
    form.classList.add('open');
    document.getElementById('btn-new').textContent = ' Cancel';
    setTimeout(() => document.getElementById('ev-name').focus(), 50);
  }
}

async function submitEvent() {
  const name  = document.getElementById('ev-name').value.trim();
  const date  = document.getElementById('ev-date').value;
  const time  = document.getElementById('ev-time').value;
  const venue = document.getElementById('ev-venue').value.trim();
  const desc  = document.getElementById('ev-desc').value.trim();
  const errEl = document.getElementById('form-err');
  const btn   = document.getElementById('btn-submit');

  errEl.style.display = 'none';

  const endDate = document.getElementById('ev-end-date').value;
  const endTime = document.getElementById('ev-end-time').value || '23:00';

  if (!name)    { errEl.textContent = 'Event name is required.'; errEl.style.display = 'block'; document.getElementById('ev-name').focus(); return; }
  if (!date)    { errEl.textContent = 'Date is required.'; errEl.style.display = 'block'; document.getElementById('ev-date').focus(); return; }
  if (!venue)   { errEl.textContent = 'Venue is required.'; errEl.style.display = 'block'; document.getElementById('ev-venue').focus(); return; }
  if (!endDate) { errEl.textContent = 'Event end date is required.'; errEl.style.display = 'block'; document.getElementById('ev-end-date').focus(); return; }

  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    const dateObj = new Date(date + 'T12:00:00');
    const dateFmt = dateObj.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
    const timeFmt = time ? new Date('1970-01-01T' + time).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }) : '';
    // Build expires_at: end date + time in ISO format (used for auto-close 48h later)
    const expires_at = endDate + 'T' + endTime + ':00';
    const result = await api.events.create({ name, date: dateFmt, time: timeFmt, venue, description: desc, timezone: document.getElementById('ev-tz').value, expires_at });
    toast('Event created!');
    window.location = '/event-detail.html?id=' + result.event.id;
  } catch(e) {
    if (e.message === 'DEMO_MODE') {
      document.getElementById('ev-form').classList.remove('open');
      document.getElementById('btn-new').textContent = '+ New Event';
      // Show pricing modal with the collected event data
      showPricingModal();
      return;
    } else if (e.message === 'EVENT_LIMIT') {
      document.getElementById('ev-form').classList.remove('open');
      document.getElementById('btn-new').textContent = '+ New Event';
      alert('You have reached the maximum number of events allowed for your account.\n\nPlease contact the Administrator to increase your event limit.');
    } else if (e.message === 'DEMO_MODE') {
      document.getElementById('ev-form').classList.remove('open');
      document.getElementById('btn-new').textContent = '+ New Event';
      if (confirm('You\'re in demo mode. To create live events with real ticket sales and email delivery, you need to upgrade your account.\n\nContact us at hello@everythingshul.com to upgrade.\n\nClick OK to learn more about pricing.')) {
        window.open('/pricing.html', '_blank');
      }
    } else {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
    }
    btn.disabled = false;
    btn.textContent = 'Create Event';
  }
}

async function load() {
  const { events } = await api.events.list();
  document.getElementById('sub').textContent = events.length + ' event(s)';

  if (!events.length) {
    document.getElementById('content').innerHTML = '<div class="empty"><div class="ico"></div><h3>No events yet</h3><p>Click "+ New Event" above to create your first event</p></div>';
    return;
  }

  let rows = '';
  for (const ev of events) {
    const total   = ev.stats?.total || 0;
    const checked = ev.stats?.checked || 0;
    const sent    = ev.stats?.sent || 0;
    const pending = ev.stats?.pending || 0;
    const isClosed = !!ev.closed_at;
    rows += '<tr onclick="go(\'' + ev.id + '\')" style="cursor:pointer' + (isClosed ? ';opacity:.65' : '') + '">'
      + '<td><strong>' + esc(ev.name) + '</strong>'
      + (isClosed ? ' <span style="background:#f0f4f8;color:#6b7280;border:1px solid #d1d5db;border-radius:4px;font-size:10px;padding:2px 7px;font-weight:600;vertical-align:middle">CLOSED</span>' : '') + '</td>'
      + '<td class="text2">' + esc(ev.date || '—') + '</td>'
      + '<td class="text2">' + esc(ev.venue || '—') + '</td>'
      + '<td><span class="chip">' + total + '</span></td>'
      + '<td><div class="row" style="gap:4px">'
      + (checked ? '<span class="badge badge-checked">' + checked + ' in</span>' : '')
      + (sent    ? '<span class="badge badge-sent">'    + sent    + ' sent</span>' : '')
      + (pending ? '<span class="badge badge-pending">' + pending + ' pending</span>' : '')
      + '</div></td>'
      + '<td><button class="btn btn-sm btn-danger" onclick="del(event,\'' + ev.id + '\',\'' + esc(ev.name) + '\')">Delete</button></td>'
      + '</tr>';
  }

  document.getElementById('content').innerHTML =
    '<div class="table-wrap"><table>'
    + '<thead><tr><th>Event</th><th>Date</th><th>Venue</th><th>Guests</th><th>Status</th><th></th></tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '</table></div>';
  makeSortable(document.querySelector('#content table'));
}

function go(id) { window.location = '/event-detail.html?id=' + id; }

function del(e, id, name) {
  e.stopPropagation();
  if (!confirm('Delete "' + name + '"? This removes all attendees.')) return;
  api.events.delete(id).then(() => { toast('Event deleted'); load(); }).catch(e => {
    if (e.message === 'EVENT_DELETE_RESTRICTED') {
      alert('Only a System Administrator can delete events.\nPlease contact your administrator.');
    } else toast(e.message, 'error');
  });
}

load();
RealtimeSync.register(load, 30000);

// ── Pricing / Payment Modal ───────────────────────────────
let pendingEventData = null;
let selectedPlan = null;
let stripeInstance = null, stripeElements = null, paymentElement = null;

async function showPricingModal() {
  // Capture current form data
  const date = document.getElementById('ev-date').value;
  const time = document.getElementById('ev-time').value;
  const endDate = document.getElementById('ev-end-date').value;
  const endTime = document.getElementById('ev-end-time').value || '23:00';
  const dateObj = new Date(date + 'T12:00:00');
  const dateFmt = dateObj.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
  const timeFmt = time ? new Date('1970-01-01T' + time).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }) : '';
  pendingEventData = {
    name: document.getElementById('ev-name').value.trim(),
    date: dateFmt, time: timeFmt,
    venue: document.getElementById('ev-venue').value.trim(),
    description: document.getElementById('ev-desc').value.trim(),
    timezone: document.getElementById('ev-tz').value,
    expires_at: endDate + 'T' + endTime + ':00'
  };

  document.getElementById('payment-section').style.display = 'none';
  document.getElementById('plan-cards').innerHTML = '<div class="text2">Loading plans…</div>';
  showModal('modal-pricing');

  const { plans } = await api.connect.pricingPlans();
  if (!plans.length) {
    document.getElementById('plan-cards').innerHTML = '<div class="info-box warn">No pricing plans available. Contact the administrator.</div>';
    return;
  }
  document.getElementById('plan-cards').innerHTML = plans.map(p => `
    <div style="background:var(--bg3);border:1.5px solid var(--border);border-radius:var(--r-lg);padding:20px;cursor:pointer;transition:all .15s" onclick="selectPlan('${p.id}')" id="plan-card-${p.id}">
      <div style="font-size:13px;font-weight:700;color:var(--navy);margin-bottom:4px">${esc(p.name)}</div>
      <div style="font-size:28px;font-weight:800;color:var(--navy);margin-bottom:6px">$${(p.price_cents/100).toFixed(0)}</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:12px">${esc(p.description||'')}</div>
      <ul style="list-style:none;padding:0">${p.features.map(f=>`<li style="font-size:12px;padding:3px 0;display:flex;gap:6px;align-items:flex-start"><span style="color:#27a85f;font-weight:700;flex-shrink:0">✓</span>${esc(f)}</li>`).join('')}</ul>
      <button class="btn btn-gold" style="width:100%;margin-top:14px;justify-content:center">Select →</button>
    </div>`).join('');
}

async function selectPlan(planId) {
  document.querySelectorAll('[id^="plan-card-"]').forEach(el => el.style.border = '1.5px solid var(--border)');
  document.getElementById('plan-card-' + planId)?.style.setProperty('border', '2px solid var(--navy)');

  const { plans } = await api.connect.pricingPlans();
  selectedPlan = plans.find(p => p.id === planId);
  if (!selectedPlan) return;

  document.getElementById('selected-plan-name').textContent = selectedPlan.name;
  document.getElementById('selected-plan-price').textContent = '$' + (selectedPlan.price_cents/100).toFixed(2);

  if (selectedPlan.price_cents === 0) {
    // Free plan — skip payment
    document.getElementById('plan-payment-element').innerHTML = '<div class="info-box ok">This plan is free — no payment required.</div>';
    document.getElementById('btn-pay-plan').textContent = 'Create Event →';
    document.getElementById('payment-section').style.display = 'block';
    return;
  }

  document.getElementById('plan-payment-element').innerHTML = '<div class="text2 sm">Loading payment form…</div>';
  document.getElementById('btn-pay-plan').textContent = 'Pay & Create Event →';
  document.getElementById('payment-section').style.display = 'block';

  const { clientSecret, publishableKey } = await api.connect.createPaymentIntent({ planId });
  stripeInstance = Stripe(publishableKey);
  stripeElements = stripeInstance.elements({ clientSecret, appearance: { theme:'stripe', variables:{ colorPrimary:'#1a3a6b' } } });
  paymentElement = stripeElements.create('payment');
  document.getElementById('plan-payment-element').innerHTML = '';
  paymentElement.mount('#plan-payment-element');
}

async function submitPlanPayment() {
  if (!selectedPlan) return;
  const errEl = document.getElementById('plan-payment-err');
  errEl.style.display = 'none';
  const btn = document.getElementById('btn-pay-plan');
  btn.disabled = true;
  btn.textContent = 'Processing…';

  try {
    let paymentIntentId = null;

    if (selectedPlan.price_cents > 0) {
      const email = document.getElementById('billing-email-plan').value.trim();
      if (!email) { errEl.textContent = 'Enter billing email'; errEl.style.display='block'; btn.disabled=false; btn.textContent='Pay & Create Event →'; return; }
      const { error, paymentIntent } = await stripeInstance.confirmPayment({
        elements: stripeElements,
        confirmParams: { return_url: location.href, receipt_email: email },
        redirect: 'if_required'
      });
      if (error) { errEl.textContent = error.message; errEl.style.display='block'; btn.disabled=false; btn.textContent='Pay & Create Event →'; return; }
      if (paymentIntent?.status !== 'succeeded') { errEl.textContent = 'Payment not completed'; errEl.style.display='block'; btn.disabled=false; btn.textContent='Pay & Create Event →'; return; }
      paymentIntentId = paymentIntent.id;
    }

    const { event } = await api.connect.confirmPayment({ paymentIntentId, planId: selectedPlan.id, eventData: pendingEventData });
    toast('Event created!');
    hideModal('modal-pricing');
    window.location = '/event-detail.html?id=' + event.id;
  } catch(e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Pay & Create Event →';
  }
}
</script>
<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
</script>
</body>
</html>
