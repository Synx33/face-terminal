// Same pattern as deviceState.js, but for the second physical device (a
// DS-K2802 card-reader controller) — kept as its own tiny module rather than
// generalizing deviceState.js itself, so the original face-terminal path is
// completely untouched by this addition. Mutable so a re-discovery can
// update it if the controller's DHCP lease ever changes.

let currentIp = process.env.CARD_DEVICE_IP || null;

function getCardDeviceIp() {
  if (!currentIp) throw new Error('card device IP not yet resolved — resolveCardDeviceIp() must run first');
  return currentIp;
}

function setCardDeviceIp(ip) {
  currentIp = ip;
}

function hasCardDeviceIp() {
  return Boolean(currentIp);
}

module.exports = { getCardDeviceIp, setCardDeviceIp, hasCardDeviceIp };
