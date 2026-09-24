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
const { buildCheckinsReport, buildPayrollReport } = require('./reports');
const { runBackup, BACKUP_DIR, BACKUP_INTERVAL_MS } = require('./backup');
const authState = require('./deviceAuthState');
const auth = require('./auth');
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
// Was a `const` computed once at module load -- meant CARD_DEVICE_IP could
// only ever take effect on process start, so typing an IP into Settings on
// a deployment that started with no card device configured at all silently
// did nothing until a restart (the comment on the settings route below used
// to document this as accepted behavior). That's now the exact gap in the
// way of "enter IP/user/password from Settings and see it connect" -- a
// function that re-reads process.env every call fixes it for good, same
// idea as deviceState.js's hasDeviceIp() for the face terminal.
function cardDeviceConfigured() {
  return Boolean(process.env.CARD_DEVICE_IP);
}
let cardConnection = null;
// Mirrors deviceAuthState's factory (built for exactly this, per its own
// comment, but never actually wired up here until now) -- a wrong card-
// device password must back off automatic retries the same way a wrong
// face-terminal password already does, instead of retrying a login every
// 15s forever. See connectCardDeviceWithRetry() below for why this matters
// more now that Settings can trigger a login attempt on demand.
const cardAuthState = authState.createAuthState('card');

const PORT = Number(process.env.PORT || 3070);

const app = express();
app.use(express.json({ limit: '8mb' })); // generous enough for a base64-encoded enrollment photo
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });

// --- auth: everything below this block requires a login session ------------
// index:false stops express.static from auto-serving public/index.html for
// GET / -- that path gets its own handler right below instead, so it can
// redirect to the login page when there's no valid session, rather than
// silently handing an unauthenticated visitor the full dashboard shell
// (whose API calls would all just 401 -- confusing, not actually secure).
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// Runs synchronously at module load, before server.listen() ever starts
// accepting connections -- there must never be a window where the server
// is reachable but no account exists to log into it yet.
auth.bootstrapAdmin();

function currentSession(req) {
  const token = auth.readSessionToken(req);
  const session = token && db.getSessionWithUser(token);
  if (!session || new Date(session.expires_at) < new Date()) return null;
  return session;
}

app.get('/', (req, res) => {
  if (!currentSession(req)) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'მომხმარებელი და პაროლი სავალდებულოა' });
  const user = db.getUserByUsername(username.trim());
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'არასწორი მომხმარებელი ან პაროლი' });
  }
  const { token } = auth.createSessionForUser(user.id);
  auth.setSessionCookie(res, token);
  logger.log(`[auth] ${user.username} logged in`);
  res.json({ ok: true });
});

// Public on purpose -- logging out only ever needs whatever cookie the
// browser already has (or doesn't), never a proof of who's asking. Missing
// or already-expired session: still a no-op success, since the end state
// ("no valid session, cookie cleared") is identical either way.
app.post('/api/auth/logout', (req, res) => {
  const token = auth.readSessionToken(req);
  if (token) db.deleteSession(token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.use(auth.requireAuth); // every route registered from here down needs a valid session

app.get('/api/auth/me', (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    isAdmin: Boolean(req.user.is_admin),
    canView: Boolean(req.user.can_view),
    canEdit: Boolean(req.user.can_edit),
    canAdd: Boolean(req.user.can_add),
    canRemove: Boolean(req.user.can_remove),
  });
});

app.post('/api/auth/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'ახალი პაროლი უნდა შედგებოდეს მინიმუმ 8 სიმბოლოსგან' });
  }
  if (!auth.verifyPassword(currentPassword || '', req.user.password_hash)) {
    return res.status(401).json({ error: 'მიმდინარე პაროლი არასწორია' });
  }
  db.updateUserPassword(req.user.id, auth.hashPassword(newPassword));
  // Every OTHER session for this account gets signed out -- a password
  // change is exactly the moment an old/compromised session should stop
  // working, and the one making the change already has a fresh cookie so
  // it never notices. The current token is re-issued fresh (rather than
  // just spared) so it isn't silently orphaned by the same invalidation.
  db.deleteSessionsForUser(req.user.id);
  const { token } = auth.createSessionForUser(req.user.id);
  auth.setSessionCookie(res, token);
  logger.log(`[auth] ${req.user.username} changed their own password`);
  res.json({ ok: true });
});

// --- user account management (admin only) -----------------------------------
app.get('/api/users', auth.requireAdmin, (req, res) => {
  res.json(db.listUsers());
});

app.post('/api/users', auth.requireAdmin, (req, res) => {
  const { username, password, isAdmin, canView, canEdit, canAdd, canRemove } = req.body || {};
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'მომხმარებლის სახელი სავალდებულოა' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'პაროლი უნდა შედგებოდეს მინიმუმ 8 სიმბოლოსგან' });
  }
  if (db.getUserByUsername(username.trim())) {
    return res.status(409).json({ error: 'ეს მომხმარებლის სახელი უკვე დაკავებულია' });
  }
  const id = db.createUser({
    username: username.trim(),
    passwordHash: auth.hashPassword(password),
    isAdmin: Boolean(isAdmin), canView: Boolean(canView), canEdit: Boolean(canEdit), canAdd: Boolean(canAdd), canRemove: Boolean(canRemove),
  });
  logger.log(`[auth] ${req.user.username} created account "${username.trim()}"`);
  res.json({ id });
});

app.put('/api/users/:id', auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'მომხმარებელი ვერ მოიძებნა' });
  const { isAdmin, canView, canEdit, canAdd, canRemove, password } = req.body || {};
  // The very last admin can't demote themselves (or be demoted) -- there
  // would then be no account left able to fix that, or manage any other
  // account, ever again, short of hand-editing the database.
  if (target.is_admin && isAdmin === false) {
    const adminCount = db.listUsers().filter((u) => u.is_admin).length;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'ბოლო ადმინისტრატორს არ შეიძლება წაერთვას უფლება — ჯერ დანიშნეთ სხვა ადმინისტრატორი' });
    }
  }
  db.updateUserPermissions(id, {
    isAdmin: isAdmin ?? Boolean(target.is_admin),
    canView: canView ?? Boolean(target.can_view),
    canEdit: canEdit ?? Boolean(target.can_edit),
    canAdd: canAdd ?? Boolean(target.can_add),
    canRemove: canRemove ?? Boolean(target.can_remove),
  });
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'პაროლი უნდა შედგებოდეს მინიმუმ 8 სიმბოლოსგან' });
    db.updateUserPassword(id, auth.hashPassword(password));
    db.deleteSessionsForUser(id); // force re-login with the new password, same reasoning as change-password above
  }
  logger.log(`[auth] ${req.user.username} updated account "${target.username}"`);
  res.json({ ok: true });
});

app.delete('/api/users/:id', auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'მომხმარებელი ვერ მოიძებნა' });
  if (target.is_admin && db.listUsers().filter((u) => u.is_admin).length <= 1) {
    return res.status(400).json({ error: 'ბოლო ადმინისტრატორის წაშლა არ შეიძლება' });
  }
  if (id === req.user.id) {
    return res.status(400).json({ error: 'საკუთარი ანგარიშის წაშლა შეუძლებელია — სთხოვეთ სხვა ადმინისტრატორს' });
  }
  db.deleteUser(id);
  logger.log(`[auth] ${req.user.username} deleted account "${target.username}"`);
  res.json({ ok: true });
});

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

// Worker/checkin photos -- gated behind the same auth as everything else
// now (this line moved here specifically so it lands after app.use(auth.requireAuth)
// above), not left as an anyone-can-fetch-if-they-guess-the-path static mount.
app.use('/snapshots', express.static(SNAPSHOT_DIR));

// --- read API for the dashboard ---------------------------------------------
app.get('/api/checkins', auth.requirePermission('can_view'), (req, res) => {
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

app.get('/api/device', auth.requirePermission('can_view'), (req, res) => {
  res.json({ model: 'DS-K1T343EWX', ip: hasDeviceIp() ? getDeviceIp() : null, auth: authState.status() });
});

app.get('/api/card-device', auth.requirePermission('can_view'), (req, res) => {
  res.json({
    model: 'DS-K2802',
    enabled: cardDeviceConfigured(),
    ip: process.env.CARD_DEVICE_IP || null,
    connected: Boolean(cardConnection),
    auth: cardAuthState.status(),
  });
});

// Opens a short-lived, separate SDK session purely to prove the given (or,
// if omitted, currently-saved) IP/user/password actually work end to end --
// used by the Settings "test connection" button so "enter it and see it
// works" doesn't just mean "hope the background retry loop eventually
// connects". Deliberately does NOT touch the live `cardConnection` used for
// real event listening: NET_DVR_Login_V40 supports more than one concurrent
// session against the same device (the same reason iVMS-4200 can be open
// on another PC while this app's own listener stays connected), so a quick
// extra login-then-logout here has no effect on the real one.
//
// Gated behind the same cardAuthState backoff as the background retry loop
// -- a "test" button being easy to click again is exactly how a wrong
// password ends up getting hammered at the device repeatedly, which is
// the precise failure mode that caused a real ~26-minute admin lockout on
// this project's OTHER device (see deviceAuthState.js). Testing NEW,
// not-yet-saved credentials is deliberately not supported here -- save
// first (which goes through the same confirm-before-saving caution the
// dashboard already asks for on the face terminal's password field), then
// test what's actually saved, so there's exactly one place a login attempt
// can be triggered from, not two.
let cardTestInFlight = false;
app.post('/api/card-device/test', auth.requireAdmin, async (req, res) => {
  if (cardTestInFlight) return res.status(429).json({ error: 'ტესტი უკვე მიმდინარეობს' });
  if (!cardDeviceConfigured()) {
    return res.status(400).json({ error: 'ჯერ მიუთითეთ ბარათის მოწყობილობის IP პარამეტრებში' });
  }
  if (cardAuthState.isBackedOff()) {
    const minutesLeft = Math.max(1, Math.ceil((cardAuthState.status().retryAt - Date.now()) / 60_000));
    return res.status(503).json({ error: `ბოლო მცდელობა ვერ დაკავშირდა — ავტომატური/ხელით ტესტირება შეჩერებულია დაახლოებით ${minutesLeft} წუთით, შესაძლო დაბლოკვის თავიდან ასაცილებლად. შეასწორეთ IP/მომხმარებელი/პაროლი და შეინახეთ ხელახლა ცდისთვის.` });
  }
  cardTestInFlight = true;
  try {
    let testConn;
    try {
      testConn = cardSdk.connect({
        ip: process.env.CARD_DEVICE_IP,
        user: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER,
        pass: process.env.CARD_DEVICE_PASS || process.env.DEVICE_PASS,
      }, () => {});
    } catch (err) {
      cardAuthState.recordAuthFailure();
      return res.json({ ok: false, error: err.message });
    }
    cardAuthState.recordAuthSuccess();
    try { testConn.close(); } catch { /* best-effort */ }
    res.json({ ok: true });
  } finally {
    cardTestInFlight = false;
  }
});

app.get('/api/stats', auth.requirePermission('can_view'), (req, res) => {
  res.json(db.stats());
});

// --- settings ------------------------------------------------------------------
// Everything here is meant to be changeable by whoever runs the site, from
// the dashboard itself — no config file, no restart, no SSH/RDP needed.
app.get('/api/settings', auth.requirePermission('can_view'), (req, res) => {
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
    cardDeviceEnabled: cardDeviceConfigured(),
    cardDeviceIp: process.env.CARD_DEVICE_IP || null,
    cardDeviceUser: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER || null,
  });
});

app.post('/api/settings/device-ip', auth.requireAdmin, (req, res) => {
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
// started with no CARD_DEVICE_IP in .env at all, i.e. a brand-new site
// deploy) now DOES take effect immediately, no restart needed —
// cardDeviceConfigured() re-reads process.env on every call instead of
// freezing the answer at startup, specifically so "type the IP in and see
// it connect" works on the very first try.
app.post('/api/settings/card-device-ip', auth.requireAdmin, (req, res) => {
  const { ip } = req.body || {};
  if (!ip || typeof ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip.trim())) {
    return res.status(400).json({ error: 'enter a valid IPv4 address, e.g. 10.10.11.185' });
  }
  setCardDeviceIpPersisted(ip.trim());
  logger.log(`[settings] card device IP manually set to ${ip.trim()}`);
  cardAuthState.resetBackoff(); // give the corrected IP an immediate attempt, not a leftover backoff meant for the old one
  reconnectCardDevice();
  res.json({ ok: true, cardDeviceIp: ip.trim() });
});

app.post('/api/settings/device-credentials', auth.requireAdmin, (req, res) => {
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

app.post('/api/settings/card-device-credentials', auth.requireAdmin, (req, res) => {
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
  cardAuthState.resetBackoff(); // same reasoning as card-device-ip above
  reconnectCardDevice();
  res.json({ ok: true, cardDeviceUser: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER || null });
});

app.post('/api/settings/app', auth.requireAdmin, (req, res) => {
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

app.get('/api/backups', auth.requireAdmin, (req, res) => {
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

app.post('/api/backups', auth.requireAdmin, async (req, res) => {
  await runBackup();
  res.json({ ok: true });
});

app.get('/api/logs', auth.requireAdmin, (req, res) => {
  res.type('text/plain').send(logger.readLog());
});

app.delete('/api/logs', auth.requireAdmin, (req, res) => {
  logger.clearLog();
  logger.log('[settings] log cleared');
  res.json({ ok: true });
});

app.delete('/api/checkins', auth.requireAdmin, (req, res) => {
  db.clearCheckins();
  logger.log('[settings] check-in history cleared');
  res.json({ ok: true });
});

// --- add worker ---------------------------------------------------------------
// Two ways in: a direct name+photo (kept for API/scripted use), and the
// primary UI flow — capture a face now (no name needed yet), then claim it
// with a name later once whoever's in charge is free to go through them.
app.post('/api/employees', auth.requirePermission('can_add'), async (req, res) => {
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

app.post('/api/pending-workers', auth.requirePermission('can_add'), async (req, res) => {
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

app.get('/api/pending-workers', auth.requirePermission('can_view'), (req, res) => {
  res.json(db.listPendingWorkers());
});

app.post('/api/pending-workers/:id/claim', auth.requirePermission('can_add'), async (req, res) => {
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

app.delete('/api/pending-workers/:id', auth.requirePermission('can_add'), (req, res) => {
  const id = Number(req.params.id);
  const pending = db.getPendingWorker(id);
  if (!pending) return res.status(404).json({ error: 'no such pending capture' });
  db.deletePendingWorker(id);
  deleteSnapshot(pending.picture_path);
  res.json({ ok: true });
});

// --- card enrollment: press button, wait for tap, name it after --------------
// Same "capture first, name later" shape as pending-workers above, but the
// "capture" here isn't instant (there's no photo to grab on demand) — it
// has to wait for whatever the physical swipe that happens sometime after
// the button is pressed. So a pending_cards row starts with card_no=NULL
// the moment the button is pressed, onCardEvent() (see the card device
// lifecycle section below) fills it in the moment a real tap arrives, and
// the dashboard just polls this row until card_no shows up.
const PENDING_CARD_TIMEOUT_MS = 60_000; // matches the UX: this is a "stand there and tap it now" action, not something left armed indefinitely
const pendingCardTimers = new Map(); // id -> setTimeout handle, so a real capture/explicit cancel can cancel the auto-expiry

function clearPendingCardTimer(id) {
  const timer = pendingCardTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    pendingCardTimers.delete(id);
  }
}

app.post('/api/pending-cards', auth.requirePermission('can_add'), (req, res) => {
  if (!cardDeviceConfigured()) {
    return res.status(400).json({ error: 'ბარათის მოწყობილობა არ არის კონფიგურირებული — მიუთითეთ IP/მომხმარებელი/პაროლი პარამეტრებში' });
  }
  // Idempotent: a double-click, or reopening the tab mid-wait, resumes the
  // same still-armed capture instead of silently arming a second one that
  // would only ever catch a swipe if the first one is cancelled first.
  let pending = db.findArmedPendingCard();
  if (!pending) {
    pending = db.insertPendingCard();
    const id = pending.id;
    pendingCardTimers.set(id, setTimeout(() => {
      pendingCardTimers.delete(id);
      const current = db.getPendingCard(id);
      if (current && !current.card_no) db.deletePendingCard(id); // never tapped -- stop listening for it
    }, PENDING_CARD_TIMEOUT_MS));
  }
  res.json(pending);
});

app.get('/api/pending-cards', auth.requirePermission('can_view'), (req, res) => {
  res.json(db.listPendingCards());
});

app.get('/api/pending-cards/:id', auth.requirePermission('can_view'), (req, res) => {
  const pending = db.getPendingCard(Number(req.params.id));
  if (!pending) return res.status(404).json({ error: 'no such pending capture' });
  res.json(pending);
});

app.post('/api/pending-cards/:id/claim', auth.requirePermission('can_add'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, dailyWage } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (dailyWage !== undefined && dailyWage !== null &&
      !(Number.isFinite(Number(dailyWage)) && Number(dailyWage) >= 0)) {
    return res.status(400).json({ error: 'daily wage must be a non-negative number' });
  }
  // Deliberately does NOT touch the face terminal at all -- a card-only
  // worker never shows their face to that device, so there's no reason
  // enrolling one should depend on it being reachable. employeeNo comes
  // from this app's own local "C<n>" namespace (db.nextLocalEmployeeNo())
  // instead of deviceClient.nextEmployeeNo(), which used to make this
  // claim fail outright with a confusing "device IP not yet resolved"
  // error any time the (unrelated) face terminal happened to be offline.
  const pending = db.getPendingCard(id);
  if (!pending) return res.status(404).json({ error: 'no such pending capture' });
  if (!pending.card_no) return res.status(409).json({ error: 'ბარათი ჯერ არ დაფიქსირებულა — მიადეთ ბარათი წამკითხველს და მოიცადეთ' });

  const employeeNo = db.nextLocalEmployeeNo();
  db.upsertEmployee(employeeNo, name.trim(), dailyWage === undefined || dailyWage === null ? null : Number(dailyWage));
  try {
    db.setEmployeeCard(employeeNo, pending.card_no);
  } catch (err) {
    // The employee row above is already committed -- only the card
    // assignment itself collided with an existing owner (partial unique
    // index on employees.card_no, almost certainly the same physical card
    // tapped and claimed once already). Same "leave what succeeded,
    // surface the real problem" principle as the /card endpoint above.
    clearPendingCardTimer(id);
    db.deletePendingCard(id);
    return res.status(409).json({ error: `თანამშრომელი #${employeeNo} შეიქმნა, მაგრამ ეს ბარათი უკვე მინიჭებული აქვს სხვას: ${err.message}` });
  }
  clearPendingCardTimer(id);
  db.deletePendingCard(id);
  logger.log(`[enroll] claimed pending card #${id} (${pending.card_no}) as local #${employeeNo} ${name.trim()}`);
  res.json({ employeeNo, name: name.trim(), cardNo: pending.card_no });
});

app.delete('/api/pending-cards/:id', auth.requirePermission('can_add'), (req, res) => {
  const id = Number(req.params.id);
  const pending = db.getPendingCard(id);
  if (!pending) return res.status(404).json({ error: 'no such pending capture' });
  clearPendingCardTimer(id);
  db.deletePendingCard(id);
  res.json({ ok: true });
});

// --- worker management (list / rename / wage / remove) ------------------------
app.get('/api/employees', auth.requirePermission('can_view'), (req, res) => {
  res.json(db.listEmployees());
});

app.put('/api/employees/:employeeNo', auth.requirePermission('can_edit'), async (req, res) => {
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
  // A card-only employee (db.isCardOnlyEmployeeNo — enrolled through the
  // pending-cards claim flow, never given a face at all) has nothing on
  // the face terminal to rename in the first place, so the device call
  // below only ever runs for a real device-backed employee. Only THAT
  // branch is gated on device auth state — a wage-only edit, or any edit
  // to a card-only employee, is a pure local DB write regardless.
  const touchesDevice = name !== undefined && !db.isCardOnlyEmployeeNo(employeeNo);
  if (touchesDevice && rejectIfAuthBackedOff(res)) return;
  try {
    if (name !== undefined && touchesDevice) {
      // Renaming touches the device too — modifyDeviceUser resets that
      // user's valid-dates window on the device (fine, a minor cosmetic
      // side effect), which is why this only runs when a name was actually
      // given, not on every wage-only edit.
      await deviceClient.modifyDeviceUser({ employeeNo, name: name.trim() });
      db.upsertEmployee(employeeNo, name.trim(), wage);
    } else if (name !== undefined) {
      // Card-only employee — local rename, no device involved.
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

app.delete('/api/employees/:employeeNo', auth.requirePermission('can_remove'), async (req, res) => {
  const { employeeNo } = req.params;
  // A card-only employee (db.isCardOnlyEmployeeNo) has no device-side user
  // or face to remove at all -- deleting one is a pure local operation,
  // never gated on the face terminal being reachable.
  if (db.isCardOnlyEmployeeNo(employeeNo)) {
    db.deleteEmployeeLocal(employeeNo);
    logger.log(`[employees] removed local card-only #${employeeNo}`);
    return res.json({ ok: true });
  }
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
app.post('/api/employees/:employeeNo/card', auth.requirePermission('can_edit'), async (req, res) => {
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
    : cardDeviceConfigured()
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
app.get('/api/payroll', auth.requirePermission('can_view'), (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params are required, e.g. ?start=2026-07-01&end=2026-07-31' });
  }
  res.json(db.payroll({ start, end }));
});

// --- report export (styled .xlsx, not raw CSV) ------------------------------
// A plain CSV can't be "pretty" -- it's just delimited text, no styling
// possible at all. Reports meant to actually be handed to someone (an
// owner, an accountant) go out as real formatted Excel workbooks instead:
// a title block, a colored header row, currency/date formatting, zebra
// striping, and (for payroll) a grand-total row. See src/reports.js.
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

app.get('/api/checkins/export', auth.requirePermission('can_view'), async (req, res) => {
  const { date, employeeNo } = req.query;
  const rows = db.listCheckins({ date, employeeNo, limit: 1_000_000 });
  const siteName = db.getSetting('site_name', 'დასწრების ჟურნალი');
  const filterParts = [];
  filterParts.push(date ? `თარიღი: ${date}` : 'ყველა თარიღი');
  if (employeeNo) {
    const empName = db.employeeName(employeeNo);
    filterParts.push(`თანამშრომელი: ${empName || `#${employeeNo}`}`);
  }
  const wb = await buildCheckinsReport(rows, { siteName, filterLabel: filterParts.join(' · ') });
  const filename = `attendance-report${date ? `-${date}` : ''}.xlsx`;
  res.type(XLSX_CONTENT_TYPE).attachment(filename);
  await wb.xlsx.write(res);
  res.end();
});

app.get('/api/payroll/export', auth.requirePermission('can_view'), async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params are required' });
  }
  const rows = db.payroll({ start, end });
  const siteName = db.getSetting('site_name', 'დასწრების ჟურნალი');
  const currency = db.getSetting('currency', '₾');
  const wb = await buildPayrollReport(rows, { siteName, currency, start, end });
  res.type(XLSX_CONTENT_TYPE).attachment(`payroll-report-${start}_to_${end}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

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
  //
  // Never applied to card-reader rows -- a face scan can passively
  // re-trigger just from someone standing in view of the camera, which is
  // the whole reason this same-session collapsing exists; a card tap can't
  // happen by accident the same way, so every tap is a deliberate action
  // that should always be read, saved, and shown, with no time-of-day
  // gating at all.
  const isRepeat = inserted.device_id !== 'card'
    && inserted.employee_no && db.isSameSession(inserted.employee_no, inserted.event_time, inserted.id);
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

// --- card device lifecycle (only runs at all if cardDeviceConfigured()) ----
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
  // Unconditional, every single alarm-channel event this device sends,
  // not just ones that turn into a checkin or a captured pending card --
  // added specifically to answer "did a real tap reach the software at
  // all, and what did it look like" from the journal directly, without
  // needing a separate scratch script each time that question comes up.
  logger.log(`[card] event received: major=${event.dwMajor} minor=${event.dwMinor} cardNo=${event.cardNo ?? '(none)'} netUser=${event.netUser ?? ''}`);
  // Non-swipe alarm-channel traffic (confirmed live: e.g. an admin login
  // shows up on this same feed as dwMajor=3, "operation") has no parseable
  // card number — extractCardNo() already returns null for those (verified
  // against a real captured non-swipe event), so filtering on cardNo alone
  // is a directly-verified signal, unlike guessing at which dwMajor/dwMinor
  // values specifically mean "this was a real swipe."
  if (!event.cardNo) return;

  // "Add card" flow (press button, wait for tap, then name it): while a
  // pending_cards row is armed (card_no still NULL), the NEXT real swipe is
  // that new/unassigned card being enrolled, not a check-in — it belongs to
  // nobody yet, so logging it as a checkin would create a permanently
  // employee_no-less row (insertCheckin resolves employeeNo from cardNo at
  // INSERT time, not on every later read, so it could never retroactively
  // attach to the employee this card is about to be assigned to). Divert it
  // into the pending capture instead and stop -- setPendingCardNo only
  // succeeds if the row is still unfilled, so a race against a second
  // swipe/second armed row can't double-assign one tap.
  const armed = db.findArmedPendingCard();
  if (armed && db.setPendingCardNo(armed.id, event.cardNo)) {
    clearPendingCardTimer(armed.id);
    logger.log(`[card] captured card ${event.cardNo} for pending enrollment #${armed.id}`);
    return;
  }

  const insertedId = db.insertCheckin({
    eventTime: event.eventTime, // already a formatted "+04:00" string (cardSdk.js's isoWithOffset), not a Date
    cardNo: event.cardNo,
    serialNo: Date.now(),
    // cardNo kept here even though employeeNo already resolved it above --
    // a card enrolled on the device itself (iVMS-4200, its own menu) but
    // never assigned to anyone in this app resolves to no employee at all,
    // and without this the actual card number would be gone for good the
    // moment this row is written, leaving no way to ever identify which
    // physical card an "(უცნობი)" row even was.
    raw: JSON.stringify({ dwMajor: event.dwMajor, dwMinor: event.dwMinor, cardNo: event.cardNo }),
  }, 'push', 'card');
  if (insertedId) onNewCheckin(insertedId);
}

let cardConnectInFlight = false;

async function connectCardDeviceWithRetry() {
  if (cardConnectInFlight) return;
  cardConnectInFlight = true;
  const RETRY_MS = 15_000;
  try {
    while (cardDeviceConfigured() && !cardConnection) {
      // A login that's currently backed off (see cardAuthState above) must
      // not be retried at the normal 15s cadence -- that's the exact
      // "hammer a possibly-locked-out login every few seconds" pattern that
      // caused a real ~26-minute lockout on this project's other device.
      // Poll the backoff state itself at a slower, harmless cadence instead
      // so it picks up either the backoff naturally expiring or a
      // Settings-triggered resetBackoff() promptly.
      if (cardAuthState.isBackedOff()) {
        await new Promise((r) => setTimeout(r, RETRY_MS));
        continue;
      }
      try {
        cardConnection = cardSdk.connect({
          ip: process.env.CARD_DEVICE_IP,
          user: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER,
          pass: process.env.CARD_DEVICE_PASS || process.env.DEVICE_PASS,
        }, onCardEvent);
        cardAuthState.recordAuthSuccess();
        logger.log(`[card] connected to card device at ${process.env.CARD_DEVICE_IP}`);
      } catch (err) {
        cardAuthState.recordAuthFailure();
        cardConnection = null;
        if (cardAuthState.isBackedOff()) {
          logger.error(`[card] connection failed (${err.message}) — pausing automatic retries, possible bad credentials/lockout risk. Fix in Settings to retry immediately.`);
        } else {
          logger.error(`[card] connection failed (${err.message}); retrying in ${RETRY_MS / 1000}s`);
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
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
  if (cardDeviceConfigured()) connectCardDeviceWithRetry();
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

  // Expired sessions are already refused by requireAuth (it checks
  // expires_at on every request) -- this is just housekeeping so the table
  // doesn't grow forever with rows nothing will ever read again.
  db.pruneExpiredSessions();
  setInterval(db.pruneExpiredSessions, 6 * 60 * 60 * 1000); // every 6h

  // Deliberately NOT awaited — an optional second device must never delay
  // or block startup of the (mandatory) face terminal path below.
  // Always scheduled now, even if no CARD_DEVICE_IP is set yet -- both
  // functions already no-op cleanly via cardDeviceConfigured() when it
  // isn't, and this is what lets a card device configured LATER (typed into
  // Settings on a running process, e.g. rolling this app out to a new site
  // whose controller isn't wired up on day one) actually start connecting
  // without a restart, instead of only ever being armed at the moment the
  // process happened to start.
  if (cardDeviceConfigured()) connectCardDeviceWithRetry();
  // Periodic forced reconnect — see reconnectCardDevice's comment on why
  // this exists instead of reacting to a verified disconnect signal.
  setInterval(reconnectCardDevice, 6 * 60 * 60 * 1000); // every 6h

  await resolveDeviceWithRetry();
  syncEmployees();
  setInterval(syncEmployees, 30 * 60 * 1000); // every 30 min — catches renames/new hires
  restartPolling();
});
