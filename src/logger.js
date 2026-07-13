// The app owns this log file directly (unlike relying on systemd's
// StandardOutput=append, which only root can clear and which doesn't exist
// at all on Windows). That makes it clearable from the dashboard UI and
// identical across platforms — needed since this runs under systemd+NSSM
// on Linux and NSSM alone on Windows.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.FACE_TERMINAL_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG_PATH = path.join(DATA_DIR, 'app.log');

// Simple size-based rotation so the file can't grow unbounded if nobody
// ever clears it — keeps one previous copy, nothing fancier is needed here.
const MAX_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
    }
  } catch {
    // file doesn't exist yet — nothing to rotate
  }
}

function write(prefix, args) {
  rotateIfNeeded();
  const line = `[${new Date().toISOString()}] ${prefix}${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  fs.appendFileSync(LOG_PATH, line);
}

function log(...args) {
  console.log(...args);
  write('', args);
}

function error(...args) {
  console.error(...args);
  write('ERROR ', args);
}

function clearLog() {
  fs.writeFileSync(LOG_PATH, '');
  try { fs.rmSync(`${LOG_PATH}.1`, { force: true }); } catch { /* fine if it never existed */ }
}

function readLog(maxBytes = 200_000) {
  if (!fs.existsSync(LOG_PATH)) return '';
  const stat = fs.statSync(LOG_PATH);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(LOG_PATH, 'r');
  const buffer = Buffer.alloc(stat.size - start);
  fs.readSync(fd, buffer, 0, buffer.length, start);
  fs.closeSync(fd);
  return buffer.toString('utf8');
}

module.exports = { log, error, clearLog, readLog, LOG_PATH };
