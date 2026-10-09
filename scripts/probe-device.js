// Standalone ISAPI compatibility probe for a device this app has NEVER
// talked to before (e.g. a different model at a different site, like the
// DS-K1T804 series vs. the DS-K1T343EWX this app was originally built
// against). Deliberately independent of deviceClient.js/deviceState.js --
// those are wired to THIS site's configured device via .env/DB settings,
// and a probe against a different device at a different IP has no business
// touching that state at all.
//
// Reuses digest.js (pure HTTP digest auth, no device-specific state) and
// hikParser.js (pure functions) directly, so this checks the exact same
// parsing logic the real app would use -- not a reimplementation that could
// quietly drift from it.
//
// Usage:
//   node scripts/probe-device.js <ip> <username> <password> [protocol] [days-back]
// Example:
//   node scripts/probe-device.js 192.168.100.15 admin 'secret123' http 7

const { digestRequest } = require('../src/digest');
const { parseJsonEvent, isCheckin } = require('../src/hikParser');

async function isapi(baseUrl, user, pass, method, path, jsonBody) {
  const res = await digestRequest({
    method,
    url: `${baseUrl}${path}`,
    username: user,
    password: pass,
    headers: jsonBody ? { 'Content-Type': 'application/json' } : {},
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });
  return res;
}

async function main() {
  const [ip, user, pass, protocol = 'http', daysBackArg = '7'] = process.argv.slice(2);
  if (!ip || !user || !pass) {
    console.error('Usage: node scripts/probe-device.js <ip> <username> <password> [protocol] [days-back]');
    process.exit(1);
  }
  const baseUrl = `${protocol}://${ip}`;
  const daysBack = Number(daysBackArg);

  console.log(`=== 1) basic reachability + identity: GET /ISAPI/System/deviceInfo ===`);
  try {
    const res = await isapi(baseUrl, user, pass, 'GET', '/ISAPI/System/deviceInfo?format=json');
    console.log(`HTTP ${res.status}`);
    console.log(res.text.slice(0, 2000));
  } catch (err) {
    console.error('FAILED:', err.message);
  }

  console.log(`\n=== 2) does this device support AcsEvent search at all? ===`);
  const now = new Date();
  const from = new Date(now.getTime() - daysBack * 24 * 3600_000);
  const iso = (d) => d.toISOString().replace('Z', '+00:00'); // close enough for a probe; the real app uses isoWithOffset's Georgia-local form
  let res;
  try {
    res = await isapi(baseUrl, user, pass, 'POST', '/ISAPI/AccessControl/AcsEvent?format=json', {
      AcsEventCond: {
        searchID: '1', searchResultPosition: 0, maxResults: 30, major: 0, minor: 0,
        startTime: iso(from), endTime: iso(now),
      },
    });
    console.log(`HTTP ${res.status}`);
  } catch (err) {
    console.error('FAILED:', err.message);
    return;
  }

  if (res.status !== 200) {
    console.log('Non-200 response -- this device may not support AcsEvent search the same way, or the path differs. Full body:');
    console.log(res.text.slice(0, 2000));
    return;
  }

  const doc = JSON.parse(res.text);
  const list = doc.AcsEvent?.InfoList || [];
  console.log(`totalMatches=${doc.AcsEvent?.totalMatches ?? '?'}  returned=${list.length}  (searched last ${daysBack} day(s))`);

  if (list.length === 0) {
    console.log('No events in that window -- try a longer --days-back, or trigger a real tap on the device right before running this.');
    return;
  }

  console.log(`\n=== 3) raw shape of the first event (exact JSON this device sends) ===`);
  console.log(JSON.stringify(list[0], null, 2));

  console.log(`\n=== 4) does our EXISTING parser (hikParser.js, unmodified) handle it? ===`);
  for (const [i, info] of list.slice(0, 5).entries()) {
    const parsed = parseJsonEvent(info);
    console.log(`event ${i}: isCheckin=${isCheckin(parsed)}  employeeNo=${parsed.employeeNo}  name=${parsed.name}  cardNo=${parsed.cardNo}  readerNo=${parsed.readerNo}  doorNo=${parsed.doorNo}  verifyMode=${parsed.verifyMode}  eventTime=${parsed.eventTime}`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
