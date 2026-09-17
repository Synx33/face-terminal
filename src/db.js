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
      SELECT id, device_id, serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, source, picture_path
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
        CASE WHEN employee_no IS NULL THEN NULL
             WHEN substr(event_time, 12, 5) < ? THEN 'in'
             ELSE 'out'
        END AS direction
      FROM scoped
    )
    SELECT
      MIN(id) AS id, device_id, serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, source, picture_path,
      direction
    FROM labeled
    -- COALESCE(direction, id): rows with no employee_no have a NULL
    -- direction, which would otherwise group every such row on the same
    -- day into one -- falling back to the row's own (unique) id keeps them
    -- ungrouped instead.
    GROUP BY employee_no, substr(event_time, 1, 10), COALESCE(direction, id)
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
function payroll({ start, end }) {
  return db.prepare(`
    SELECT e.employee_no, e.name, e.daily_wage,
      COUNT(DISTINCT substr(c.event_time, 1, 10)) AS days_present,
      COUNT(DISTINCT substr(c.event_time, 1, 10)) * COALESCE(e.daily_wage, 0) AS total_pay
    FROM employees e
    LEFT JOIN checkins c
      ON c.employee_no = e.employee_no
     AND substr(c.event_time, 1, 10) BETWEEN ? AND ?
    GROUP BY e.employee_no
    ORDER BY e.name COLLATE NOCASE ASC
  `).all(start, end);
}

module.exports = {
  db, upsertEmployee, employeeName, insertCheckin, listCheckins, stats, clearCheckins, DB_PATH,
  setCheckinPicture, getCheckinById, isSameSession, periodOf, getCheckoutAfter, getPollIntervalMs,
  insertPendingWorker, listPendingWorkers, getPendingWorker, deletePendingWorker,
  listEmployees, setEmployeeWage, deleteEmployeeLocal, getSetting, setSetting, payroll,
  setEmployeeCard, employeeByCard,
  insertPendingCard, listPendingCards, getPendingCard, setPendingCardNo, findArmedPendingCard, deletePendingCard,
};
