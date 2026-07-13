const fs = require('fs');
const path = require('path');
const { GEORGIA_OFFSET_HOURS } = require('./time');

const SNAPSHOT_DIR = process.env.FACE_TERMINAL_SNAPSHOTS
  || path.join(process.env.FACE_TERMINAL_DATA || path.join(__dirname, '..', 'data'), 'snapshots');

// Georgia time, not this machine's configured timezone — same reasoning as
// time.js: don't want photo folders filed under the wrong date just because
// whoever set up the laptop didn't change its OS timezone.
function georgiaParts(date) {
  const shifted = new Date(date.getTime() + GEORGIA_OFFSET_HOURS * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year: String(shifted.getUTCFullYear()),
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate()),
    hour: pad(shifted.getUTCHours()),
    minute: pad(shifted.getUTCMinutes()),
    second: pad(shifted.getUTCSeconds()),
  };
}

/** Saves a JPEG buffer under SNAPSHOT_DIR/YYYY/MM/DD/, returns the path relative to SNAPSHOT_DIR (URL-usable). */
function saveSnapshot(buffer, { employeeNo, serialNo }) {
  const p = georgiaParts(new Date());
  const subdir = path.join(SNAPSHOT_DIR, p.year, p.month, p.day);
  fs.mkdirSync(subdir, { recursive: true });
  const filename = `${p.hour}${p.minute}${p.second}_${employeeNo || 'unknown'}_${serialNo}.jpg`;
  const fullPath = path.join(subdir, filename);
  fs.writeFileSync(fullPath, buffer);
  return path.relative(SNAPSHOT_DIR, fullPath).split(path.sep).join('/');
}

/** Saves a pending-worker capture under SNAPSHOT_DIR/pending/, returns the path relative to SNAPSHOT_DIR. */
function savePendingSnapshot(buffer) {
  const subdir = path.join(SNAPSHOT_DIR, 'pending');
  fs.mkdirSync(subdir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const fullPath = path.join(subdir, filename);
  fs.writeFileSync(fullPath, buffer);
  return path.relative(SNAPSHOT_DIR, fullPath).split(path.sep).join('/');
}

function deleteSnapshot(relativePath) {
  const fullPath = path.join(SNAPSHOT_DIR, relativePath);
  fs.rmSync(fullPath, { force: true });
}

module.exports = { SNAPSHOT_DIR, saveSnapshot, savePendingSnapshot, deleteSnapshot };
