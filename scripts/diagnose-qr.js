// One-off diagnostic: probes several plausible ISAPI paths on the terminal
// to find where QR-code credential support actually lives, since the
// UserInfo/capabilities check done earlier in this project didn't list QR
// as a userVerifyMode option -- meaning it's exposed somewhere else, or via
// a different mechanism (e.g. a QR code stored as a "card" number) if it
// exists via ISAPI at all. Run from the install directory so .env is
// picked up:
//   node --env-file=.env scripts\diagnose-qr.js

const { digestRequest } = require('../src/digest');
const { resolveDeviceIp } = require('../src/resolveDevice');
const { getDeviceIp } = require('../src/deviceState');

const CANDIDATES = [
  { method: 'GET', path: '/ISAPI/AccessControl/CardInfo/capabilities?format=json' },
  { method: 'POST', path: '/ISAPI/AccessControl/CardInfo/Search?format=json',
    body: { CardInfoSearchCond: { searchID: '1', searchResultPosition: 0, maxResults: 5 } } },
  { method: 'GET', path: '/ISAPI/AccessControl/QRCode/capabilities?format=json' },
  { method: 'GET', path: '/ISAPI/AccessControl/UserInfo/capabilities?format=json' },
  { method: 'GET', path: '/ISAPI/System/capabilities?format=json' },
  { method: 'GET', path: '/ISAPI/AccessControl/capabilities?format=json' },
  { method: 'GET', path: '/ISAPI/Intelligent/capabilities?format=json' },
];

async function main() {
  await resolveDeviceIp();
  const ip = getDeviceIp();
  const protocol = process.env.DEVICE_PROTOCOL || 'http';
  console.log('device IP:', ip);
  console.log('');

  for (const c of CANDIDATES) {
    try {
      const res = await digestRequest({
        method: c.method,
        url: `${protocol}://${ip}${c.path}`,
        username: process.env.DEVICE_USER,
        password: process.env.DEVICE_PASS,
        headers: c.body ? { 'Content-Type': 'application/json' } : {},
        body: c.body ? JSON.stringify(c.body) : undefined,
      });
      console.log('===', c.method, c.path, '-> HTTP', res.status, '===');
      if (res.status < 400) {
        console.log(res.text.slice(0, 1500));
      } else {
        console.log(res.text.slice(0, 200));
      }
    } catch (err) {
      console.log('===', c.method, c.path, '-> FAILED:', err.message, '===');
    }
    console.log('');
  }
}

main().catch((err) => { console.error('diagnostic script failed:', err.message); process.exit(1); });
