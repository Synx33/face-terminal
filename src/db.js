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
  -- debounce window, ...) without editing .env or restarting anything.
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
`);

// picture_path was added after the table already existed in production —
// ALTER TABLE ADD COLUMN errors if the column is already there, so guard it.
const existingCols = db.prepare('PRAGMA table_info(checkins)').all().map((c) => c.name);
if (!existingCols.includes('picture_path')) {
  db.exec('ALTER TABLE checkins ADD COLUMN picture_path TEXT');
}

// daily_wage was added after employees already existed in production — same
// ALTER TABLE guard as picture_path above.
const existingEmployeeCols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
if (!existingEmployeeCols.includes('daily_wage')) {
  db.exec('ALTER TABLE employees ADD COLUMN daily_wage REAL');
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
    SELECT e.employee_no, e.name, e.daily_wage, e.updated_at,
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

function getDebounceSeconds() {
  return Number(getSetting('debounce_seconds', process.env.CHECKIN_DEBOUNCE_SECONDS || 60));
}

function getPollIntervalMs() {
  return Number(getSetting('poll_interval_ms', process.env.POLL_INTERVAL_MS || 5000));
}

const insertCheckinStmt = db.prepare(`
  INSERT OR IGNORE INTO checkins
    (serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, major_event, minor_event, source, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/** Returns true if a new row was inserted (false if it was a duplicate serialNo). */
function insertCheckin(ev, source) {
  const name = ev.name || employeeName(ev.employeeNo);
  const result = insertCheckinStmt.run(
    ev.serialNo ?? null,
    ev.eventTime ?? null,
    new Date().toISOString(),
    ev.employeeNo ?? null,
    name ?? null,
    ev.verifyMode ?? null,
    ev.doorNo ?? null,
    ev.majorEvent ?? null,
    ev.minorEvent ?? null,
    source,
    ev.raw ?? null,
  );
  return result.changes > 0;
}

const setPictureStmt = db.prepare('UPDATE checkins SET picture_path = ? WHERE id = ?');
/** Attaches a snapshot path to an already-inserted checkin (captured asynchronously, shortly after). */
function setCheckinPicture(id, picturePath) {
  setPictureStmt.run(picturePath, id);
}

function getCheckinById(id) {
  return db.prepare(`
    SELECT id, serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, source, picture_path
    FROM checkins WHERE id = ?
  `).get(id);
}

// A face terminal gets scanned more than once per actual visit — someone
// unsure if it registered scans again, or the camera catches the same face
// twice in quick succession. Treated naively (every scan flips in/out),
// that turns one real visit into a spurious in/out/in flicker. Instead,
// scans by the same employee within the debounce window of each other
// collapse into a single "session": only a gap bigger than the threshold
// starts a new one, and direction alternates per session, not per raw scan.
// Every raw scan still gets its own row in the table (nothing is
// discarded), this only affects how they're grouped/labeled for display.
// The window itself is customizable live from Settings (getDebounceSeconds
// above), so it's read fresh on every call rather than frozen at startup.

/** Most recent OTHER checkin for this employee strictly before the given time — used to decide if a new scan starts a new session or continues one. */
function priorCheckinForEmployee(employeeNo, beforeEventTime, excludeId) {
  if (!employeeNo) return null;
  return db.prepare(`
    SELECT id, event_time FROM checkins
    WHERE employee_no = ? AND event_time < ? AND id != ?
    ORDER BY event_time DESC LIMIT 1
  `).get(String(employeeNo), beforeEventTime, excludeId);
}

/** True if this scan is close enough to the employee's previous one to be the same session (not a fresh check-in/out). */
function isSameSession(employeeNo, eventTime, excludeId) {
  const prior = priorCheckinForEmployee(employeeNo, eventTime, excludeId);
  if (!prior) return false;
  const gapSeconds = (new Date(eventTime) - new Date(prior.event_time)) / 1000;
  return gapSeconds >= 0 && gapSeconds <= getDebounceSeconds();
}

// Direction (check-in/check-out) isn't a device concept on this terminal —
// it's a single reader with no in/out mode selector, so we derive it: the
// 1st *session* of a given day for a given employee is "in", the 2nd is
// "out", and so on — where a session absorbs any repeat scans within
// DEBOUNCE_SECONDS. Each displayed row represents one session (the most
// recent scan in it, via SQLite's min/max "bare column" behavior — grouping
// by MAX(id) pulls every other column from that same row). Computed at
// query time via window functions, never stored, so it never needs a
// backfill/migration when the logic changes.
function listCheckins({ date, employeeNo, limit = 200 } = {}) {
  let sql = `
    WITH scoped AS (
      SELECT id, serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, source, picture_path
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
    lagged AS (
      SELECT *,
        LAG(event_time) OVER (
          PARTITION BY employee_no, substr(event_time, 1, 10)
          ORDER BY event_time
        ) AS prev_time
      FROM scoped
    ),
    sessioned AS (
      SELECT *,
        CASE WHEN employee_no IS NULL THEN NULL ELSE
          SUM(
            CASE
              WHEN prev_time IS NULL THEN 1
              WHEN (julianday(event_time) - julianday(prev_time)) * 86400.0 > ? THEN 1
              ELSE 0
            END
          ) OVER (
            PARTITION BY employee_no, substr(event_time, 1, 10)
            ORDER BY event_time
          )
        END AS session_no
      FROM lagged
    )
    SELECT
      MAX(id) AS id, serial_no, event_time, received_at, employee_no, name, verify_mode, door_no, source, picture_path,
      CASE WHEN employee_no IS NULL THEN NULL
           WHEN session_no % 2 = 1 THEN 'in' ELSE 'out' END AS direction
    FROM sessioned
    -- COALESCE(session_no, id): rows with no employee_no have a NULL
    -- session_no, which would otherwise group every such row on the same
    -- day into one — falling back to the row's own (unique) id keeps them
    -- ungrouped instead.
    GROUP BY employee_no, substr(event_time, 1, 10), COALESCE(session_no, id)
    ORDER BY event_time DESC LIMIT ?
  `;
  params.push(getDebounceSeconds(), limit);
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
  setCheckinPicture, getCheckinById, isSameSession, getDebounceSeconds, getPollIntervalMs,
  insertPendingWorker, listPendingWorkers, getPendingWorker, deletePendingWorker,
  listEmployees, setEmployeeWage, deleteEmployeeLocal, getSetting, setSetting, payroll,
};
