// Same pattern as resolveDevice.js, but for the card-reader controller.
// Entirely optional — every caller of this module only runs if
// CARD_DEVICE_MAC or CARD_DEVICE_IP is actually set (see server.js), so a
// deployment that hasn't got this second device yet is completely
// unaffected by its existence.

const { discoverDeviceIp } = require('./discovery');
const { setCardDeviceIp, hasCardDeviceIp } = require('./cardDeviceState');
const logger = require('./logger');

let isDynamic = false;

/** Resolves the card device's IP once at startup — configured value wins, else scans the LAN. */
async function resolveCardDeviceIp() {
  if (hasCardDeviceIp()) {
    logger.log(`[card] using configured CARD_DEVICE_IP=${process.env.CARD_DEVICE_IP}`);
    return;
  }
  if (!process.env.CARD_DEVICE_MAC) {
    throw new Error('CARD_DEVICE_IP not set and CARD_DEVICE_MAC missing — need one or the other to find the card reader controller');
  }
  isDynamic = true;
  logger.log(`[card] CARD_DEVICE_IP not set — scanning local network for MAC ${process.env.CARD_DEVICE_MAC}...`);
  const found = await discoverDeviceIp({
    username: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER,
    password: process.env.CARD_DEVICE_PASS || process.env.DEVICE_PASS,
    expectedMac: process.env.CARD_DEVICE_MAC,
  });
  if (!found) throw new Error(`could not find a card device with MAC ${process.env.CARD_DEVICE_MAC} on any local subnet`);
  logger.log(`[card] discovered card device at ${found}`);
  setCardDeviceIp(found);
}

/** Re-scans and updates the resolved IP if it changed. No-op if CARD_DEVICE_IP was explicitly pinned. */
async function forceRediscoverCardDevice() {
  if (!isDynamic) {
    logger.log('[card] CARD_DEVICE_IP is explicitly configured — not auto-recovering, this needs a human to look at.');
    return false;
  }
  logger.log(`[card] re-scanning for MAC ${process.env.CARD_DEVICE_MAC} (device unreachable at its last known IP)...`);
  const found = await discoverDeviceIp({
    username: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER,
    password: process.env.CARD_DEVICE_PASS || process.env.DEVICE_PASS,
    expectedMac: process.env.CARD_DEVICE_MAC,
  });
  if (!found) {
    logger.error(`[card] re-scan found nothing for MAC ${process.env.CARD_DEVICE_MAC}`);
    return false;
  }
  logger.log(`[card] re-discovered card device at ${found}`);
  setCardDeviceIp(found);
  return true;
}

module.exports = { resolveCardDeviceIp, forceRediscoverCardDevice };
