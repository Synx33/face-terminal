const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');

const db = require('./db');
const deviceClient = require('./deviceClient');
const { startPolling } = require('./poller');
const { SNAPSHOT_DIR, saveSnapshot, savePendingSnapshot, deleteSnapshot } = require('./snapshots');
const { resolveDeviceIp, forceRediscover } = require('./resolveDevice');
const { getDeviceIp, hasDeviceIp } = require('./deviceState');
const {
  setDeviceIpPersisted, setDeviceCredentialsPersisted,
  setCardDeviceIpPersisted, setCardDeviceCredentialsPersisted,
} = require('./settings');
const { enrollEmployee } = require('./enroll');
const { runBackup, BACKUP_DIR, BACKUP_INTERVAL_MS } = require('./backup');
const authState = require('./deviceAuthState');
const logger = require('./logger');

// --- second device: DS-K2802 card-reader controller (optional) -------------
// Everything below in this block is fully inert unless CARD_DEVICE_IP is
// actually set in .env — a deployment without this second device (every
// deployment so far) behaves exactly as before.
//
// This device speaks Hikvision's proprietary binary "HCNetSDK" protocol
// (TCP port 8000), NOT the HTTP-based ISAPI the face terminal uses —
// confirmed live: NET_DVR_STDXMLConfig (the ISAPI-passthrough call) returns
// NET_DVR_NOSUPPORT on this firmware. So unlike the face terminal, this is
// push-based (a real-time alarm subscription that calls onNewCheckin the
// moment a card is swiped), not polled — see src/cardSdk.js for the full
// verification story. It also can't be found via the face terminal's
// MAC-scan discovery (that probes ISAPI too) — CARD_DEVICE_IP must be set
// explicitly.
const cardSdk = require('./cardSdk');
const cardEnabled = Boolean(process.env.CARD_DEVICE_IP);
let cardConnection = null;

const PORT = Number(process.env.PORT || 3070);

const app = express();
app.use(express.json({ limit: '8mb' })); // generous enough for a base64-encoded enrollment photo
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(json);
  }
}

// Snapshot capture is best-effort and happens *after* the text row is
// already shown — a failed/slow photo grab should never hold up or break
// the check-in feed itself.
async function capturePhoto(row) {
  try {
    const jpeg = await deviceClient.fetchSnapshot();
    const picturePath = saveSnapshot(jpeg, { employeeNo: row.employee_no, serialNo: row.serial_no });
    db.setCheckinPicture(row.id, picturePath);
    broadcast({ type: 'photo', id: row.id, picture_path: picturePath });
  } catch (err) {
    logger.error(`snapshot capture failed for checkin ${row.id}:`, err.message);
  }
}

// A manual retry loop (someone clicking Capture repeatedly out of
// frustration) is a smaller-scale version of the same problem the poller's
// backoff exists for — check this before ever attempting a device call from
// a user-triggered route, so a known-bad-auth state gets one clear error
// message instead of silently piling on more failed attempts.
function rejectIfAuthBackedOff(res) {
  const status = authState.status();
  if (!status.failing) return false;
  const minutesLeft = Math.max(1, Math.ceil((status.retryAt - Date.now()) / 60_000));
  res.status(503).json({ error: `ტერმინალმა უარყო წვდომა — ავტომატური მცდელობები შეჩერებულია დაახლოებით ${minutesLeft} წუთით, შესაძლო დაბლოკვის თავიდან ასაცილებლად. შეამოწმეთ პაროლი პარამეტრებში — მისი გასწორებისთანავე ავტომატური მცდელობა დაუყოვნებლივ განახლდება.` });
  return true;
}

// --- read API for the dashboard ---------------------------------------------
app.get('/api/checkins', (req, res) => {
  const { date, employeeNo, limit } = req.query;
  // A non-numeric ?limit (or anything else that doesn't parse to a finite,
  // positive number) must fall back to listCheckins' own default rather
  // than pass through as NaN — binding NaN to the SQL LIMIT throws a
  // "datatype mismatch" that previously took the whole request down with a
  // raw stack trace in the response.
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
  res.json(db.listCheckins({ date, employeeNo, limit: safeLimit }));
});

app.get('/api/device', (req, res) => {
  res.json({ model: 'DS-K1T343EWX', ip: hasDeviceIp() ? getDeviceIp() : null, auth: authState.status() });
});

app.get('/api/card-device', (req, res) => {
  res.json({
    model: 'DS-K2802',
    enabled: cardEnabled,
    ip: process.env.CARD_DEVICE_IP || null,
    connected: Boolean(cardConnection),
  });
});

app.get('/api/stats', (req, res) => {
  res.json(db.stats());
});

// --- settings ------------------------------------------------------------------
// Everything here is meant to be changeable by whoever runs the site, from
// the dashboard itself — no config file, no restart, no SSH/RDP needed.
app.get('/api/settings', (req, res) => {
  res.json({
    deviceIp: hasDeviceIp() ? getDeviceIp() : null,
    deviceMac: process.env.DEVICE_MAC || null,
    autoDiscover: !process.env.DEVICE_IP,
    // The password itself is never sent back to the client, even on a
    // trusted LAN — a credential should be write-only over the wire.
    deviceUser: process.env.DEVICE_USER || null,
    siteName: db.getSetting('site_name', 'დასწრების ჟურნალი'),
    currency: db.getSetting('currency', '₾'),
    pollIntervalMs: db.getPollIntervalMs(),
    checkoutAfter: db.getCheckoutAfter(),
    cardDeviceEnabled: cardEnabled,
    cardDeviceIp: process.env.CARD_DEVICE_IP || null,
    cardDeviceUser: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER || null,
  });
});

app.post('/api/settings/device-ip', (req, res) => {
  const { ip } = req.body || {};
  if (!ip || typeof ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip.trim())) {
    return res.status(400).json({ error: 'enter a valid IPv4 address, e.g. 10.10.11.184' });
  }
  setDeviceIpPersisted(ip.trim());
  logger.log(`[settings] device IP manually set to ${ip.trim()}`);
  res.json({ ok: true, deviceIp: ip.trim() });
});

// Same idea as device-ip/device-credentials above, for the card-reader
// controller. Setting an IP here for the first time (when the process
// started with cardEnabled=false, i.e. no CARD_DEVICE_MAC/IP was in .env
// yet) persists it but does NOT retroactively start polling this session —
// that only happens on the next restart, same as how DEVICE_IP/MAC always
// worked before Settings existed at all. Kept simple deliberately: this is
// a rarely-changed, one-time-setup value, not something that needs
// live-without-restart semantics the way poll interval or checkout time do.
app.post('/api/settings/card-device-ip', (req, res) => {
  const { ip } = req.body || {};
  if (!ip || typeof ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip.trim())) {
    return res.status(400).json({ error: 'enter a valid IPv4 address, e.g. 10.10.11.185' });
  }
  setCardDeviceIpPersisted(ip.trim());
  logger.log(`[settings] card device IP manually set to ${ip.trim()}`);
  reconnectCardDevice();
  res.json({ ok: true, cardDeviceIp: ip.trim() });
});

app.post('/api/settings/device-credentials', (req, res) => {
  const { user, pass } = req.body || {};
  if (user !== undefined && (typeof user !== 'string' || !user.trim())) {
    return res.status(400).json({ error: 'username cannot be empty' });
  }
  // An empty password field means "leave it as-is" (the field is never
  // pre-filled with the real password, so there's no other way to submit
  // "no change" versus "clear it to blank" — and a blank device password
  // isn't a meaningful state anyway).
  const newPass = typeof pass === 'string' && pass.length > 0 ? pass : undefined;
  const newUser = user !== undefined ? user.trim() : undefined;
  if (newUser === undefined && newPass === undefined) {
    return res.status(400).json({ error: 'nothing to update' });
  }
  setDeviceCredentialsPersisted({ user: newUser, pass: newPass });
  logger.log(`[settings] device credentials updated${newUser ? ` (user: ${newUser})` : ''}${newPass ? ' (password changed)' : ''}`);
  res.json({ ok: true, deviceUser: process.env.DEVICE_USER || null });
});

app.post('/api/settings/card-device-credentials', (req, res) => {
  const { user, pass } = req.body || {};
  if (user !== undefined && (typeof user !== 'string' || !user.trim())) {
    return res.status(400).json({ error: 'username cannot be empty' });
  }
  const newPass = typeof pass === 'string' && pass.length > 0 ? pass : undefined;
  const newUser = user !== undefined ? user.trim() : undefined;
  if (newUser === undefined && newPass === undefined) {
    return res.status(400).json({ error: 'nothing to update' });
  }
  setCardDeviceCredentialsPersisted({ user: newUser, pass: newPass });
  logger.log(`[settings] card device credentials updated${newUser ? ` (user: ${newUser})` : ''}${newPass ? ' (password changed)' : ''}`);
  reconnectCardDevice();
  res.json({ ok: true, cardDeviceUser: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER || null });
});

app.post('/api/settings/app', (req, res) => {
  const { siteName, currency, pollIntervalMs, checkoutAfter } = req.body || {};

  if (siteName !== undefined) {
    if (typeof siteName !== 'string' || !siteName.trim()) {
      return res.status(400).json({ error: 'site name cannot be empty' });
    }
    db.setSetting('site_name', siteName.trim());
  }
  if (currency !== undefined) {
    if (typeof currency !== 'string' || !currency.trim()) {
      return res.status(400).json({ error: 'currency symbol cannot be empty' });
    }
    db.setSetting('currency', currency.trim());
  }
  if (pollIntervalMs !== undefined) {
    const ms = Number(pollIntervalMs);
    if (!Number.isFinite(ms) || ms < 250) {
      return res.status(400).json({ error: 'poll interval must be at least 250ms' });
    }
    db.setSetting('poll_interval_ms', ms);
    restartPolling();
  }
  if (checkoutAfter !== undefined) {
    if (typeof checkoutAfter !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(checkoutAfter)) {
      return res.status(400).json({ error: 'checkout time must be in HH:MM 24-hour format, e.g. 19:00' });
    }
    db.setSetting('checkout_after', checkoutAfter);
  }
  logger.log('[settings] app settings updated');
  res.json({
    ok: true,
    siteName: db.getSetting('site_name', 'დასწრების ჟურნალი'),
    currency: db.getSetting('currency', '₾'),
    pollIntervalMs: db.getPollIntervalMs(),
    checkoutAfter: db.getCheckoutAfter(),
  });
});

app.get('/api/backups', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('attendance-') && f.endsWith('.db'))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, bytes: stat.size, created_at: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch { /* backups dir doesn't exist yet — none taken so far, empty list is correct */ }
  res.json(files);
});

app.post('/api/backups', async (req, res) => {
  await runBackup();
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => {
  res.type('text/plain').send(logger.readLog());
});

app.delete('/api/logs', (req, res) => {
  logger.clearLog();
  logger.log('[settings] log cleared');
  res.json({ ok: true });
});

app.delete('/api/checkins', (req, res) => {
  db.clearCheckins();
  logger.log('[settings] check-in history cleared');
  res.json({ ok: true });
});

// --- add worker ---------------------------------------------------------------
// Two ways in: a direct name+photo (kept for API/scripted use), and the
// primary UI flow — capture a face now (no name needed yet), then claim it
// with a name later once whoever's in charge is free to go through them.
app.post('/api/employees', async (req, res) => {
  const { name, photoBase64, dailyWage } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (dailyWage !== undefined && dailyWage !== null &&
      !(Number.isFinite(Number(dailyWage)) && Number(dailyWage) >= 0)) {
    return res.status(400).json({ error: 'daily wage must be a non-negative number' });
  }
  if (rejectIfAuthBackedOff(res)) return;
  try {
    const result = await enrollEmployee({
      name: name.trim(),
      jpegBuffer: photoBase64 ? Buffer.from(photoBase64, 'base64') : null,
      dailyWage: dailyWage === undefined || dailyWage === null ? null : Number(dailyWage),
    });
    logger.log(`[enroll] added #${result.employeeNo} ${result.name}${result.photoWarning ? ` (photo rejected: ${result.photoWarning})` : ''}`);
    res.json(result);
  } catch (err) {
    logger.error('enrollment failed:', err.message);
    res.status(502).json({ error: `could not create user on terminal: ${err.message}` });
  }
});

app.post('/api/pending-workers', async (req, res) => {
  if (rejectIfAuthBackedOff(res)) return;
  try {
    const jpeg = await deviceClient.fetchSnapshot();
    const picturePath = savePendingSnapshot(jpeg);
    const pending = db.insertPendingWorker(picturePath);
    res.json(pending);
  } catch (err) {
    logger.error('pending capture failed:', err.message);
    res.status(502).json({ error: `could not capture from terminal: ${err.message}` });
  }
});

app.get('/api/pending-workers', (req, res) => {
  res.json(db.listPendingWorkers());
});

app.post('/api/pending-workers/:id/claim', async (req, res) => {
  const id = Number(req.params.id);
  const { name, dailyWage } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (dailyWage !== undefined && dailyWage !== null &&
      !(Number.isFinite(Number(dailyWage)) && Number(dailyWage) >= 0)) {
    return res.status(400).json({ error: 'daily wage must be a non-negative number' });
  }
  if (rejectIfAuthBackedOff(res)) return;
  const pending = db.getPendingWorker(id);
  if (!pending) return res.status(404).json({ error: 'no such pending capture' });

  try {
    const jpegBuffer = fs.readFileSync(path.join(SNAPSHOT_DIR, pending.picture_path));
    const result = await enrollEmployee({
      name: name.trim(),
      jpegBuffer,
      dailyWage: dailyWage === undefined || dailyWage === null ? null : Number(dailyWage),
    });
    db.deletePendingWorker(id);
    deleteSnapshot(pending.picture_path);
    logger.log(`[enroll] claimed pending #${id} as #${result.employeeNo} ${result.name}${result.photoWarning ? ` (photo rejected: ${result.photoWarning})` : ''}`);
    res.json(result);
  } catch (err) {
    logger.error('claim failed:', err.message);
    res.status(502).json({ error: `could not create user on terminal: ${err.message}` });
  }
});

app.delete('/api/pending-workers/:id', (req, res) => {
  const id = Number(req.params.id);
  const pending = db.getPendingWorker(id);
  if (!pending) return res.status(404).json({ error: 'no such pending capture' });
  db.deletePendingWorker(id);
  deleteSnapshot(pending.picture_path);
  res.json({ ok: true });
});

// --- worker management (list / rename / wage / remove) ------------------------
app.get('/api/employees', (req, res) => {
  res.json(db.listEmployees());
});

app.put('/api/employees/:employeeNo', async (req, res) => {
  const { employeeNo } = req.params;
  const { name, dailyWage } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }
  if (dailyWage !== undefined && dailyWage !== null &&
      !(Number.isFinite(Number(dailyWage)) && Number(dailyWage) >= 0)) {
    return res.status(400).json({ error: 'daily wage must be a non-negative number' });
  }
  const wage = dailyWage === undefined ? undefined : (dailyWage === null ? null : Number(dailyWage));
  // Only the rename branch below actually touches the device — a wage-only
  // edit is a pure local DB write, so it's never gated on device auth state.
  if (name !== undefined && rejectIfAuthBackedOff(res)) return;
  try {
    if (name !== undefined) {
      // Renaming touches the device too — modifyDeviceUser resets that
      // user's valid-dates window on the device (fine, a minor cosmetic
      // side effect), which is why this only runs when a name was actually
      // given, not on every wage-only edit.
      await deviceClient.modifyDeviceUser({ employeeNo, name: name.trim() });
      db.upsertEmployee(employeeNo, name.trim(), wage);
    } else if (wage !== undefined) {
      // Wage-only edit — go through setEmployeeWage instead of
      // upsertEmployee so the employee's name isn't touched at all.
      db.setEmployeeWage(employeeNo, wage);
    }
    logger.log(`[employees] updated #${employeeNo}`);
    res.json({ ok: true });
  } catch (err) {
    logger.error('employee update failed:', err.message);
    res.status(502).json({ error: `could not update on terminal: ${err.message}` });
  }
});

app.delete('/api/employees/:employeeNo', async (req, res) => {
  const { employeeNo } = req.params;
  if (rejectIfAuthBackedOff(res)) return;
  try {
    // Removes both the device user AND their enrolled face (the device
    // treats a face as an attribute of the user, not a separate record) —
    // there's no such thing as deleting "just the face" while keeping the
    // user able to badge in.
    await deviceClient.deleteDeviceUser(employeeNo);
    db.deleteEmployeeLocal(employeeNo);
    logger.log(`[employees] removed #${employeeNo} (and their face) from the terminal`);
    res.json({ ok: true });
  } catch (err) {
    logger.error('employee delete failed:', err.message);
    res.status(502).json({ error: `could not remove from terminal: ${err.message}` });
  }
});

// Assigns a physical card number (DS-K2802) to an existing local employee.
app.post('/api/employees/:employeeNo/card', async (req, res) => {
  const { employeeNo } = req.params;
  const { cardNo } = req.body || {};
  if (cardNo !== undefined && typeof cardNo !== 'string') {
    return res.status(400).json({ error: 'card number must be a string' });
  }
  // An empty string clears the assignment (e.g. a card was lost/reissued) —
  // distinct from omitting cardNo entirely, which is a client bug.
  const trimmedCard = cardNo !== undefined ? cardNo.trim() : undefined;
  if (trimmedCard === undefined) {
    return res.status(400).json({ error: 'cardNo is required (send an empty string to clear the assignment)' });
  }
  const name = db.employeeName(employeeNo);
  if (!name) {
    return res.status(404).json({ error: `no local employee #${employeeNo}` });
  }

  // Local assignment happens first and is never rolled back by a
  // device-side failure below — same "local DB is authoritative" principle
  // already used for daily wage: a card swipe can resolve to the right
  // person via employees.card_no (see db.js's insertCheckin) even if
  // provisioning it ON the card device itself didn't work.
  try {
    db.setEmployeeCard(employeeNo, trimmedCard);
  } catch (err) {
    // Almost certainly the partial unique index on card_no — that card
    // number is already assigned to someone else.
    return res.status(409).json({ error: `that card number is already assigned to someone else: ${err.message}` });
  }

  // No device-side provisioning call here — confirmed live against the real
  // DS-K2802 that it does not support remote card/person enrollment via SDK
  // (every provisioning command tried failed consistently, unlike the alarm
  // subscription mechanism which worked on the first correctly-parameterized
  // attempt — a firmware limitation, not a gap in this code). The card must
  // be enrolled ON the device itself (its own menu, or iVMS-4200's Person
  // and Card Management screen) — this endpoint only records which employee
  // that card number belongs to locally, which is all a swipe event needs
  // to resolve correctly (see db.js's insertCheckin/employeeNoForCard).
  const clearing = trimmedCard === '';
  const deviceWarning = clearing
    ? null
    : cardEnabled
      ? null
      // User-facing (rendered directly in the dashboard) — Georgian, matching
      // every other client-visible string in this app. The logger.log below
      // stays English, matching every other server-side log line.
      : 'ბარათის წამკითხველი ჯერ არ არის დაკონფიგურირებული — ბარათი შენახულია მხოლოდ პროგრამაში. მოწყობილობის დამატებისთანავე, ამ ბარათის მიტანისას ავტომატურად ამოიცნობა ეს თანამშრომელი.';

  logger.log(clearing
    ? `[employees] card assignment cleared for #${employeeNo}`
    : `[employees] card assigned to #${employeeNo} locally${deviceWarning ? ' (device not configured)' : ' — remember to also enroll this card on the device itself, provisioning is not remote-controllable on this hardware'}`);
  res.json({ ok: true, employeeNo, cardNo: clearing ? null : trimmedCard, warning: deviceWarning });
});

// --- payroll -------------------------------------------------------------------
app.get('/api/payroll', (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params are required, e.g. ?start=2026-07-01&end=2026-07-31' });
  }
  res.json(db.payroll({ start, end }));
});

// --- CSV export ------------------------------------------------------------------
function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(fields) {
  return fields.map(csvField).join(',');
}

app.get('/api/checkins/export', (req, res) => {
  const { date, employeeNo } = req.query;
  const rows = db.listCheckins({ date, employeeNo, limit: 1_000_000 });
  const lines = ['employee_no,name,event_time,direction,verify_mode'];
  for (const r of rows) lines.push(csvRow([r.employee_no, r.name, r.event_time, r.direction, r.verify_mode]));
  const filename = `checkins${date ? `-${date}` : ''}.csv`;
  res.type('text/csv').attachment(filename).send(lines.join('\n'));
});

app.get('/api/payroll/export', (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params are required' });
  }
  const rows = db.payroll({ start, end });
  const lines = ['employee_no,name,days_present,daily_wage,total_pay'];
  for (const r of rows) lines.push(csvRow([r.employee_no, r.name, r.days_present, r.daily_wage, r.total_pay]));
  res.type('text/csv').attachment(`payroll-${start}_to_${end}.csv`).send(lines.join('\n'));
});

app.use('/snapshots', express.static(SNAPSHOT_DIR));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- startup -----------------------------------------------------------------
async function syncEmployees() {
  // Same reasoning as the poller's skip-gate: don't add another 401 to the
  // pile every 30 minutes while we already know auth is failing.
  if (authState.isBackedOff()) {
    logger.log('[sync] skipping employee sync — device auth is currently backed off, see Settings');
    return;
  }
  try {
    const users = await deviceClient.fetchAllUsers();
    for (const u of users) db.upsertEmployee(u.employeeNo, u.name);
    // Deliberately add/update-only, never delete here. This used to also
    // remove any local row missing from the device's current roster — but
    // that meant a factory reset, a swapped-in replacement unit, a device
    // hiccup returning a short list, or someone deleting a user directly on
    // the terminal (bypassing the dashboard) would silently wipe that
    // person's locally-stored daily wage and drop them from all future
    // payroll output, with nobody asked and nothing to undo it. Wage data
    // exists ONLY in this local DB, never on the device, so it must never
    // be an automatic side effect of a background sync. The only way to
    // remove a worker now is the explicit Remove button in Worker
    // Management, which touches both the device and the local record
    // together, deliberately, with a confirmation.
    logger.log(`synced ${users.length} employee(s) from the terminal`);
  } catch (err) {
    logger.error('employee sync failed (will retry):', err.message);
  }
}

async function resolveDeviceWithRetry() {
  const RETRY_MS = 15_000;
  while (true) {
    try {
      await resolveDeviceIp();
      return;
    } catch (err) {
      logger.error(`device resolution failed (${err.message}); retrying in ${RETRY_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}

// Mutable so a poll-interval change from Settings (POST /api/settings/app)
// can tear down the running interval and start a fresh one at the new
// speed — no service restart needed for this to take effect.
let pollTimer = null;
let consecutiveFailures = 0;
let rediscoveryInFlight = false;

function onNewCheckin(insertedId) {
  const inserted = db.getCheckinById(insertedId);
  if (!inserted) return; // shouldn't happen, but don't crash on a stale/bad id

  // A scan while already checked in/out for this same period (same day,
  // same side of the checkout-time boundary) is fully ignored for display:
  // no broadcast, no photo capture, the feed doesn't change at all — this
  // is deliberate ("it doesn't detect it anymore until 19:00"), not a bug.
  // Checked against the row that was ACTUALLY just inserted (its own id +
  // event_time), not the period's representative row — using the
  // representative here would always compare a row against itself and
  // never detect a repeat.
  const isRepeat = inserted.employee_no && db.isSameSession(inserted.employee_no, inserted.event_time, inserted.id);
  if (isRepeat) {
    const direction = db.periodOf(inserted.event_time, db.getCheckoutAfter());
    logger.log(`[checkin] ${inserted.name || inserted.employee_no} scanned again while already checked ${direction} today — ignored until the period changes`);
    return;
  }

  // Not a repeat means this scan started a new period, so it IS the
  // representative (earliest) row of its (employee, day, direction) group —
  // re-fetch through listCheckins() to get the computed `direction` field
  // for the broadcast payload/log line.
  const row = db.listCheckins({ limit: 1 })[0];
  broadcast({ type: 'checkin', row });
  logger.log(`[checkin] ${row.name || row.employee_no} (${row.direction}) @ ${row.event_time}`);
  // The card-reader controller has no camera of its own (it's a bare PCB
  // wired to external Wiegand readers) — only ever try to grab a snapshot
  // for a row that actually came from the face terminal.
  if (row.device_id === 'face') capturePhoto(row);
}

async function onPollError(err) {
  if (!err) { consecutiveFailures = 0; return; }
  consecutiveFailures += 1;
  // If polling keeps failing for a sustained stretch (not just one blip —
  // ~30s worth of consecutive failures at the current poll interval), the
  // device may have moved to a new IP (DHCP lease change at a new site).
  // Re-scan for it rather than staying stuck forever on a stale address.
  const failureThreshold = Math.max(5, Math.round(30_000 / db.getPollIntervalMs()));
  if (consecutiveFailures < failureThreshold || rediscoveryInFlight) return;
  consecutiveFailures = 0;
  rediscoveryInFlight = true;
  try {
    await forceRediscover();
  } finally {
    rediscoveryInFlight = false;
  }
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  consecutiveFailures = 0;
  pollTimer = startPolling(db.getPollIntervalMs(), onNewCheckin, onPollError);
}

// --- card device lifecycle (only runs at all if cardEnabled) ---------------
// Push-based, not polled: a persistent HCNetSDK session subscribes to
// real-time alarms and onCardEvent() fires directly from that callback,
// so there's no poll-interval/tick/backoff machinery to mirror from the
// face terminal's side here.

// The device doesn't hand us a monotonic per-event serial number the way
// AcsEvent search does for the face terminal, so checkins.serial_no (needed
// for the device_id+serial_no dedup key) is synthesized locally as
// Date.now() (milliseconds since epoch) rather than a simple in-memory
// counter. A counter was the original design here, but an independent
// review caught a real data-loss bug in it, reproduced directly: it started
// over at 0 on every process restart, while the database's own stored
// serials from BEFORE the restart don't reset — so a fresh run's very first
// few real swipes would collide with already-used serial numbers and get
// silently discarded by the UNIQUE(device_id, serial_no) + INSERT OR IGNORE
// dedup, exactly the kind of silent data loss this whole app exists to
// avoid. Date.now() is monotonically increasing across restarts (today's
// timestamp is always greater than any previous run's), so this can't happen.
function onCardEvent(event) {
  // Non-swipe alarm-channel traffic (confirmed live: e.g. an admin login
  // shows up on this same feed as dwMajor=3, "operation") has no parseable
  // card number — extractCardNo() already returns null for those (verified
  // against a real captured non-swipe event), so filtering on cardNo alone
  // is a directly-verified signal, unlike guessing at which dwMajor/dwMinor
  // values specifically mean "this was a real swipe."
  if (!event.cardNo) return;
  const insertedId = db.insertCheckin({
    eventTime: event.eventTime, // already a formatted "+04:00" string (cardSdk.js's isoWithOffset), not a Date
    cardNo: event.cardNo,
    serialNo: Date.now(),
    raw: JSON.stringify({ dwMajor: event.dwMajor, dwMinor: event.dwMinor }),
  }, 'push', 'card');
  if (insertedId) onNewCheckin(insertedId);
}

let cardConnectInFlight = false;

async function connectCardDeviceWithRetry() {
  if (cardConnectInFlight) return;
  cardConnectInFlight = true;
  const RETRY_MS = 15_000;
  try {
    while (cardEnabled && !cardConnection) {
      try {
        cardConnection = cardSdk.connect({
          ip: process.env.CARD_DEVICE_IP,
          user: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER,
          pass: process.env.CARD_DEVICE_PASS || process.env.DEVICE_PASS,
        }, onCardEvent);
        logger.log(`[card] connected to card device at ${process.env.CARD_DEVICE_IP}`);
      } catch (err) {
        logger.error(`[card] connection failed (${err.message}); retrying in ${RETRY_MS / 1000}s`);
        cardConnection = null;
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  } finally {
    cardConnectInFlight = false;
  }
}

// Closes and re-opens the session — used after a credentials/IP change from
// Settings, and as a periodic safety net (below): this SDK's C API doesn't
// give a verified "connection was lost" callback to react to here, so
// rather than silently going dark for good after a device reboot or network
// blip, a fresh reconnect is forced periodically regardless of apparent state.
function reconnectCardDevice() {
  if (cardConnection) {
    try { cardConnection.close(); } catch { /* best-effort */ }
    cardConnection = null;
  }
  if (cardEnabled) connectCardDeviceWithRetry();
}

server.listen(PORT, async () => {
  logger.log(`face-terminal listening on :${PORT}`);
  logger.log(`  dashboard   http://${process.env.RECEIVER_IP || 'localhost'}:${PORT}/`);

  // Backups only ever touch the local SQLite file — they must never be
  // gated on the device being reachable. This used to run AFTER
  // resolveDeviceWithRetry(), which retries forever every 15s while the
  // terminal is offline — meaning if the service happened to start (or
  // restart) while the device was unreachable, backups silently never ran
  // at all until it came back, for a reason that had nothing to do with
  // what's actually being backed up. Start this immediately instead.
  runBackup();
  setInterval(runBackup, BACKUP_INTERVAL_MS);

  // Deliberately NOT awaited — an optional second device must never delay
  // or block startup of the (mandatory) face terminal path below.
  if (cardEnabled) {
    connectCardDeviceWithRetry();
    // Periodic forced reconnect — see reconnectCardDevice's comment on why
    // this exists instead of reacting to a verified disconnect signal.
    setInterval(reconnectCardDevice, 6 * 60 * 60 * 1000); // every 6h
  }

  await resolveDeviceWithRetry();
  syncEmployees();
  setInterval(syncEmployees, 30 * 60 * 1000); // every 30 min — catches renames/new hires
  restartPolling();
});
