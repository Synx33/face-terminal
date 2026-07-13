// Finds the face terminal on whatever network this host is currently on,
// by MAC address, instead of relying on a hardcoded IP. Needed because this
// unit gets moved between networks (currently the office LAN for testing,
// eventually an install site whose IP range isn't known ahead of time).
//
// Approach: enumerate this host's own IPv4 interfaces, derive each one's
// /24-ish subnet, and probe every host address concurrently for a Hikvision
// ISAPI response whose macAddress matches. A short per-probe timeout keeps
// a full subnet sweep to a few seconds — most non-device hosts refuse the
// connection immediately; only silently-firewalled IPs eat the timeout.

const os = require('os');
const { digestRequest } = require('./digest');
const logger = require('./logger');

const PROBE_TIMEOUT_MS = 1500;
const CONCURRENCY = 40;

// Every LAN we've actually seen this device on is a /24 (254 hosts). But a
// Windows laptop can carry interfaces we don't control the size of — VPN
// clients, corporate DHCP scopes, Hyper-V/VMware virtual switches — and
// os.networkInterfaces() doesn't distinguish "real" from virtual. Without a
// cap, one interface with a huge netmask (e.g. a /16, 65k+ hosts) could turn
// a few-second scan into the better part of an hour, and unauthenticated
// probes against thousands of unrelated hosts is the kind of traffic that
// gets a laptop flagged by a client's network security tooling.
const MAX_HOSTS_PER_SUBNET = 2048; // up to a /21 — generous for any real LAN, blocks runaway virtual/VPN ranges
const MAX_TOTAL_HOSTS = 4096; // hard ceiling across all interfaces combined

function localIPv4Subnets() {
  const nets = os.networkInterfaces();
  const subnets = [];
  for (const [name, ifaceList] of Object.entries(nets)) {
    for (const net of ifaceList) {
      if (net.family === 'IPv4' && !net.internal) subnets.push({ name, address: net.address, netmask: net.netmask });
    }
  }
  return subnets;
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function intToIp(int) {
  return [24, 16, 8, 0].map((shift) => (int >>> shift) & 255).join('.');
}

/** All host addresses in a subnet, excluding the network and broadcast addresses. Capped — see MAX_HOSTS_PER_SUBNET. */
function subnetHosts({ name, address, netmask }) {
  const addrInt = ipToInt(address);
  const maskInt = ipToInt(netmask);
  const network = addrInt & maskInt;
  const broadcast = network | (~maskInt >>> 0);
  const size = broadcast - network - 1;
  if (size > MAX_HOSTS_PER_SUBNET) {
    logger.log(`discovery: skipping interface "${name}" (${address}/${netmask}, ~${size} hosts) — larger than the ${MAX_HOSTS_PER_SUBNET}-host safety cap, likely a VPN/virtual adapter rather than the real LAN`);
    return [];
  }
  const hosts = [];
  for (let ip = network + 1; ip < broadcast; ip++) hosts.push(intToIp(ip));
  return hosts;
}

async function probe(ip, { username, password, expectedMac }) {
  try {
    const res = await digestRequest({
      method: 'GET',
      url: `http://${ip}/ISAPI/System/deviceInfo`,
      username,
      password,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (res.status !== 200) return null;
    return res.text.toLowerCase().includes(expectedMac.toLowerCase()) ? ip : null;
  } catch {
    return null; // refused / timed out / not a Hikvision device / wrong credentials — all just "not this one"
  }
}

/**
 * Scans local subnets for the terminal by MAC address.
 * @returns {Promise<string|null>} the device's IP, or null if not found on any local subnet.
 */
async function discoverDeviceIp({ username, password, expectedMac }) {
  const subnets = localIPv4Subnets();
  let hosts = [...new Set(subnets.flatMap(subnetHosts))];
  if (hosts.length > MAX_TOTAL_HOSTS) {
    logger.log(`discovery: ${hosts.length} candidate hosts across all interfaces exceeds the ${MAX_TOTAL_HOSTS} safety cap — scanning only the first ${MAX_TOTAL_HOSTS}`);
    hosts = hosts.slice(0, MAX_TOTAL_HOSTS);
  }
  logger.log(`discovery: scanning ${hosts.length} host(s) across ${subnets.length} interface(s)`);

  for (let i = 0; i < hosts.length; i += CONCURRENCY) {
    const batch = hosts.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((ip) => probe(ip, { username, password, expectedMac })));
    const found = results.find(Boolean);
    if (found) return found;
  }
  return null;
}

module.exports = { discoverDeviceIp };
