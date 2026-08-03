// Polls AcsEvent search for new events instead of relying on the device's
// httpHosts push mechanism.
//
// Why not push: arming httpHosts on this terminal caused it to flood us
// with tens of thousands of "operation" log entries (major=3) timestamped
// back in March 2025 — an unrelated historical backlog, not real-time
// verification events. Zero real (major=5, named) events showed up in that
// flood even after a live face scan. Polling AcsEvent directly is the same
// call already proven correct in backfill.js: ask for a narrow time window,
// insert deduped by the device's own serialNo. Slower to notice a scan
// (poll interval, not instant push) but actually delivers the data.

const db = require('./db');
const deviceClient = require('./deviceClient');
const { parseJsonEvent, isCheckin } = require('./hikParser');
const { isoWithOffset } = require('./time');
const logger = require('./logger');
const authState = require('./deviceAuthState');

// Small overlap on every poll so a slow tick never loses an event at the
// window boundary — duplicates are harmless, insertCheckin dedupes by serialNo.
const OVERLAP_MS = 5_000;

// The device's clock isn't reliably synced to this host's (observed running
// ~1 minute ahead during testing, and its "operation" log timestamps were
// off by over a year in another context entirely). AcsEvent search excludes
// anything past our requested `endTime`, so if we bound the query by our own
// wall-clock "now", an event the device stamps slightly in the future
// (relative to us) gets silently skipped until our clock catches up — a
// real event that just happened would sit invisible for ~a minute. Padding
// `to` past our own "now" closes that gap; the device just won't have
// anything past its actual real time regardless of how far we ask.
const CLOCK_SKEW_BUFFER_MS = 3 * 60_000;

let lastPolledThrough = new Date(Date.now() - 60_000); // 60s lookback at boot

async function pollOnce(onNewCheckin) {
  const from = new Date(lastPolledThrough.getTime() - OVERLAP_MS);
  const now = new Date();
  const to = new Date(now.getTime() + CLOCK_SKEW_BUFFER_MS);
  // Advance the high-water mark by REAL elapsed time, not by the
  // future-padded `to`. Setting it to `to` was the actual bug: every tick
  // after the first re-derived `from` from an already-future-shifted value,
  // so the query window permanently drifted to a fixed ~3 minutes ahead of
  // real time from the second tick onward — a window where no real event
  // could ever land yet. Only the very first tick after each restart (which
  // starts from this real, unbuffered `lastPolledThrough` seed) ever worked;
  // every tick after that was chasing a horizon it could never reach.
  lastPolledThrough = now;

  const infoList = await deviceClient.fetchEvents({
    startTime: isoWithOffset(from),
    endTime: isoWithOffset(to),
  });

  for (const info of infoList) {
    const parsed = parseJsonEvent(info);
    if (!isCheckin(parsed)) continue;
    const inserted = db.insertCheckin(parsed, 'poll');
    if (inserted && onNewCheckin) {
      const row = db.listCheckins({ limit: 1 })[0];
      onNewCheckin(row);
    }
  }
}

function startPolling(intervalMs, onNewCheckin, onPollError) {
  // setInterval doesn't wait for an async callback to finish, so without this
  // guard a slow/stuck poll would pile up concurrent overlapping calls, all
  // racing on the shared lastPolledThrough — this is what actually happened
  // in production (paired with the digest.js timeout fix): one request
  // apparently stalled, and every subsequent tick queued up behind it
  // instead of erroring, silently freezing new check-ins out for ~30
  // minutes with nothing in the logs to show why.
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    // Skip this tick entirely (no request attempted at all, no error/success
    // callback fired) while we already know the device is rejecting our
    // credentials — retrying every intervalMs into a known-bad-auth state
    // would just be the same hammering this backoff exists to prevent, and
    // it wouldn't tell forceRediscover() anything useful either (the device
    // is reachable at its current IP, it's just rejecting the password).
    if (authState.isBackedOff()) return;
    inFlight = true;
    pollOnce(onNewCheckin)
      .then(() => onPollError && onPollError(null))
      .catch((err) => {
        logger.error('poll failed:', err.message);
        if (onPollError) onPollError(err);
      })
      .finally(() => { inFlight = false; });
  };
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { pollOnce, startPolling };
