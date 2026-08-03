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
const { setDeviceIpPersisted, setDeviceCredentialsPersisted } = require('./settings');
const { enrollEmployee } = require('./enroll');
const { runBackup, BACKUP_DIR, BACKUP_INTERVAL_MS } = require('./backup');
const authState = require('./deviceAuthState');
const logger = require('./logger');

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
    debounceSeconds: db.getDebounceSeconds(),
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

app.post('/api/settings/app', (req, res) => {
  const { siteName, currency, pollIntervalMs, debounceSeconds } = req.body || {};

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
  if (debounceSeconds !== undefined) {
    const secs = Number(debounceSeconds);
    if (!Number.isFinite(secs) || secs < 0) {
      return res.status(400).json({ error: 'debounce must be zero or a positive number of seconds' });
    }
    db.setSetting('debounce_seconds', secs);
  }
  logger.log('[settings] app settings updated');
  res.json({
    ok: true,
    siteName: db.getSetting('site_name', 'დასწრების ჟურნალი'),
    currency: db.getSetting('currency', '₾'),
    pollIntervalMs: db.getPollIntervalMs(),
    debounceSeconds: db.getDebounceSeconds(),
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
    const deviceNos = new Set(users.map((u) => String(u.employeeNo)));
    for (const u of users) db.upsertEmployee(u.employeeNo, u.name);
    // Mirror the device's roster exactly — someone removed straight from
    // the device (or a leftover row from before local deletion existed)
    // shouldn't linger forever as a ghost entry in worker management.
    for (const e of db.listEmployees()) {
      if (!deviceNos.has(String(e.employee_no))) db.deleteEmployeeLocal(e.employee_no);
    }
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

function onNewCheckin(row) {
  // A repeat scan within the debounce window (someone unsure it registered,
  // or the camera catching the same face twice) is the same session as the
  // one already showing — listCheckins already folds it into that session
  // for anyone who reloads, so update the existing displayed row in place
  // (new time/photo) rather than either adding a duplicate row or leaving
  // the live view showing stale data until the next manual refresh.
  const isRepeat = row.employee_no && db.isSameSession(row.employee_no, row.event_time, row.id);
  if (!isRepeat) {
    broadcast({ type: 'checkin', row });
    logger.log(`[checkin] ${row.name || row.employee_no} (${row.direction}) @ ${row.event_time}`);
  } else {
    broadcast({ type: 'session-update', row });
    logger.log(`[checkin] ${row.name || row.employee_no} re-scanned within ${db.getDebounceSeconds()}s — updating in place, not spamming the feed`);
  }
  capturePhoto(row);
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

server.listen(PORT, async () => {
  logger.log(`face-terminal listening on :${PORT}`);
  logger.log(`  dashboard   http://${process.env.RECEIVER_IP || 'localhost'}:${PORT}/`);
  await resolveDeviceWithRetry();
  syncEmployees();
  setInterval(syncEmployees, 30 * 60 * 1000); // every 30 min — catches renames/new hires
  restartPolling();
  runBackup(); // one backup right at startup, then on its own schedule below
  setInterval(runBackup, BACKUP_INTERVAL_MS);
});
