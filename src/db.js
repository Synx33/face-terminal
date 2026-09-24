const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.FACE_TERMINAL_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'attendance.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    employee_no TEXT PRIMARY KEY,
    name        TEXT,
    updated_at  TEXT
  );

  -- Free-form key/value store for anything the client should be able to
  -- customize from the dashboard (site name, currency, poll interval,
  -- checkout-time boundary, ...) without editing .env or restarting anything.
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_no    INTEGER UNIQUE,
    event_time   TEXT,
    received_at  TEXT NOT NULL,
    employee_no  TEXT,
    name         TEXT,
    verify_mode  TEXT,
    door_no      INTEGER,
    major_event  INTEGER,
    minor_event  INTEGER,
    source       TEXT NOT NULL,
    raw          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_checkins_event_time ON checkins(event_time);
  CREATE INDEX IF NOT EXISTS idx_checkins_employee   ON checkins(employee_no);

  -- Captured-but-not-yet-named faces: the "scan first, name later" enrollment
  -- flow. A row here means someone stood in front of the terminal and an
  -- admin hit "capture", but no employeeNo/name exists on the device yet.
  CREATE TABLE IF NOT EXISTS pending_workers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    picture_path TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  -- Same "capture first, name later" idea as pending_workers, but for the
  -- DS-K2802 card reader: a row is created the instant someone presses
  -- "wait for card" (card_no still NULL), and gets filled in by the next
  -- real swipe onCardEvent() sees while this row is the oldest unfilled one
  -- -- see server.js's findArmedPendingCard()/onCardEvent. Kept as its own
  -- table rather than reusing pending_workers because there's no photo here
  -- and the row can legitimately sit around with card_no still NULL for a
  -- while (waiting for the physical tap), unlike a pending_workers row which
  -- always has its picture_path from the moment it's created.
  CREATE TABLE IF NOT EXISTS pending_cards (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    card_no    TEXT,
    created_at TEXT NOT NULL
  );

  -- Dashboard login accounts. Permissions are plain boolean flags rather
  -- than a role-name lookup table -- there are exactly four capabilities
  -- this app has (view / edit / add / remove) and they don't compose into
  -- anything more complex than "which of these four can this person do",
  -- so a lookup table would just be indirection with nothing behind it.
  -- is_admin is separate from (not implied by combining) the four flags --
  -- it specifically means "can manage OTHER accounts", which none of the
  -- four on their own should ever grant.
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    can_view      INTEGER NOT NULL DEFAULT 1,
    can_edit      INTEGER NOT NULL DEFAULT 0,
    can_add       INTEGER NOT NULL DEFAULT 0,
    can_remove    INTEGER NOT NULL DEFAULT 0,
    can_export    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );

  -- Session tokens live in the DB (not just memory) so a service restart
  -- doesn't silently log everyone out. No foreign key on user_id --
  -- node:sqlite's FK enforcement needs PRAGMA foreign_keys=ON, which isn't
  -- set here, so integrity is kept explicitly in application code instead
  -- (auth.js deletes a user's sessions when that user is removed).
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

// picture_path was added after the table already existed in production —
// ALTER TABLE ADD COLUMN errors if the column is already there, so guard it.
const existingCols = db.prepare('PRAGMA table_info(checkins)').all().map((c) => c.name);
if (!existingCols.includes('picture_path')) {
  db.exec('ALTER TABLE checkins ADD COLUMN picture_path TEXT');
}

// device_id was added when a second physical device (a DS-K2802 card-reader
// controller, alongside the original DS-K1T343EWX face terminal) entered the
// picture. `serial_no` is a monotonic counter the DEVICE assigns, not
// globally unique across devices — two independent devices' counters will
// eventually produce the same number by coincidence. The original schema's
// bare `serial_no INTEGER UNIQUE` would silently drop a real event from one
// device just because the other device had already used that same number,
// which is a real, if rare, correctness bug once a second device exists.
// SQLite can't ALTER a column-level UNIQUE constraint away, so this rebuilds
// the table (rename, recreate with a composite UNIQUE(device_id, serial_no),
// copy every row across tagged 'face' — the only device that has EVER
// written to this table before this migration existed, so that tag is exact
// for 100% of pre-existing data, not a guess). AUTOINCREMENT's sequence
// counter tracks the highest ROWID ever inserted regardless of whether the
// ROWID was explicit or auto-assigned, so copying rows with their original
// ids preserves the id sequence correctly — verified directly against a copy
// of the real production DB before shipping this (fresh inserts afterward
// get ids past the old max, no collision, and a same-device duplicate
// serial_no is still correctly ignored while a cross-device one is not).
if (!existingCols.includes('device_id')) {
  db.exec(`
    ALTER TABLE checkins RENAME TO checkins_old;
    CREATE TABLE checkins (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id    TEXT NOT NULL DEFAULT 'face',
      serial_no    INTEGER,
      event_time   TEXT,
      received_at  TEXT NOT NULL,
      employee_no  TEXT,
      name         TEXT,
      verify_mode  TEXT,
      door_no      INTEGER,
      major_event  INTEGER,
      minor_event  INTEGER,
      source       TEXT NOT NULL,
      raw          TEXT,
      picture_path TEXT,
      UNIQUE(device_id, serial_no)
    );
    INSERT INTO checkins (id, device_id, serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, major_event, minor_event, source, raw, picture_path)
      SELECT id, 'face', serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, major_event, minor_event, source, raw, picture_path FROM checkins_old;
    DROP TABLE checkins_old;
    CREATE INDEX IF NOT EXISTS idx_checkins_event_time ON checkins(event_time);
    CREATE INDEX IF NOT EXISTS idx_checkins_employee ON checkins(employee_no);
  `);
}

// daily_wage was added after employees already existed in production — same
// ALTER TABLE guard as picture_path above.
const existingEmployeeCols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
if (!existingEmployeeCols.includes('daily_wage')) {
  db.exec('ALTER TABLE employees ADD COLUMN daily_wage REAL');
}

// card_no: the employee's card number on the DS-K2802 card-reader controller
// (distinct from employee_no, which is this app's/the face terminal's own
// numbering — a card's number is whatever's physically encoded on it). NULL
// for anyone not issued a card yet. The partial unique index (only over
// non-NULL values) stops two employees from accidentally being assigned the
// same physical card while still allowing any number of employees to have
// no card at all.
if (!existingEmployeeCols.includes('card_no')) {
  db.exec('ALTER TABLE employees ADD COLUMN card_no TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_card_no ON employees(card_no) WHERE card_no IS NOT NULL');
}

// can_export was added after some sites already had real accounts created --
// same ALTER-if-missing pattern as card_no above. Defaults to 0 (off) for
// existing accounts on upgrade -- an admin explicitly turns it on per
// person rather than every pre-existing account silently gaining a new
// capability the moment this code ships.
const existingUserCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!existingUserCols.includes('can_export')) {
  db.exec('ALTER TABLE users ADD COLUMN can_export INTEGER NOT NULL DEFAULT 0');
}

// direction_override: a manual in/out correction for one specific checkin
// row. Exists because the direction shown for a scan is normally GUESSED
// from wall-clock time (see periodOf() below) -- fine for a single reader,
// but at a site with a separate physical entry reader and exit reader
// wired to the same DS-K2802 controller, that guess can be wrong (both
// readers can fire after the checkout boundary and both get labeled
// "out"). Confirmed live and by two independent methods that this
// controller's firmware (2019, "Value Series") does not report which
// physical reader a swipe came from anywhere in its alarm payload -- see
// cardSdk.js's byAlarmInfoType comment -- so there is no byte to decode
// here; a human correcting the occasional wrong label is the only
// reliable fix available for this hardware. NULL (the default) means
// "still just the time-based guess".
const existingCheckinCols = db.prepare('PRAGMA table_info(checkins)').all().map((c) => c.name);
if (!existingCheckinCols.includes('direction_override')) {
  db.exec('ALTER TABLE checkins ADD COLUMN direction_override TEXT');
}

const upsertEmployeeStmt = db.prepare(`
  INSERT INTO employees (employee_no, name, daily_wage, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(employee_no) DO UPDATE SET
    name = excluded.name,
    daily_wage = COALESCE(excluded.daily_wage, employees.daily_wage),
    updated_at = excluded.updated_at
`);

// dailyWage is optional (device sync and plain enrollment don't know about
// it) — when omitted, COALESCE above leaves whatever wage is already on
// file untouched instead of clobbering it back to NULL.
function upsertEmployee(employeeNo, name, dailyWage) {
  if (!employeeNo) return;
  upsertEmployeeStmt.run(String(employeeNo), name || null, dailyWage ?? null, new Date().toISOString());
}

function employeeName(employeeNo) {
  if (!employeeNo) return null;
  const row = db.prepare('SELECT name FROM employees WHERE employee_no = ?').get(String(employeeNo));
  return row ? row.name : null;
}

function listEmployees() {
  return db.prepare(`
    SELECT e.employee_no, e.name, e.daily_wage, e.updated_at, e.card_no,
      (SELECT c.picture_path FROM checkins c
       WHERE c.employee_no = e.employee_no AND c.picture_path IS NOT NULL
       ORDER BY c.event_time DESC LIMIT 1) AS picture_path
    FROM employees e
    ORDER BY e.name COLLATE NOCASE ASC
  `).all();
}

function setEmployeeWage(employeeNo, dailyWage) {
  db.prepare('UPDATE employees SET daily_wage = ?, updated_at = ? WHERE employee_no = ?')
    .run(dailyWage ?? null, new Date().toISOString(), String(employeeNo));
}

// Card-only workers (enrolled straight from a captured card via the
// pending-cards claim flow, never touching the face terminal at all) get
// an employee_no in this app's own "C<n>" namespace instead of one minted
// by the face terminal's deviceClient.nextEmployeeNo() -- deliberately
// disjoint from that scheme (which only ever hands out plain digit
// strings), so the two numbering sources can never collide and callers
// can tell which kind of employee they're looking at from the ID alone,
// no separate column needed. See server.js's rename/delete routes, which
// branch on this to skip a face-terminal ISAPI call entirely for these.
const CARD_ONLY_PREFIX = 'C';

function isCardOnlyEmployeeNo(employeeNo) {
  return typeof employeeNo === 'string' && employeeNo.startsWith(CARD_ONLY_PREFIX);
}

function nextLocalEmployeeNo() {
  const rows = db.prepare("SELECT employee_no FROM employees WHERE employee_no LIKE 'C%'").all();
  const nums = rows.map((r) => parseInt(r.employee_no.slice(1), 10)).filter(Number.isFinite);
  return CARD_ONLY_PREFIX + String((nums.length ? Math.max(...nums) : 0) + 1);
}

/** Assigns (or clears, with cardNo=null) the physical card number an employee's DS-K2802 swipes resolve to. Throws on a card already assigned to someone else (the partial unique index on employees.card_no) — the caller should surface that as a real error, not silently overwrite who a card belongs to. */
function setEmployeeCard(employeeNo, cardNo) {
  db.prepare('UPDATE employees SET card_no = ?, updated_at = ? WHERE employee_no = ?')
    .run(cardNo ? String(cardNo) : null, new Date().toISOString(), String(employeeNo));
}

function employeeByCard(cardNo) {
  if (!cardNo) return null;
  return db.prepare('SELECT employee_no, name, card_no FROM employees WHERE card_no = ?').get(String(cardNo));
}

/** Removes the employee from the local roster only — caller is responsible for removing them on the device too. Attendance history is kept (it's a historical record, not tied to whether they're still active). */
function deleteEmployeeLocal(employeeNo) {
  db.prepare('DELETE FROM employees WHERE employee_no = ?').run(String(employeeNo));
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row && row.value !== null ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// "HH:MM" 24-hour boundary — scans before this are the day's "in", scans at
// or after it are "out". Kept as a zero-padded string (not minutes-since-
// midnight or similar) specifically so it can be compared directly against
// the "HH:MM" slice of a stored event_time with a plain string comparison
// ("09:00" < "18:30" < "23:59" sorts correctly character-by-character for
// same-length zero-padded values) -- no time-of-day math needed anywhere.
function getCheckoutAfter() {
  return getSetting('checkout_after', process.env.CHECKOUT_AFTER || '19:00');
}

function getPollIntervalMs() {
  return Number(getSetting('poll_interval_ms', process.env.POLL_INTERVAL_MS || 5000));
}

const insertCheckinStmt = db.prepare(`
  INSERT OR IGNORE INTO checkins
    (device_id, serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, major_event, minor_event, source, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// A card-only event (DS-K2802) may arrive with a cardNo but no employeeNo of
// its own — resolve it locally via the employee that card is assigned to
// (setEmployeeCard below), same idea as employeeName() resolving a name for
// an event that only carried an employeeNo.
function employeeNoForCard(cardNo) {
  if (!cardNo) return null;
  const row = db.prepare('SELECT employee_no FROM employees WHERE card_no = ?').get(String(cardNo));
  return row ? row.employee_no : null;
}

/** Returns the new row's id, or null if it was a duplicate (device_id, serialNo) pair (nothing inserted). deviceId defaults to 'face' — the original/only device before a second one existed. */
function insertCheckin(ev, source, deviceId = 'face') {
  const employeeNo = ev.employeeNo || employeeNoForCard(ev.cardNo);
  const name = ev.name || employeeName(employeeNo);
  const result = insertCheckinStmt.run(
    deviceId,
    ev.serialNo ?? null,
    ev.eventTime ?? null,
    new Date().toISOString(),
    employeeNo ?? null,
    name ?? null,
    ev.verifyMode ?? null,
    ev.doorNo ?? null,
    ev.majorEvent ?? null,
    ev.minorEvent ?? null,
    source,
    ev.raw ?? null,
  );
  return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}

const setPictureStmt = db.prepare('UPDATE checkins SET picture_path = ? WHERE id = ?');
/** Attaches a snapshot path to an already-inserted checkin (captured asynchronously, shortly after). */
function setCheckinPicture(id, picturePath) {
  setPictureStmt.run(picturePath, id);
}

function getCheckinById(id) {
  return db.prepare(`
    SELECT id, device_id, serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, source, picture_path
    FROM checkins WHERE id = ?
  `).get(id);
}

// Direction (check-in/check-out) isn't a device concept on this terminal --
// it's a single reader with no in/out mode selector. Derived by wall-clock
// time instead of scan order: every scan before the configured
// getCheckoutAfter() boundary (default 19:00) is "in", everything at or
// after it is "out". A person can walk past the camera any number of times
// during the day -- lunch, stepping out, whatever -- and every one of those
// scans stays labeled "in" and collapses into the SAME displayed row, not a
// new one; only the first scan at or after the boundary starts the "out"
// row. This deliberately replaced an earlier short-gap "debounce" design
// (same employee within N seconds = same session): that only caught
// near-simultaneous double-scans, not "recognized again three hours
// later", which is the actual all-day case this app needs to handle.
//
// The representative row for each (employee, day, in/out) group is always
// the EARLIEST scan in it (MIN(id)), not the latest -- the displayed time
// is "when they arrived" / "when they first left", and must stay fixed as
// more same-period scans come in, not drift forward to whatever the most
// recent walk-by happened to be.

/** Most recent OTHER checkin for this employee strictly before the given time -- used to decide if a new scan is still within the same in/out period as the last one. */
function priorCheckinForEmployee(employeeNo, beforeEventTime, excludeId) {
  if (!employeeNo) return null;
  return db.prepare(`
    SELECT id, event_time FROM checkins
    WHERE employee_no = ? AND event_time < ? AND id != ?
    ORDER BY event_time DESC LIMIT 1
  `).get(String(employeeNo), beforeEventTime, excludeId);
}

function periodOf(eventTime, boundary) {
  return eventTime.slice(11, 16) < boundary ? 'in' : 'out';
}

/** Manually corrects the in/out label for one checkin row -- see the
 * direction_override migration comment above for why this exists at all.
 * direction must be 'in' or 'out'; null clears the override and goes back
 * to the time-based guess. */
function setCheckinDirectionOverride(id, direction) {
  db.prepare('UPDATE checkins SET direction_override = ? WHERE id = ?').run(direction, id);
}

/** True if this scan falls in the same day + in/out period as the employee's previous scan (nothing new to show -- still the same visit). */
function isSameSession(employeeNo, eventTime, excludeId) {
  const prior = priorCheckinForEmployee(employeeNo, eventTime, excludeId);
  if (!prior) return false;
  if (eventTime.slice(0, 10) !== prior.event_time.slice(0, 10)) return false; // different calendar day
  const boundary = getCheckoutAfter();
  return periodOf(eventTime, boundary) === periodOf(prior.event_time, boundary);
}

function listCheckins({ date, employeeNo, limit = 200 } = {}) {
  let sql = `
    WITH scoped AS (
      SELECT id, device_id, serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, source, picture_path, direction_override
      FROM checkins WHERE 1=1
  `;
  const params = [];
  if (date) {
    sql += ' AND substr(event_time, 1, 10) = ?';
    params.push(date);
  }
  if (employeeNo) {
    sql += ' AND employee_no = ?';
    params.push(String(employeeNo));
  }
  sql += `
    ),
    labeled AS (
      SELECT *,
        COALESCE(
          direction_override,
          CASE WHEN employee_no IS NULL THEN NULL
               WHEN substr(event_time, 12, 5) < ? THEN 'in'
               ELSE 'out'
          END
        ) AS direction
      FROM scoped
    )
    SELECT
      MIN(id) AS id, device_id, serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, source, picture_path,
      direction, direction_override
    FROM labeled
    -- COALESCE(direction, id): rows with no employee_no have a NULL
    -- direction, which would otherwise group every such row on the same
    -- day into one -- falling back to the row's own (unique) id keeps them
    -- ungrouped instead.
    --
    -- Card-reader rows (device_id='card') are deliberately grouped by their
    -- own id instead -- i.e. never collapsed with anything else. A face
    -- scan can passively re-trigger just from someone standing in the
    -- camera's view, so collapsing repeats down to one "in" and one "out"
    -- per day is the right call there; a card tap can't happen by accident
    -- the same way (it needs an actual physical tap), so every single one
    -- is a real, deliberate event that should show up on its own.
    GROUP BY CASE
      WHEN device_id = 'card' THEN 'card:' || id
      ELSE employee_no || ':' || substr(event_time, 1, 10) || ':' || COALESCE(direction, id)
    END
    ORDER BY event_time DESC LIMIT ?
  `;
  params.push(getCheckoutAfter(), limit);
  return db.prepare(sql).all(...params);
}

function stats() {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           COUNT(DISTINCT employee_no) AS people,
           MAX(received_at) AS last_event
    FROM checkins
  `).get();
  return row;
}

/** Wipes all check-in history (UI-triggered, e.g. clearing test data before real use). Employees are untouched. */
function clearCheckins() {
  db.exec('DELETE FROM checkins');
}

function insertPendingWorker(picturePath) {
  const result = db.prepare('INSERT INTO pending_workers (picture_path, created_at) VALUES (?, ?)')
    .run(picturePath, new Date().toISOString());
  return { id: Number(result.lastInsertRowid), picture_path: picturePath };
}

function listPendingWorkers() {
  return db.prepare('SELECT id, picture_path, created_at FROM pending_workers ORDER BY created_at ASC').all();
}

function getPendingWorker(id) {
  return db.prepare('SELECT id, picture_path, created_at FROM pending_workers WHERE id = ?').get(id);
}

function deletePendingWorker(id) {
  db.prepare('DELETE FROM pending_workers WHERE id = ?').run(id);
}

function insertPendingCard() {
  const result = db.prepare('INSERT INTO pending_cards (card_no, created_at) VALUES (NULL, ?)')
    .run(new Date().toISOString());
  return { id: Number(result.lastInsertRowid), card_no: null };
}

function listPendingCards() {
  return db.prepare('SELECT id, card_no, created_at FROM pending_cards ORDER BY created_at ASC').all();
}

function getPendingCard(id) {
  return db.prepare('SELECT id, card_no, created_at FROM pending_cards WHERE id = ?').get(id);
}

// Only ever fills in a still-empty row -- returns false (and touches
// nothing) if this row was already claimed/cancelled/filled between when
// the caller looked it up and now, so onCardEvent can't double-assign one
// physical swipe to two different in-flight pending captures.
function setPendingCardNo(id, cardNo) {
  const result = db.prepare('UPDATE pending_cards SET card_no = ? WHERE id = ? AND card_no IS NULL').run(cardNo, id);
  return result.changes > 0;
}

// The oldest still-unfilled capture -- "oldest" so that if an admin somehow
// starts a second capture before finishing the first (e.g. two browser tabs),
// the next real swipe resolves the older, presumably-still-open one first
// rather than an arbitrary one.
function findArmedPendingCard() {
  return db.prepare("SELECT id, card_no, created_at FROM pending_cards WHERE card_no IS NULL ORDER BY created_at ASC LIMIT 1").get();
}

function deletePendingCard(id) {
  db.prepare('DELETE FROM pending_cards WHERE id = ?').run(id);
}

// Daily-wage payroll: counts DISTINCT calendar days a person showed up at
// all in [start, end] (inclusive, "YYYY-MM-DD" strings) x their daily wage.
// Deliberately simple — no hours/overtime math, because the terminal has no
// concept of a shift, only scans. A day with one scan or ten still counts
// as one day worked, same as check-in/out direction already treats it.
// attended_dates: a sorted, comma-separated list of the actual calendar
// days counted in days_present -- a plain count is enough for the on-screen
// payroll table, but a proper exported report should let whoever's paying
// someone actually see and audit which days, not just trust a number. A
// correlated subquery (rather than pulling it from the same LEFT JOIN as
// days_present/total_pay) is what lets it come out pre-sorted -- SQLite's
// GROUP_CONCAT(DISTINCT ...) does not support ORDER BY and returns dates in
// an unspecified order otherwise.
function payroll({ start, end }) {
  return db.prepare(`
    SELECT e.employee_no, e.name, e.daily_wage,
      COUNT(DISTINCT substr(c.event_time, 1, 10)) AS days_present,
      COUNT(DISTINCT substr(c.event_time, 1, 10)) * COALESCE(e.daily_wage, 0) AS total_pay,
      (
        SELECT GROUP_CONCAT(d, ', ') FROM (
          SELECT DISTINCT substr(c2.event_time, 1, 10) AS d
          FROM checkins c2
          WHERE c2.employee_no = e.employee_no
            AND substr(c2.event_time, 1, 10) BETWEEN ? AND ?
          ORDER BY d
        )
      ) AS attended_dates
    FROM employees e
    LEFT JOIN checkins c
      ON c.employee_no = e.employee_no
     AND substr(c.event_time, 1, 10) BETWEEN ? AND ?
    GROUP BY e.employee_no
    ORDER BY e.name COLLATE NOCASE ASC
  `).all(start, end, start, end);
}

// --- user accounts + sessions -------------------------------------------------
// Plain data-access functions -- password hashing/verification and session
// token generation live in auth.js, not here, same separation as the rest
// of this file (db.js never knows about HTTP/cookies, auth.js never writes
// raw SQL).

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function createUser({ username, passwordHash, isAdmin = false, canView = true, canEdit = false, canAdd = false, canRemove = false, canExport = false }) {
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, is_admin, can_view, can_edit, can_add, can_remove, can_export, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(username, passwordHash, isAdmin ? 1 : 0, canView ? 1 : 0, canEdit ? 1 : 0, canAdd ? 1 : 0, canRemove ? 1 : 0, canExport ? 1 : 0, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// Excludes password_hash -- this is what the admin panel's user list uses,
// which sends its response straight to the browser.
function listUsers() {
  return db.prepare(`
    SELECT id, username, is_admin, can_view, can_edit, can_add, can_remove, can_export, created_at
    FROM users ORDER BY username COLLATE NOCASE ASC
  `).all();
}

function updateUserPermissions(id, { isAdmin, canView, canEdit, canAdd, canRemove, canExport }) {
  db.prepare(`
    UPDATE users SET is_admin = ?, can_view = ?, can_edit = ?, can_add = ?, can_remove = ?, can_export = ? WHERE id = ?
  `).run(isAdmin ? 1 : 0, canView ? 1 : 0, canEdit ? 1 : 0, canAdd ? 1 : 0, canRemove ? 1 : 0, canExport ? 1 : 0, id);
}

function updateUserPassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

function deleteUser(id) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function createSession(token, userId, expiresAt) {
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, new Date().toISOString(), expiresAt);
}

// One query, not two -- joins straight to the owning user so a request
// carrying a session cookie only ever costs a single lookup.
function getSessionWithUser(token) {
  return db.prepare(`
    SELECT s.token, s.expires_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function deleteSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function pruneExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

module.exports = {
  db, upsertEmployee, employeeName, insertCheckin, listCheckins, stats, clearCheckins, DB_PATH,
  setCheckinPicture, getCheckinById, isSameSession, periodOf, setCheckinDirectionOverride, getCheckoutAfter, getPollIntervalMs,
  insertPendingWorker, listPendingWorkers, getPendingWorker, deletePendingWorker,
  listEmployees, setEmployeeWage, deleteEmployeeLocal, getSetting, setSetting, payroll,
  setEmployeeCard, employeeByCard, isCardOnlyEmployeeNo, nextLocalEmployeeNo,
  insertPendingCard, listPendingCards, getPendingCard, setPendingCardNo, findArmedPendingCard, deletePendingCard,
  countUsers, createUser, getUserByUsername, getUserById, listUsers, updateUserPermissions, updateUserPassword, deleteUser,
  createSession, getSessionWithUser, deleteSession, deleteSessionsForUser, pruneExpiredSessions,
};
