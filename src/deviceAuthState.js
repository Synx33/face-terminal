// Tracks whether the device is currently rejecting our credentials (HTTP
// 401), so callers can back off instead of hammering it with failed logins.
//
// Why this exists: the poller hits the device every ~1.5s. Before this, a
// 401 was treated exactly like any other transient error — retried at the
// same 1.5s cadence forever. If credentials are ever actually wrong (a typo
// via Settings, or the device's own password changed independently), that
// meant hundreds of failed login attempts per few minutes with no backoff
// at all. Confirmed firsthand on the real device: even a SINGLE failed
// login attempt triggered a ~26-minute admin-login lockout — continuing to
// retry every 1.5s into that lockout window at best does nothing, at worst
// risks extending it further. Once we see a 401, stop trying automatically
// for a long cool-down window instead.

const logger = require('./logger');

const BACKOFF_MS = 10 * 60_000; // 10 min between automatic retries once auth is known to be failing

let backoffUntil = 0;
let consecutiveFailures = 0;

function isBackedOff() {
  return Date.now() < backoffUntil;
}

function recordAuthFailure() {
  const enteringBackoff = !isBackedOff();
  consecutiveFailures += 1;
  backoffUntil = Date.now() + BACKOFF_MS;
  // Log once on the transition into backoff, not on every skipped tick
  // afterward — that would just be a different flavor of the same spam.
  if (enteringBackoff) {
    logger.error(`[auth] device rejected credentials (401) — pausing automatic requests for ${BACKOFF_MS / 60_000} min to avoid hammering a possible lockout. Fix credentials in Settings to retry immediately.`);
  }
}

function recordAuthSuccess() {
  if (consecutiveFailures > 0) {
    logger.log('[auth] device is accepting credentials again — resuming normal polling');
  }
  consecutiveFailures = 0;
  backoffUntil = 0;
}

// Called when the user explicitly saves new credentials from Settings —
// gives the new value an immediate fresh attempt on the very next poll tick
// instead of waiting out a backoff window that was set for the OLD (wrong)
// credentials.
function resetBackoff() {
  backoffUntil = 0;
}

function status() {
  return { failing: isBackedOff(), consecutiveFailures, retryAt: backoffUntil || null };
}

module.exports = { isBackedOff, recordAuthFailure, recordAuthSuccess, resetBackoff, status };
