// Lets the dashboard's Settings panel set the device IP directly (type it
// in, done — no editing .env by hand, no restart needed). Takes effect
// immediately via deviceState, and persists to .env so it survives the next
// restart too.

const fs = require('fs');
const path = require('path');
const { setDeviceIp } = require('./deviceState');

const ENV_PATH = path.join(__dirname, '..', '.env');

function setDeviceIpPersisted(ip) {
  setDeviceIp(ip);
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch { /* no .env on disk yet — fine, we'll create one */ }
  const line = `DEVICE_IP=${ip}`;
  if (/^DEVICE_IP=.*$/m.test(content)) {
    content = content.replace(/^DEVICE_IP=.*$/m, line);
  } else {
    content += (content === '' || content.endsWith('\n') ? '' : '\n') + line + '\n';
  }
  fs.writeFileSync(ENV_PATH, content);
}

module.exports = { setDeviceIpPersisted, ENV_PATH };
