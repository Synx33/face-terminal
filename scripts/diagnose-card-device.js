// One-off diagnostic for the DS-K2802 card-reader controller (the second
// device added alongside the DS-K1T343EWX face terminal). Everything in
// cardDeviceClient.js except setCardForUser (the CardInfo/SetUp call that
// links a card number to an employeeNo) was built from the same ISAPI
// conventions already PROVEN correct against the face terminal — those
// should just work. setCardForUser is a guess at the standard Hikvision
// CardInfo shape, never tested against real hardware. This script:
//   1. Confirms basic connectivity + what the device actually says it is.
//   2. Probes CardInfo-related endpoints to nail down the real shape.
//   3. Exercises the ACTUAL integration functions (fetchAllUsers,
//      fetchEvents, createDeviceUser+setCardForUser against a disposable
//      throwaway test employee) so a real result — not just raw JSON — is
//      what tells you whether this is wired up correctly.
//
// Run from the install directory so .env (with CARD_DEVICE_MAC/IP/USER/PASS
// set) is picked up:
//   node --env-file=.env scripts\diagnose-card-device.js
//
// Safe to run repeatedly: the throwaway test employee it creates (if
// createDeviceUser succeeds) is deleted again at the end, success or not.

const { digestRequest } = require('../src/digest');
const { resolveCardDeviceIp } = require('../src/resolveCardDevice');
const { getCardDeviceIp } = require('../src/cardDeviceState');
const cardDeviceClient = require('../src/cardDeviceClient');

const CANDIDATES = [
  { method: 'GET', path: '/ISAPI/System/deviceInfo' },
  { method: 'GET', path: '/ISAPI/AccessControl/CardInfo/capabilities?format=json' },
  { method: 'POST', path: '/ISAPI/AccessControl/CardInfo/Search?format=json',
    body: { CardInfoSearchCond: { searchID: '1', searchResultPosition: 0, maxResults: 5 } } },
  { method: 'GET', path: '/ISAPI/AccessControl/UserInfo/capabilities?format=json' },
  { method: 'GET', path: '/ISAPI/AccessControl/capabilities?format=json' },
];

function protocol() {
  return process.env.CARD_DEVICE_PROTOCOL || process.env.DEVICE_PROTOCOL || 'http';
}

function credentials() {
  return {
    username: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER,
    password: process.env.CARD_DEVICE_PASS || process.env.DEVICE_PASS,
  };
}

async function probeEndpoints(ip) {
  console.log('--- raw ISAPI probes -------------------------------------------------');
  for (const c of CANDIDATES) {
    try {
      const res = await digestRequest({
        method: c.method,
        url: `${protocol()}://${ip}${c.path}`,
        ...credentials(),
        headers: c.body ? { 'Content-Type': 'application/json' } : {},
        body: c.body ? JSON.stringify(c.body) : undefined,
      });
      console.log('===', c.method, c.path, '-> HTTP', res.status, '===');
      console.log(res.text.slice(0, res.status < 400 ? 1500 : 200));
    } catch (err) {
      console.log('===', c.method, c.path, '-> FAILED:', err.message, '===');
    }
    console.log('');
  }
}

async function testIntegrationCode() {
  console.log('--- exercising the actual cardDeviceClient.js functions -------------');

  try {
    const users = await cardDeviceClient.fetchAllUsers();
    console.log(`fetchAllUsers() -> OK, ${users.length} enrolled user(s):`, users.slice(0, 5));
  } catch (err) {
    console.log('fetchAllUsers() -> FAILED:', err.message);
  }

  try {
    const from = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const to = new Date().toISOString();
    const events = await cardDeviceClient.fetchEvents({ startTime: from, endTime: to });
    console.log(`fetchEvents() over the last 24h -> OK, ${events.length} event(s). First one (if any):`);
    if (events[0]) console.log(JSON.stringify(events[0], null, 2).slice(0, 1000));
  } catch (err) {
    console.log('fetchEvents() -> FAILED:', err.message);
  }

  console.log('');
  console.log('--- testing setCardForUser against a disposable throwaway employee ---');
  const testEmployeeNo = `9${Date.now().toString().slice(-6)}`; // unlikely to collide
  const testCardNo = 'DIAGTEST01';
  try {
    await cardDeviceClient.createDeviceUser({ employeeNo: testEmployeeNo, name: 'diagnostic-test' });
    console.log(`createDeviceUser(#${testEmployeeNo}) -> OK`);
    try {
      const result = await cardDeviceClient.setCardForUser({ employeeNo: testEmployeeNo, cardNo: testCardNo });
      console.log('setCardForUser() -> OK:', JSON.stringify(result));
      console.log('>>> setCardForUser IS CORRECT AS WRITTEN. No changes needed in cardDeviceClient.js. <<<');
    } catch (err) {
      console.log('setCardForUser() -> FAILED:', err.message);
      console.log('>>> This confirms the endpoint/body shape needs fixing in cardDeviceClient.js.setCardForUser().');
      console.log('>>> Compare against the raw CardInfo probes above and Hikvision\'s ISAPI dev guide for the exact shape this firmware expects.');
    }
  } catch (err) {
    console.log(`createDeviceUser(#${testEmployeeNo}) -> FAILED, could not even test setCardForUser:`, err.message);
  } finally {
    try {
      await cardDeviceClient.deleteDeviceUser(testEmployeeNo);
      console.log(`cleaned up: deleted throwaway test employee #${testEmployeeNo}`);
    } catch (err) {
      console.log(`WARNING: could not clean up throwaway test employee #${testEmployeeNo} — remove it manually:`, err.message);
    }
  }
}

async function main() {
  await resolveCardDeviceIp();
  const ip = getCardDeviceIp();
  console.log('card device IP:', ip);
  console.log('');

  await probeEndpoints(ip);
  await testIntegrationCode();
}

main().catch((err) => { console.error('diagnostic script failed:', err.message); process.exit(1); });
