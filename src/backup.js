// Periodic backup of the attendance database — the one thing on the site
// laptop that can't be re-created if the disk fails or the machine is lost.
// Keeps a rolling window of dated copies in data/backups/ so attendance and
// payroll history survives even a dead drive, not just a crash/reboot.
//
// Uses node:sqlite's own backup() (the SQLite "online backup API") rather
// than a plain file copy: the live db runs in WAL mode, where recent writes
// can sit in a separate -wal file rather than the main .db file yet, so a
// raw fs.copyFile of just the .db file can miss them or grab an
// inconsistent snapshot. The online backup API reads a consistent view of
// the whole database regardless of what's mid-flight in the WAL.

const path = require('path');
const fs = require('fs');
const sqlite = require('node:sqlite');
const { db, DB_PATH } = require('./db');
const logger = require('./logger');

const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const KEEP_BACKUPS = 14; // ~2 weeks of daily backups is enough to recover from "we noticed late"
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function pruneOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('attendance-') && f.endsWith('.db'))
    .sort(); // filenames are zero-padded timestamps, so lexical sort == chronological
  const excess = files.length - KEEP_BACKUPS;
  for (let i = 0; i < excess; i++) fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
}

async function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `attendance-${timestamp()}.db`);
  try {
    if (typeof sqlite.backup === 'function') {
      await sqlite.backup(db, dest);
    } else {
      // Older node:sqlite without backup() — checkpoint the WAL into the
      // main file first so a plain copy afterward is complete on its own.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(DB_PATH, dest);
    }
    logger.log(`[backup] wrote ${dest}`);
    pruneOldBackups();
  } catch (err) {
    logger.error('[backup] failed:', err.message);
  }
}

module.exports = { runBackup, BACKUP_DIR, BACKUP_INTERVAL_MS };
