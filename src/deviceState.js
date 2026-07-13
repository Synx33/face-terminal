// Holds the terminal's current IP, resolved once at startup — either taken
// directly from DEVICE_IP (if set, e.g. for this dev/test box) or found via
// discovery.js by scanning the local network for its MAC address (for a
// real site deploy where the IP isn't known ahead of time). Kept mutable so
// a re-discovery can update it if the device's DHCP lease ever changes.

let currentIp = process.env.DEVICE_IP || null;

function getDeviceIp() {
  if (!currentIp) throw new Error('device IP not yet resolved — resolveDeviceIp() must run first');
  return currentIp;
}

function setDeviceIp(ip) {
  currentIp = ip;
}

function hasDeviceIp() {
  return Boolean(currentIp);
}

module.exports = { getDeviceIp, setDeviceIp, hasDeviceIp };
