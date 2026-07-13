// One-off / cron-able backfill: pulls AcsEvent history straight from the
// terminal for a date range and inserts any check-in events we don't already
// have (deduped by the device's own serialNo). Useful for the first run
// (there's no push history before the receiver existed) and as a safety net
// if this service was ever down while the terminal kept logging locally.
//
// Usage: npm run backfill [YYYY-MM-DD] [YYYY-MM-DD]   (defaults to today..today)

const db = require('../src/db');
const deviceClient = require('../src/deviceClient');
const { parseJsonEvent, isCheckin } = require('../src/hikParser');
const { isoWithOffset } = require('../src/time');
const { resolveDeviceIp } = require('../src/resolveDevice');

async function main() {
  // deviceClient talks to the terminal by IP, which — since discovery.js was
  // added — isn't necessarily known yet at process start (DEVICE_IP is now
  // commonly left blank to auto-discover). This script never went through
  // server.js's startup sequence, so without this it throws immediately:
  // "device IP not yet resolved". Confirmed by testing directly.
  await resolveDeviceIp();

  const [fromArg, toArg] = process.argv.slice(2);
  const from = fromArg ? new Date(`${fromArg}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0));
  const to = toArg ? new Date(`${toArg}T23:59:59`) : new Date(new Date().setHours(23, 59, 59, 999));

  console.log(`backfilling ${isoWithOffset(from)} .. ${isoWithOffset(to)}`);
  const infoList = await deviceClient.fetchEvents({ startTime: isoWithOffset(from), endTime: isoWithOffset(to) });

  let inserted = 0;
  for (const info of infoList) {
    // AcsEvent search results are already flat JSON (no AccessControllerEvent
    // wrapper like the push payload has) — parseJsonEvent's deep key search
    // handles both shapes fine.
    const parsed = parseJsonEvent(info);
    if (!isCheckin(parsed)) continue;
    if (db.insertCheckin(parsed, 'backfill')) inserted += 1;
  }
  console.log(`fetched ${infoList.length} event(s), inserted ${inserted} new check-in(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
