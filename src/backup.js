// Periodic backup of everything on the site laptop that can't be
// re-created if the disk fails or the machine is lost: the attendance
// database (check-ins, employees, daily wages, settings) AND the worker
// photo library. Both live under data/, both go into data/backups/.
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
const { SNAPSHOT_DIR } = require('./snapshots');
const logger = require('./logger');

const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const SNAPSHOT_BACKUP_DIR = path.join(BACKUP_DIR, 'snapshots');
const BACKUP_INTERVAL_MS = 10 * 60_000; // every 10 minutes

// Ten-minute backups add up fast — 144/day, ~4,300/month — so "keep the
// last N" from the old once-a-day design doesn't translate directly (N=14
// would only cover 140 minutes). Two tiers instead: every backup from the
// last 24h is kept as-is (fine-grained, "recover from 10 minutes ago"),
// and beyond that only one backup per calendar day survives, for up to 30
// days (same 2-week-plus-margin spirit as the original daily design, just
// layered on top of much finer recent granularity).
const RECENT_WINDOW_MS = 24 * 60 * 60_000;
const DAILY_RETENTION_MS = 30 * 24 * 60 * 60_000;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function pruneOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('attendance-') && f.endsWith('.db'))
    .sort(); // filenames are zero-padded timestamps, so lexical sort == chronological
  const now = Date.now();
  const keptDays = new Set();
  const toDelete = [];
  // Walk newest-first so, within a day, the backup kept for the daily tier
  // is that day's most recent one, not its earliest.
  for (let i = files.length - 1; i >= 0; i--) {
    const f = files[i];
    let ageMs;
    try {
      ageMs = now - fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat — nothing to prune
    }
    if (ageMs <= RECENT_WINDOW_MS) continue; // fine-grained tier — always kept
    if (ageMs > DAILY_RETENTION_MS) { toDelete.push(f); continue; } // past even the daily tier
    const dayKey = f.slice('attendance-'.length, 'attendance-'.length + 10); // "YYYY-MM-DD"
    if (keptDays.has(dayKey)) toDelete.push(f);
    else keptDays.add(dayKey);
  }
  for (const f of toDelete) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

async function backupDatabase() {
  const dest = path.join(BACKUP_DIR, `attendance-${timestamp()}.db`);
  if (typeof sqlite.backup === 'function') {
    await sqlite.backup(db, dest);
  } else {
    // Older node:sqlite without backup() — checkpoint the WAL into the
    // main file first so a plain copy afterward is complete on its own.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(DB_PATH, dest);
  }
  pruneOldBackups();
}

// Mirrors SNAPSHOT_DIR into SNAPSHOT_BACKUP_DIR, copying only files that
// aren't already there — incremental, so a photo library that's grown over
// months doesn't get fully re-copied every 10 minutes, only whatever's new
// since the last run. Deliberately never deletes from the backup copy even
// if the source file is gone (a discarded pending capture, say) — the
// whole point of a backup is to survive loss on the live side, so it stays
// strictly additive.
function backupSnapshotsDir(srcDir, destDir, counts) {
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return; // no snapshots taken yet — nothing to mirror
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      backupSnapshotsDir(srcPath, destPath, counts);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
      counts.copied += 1;
    }
  }
}

async function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  try {
    await backupDatabase();
    const counts = { copied: 0 };
    backupSnapshotsDir(SNAPSHOT_DIR, SNAPSHOT_BACKUP_DIR, counts);
    logger.log(`[backup] database backed up${counts.copied ? `, ${counts.copied} new photo(s) copied` : ''}`);
  } catch (err) {
    logger.error('[backup] failed:', err.message);
  }
}

module.exports = { runBackup, BACKUP_DIR, BACKUP_INTERVAL_MS };
