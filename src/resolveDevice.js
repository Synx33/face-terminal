const { discoverDeviceIp } = require('./discovery');
const { setDeviceIp, hasDeviceIp } = require('./deviceState');
const logger = require('./logger');

// Only auto-recover by re-scanning if we found the device via discovery in
// the first place. If the operator explicitly pinned DEVICE_IP, connectivity
// trouble is a different kind of problem (real outage, wrong config) —
// silently re-scanning could even bind to a different device that happens
// to answer, so we leave that case to a human.
let isDynamic = false;

/** Resolves the device's IP once at startup — configured value wins, else scans the LAN. */
async function resolveDeviceIp() {
  if (hasDeviceIp()) {
    logger.log(`using configured DEVICE_IP=${process.env.DEVICE_IP}`);
    return;
  }
  if (!process.env.DEVICE_MAC) {
    throw new Error('DEVICE_IP not set and DEVICE_MAC missing — need one or the other to find the terminal');
  }
  isDynamic = true;
  logger.log(`DEVICE_IP not set — scanning local network for MAC ${process.env.DEVICE_MAC}...`);
  const found = await discoverDeviceIp({
    username: process.env.DEVICE_USER,
    password: process.env.DEVICE_PASS,
    expectedMac: process.env.DEVICE_MAC,
  });
  if (!found) throw new Error(`could not find a device with MAC ${process.env.DEVICE_MAC} on any local subnet`);
  logger.log(`discovered terminal at ${found}`);
  setDeviceIp(found);
}

/** Re-scans and updates the resolved IP if it changed. No-op if DEVICE_IP was explicitly pinned. */
async function forceRediscover() {
  if (!isDynamic) {
    logger.log('DEVICE_IP is explicitly configured — not auto-recovering, this needs a human to look at.');
    return false;
  }
  logger.log(`re-scanning for MAC ${process.env.DEVICE_MAC} (device unreachable at its last known IP)...`);
  const found = await discoverDeviceIp({
    username: process.env.DEVICE_USER,
    password: process.env.DEVICE_PASS,
    expectedMac: process.env.DEVICE_MAC,
  });
  if (!found) {
    logger.error(`re-scan found nothing for MAC ${process.env.DEVICE_MAC}`);
    return false;
  }
  logger.log(`re-discovered terminal at ${found}`);
  setDeviceIp(found);
  return true;
}

module.exports = { resolveDeviceIp, forceRediscover };
