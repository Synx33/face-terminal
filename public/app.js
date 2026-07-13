const dateInput = document.getElementById('dateFilter');
const rowsEl = document.getElementById('rows');
const emptyMsg = document.getElementById('emptyMsg');
const statusEl = document.getElementById('status');
const liveDot = document.getElementById('liveDot');

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

dateInput.value = todayLocal();

function timeOnly(iso) {
  if (!iso) return '—';
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

// Employee names come from whoever ran enrollment (typed freely, no
// restriction on characters) and get interpolated into innerHTML below —
// without this, a name containing HTML would render as markup instead of
// text, or worse, run as script.
function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function avatarHtml(row) {
  if (row.picture_path) return `<img src="/snapshots/${row.picture_path}" alt="" loading="lazy" />`;
  return initials(row.name);
}

function directionBadge(direction) {
  if (!direction) return '';
  const label = direction === 'in' ? 'In' : 'Out';
  return `<span class="badge ${direction}">${label}</span>`;
}

function renderRow(row, fresh) {
  const el = document.createElement('div');
  el.className = 'row' + (fresh ? ' fresh' : '');
  el.dataset.id = row.id;
  el.dataset.employee = row.employee_no ?? '';
  el.innerHTML = `
    <div class="avatar">${avatarHtml(row)}</div>
    <div class="who">
      <div class="name">${row.name ? escapeHtml(row.name) : '(unknown)'}</div>
      <div class="no">#${row.employee_no ?? '—'}</div>
    </div>
    <div class="time">${timeOnly(row.event_time)}</div>
    ${directionBadge(row.direction)}
  `;
  return el;
}

async function load() {
  const date = dateInput.value;
  const res = await fetch(`/api/checkins?date=${date}&limit=500`);
  const data = await res.json();
  rowsEl.innerHTML = '';
  emptyMsg.hidden = data.length > 0;
  for (const row of data) rowsEl.appendChild(renderRow(row, false));
  statusEl.textContent = `${data.length} check-in${data.length === 1 ? '' : 's'}`;
}

dateInput.addEventListener('change', load);
document.getElementById('todayBtn').addEventListener('click', () => {
  dateInput.value = todayLocal();
  load();
});

function applyPhoto(id, picturePath) {
  const row = rowsEl.querySelector(`.row[data-id="${id}"]`);
  if (!row) return;
  row.querySelector('.avatar').innerHTML = `<img src="/snapshots/${picturePath}" alt="" loading="lazy" />`;
}

// A repeat scan within the debounce window continues the session already
// shown for this employee rather than adding a new row — update that row's
// time/id in place (its `id` has to move to the new one so a later `photo`
// broadcast for this scan, keyed by id, can still find it) so the live view
// never drifts from what a fresh page load of the same data would show.
function applySessionUpdate(row) {
  if (!row.employee_no) return;
  const existing = rowsEl.querySelector(`.row[data-employee="${row.employee_no}"]`);
  if (!existing) {
    // Nothing currently shown for them (e.g. just switched dates) — treat as new.
    if (row.event_time && row.event_time.startsWith(dateInput.value)) {
      rowsEl.insertBefore(renderRow(row, true), rowsEl.firstChild);
      emptyMsg.hidden = true;
    }
    return;
  }
  existing.dataset.id = row.id;
  const timeEl = existing.querySelector('.time');
  if (timeEl) timeEl.textContent = timeOnly(row.event_time);
  existing.classList.remove('fresh');
  void existing.offsetWidth; // restart the flash animation
  existing.classList.add('fresh');
}

function connectLive() {
  const ws = new WebSocket(`ws://${location.host}/live`);
  ws.onopen = () => liveDot.classList.add('live');
  ws.onclose = () => { liveDot.classList.remove('live'); setTimeout(connectLive, 2000); };
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === 'checkin') {
      const row = data.row;
      if (!row.event_time || !row.event_time.startsWith(dateInput.value)) return;
      rowsEl.insertBefore(renderRow(row, true), rowsEl.firstChild);
      emptyMsg.hidden = true;
    } else if (data.type === 'session-update') {
      applySessionUpdate(data.row);
    } else if (data.type === 'photo') {
      applyPhoto(data.id, data.picture_path);
    }
  };
}

// --- add worker: capture first, name later -----------------------------------

const captureBtn = document.getElementById('captureBtn');
const captureMsg = document.getElementById('captureMsg');
const pendingGrid = document.getElementById('pendingGrid');

function renderPendingCard(pending) {
  const el = document.createElement('div');
  el.className = 'pending-card';
  el.dataset.id = pending.id;
  el.innerHTML = `
    <img class="thumb" src="/snapshots/${pending.picture_path}" alt="" />
    <input type="text" placeholder="Name" />
    <div class="pending-row">
      <button class="save primary">Save</button>
      <button class="discard">×</button>
    </div>
    <div class="pending-status"></div>
  `;

  const nameInput = el.querySelector('input');
  const saveBtn = el.querySelector('.save');
  const discardBtn = el.querySelector('.discard');
  const statusEl = el.querySelector('.pending-status');

  const save = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    saveBtn.disabled = true;
    discardBtn.disabled = true;
    statusEl.className = 'pending-status';
    statusEl.textContent = 'Saving…';
    try {
      const res = await fetch(`/api/pending-workers/${pending.id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'failed');
      el.remove();
    } catch (err) {
      statusEl.className = 'pending-status err';
      statusEl.textContent = err.message;
      saveBtn.disabled = false;
      discardBtn.disabled = false;
    }
  };

  saveBtn.addEventListener('click', save);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  discardBtn.addEventListener('click', async () => {
    discardBtn.disabled = true;
    await fetch(`/api/pending-workers/${pending.id}`, { method: 'DELETE' });
    el.remove();
  });

  return el;
}

async function loadPending() {
  const res = await fetch('/api/pending-workers');
  const list = await res.json();
  pendingGrid.innerHTML = '';
  for (const p of list) pendingGrid.appendChild(renderPendingCard(p));
}

captureBtn.addEventListener('click', async () => {
  captureBtn.disabled = true;
  captureMsg.className = 'enroll-msg';
  captureMsg.textContent = 'Capturing…';
  try {
    const res = await fetch('/api/pending-workers', { method: 'POST' });
    const pending = await res.json();
    if (!res.ok) throw new Error(pending.error || 'failed');
    pendingGrid.appendChild(renderPendingCard(pending));
    captureMsg.textContent = '';
  } catch (err) {
    captureMsg.className = 'enroll-msg err';
    captureMsg.textContent = err.message;
  } finally {
    captureBtn.disabled = false;
  }
});

async function loadDeviceInfo() {
  try {
    const res = await fetch('/api/device');
    const info = await res.json();
    document.getElementById('deviceSubtitle').textContent = info.ip ? `${info.model} · ${info.ip}` : `${info.model} · finding it…`;
  } catch {
    // cosmetic only — fine if this silently stays as the static fallback text
  }
}

// --- settings -----------------------------------------------------------------

const deviceIpInput = document.getElementById('deviceIpInput');
const ipMode = document.getElementById('ipMode');
const ipMsg = document.getElementById('ipMsg');
const settingsMsg = document.getElementById('settingsMsg');
const logView = document.getElementById('logView');

async function loadSettings() {
  const res = await fetch('/api/settings');
  const s = await res.json();
  if (s.deviceIp) deviceIpInput.value = s.deviceIp;
  ipMode.textContent = s.autoDiscover ? '(auto-discovered by MAC — type an IP to pin it)' : '(manually pinned)';
}

document.getElementById('saveIpBtn').addEventListener('click', async () => {
  const ip = deviceIpInput.value.trim();
  ipMsg.className = 'enroll-msg';
  ipMsg.textContent = 'Saving…';
  try {
    const res = await fetch('/api/settings/device-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'failed');
    ipMsg.className = 'enroll-msg ok';
    ipMsg.textContent = `Now using ${result.deviceIp}`;
    ipMode.textContent = '(manually pinned)';
    loadDeviceInfo();
  } catch (err) {
    ipMsg.className = 'enroll-msg err';
    ipMsg.textContent = err.message;
  }
});

document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  if (!confirm('Clear all check-in history? Enrolled workers are not affected.')) return;
  await fetch('/api/checkins', { method: 'DELETE' });
  settingsMsg.className = 'enroll-msg ok';
  settingsMsg.textContent = 'Check-in history cleared.';
  load();
});

document.getElementById('clearLogBtn').addEventListener('click', async () => {
  if (!confirm('Clear the log file?')) return;
  await fetch('/api/logs', { method: 'DELETE' });
  settingsMsg.className = 'enroll-msg ok';
  settingsMsg.textContent = 'Log cleared.';
  if (!logView.hidden) viewLog();
});

async function viewLog() {
  const res = await fetch('/api/logs');
  logView.textContent = (await res.text()) || '(empty)';
  logView.hidden = false;
  logView.scrollTop = logView.scrollHeight;
}

document.getElementById('viewLogBtn').addEventListener('click', () => {
  if (!logView.hidden) { logView.hidden = true; return; }
  viewLog();
});

load();
loadPending();
loadDeviceInfo();
loadSettings();
connectLive();
