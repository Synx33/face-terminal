const dateInput = document.getElementById('dateFilter');
const rowsEl = document.getElementById('rows');
const emptyMsg = document.getElementById('emptyMsg');
const statusEl = document.getElementById('status');
const liveDot = document.getElementById('liveDot');
const employeeFilter = document.getElementById('employeeFilter');

// --- tabs ------------------------------------------------------------------
// Feed/Workers/Payroll used to all sit stacked on one long page; now only
// one panel is visible at a time, switched by these top-level tab buttons.
for (const tabBtn of document.querySelectorAll('.tab')) {
  tabBtn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b === tabBtn));
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.hidden = panel.dataset.panel !== tabBtn.dataset.tab;
    }
  });
}

// --- settings modal ----------------------------------------------------------
// Terminal IP, site name/currency, poll timing, and maintenance/backups all
// used to live inline on the main page — moved into a dialog so the primary
// screen (the actual day-to-day feed/workers/payroll) stays uncluttered.
const settingsModal = document.getElementById('settingsModal');
document.getElementById('settingsBtn').addEventListener('click', () => settingsModal.showModal());
document.getElementById('settingsCloseBtn').addEventListener('click', () => settingsModal.close());
// A native <dialog>'s backdrop click lands on the <dialog> element itself
// (its padding-box fills the viewport when open) — only close if the click
// target IS the dialog, not something inside modal-body/modal-head.
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.close();
});

// Georgia is a fixed UTC+4, no DST. This dashboard runs on laptops that
// move between networks/sites, and nothing guarantees whoever set the
// laptop up ever changed its Windows timezone to Georgia — it defaults to
// wherever it was originally configured. Computing "today" from the
// browser's own local Date getters (getFullYear/getMonth/getDate) would
// silently use whatever timezone THAT machine happens to have, which is
// exactly the bug this had: it looked fine on a dev box that happens to
// already be set to Asia/Tbilisi, and would only show wrong on a laptop set
// to anything else. Fix: shift the absolute UTC instant by Georgia's fixed
// offset and read UTC getters off the result — mirrors src/time.js's
// georgiaNaive() exactly (no shared module between server and browser here).
const GEORGIA_OFFSET_HOURS = 4;

function georgiaParts(date) {
  const shifted = new Date(date.getTime() + GEORGIA_OFFSET_HOURS * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year: shifted.getUTCFullYear(),
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate()),
    hour: pad(shifted.getUTCHours()),
    minute: pad(shifted.getUTCMinutes()),
  };
}

function todayLocal() {
  const p = georgiaParts(new Date());
  return `${p.year}-${p.month}-${p.day}`;
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
  const label = direction === 'in' ? 'შემოსვლა' : 'გასვლა';
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
      <div class="name">${row.name ? escapeHtml(row.name) : '(უცნობი)'}</div>
      <div class="no">#${row.employee_no ?? '—'}</div>
    </div>
    <div class="time">${timeOnly(row.event_time)}</div>
    ${directionBadge(row.direction)}
  `;
  return el;
}

async function load() {
  const date = dateInput.value;
  const employeeNo = employeeFilter.value;
  const params = new URLSearchParams({ date, limit: 500 });
  if (employeeNo) params.set('employeeNo', employeeNo);
  const res = await fetch(`/api/checkins?${params}`);
  const data = await res.json();
  rowsEl.innerHTML = '';
  emptyMsg.hidden = data.length > 0;
  for (const row of data) rowsEl.appendChild(renderRow(row, false));
  statusEl.textContent = `${data.length} ჩანაწერი`;
}

dateInput.addEventListener('change', load);
employeeFilter.addEventListener('change', load);
document.getElementById('todayBtn').addEventListener('click', () => {
  dateInput.value = todayLocal();
  load();
});

async function loadEmployeeFilterOptions() {
  const res = await fetch('/api/employees');
  const employees = await res.json();
  const current = employeeFilter.value;
  employeeFilter.innerHTML = '<option value="">ყველა თანამშრომელი</option>';
  for (const e of employees) {
    const opt = document.createElement('option');
    opt.value = e.employee_no;
    opt.textContent = e.name || `#${e.employee_no}`;
    employeeFilter.appendChild(opt);
  }
  employeeFilter.value = current; // survives a reload triggered by worker management changes
}

function applyPhoto(id, picturePath) {
  const row = rowsEl.querySelector(`.row[data-id="${id}"]`);
  if (!row) return;
  row.querySelector('.avatar').innerHTML = `<img src="/snapshots/${picturePath}" alt="" loading="lazy" />`;
}

// A live scan should only land in the feed if it matches whatever the
// dashboard is currently narrowed to — the right day, and (if a worker
// filter is active) that specific worker. Otherwise a scan from someone
// NOT selected would pop into a filtered "just this person" view, which
// would look like the filter silently stopped working.
function matchesCurrentFilter(row) {
  if (!row.event_time || !row.event_time.startsWith(dateInput.value)) return false;
  if (employeeFilter.value && String(row.employee_no) !== employeeFilter.value) return false;
  return true;
}

function connectLive() {
  const ws = new WebSocket(`ws://${location.host}/live`);
  ws.onopen = () => liveDot.classList.add('live');
  ws.onclose = () => { liveDot.classList.remove('live'); setTimeout(connectLive, 2000); };
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === 'checkin') {
      const row = data.row;
      if (!matchesCurrentFilter(row)) return;
      rowsEl.insertBefore(renderRow(row, true), rowsEl.firstChild);
      emptyMsg.hidden = true;
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
    <input type="text" class="name-input" placeholder="სახელი" />
    <input type="text" class="wage-input" placeholder="დღიური ანაზღაურება (არასავალდებულო)" inputmode="decimal" />
    <div class="pending-row">
      <button class="save primary">შენახვა</button>
      <button class="discard">×</button>
    </div>
    <div class="pending-status"></div>
  `;

  const nameInput = el.querySelector('.name-input');
  const wageInput = el.querySelector('.wage-input');
  const saveBtn = el.querySelector('.save');
  const discardBtn = el.querySelector('.discard');
  const statusEl = el.querySelector('.pending-status');

  const save = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const wageText = wageInput.value.trim();
    if (wageText && (!Number.isFinite(Number(wageText)) || Number(wageText) < 0)) {
      statusEl.className = 'pending-status err';
      statusEl.textContent = 'დღიური ანაზღაურება უნდა იყოს არაუარყოფითი რიცხვი';
      wageInput.focus();
      return;
    }
    saveBtn.disabled = true;
    discardBtn.disabled = true;
    statusEl.className = 'pending-status';
    statusEl.textContent = 'ინახება…';
    try {
      const res = await fetch(`/api/pending-workers/${pending.id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, dailyWage: wageText ? Number(wageText) : null }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'ვერ შესრულდა');
      el.remove();
      // The newly-enrolled person needs to actually show up somewhere —
      // the roster grid and the feed's worker filter both list currently
      // enrolled employees, and neither auto-refreshes on its own.
      loadWorkers();
      loadEmployeeFilterOptions();
    } catch (err) {
      statusEl.className = 'pending-status err';
      statusEl.textContent = err.message;
      saveBtn.disabled = false;
      discardBtn.disabled = false;
    }
  };

  saveBtn.addEventListener('click', save);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  wageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
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
  captureMsg.textContent = 'ფოტოს გადაღება…';
  try {
    const res = await fetch('/api/pending-workers', { method: 'POST' });
    const pending = await res.json();
    if (!res.ok) throw new Error(pending.error || 'ვერ შესრულდა');
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
    const subtitleEl = document.getElementById('deviceSubtitle');
    const base = info.ip ? `${info.model} · ${info.ip}` : `${info.model} · ეძებს…`;
    if (info.auth?.failing) {
      const minutesLeft = Math.max(1, Math.ceil((info.auth.retryAt - Date.now()) / 60_000));
      subtitleEl.textContent = `${base} · ავტორიზაცია ვერ მოხერხდა (სცადეთ ${minutesLeft} წთ-ში ან შეასწორეთ პაროლი პარამეტრებში)`;
      subtitleEl.classList.add('subtitle-err');
    } else {
      subtitleEl.textContent = base;
      subtitleEl.classList.remove('subtitle-err');
    }
  } catch {
    // cosmetic only — fine if this silently stays as the static fallback text
  }
}

// The auth-failure state can change on its own between page loads (backoff
// expiring, or someone fixing the password from another tab/device) —
// re-check it periodically instead of only once at page load.
setInterval(loadDeviceInfo, 30_000);

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  const params = new URLSearchParams({ date: dateInput.value });
  if (employeeFilter.value) params.set('employeeNo', employeeFilter.value);
  window.location.href = `/api/checkins/export?${params}`;
});

// --- worker management (list / rename / wage / remove) ------------------------

const workerGrid = document.getElementById('workerGrid');
let currencySymbol = '₾';

function renderWorkerCard(w) {
  const el = document.createElement('div');
  el.className = 'pending-card';
  el.dataset.employeeNo = w.employee_no;
  el.innerHTML = `
    ${w.picture_path
      ? `<img class="thumb" src="/snapshots/${w.picture_path}" alt="" />`
      : `<div class="thumb thumb-placeholder">${escapeHtml(initials(w.name))}</div>`}
    <input type="text" class="name-input" value="${escapeHtml(w.name || '')}" placeholder="სახელი" />
    <input type="text" class="wage-input" value="${w.daily_wage ?? ''}" placeholder="დღიური ანაზღაურება" inputmode="decimal" />
    <div class="pending-row">
      <button class="save primary">შენახვა</button>
      <button class="discard" title="სრულად წაშლა ტერმინალიდან">წაშლა</button>
    </div>
    <div class="pending-status"></div>
    <div class="no">#${w.employee_no}</div>
  `;

  const nameInput = el.querySelector('.name-input');
  const wageInput = el.querySelector('.wage-input');
  const saveBtn = el.querySelector('.save');
  const removeBtn = el.querySelector('.discard');
  const statusEl = el.querySelector('.pending-status');

  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const wageText = wageInput.value.trim();
    if (wageText && (!Number.isFinite(Number(wageText)) || Number(wageText) < 0)) {
      statusEl.className = 'pending-status err';
      statusEl.textContent = 'დღიური ანაზღაურება უნდა იყოს არაუარყოფითი რიცხვი';
      wageInput.focus();
      return;
    }
    saveBtn.disabled = true;
    statusEl.className = 'pending-status';
    statusEl.textContent = 'ინახება…';
    try {
      const res = await fetch(`/api/employees/${w.employee_no}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name !== w.name ? name : undefined,
          dailyWage: wageText ? Number(wageText) : null,
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'ვერ შესრულდა');
      statusEl.className = 'pending-status ok';
      statusEl.textContent = 'შენახულია';
      loadEmployeeFilterOptions();
    } catch (err) {
      statusEl.className = 'pending-status err';
      statusEl.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  removeBtn.addEventListener('click', async () => {
    const currentName = nameInput.value.trim() || w.name || `#${w.employee_no}`;
    if (!confirm(`წავშალოთ ${currentName} ტერმინალიდან? წაშლისას წაიშლება მისი სახეც და წვდომაც — ადრინდელი დასწრების ისტორია შენარჩუნდება.`)) return;
    removeBtn.disabled = true;
    saveBtn.disabled = true;
    statusEl.className = 'pending-status';
    statusEl.textContent = 'იშლება…';
    try {
      const res = await fetch(`/api/employees/${w.employee_no}`, { method: 'DELETE' });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'ვერ შესრულდა');
      el.remove();
      loadEmployeeFilterOptions();
    } catch (err) {
      statusEl.className = 'pending-status err';
      statusEl.textContent = err.message;
      removeBtn.disabled = false;
      saveBtn.disabled = false;
    }
  });

  return el;
}

async function loadWorkers() {
  const res = await fetch('/api/employees');
  const workers = await res.json();
  workerGrid.innerHTML = '';
  for (const w of workers) workerGrid.appendChild(renderWorkerCard(w));
}

// --- payroll -------------------------------------------------------------------

const payrollStart = document.getElementById('payrollStart');
const payrollEnd = document.getElementById('payrollEnd');
const payrollTable = document.getElementById('payrollTable');
const payrollBody = document.getElementById('payrollBody');
const payrollMsg = document.getElementById('payrollMsg');

function defaultPayrollRange() {
  const p = georgiaParts(new Date());
  const first = `${p.year}-${p.month}-01`;
  const today = todayLocal();
  return { first, today };
}

{
  const { first, today } = defaultPayrollRange();
  payrollStart.value = first;
  payrollEnd.value = today;
}

async function calcPayroll() {
  const start = payrollStart.value;
  const end = payrollEnd.value;
  if (!start || !end) return;
  payrollMsg.className = 'enroll-msg';
  payrollMsg.textContent = 'გამოითვლება…';
  try {
    const res = await fetch(`/api/payroll?start=${start}&end=${end}`);
    const rows = await res.json();
    payrollBody.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.dataset.employeeNo = r.employee_no;
      tr.innerHTML = `
        <td>${escapeHtml(r.name || `#${r.employee_no}`)}</td>
        <td>${r.days_present}</td>
        <td class="wage-cell">
          <input type="text" class="wage-input-inline" value="${r.daily_wage ?? ''}" inputmode="decimal" placeholder="—" />
          <button class="save-wage-btn icon-btn" title="განაკვეთის შენახვა" aria-label="განაკვეთის შენახვა">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
        </td>
        <td>${r.daily_wage ? `${r.total_pay} ${escapeHtml(currencySymbol)}` : '—'}</td>
      `;
      payrollBody.appendChild(tr);
    }
    payrollTable.hidden = rows.length === 0;
    payrollMsg.textContent = rows.length ? '' : 'ჯერ არცერთი თანამშრომელი არ არის რეგისტრირებული.';
  } catch (err) {
    payrollMsg.className = 'enroll-msg err';
    payrollMsg.textContent = err.message;
  }
}

document.getElementById('calcPayrollBtn').addEventListener('click', calcPayroll);
document.getElementById('exportPayrollBtn').addEventListener('click', () => {
  const start = payrollStart.value;
  const end = payrollEnd.value;
  if (!start || !end) return;
  window.location.href = `/api/payroll/export?start=${start}&end=${end}`;
});

// Daily rate is editable right from the payroll table too, not only from
// the Workers tab — changing someone's wage here recalculates their total
// immediately (via a fresh calcPayroll(), so the number shown is always
// exactly what the server computed, never a hand-rolled client-side copy).
async function saveWageFromPayrollRow(tr) {
  const employeeNo = tr.dataset.employeeNo;
  const input = tr.querySelector('.wage-input-inline');
  const wageText = input.value.trim();
  if (wageText && (!Number.isFinite(Number(wageText)) || Number(wageText) < 0)) {
    payrollMsg.className = 'enroll-msg err';
    payrollMsg.textContent = 'დღიური განაკვეთი უნდა იყოს არაუარყოფითი რიცხვი';
    input.focus();
    return;
  }
  input.disabled = true;
  try {
    const res = await fetch(`/api/employees/${employeeNo}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailyWage: wageText ? Number(wageText) : null }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'ვერ შესრულდა');
    // calcPayroll() sets its own (transient) status text while it re-fetches
    // — set the actual confirmation message after it resolves, not before,
    // or this would get overwritten and never actually be seen.
    await calcPayroll();
    payrollMsg.className = 'enroll-msg ok';
    payrollMsg.textContent = 'განაკვეთი შენახულია.';
  } catch (err) {
    payrollMsg.className = 'enroll-msg err';
    payrollMsg.textContent = err.message;
    input.disabled = false;
  }
}

payrollBody.addEventListener('click', (e) => {
  const btn = e.target.closest('.save-wage-btn');
  if (!btn) return;
  saveWageFromPayrollRow(btn.closest('tr'));
});
payrollBody.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('wage-input-inline')) {
    saveWageFromPayrollRow(e.target.closest('tr'));
  }
});

// --- settings -----------------------------------------------------------------

const deviceIpInput = document.getElementById('deviceIpInput');
const ipMode = document.getElementById('ipMode');
const ipMsg = document.getElementById('ipMsg');
const settingsMsg = document.getElementById('settingsMsg');
const logView = document.getElementById('logView');

const deviceUserInput = document.getElementById('deviceUserInput');
const devicePassInput = document.getElementById('devicePassInput');
const credsMsg = document.getElementById('credsMsg');

const siteNameInput = document.getElementById('siteNameInput');
const currencyInput = document.getElementById('currencyInput');
const pollIntervalInput = document.getElementById('pollIntervalInput');
const checkoutAfterInput = document.getElementById('checkoutAfterInput');
const appSettingsMsg = document.getElementById('appSettingsMsg');

function applySiteName(name) {
  document.getElementById('siteTitle').textContent = name;
  document.getElementById('pageTitle').textContent = `${name} — სახის ტერმინალი`;
}

async function loadSettings() {
  const res = await fetch('/api/settings');
  const s = await res.json();
  if (s.deviceIp) deviceIpInput.value = s.deviceIp;
  ipMode.textContent = s.autoDiscover ? '(ავტომატურად მოძებნილია MAC მისამართით — ჩაწერეთ IP მის მისამაგრებლად)' : '(მითითებულია ხელით)';
  if (s.deviceUser) deviceUserInput.value = s.deviceUser;
  // devicePassInput is deliberately never pre-filled — the real password
  // is never sent to the browser at all, only ever written, never read.
  siteNameInput.value = s.siteName;
  currencyInput.value = s.currency;
  pollIntervalInput.value = s.pollIntervalMs;
  checkoutAfterInput.value = s.checkoutAfter;
  currencySymbol = s.currency;
  applySiteName(s.siteName);
}

const CHECKOUT_AFTER_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

document.getElementById('saveAppSettingsBtn').addEventListener('click', async () => {
  const pollIntervalMs = Number(pollIntervalInput.value);
  const checkoutAfter = checkoutAfterInput.value.trim();
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 250) {
    appSettingsMsg.className = 'enroll-msg err';
    appSettingsMsg.textContent = 'შემოწმების ინტერვალი უნდა იყოს მინიმუმ 250 მწმ';
    return;
  }
  if (!CHECKOUT_AFTER_RE.test(checkoutAfter)) {
    appSettingsMsg.className = 'enroll-msg err';
    appSettingsMsg.textContent = 'გასვლის დრო უნდა იყოს სთ:წთ ფორმატში, მაგ. 19:00';
    return;
  }
  appSettingsMsg.className = 'enroll-msg';
  appSettingsMsg.textContent = 'ინახება…';
  try {
    const res = await fetch('/api/settings/app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteName: siteNameInput.value.trim() || 'დასწრების ჟურნალი',
        currency: currencyInput.value.trim() || '₾',
        pollIntervalMs,
        checkoutAfter,
      }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'ვერ შესრულდა');
    currencySymbol = result.currency;
    applySiteName(result.siteName);
    appSettingsMsg.className = 'enroll-msg ok';
    appSettingsMsg.textContent = 'შენახულია.';
  } catch (err) {
    appSettingsMsg.className = 'enroll-msg err';
    appSettingsMsg.textContent = err.message;
  }
});

// --- backups ---------------------------------------------------------------------

const backupList = document.getElementById('backupList');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// toLocaleString() would format in the BROWSER's configured timezone —
// same host-timezone trap as todayLocal() above. Georgia-anchor this too.
function formatGeorgiaDateTime(isoString) {
  const p = georgiaParts(new Date(isoString));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

async function loadBackups() {
  const res = await fetch('/api/backups');
  const backups = await res.json();
  if (!backups.length) { backupList.textContent = 'სარეზერვო ასლი ჯერ არ არის შექმნილი.'; return; }
  const latest = backups[0];
  backupList.textContent = `ინახება ${backups.length} ასლი · ბოლო: ${formatGeorgiaDateTime(latest.created_at)} (${formatBytes(latest.bytes)})`;
}

document.getElementById('backupNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('backupNowBtn');
  btn.disabled = true;
  settingsMsg.className = 'enroll-msg ok';
  settingsMsg.textContent = 'იქმნება სარეზერვო ასლი…';
  try {
    await fetch('/api/backups', { method: 'POST' });
    settingsMsg.textContent = 'სარეზერვო ასლი შექმნილია.';
    loadBackups();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('saveIpBtn').addEventListener('click', async () => {
  const ip = deviceIpInput.value.trim();
  ipMsg.className = 'enroll-msg';
  ipMsg.textContent = 'ინახება…';
  try {
    const res = await fetch('/api/settings/device-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'ვერ შესრულდა');
    ipMsg.className = 'enroll-msg ok';
    ipMsg.textContent = `ახლა გამოიყენება ${result.deviceIp}`;
    ipMode.textContent = '(მითითებულია ხელით)';
    loadDeviceInfo();
  } catch (err) {
    ipMsg.className = 'enroll-msg err';
    ipMsg.textContent = err.message;
  }
});

document.getElementById('saveCredsBtn').addEventListener('click', async () => {
  const user = deviceUserInput.value.trim();
  const pass = devicePassInput.value; // not trimmed — a leading/trailing space could be a real (if unusual) part of a password
  if (!user) {
    credsMsg.className = 'enroll-msg err';
    credsMsg.textContent = 'მომხმარებლის სახელი არ შეიძლება იყოს ცარიელი';
    return;
  }
  // A wrong password sent to the terminal can lock its admin login out for
  // an extended period (observed: 26 minutes from a single failed attempt)
  // — this dashboard never tests a password against the device before
  // saving it (that itself would risk triggering the same lockout), so a
  // typo here isn't caught until something later actually needs the
  // terminal. A deliberate pause before saving is the only real safeguard.
  if (pass && !confirm('დარწმუნებული ხართ, რომ პაროლი სწორად შეიყვანეთ? არასწორმა პაროლმა შეიძლება დაბლოკოს ტერმინალის ადმინის შესვლა ხანგრძლივი დროით.')) {
    return;
  }
  credsMsg.className = 'enroll-msg';
  credsMsg.textContent = 'ინახება…';
  try {
    const res = await fetch('/api/settings/device-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass: pass || undefined }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'ვერ შესრულდა');
    credsMsg.className = 'enroll-msg ok';
    credsMsg.textContent = 'შენახულია.';
  } catch (err) {
    credsMsg.className = 'enroll-msg err';
    credsMsg.textContent = err.message;
  }
});

document.getElementById('togglePassBtn').addEventListener('click', () => {
  const showing = devicePassInput.type === 'text';
  devicePassInput.type = showing ? 'password' : 'text';
});

document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  if (!confirm('წავშალოთ დასწრების მთელი ისტორია? რეგისტრირებულ თანამშრომლებზე გავლენას არ იქონიებს.')) return;
  await fetch('/api/checkins', { method: 'DELETE' });
  settingsMsg.className = 'enroll-msg ok';
  settingsMsg.textContent = 'ისტორია გასუფთავებულია.';
  load();
});

document.getElementById('clearLogBtn').addEventListener('click', async () => {
  if (!confirm('გავასუფთაოთ ლოგის ფაილი?')) return;
  await fetch('/api/logs', { method: 'DELETE' });
  settingsMsg.className = 'enroll-msg ok';
  settingsMsg.textContent = 'ლოგი გასუფთავებულია.';
  if (!logView.hidden) viewLog();
});

async function viewLog() {
  const res = await fetch('/api/logs');
  logView.textContent = (await res.text()) || '(ცარიელია)';
  logView.hidden = false;
  logView.scrollTop = logView.scrollHeight;
}

document.getElementById('viewLogBtn').addEventListener('click', () => {
  if (!logView.hidden) { logView.hidden = true; return; }
  viewLog();
});

// --- photo lightbox -----------------------------------------------------------

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');
const LIGHTBOX_TRANSITION_MS = 220;

function openLightbox(src) {
  lightboxImg.src = src;
  lightbox.hidden = false;
  // Force layout with `hidden` removed but pre-transition, then add the
  // class on the next frame so the CSS transition actually plays instead
  // of snapping straight to the open state.
  requestAnimationFrame(() => requestAnimationFrame(() => lightbox.classList.add('open')));
}

function closeLightbox() {
  lightbox.classList.remove('open');
  setTimeout(() => {
    lightbox.hidden = true;
    lightboxImg.src = '';
  }, LIGHTBOX_TRANSITION_MS);
}

// Delegated click handling — rows/cards get created and replaced
// dynamically, so listen on the containers rather than each image.
// Explicitly requires an <img> tag (not just ".thumb") so a worker card with
// no photo yet (rendered as a text-initials placeholder <div>, not an <img>)
// doesn't open an empty lightbox with a blank src.
for (const container of [rowsEl, pendingGrid, workerGrid]) {
  container.addEventListener('click', (e) => {
    const img = e.target.closest('.avatar img, .pending-card img.thumb');
    if (img) openLightbox(img.src);
  });
}

lightbox.addEventListener('click', closeLightbox);
lightboxImg.addEventListener('click', (e) => e.stopPropagation()); // clicking the photo itself shouldn't close it
document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
});

load();
loadPending();
loadDeviceInfo();
loadSettings();
loadEmployeeFilterOptions();
loadWorkers();
loadBackups();
calcPayroll();
connectLive();
