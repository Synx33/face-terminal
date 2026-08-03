// Lets the dashboard's Settings panel set the device IP and credentials
// directly (type them in, done — no editing .env by hand on the site
// laptop, no restart needed). Takes effect immediately, and persists to
// .env so it survives the next restart too. Added after a real support
// case: a mistyped DEVICE_PASS in .env (an easy mistake — a laptop with a
// different keyboard layout can silently type "@" as something else) had
// no fix path except finding and hand-editing the file as Administrator.

const fs = require('fs');
const path = require('path');
const { setDeviceIp } = require('./deviceState');

const ENV_PATH = path.join(__dirname, '..', '.env');

function setEnvVar(key, value) {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch { /* no .env on disk yet — fine, we'll create one */ }
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) {
    content = content.replace(pattern, line);
  } else {
    content += (content === '' || content.endsWith('\n') ? '' : '\n') + line + '\n';
  }
  fs.writeFileSync(ENV_PATH, content);
}

function setDeviceIpPersisted(ip) {
  setDeviceIp(ip);
  setEnvVar('DEVICE_IP', ip);
}

// deviceClient.js reads process.env.DEVICE_USER/DEVICE_PASS fresh on every
// ISAPI call (never cached at startup), so updating process.env here takes
// effect on the very next request — no restart, no deviceState-style
// module needed for these two.
function setDeviceCredentialsPersisted({ user, pass }) {
  if (user !== undefined) {
    process.env.DEVICE_USER = user;
    setEnvVar('DEVICE_USER', user);
  }
  if (pass !== undefined) {
    process.env.DEVICE_PASS = pass;
    setEnvVar('DEVICE_PASS', pass);
  }
}

module.exports = { setDeviceIpPersisted, setDeviceCredentialsPersisted, ENV_PATH };
