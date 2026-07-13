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
const { setDeviceIpPersisted } = require('./settings');
const { enrollEmployee } = require('./enroll');
const logger = require('./logger');

const PORT = Number(process.env.PORT || 3070);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);

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

// --- read API for the dashboard ---------------------------------------------
app.get('/api/checkins', (req, res) => {
  const { date, employeeNo, limit } = req.query;
  res.json(db.listCheckins({ date, employeeNo, limit: limit ? Number(limit) : undefined }));
});

app.get('/api/device', (req, res) => {
  res.json({ model: 'DS-K1T343EWX', ip: hasDeviceIp() ? getDeviceIp() : null });
});

app.get('/api/stats', (req, res) => {
  res.json(db.stats());
});

// --- settings ------------------------------------------------------------------
app.get('/api/settings', (req, res) => {
  res.json({
    deviceIp: hasDeviceIp() ? getDeviceIp() : null,
    deviceMac: process.env.DEVICE_MAC || null,
    autoDiscover: !process.env.DEVICE_IP,
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
  const { name, photoBase64 } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const result = await enrollEmployee({
      name: name.trim(),
      jpegBuffer: photoBase64 ? Buffer.from(photoBase64, 'base64') : null,
    });
    logger.log(`[enroll] added #${result.employeeNo} ${result.name}${result.photoWarning ? ` (photo rejected: ${result.photoWarning})` : ''}`);
    res.json(result);
  } catch (err) {
    logger.error('enrollment failed:', err.message);
    res.status(502).json({ error: `could not create user on terminal: ${err.message}` });
  }
});

app.post('/api/pending-workers', async (req, res) => {
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
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const pending = db.getPendingWorker(id);
  if (!pending) return res.status(404).json({ error: 'no such pending capture' });

  try {
    const jpegBuffer = fs.readFileSync(path.join(SNAPSHOT_DIR, pending.picture_path));
    const result = await enrollEmployee({ name: name.trim(), jpegBuffer });
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

app.use('/snapshots', express.static(SNAPSHOT_DIR));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- startup -----------------------------------------------------------------
async function syncEmployees() {
  try {
    const users = await deviceClient.fetchAllUsers();
    for (const u of users) db.upsertEmployee(u.employeeNo, u.name);
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

server.listen(PORT, async () => {
  logger.log(`face-terminal listening on :${PORT}`);
  logger.log(`  dashboard   http://${process.env.RECEIVER_IP || 'localhost'}:${PORT}/`);
  await resolveDeviceWithRetry();
  syncEmployees();
  setInterval(syncEmployees, 30 * 60 * 1000); // every 30 min — catches renames/new hires
  // If polling keeps failing for a sustained stretch (not just one blip —
  // ~30s worth of consecutive failures at the current poll interval), the
  // device may have moved to a new IP (DHCP lease change at a new site).
  // Re-scan for it rather than staying stuck forever on a stale address.
  const FAILURE_THRESHOLD = Math.max(5, Math.round(30_000 / POLL_INTERVAL_MS));
  let consecutiveFailures = 0;
  let rediscoveryInFlight = false;

  startPolling(POLL_INTERVAL_MS, (row) => {
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
      logger.log(`[checkin] ${row.name || row.employee_no} re-scanned within ${db.DEBOUNCE_SECONDS}s — updating in place, not spamming the feed`);
    }
    capturePhoto(row);
  }, async (err) => {
    if (!err) { consecutiveFailures = 0; return; }
    consecutiveFailures += 1;
    if (consecutiveFailures < FAILURE_THRESHOLD || rediscoveryInFlight) return;
    consecutiveFailures = 0;
    rediscoveryInFlight = true;
    try {
      await forceRediscover();
    } finally {
      rediscoveryInFlight = false;
    }
  });
});
