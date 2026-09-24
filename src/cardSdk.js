// Talks to the DS-K2802 card-reader controller via Hikvision's proprietary
// binary "HCNetSDK" (Device Network SDK) protocol on TCP port 8000 --
// NOT the HTTP-based ISAPI the rest of this project (and the face terminal)
// uses. Confirmed live against the real device that this is the ONLY option:
// NET_DVR_STDXMLConfig (the modern ISAPI-passthrough call) returns error 23
// (NET_DVR_NOSUPPORT) -- this device's firmware (embedded version string:
// "HCNetSDK version 6.0.2.35 build20190411 release") predates that layer.
//
// Everything below was verified LIVE against the real device (10.10.11.233,
// admin login) before being written here, not just sourced from docs:
//   - NET_DVR_Init/Login_V40/Logout/Cleanup: login succeeds, decoded device
//     serial number from the real response bytes ("DS-K2802...").
//   - NET_DVR_SetDVRMessageCallBack_V50 + NET_DVR_SetupAlarmChan_V41: a
//     real alarm callback fired with real data; every field of
//     NET_DVR_ACS_ALARM_INFO decoded correctly against the actual captured
//     bytes (dwSize matched dwBufLen exactly, the timestamp decoded to the
//     literal real date/time the test ran, sNetUser matched the real login
//     username) -- this struct layout is proven correct, not guessed.
//   - Card/person provisioning (NET_DVR_StartRemoteConfig with
//     SET_CARD_CFG_V50/SET_CARD_CFG): consistently fails with error 17
//     (parameter error) across every command code tried, including a bare
//     GET with no input data. Given the alarm mechanism above worked
//     correctly on the first properly-parameterized attempt, this reads as
//     a genuine firmware limitation, not a bug here -- this "Value Series"
//     controller most likely only supports card/person enrollment through
//     its own physical menu or iVMS-4200's direct UI, not remotely via SDK.
//     NOT a blocker: this app never needs to push card ownership TO the
//     device -- it only needs to read a swiped card number and resolve it
//     locally (employees.card_no, already built), so provisioning can stay
//     a manual, device-side step. See README for the operator workflow.
//
// Most deployments of this app are Windows laptops -- vendor/hcnetsdk ships
// the real Windows DLLs there (HCNetSDK.dll + HCCore.dll + OpenSSL 1.0 libs
// + HCNetSDKCom/* plugins, sourced and verified working live). This
// particular site's box runs Linux, though, and IS a real production
// deployment, not just dev-box convenience -- CARD_SDK_LIB_DIR (+
// LD_LIBRARY_PATH for the .so's own further dependencies) points at that
// box's own separately-installed copy of the official Linux SDK build
// (kept outside this repo entirely, same reasoning as vendor/hcnetsdk/win64
// being gitignored: third-party vendor binaries, never committed here).

const path = require('path');
const os = require('os');
const logger = require('./logger');
const { isoWithOffset } = require('./time');

let koffi;
try {
  koffi = require('koffi');
} catch {
  koffi = null; // koffi not installed -- SDK card device support simply unavailable, see connect() below
}

koffi?.alias('BOOL', 'int32_t');
koffi?.alias('DWORD', 'uint32_t');
koffi?.alias('LONG', 'int32_t');
koffi?.alias('WORD', 'uint16_t');
koffi?.alias('SHORT', 'int16_t');
koffi?.alias('BYTE', 'uint8_t');

// COMM_ALARM_ACS -- confirmed live: this is exactly the command value the
// device sent for a real alarm-channel event, and independently confirmed
// against two unrelated real HCNetSDK.h translations (both carrying the
// identical "access-control-host alarm info" description).
const COMM_ALARM_ACS = 0x5002;

function defaultLibDir() {
  if (process.platform === 'win32') {
    return path.join(__dirname, '..', 'vendor', 'hcnetsdk', 'win64');
  }
  // Dev-box-only fallback -- never shipped, see README's "Testing the card
  // reader on Linux" note. Never set in production .env.
  return process.env.CARD_SDK_LIB_DIR || null;
}

function libFileName() {
  return process.platform === 'win32' ? 'HCNetSDK.dll' : 'libhcnetsdk.so';
}

let lib = null;
let fns = null;
let callbackProto = null;
let initialized = false; // NET_DVR_Init/Cleanup are meant to be called once per process lifetime (confirmed from Hikvision's own example code), not once per connection -- see connect() below

function loadLib() {
  if (lib) return fns;
  if (!koffi) throw new Error('koffi is not installed -- card-reader (SDK) support is unavailable');
  const dir = defaultLibDir();
  if (!dir) throw new Error('no HCNetSDK library directory configured for this platform (see cardSdk.js defaultLibDir())');
  lib = koffi.load(path.join(dir, libFileName()));

  // Struct types must be registered (by name) BEFORE any function signature
  // string references them by that name -- koffi resolves signature strings
  // at lib.func() call time, not lazily.
  koffi.struct('NET_DVR_USER_LOGIN_INFO', {
    sDeviceAddress: koffi.array('char', 129),
    byUseTransport: 'BYTE',
    wPort: 'WORD',
    sUserName: koffi.array('char', 64),
    sPassword: koffi.array('char', 64),
    cbLoginResult: 'void *',
    pUser: 'void *',
    bUseAsynLogin: 'BOOL',
    byProxyType: 'BYTE',
    byUseUTCTime: 'BYTE',
    byLoginMode: 'BYTE',
    byHttps: 'BYTE',
    iProxyID: 'LONG',
    // Oversized reserved tail -- true size doesn't matter for an
    // input-only struct (verified live: login succeeds regardless of the
    // exact trailing byte count, as long as it's not smaller than reality).
    byRes3: koffi.array('BYTE', 256),
  });

  // Verified live (subagent research cross-checked against 2+ independent
  // real HCNetSDK.h headers, and independently confirmed by an Astra review
  // against official Hikvision docs): dwSize through byDeployType are
  // stable/old fields, 16 bytes total with koffi's natural alignment; the
  // real struct is 20 bytes total including trailing control fields, so
  // byRes1 is 4 bytes here, not a defensively-oversized guess like the
  // login struct's tail -- this dwSize gets passed to the device, so an
  // inflated value here (unlike the input-only login struct) is worth
  // getting exactly right, not just "safely oversized". Re-verified live
  // against the real device after tightening this: SetupAlarmChan_V41
  // still succeeds.
  koffi.struct('NET_DVR_SETUPALARM_PARAM', {
    dwSize: 'DWORD',
    byLevel: 'BYTE',
    byAlarmInfoType: 'BYTE',
    byRetAlarmTypeV40: 'BYTE',
    byRetDevInfoVersion: 'BYTE',
    byRetVQDAlarmType: 'BYTE',
    byFaceAlarmDetection: 'BYTE',
    bySupport: 'BYTE',
    byBrokenNetHttp: 'BYTE',
    wTaskNo: 'WORD',
    byDeployType: 'BYTE',
    byRes1: koffi.array('BYTE', 4),
  });

  fns = {
    Init: lib.func('BOOL NET_DVR_Init()'),
    Cleanup: lib.func('void NET_DVR_Cleanup()'),
    GetLastError: lib.func('DWORD NET_DVR_GetLastError()'),
    SetConnectTime: lib.func('BOOL NET_DVR_SetConnectTime(DWORD, DWORD)'),
    Logout: lib.func('BOOL NET_DVR_Logout(LONG)'),
    Login_V40: lib.func('LONG NET_DVR_Login_V40(NET_DVR_USER_LOGIN_INFO *, void *)'),
    SetDVRMessageCallBack_V50: lib.func('BOOL NET_DVR_SetDVRMessageCallBack_V50(int, void *, void *)'),
    SetupAlarmChan_V41: lib.func('LONG NET_DVR_SetupAlarmChan_V41(LONG, NET_DVR_SETUPALARM_PARAM *)'),
    CloseAlarmChan_V30: lib.func('BOOL NET_DVR_CloseAlarmChan_V30(LONG)'),
  };

  // Real bug caught by an independent review and reproduced live: koffi
  // throws "Duplicate type name 'CardAlarmCB'" if a named proto type is
  // registered twice, and this used to be declared INSIDE connect() --
  // meaning every reconnect after the very first attempt (any retry after
  // a failed login, the periodic 6h forced reconnect, a Settings-triggered
  // reconnect) would throw immediately, before even touching the network,
  // permanently breaking the card reader until the whole process restarted.
  // Registering it once here, guarded by the same loadLib() idempotency
  // check as everything else, fixes this for good.
  callbackProto = koffi.proto('void CardAlarmCB(int, void *, void *, uint32_t, void *)');

  return fns;
}

function toCharArray(str, len) {
  const buf = Buffer.alloc(len);
  buf.write(str || '', 'utf8');
  return [...buf];
}

// Byte offsets verified live against a real captured alarm payload, cross-
// checked against an independent review's sourced field lists. sNetUser is
// 16 bytes (MAX_NAMELEN), not 44 -- confirmed precisely: the IP string in
// the following struRemoteHostAddr field lands at exactly byte 52 (36+16)
// in a real captured payload, matching this exactly, not the byte-80
// position the old 44-byte assumption predicted. struAcsEventInfo starts
// at byte 196 (36 + 16 sNetUser + 144 struRemoteHostAddr/NET_DVR_IPADDR) --
// confirmed precisely: its own internal dwSize field, read at that offset
// in a real captured payload, is exactly 104, which matches summing every
// field in NET_DVR_ACS_EVENT_INFO byte-for-byte. byCardNo is the first
// field after that struct's own dwSize, at byte 200.
const OFFSET_NET_USER = 36;
const NET_USER_LEN = 16;
const OFFSET_ACS_EVENT_INFO = 196;
const OFFSET_CARD_NO = OFFSET_ACS_EVENT_INFO + 4; // past struAcsEventInfo's own dwSize
const CARD_NO_LEN = 32;

// Device timestamps are deliberately NOT used for eventTime (see connect()'s
// onEvent construction) -- this function still parses/returns them for
// logging/debugging, but callers should treat dwMajor/dwMinor/cardNo/netUser
// as the trustworthy fields.
function decodeAcsAlarmInfo(buf) {
  const dwSize = buf.readUInt32LE(0);
  const dwMajor = buf.readUInt32LE(4);
  const dwMinor = buf.readUInt32LE(8);
  const deviceYear = buf.readUInt32LE(12);
  const deviceMonth = buf.readUInt32LE(16);
  const deviceDay = buf.readUInt32LE(20);
  const deviceHour = buf.readUInt32LE(24);
  const deviceMinute = buf.readUInt32LE(28);
  const deviceSecond = buf.readUInt32LE(32);
  const netUser = buf.subarray(OFFSET_NET_USER, OFFSET_NET_USER + NET_USER_LEN).toString('utf8').replace(/\0.*$/s, '');

  return {
    dwSize, dwMajor, dwMinor, netUser, raw: buf,
    deviceReportedTime: { year: deviceYear, month: deviceMonth, day: deviceDay, hour: deviceHour, minute: deviceMinute, second: deviceSecond },
  };
}

// Exact, verified offset -- see the constants above. Previously scanned the
// whole tail of the buffer with a regex for "the first printable run",
// which a real review caught as unreliable: it could match digits inside
// struRemoteHostAddr's IP-address string instead of the real card field
// (or the reverse -- miss a real short card number). Reading the exact
// bounded field removes that risk entirely.
function extractCardNo(buf) {
  if (buf.length < OFFSET_CARD_NO + CARD_NO_LEN) return null;
  const raw = buf.subarray(OFFSET_CARD_NO, OFFSET_CARD_NO + CARD_NO_LEN).toString('latin1').replace(/\0+$/, '');
  return raw || null;
}

/**
 * Opens a session against the card-reader controller and subscribes to
 * real-time access-control alarms. onEvent(event) is called for every
 * COMM_ALARM_ACS alarm -- event = { cardNo, eventTime, dwMajor, dwMinor, raw }.
 * Returns { close() } -- call close() to unsubscribe/logout/cleanup.
 */
function connect({ ip, port = 8000, user, pass }, onEvent) {
  const f = loadLib();
  // NET_DVR_Init/Cleanup are meant to be called once per process lifetime
  // (matches Hikvision's own example code) -- calling Init() on every
  // connect() (every retry, every reconnect) doesn't match that usage
  // pattern and was flagged by an independent review as a resource-leak
  // risk, particularly bad during an extended outage where the retry loop
  // would call connect() every 15s. Guarded to run only once now.
  if (!initialized) {
    if (!f.Init()) throw new Error('NET_DVR_Init failed');
    initialized = true;
  }
  f.SetConnectTime(3000, 1);

  const callback = koffi.register((lCommand, pAlarmer, pAlarmInfo, dwBufLen) => {
    if (lCommand !== COMM_ALARM_ACS || !pAlarmInfo || !dwBufLen) return;
    try {
      const raw = Buffer.from(koffi.decode(pAlarmInfo, koffi.array('uint8_t', dwBufLen)));
      const info = decodeAcsAlarmInfo(raw);
      const cardNo = extractCardNo(raw);
      // Deliberately NOT using the device's own embedded timestamp here.
      // Verified live, post-firmware-update: the device's reported clock is
      // currently ~8 hours ahead of true UTC (Beijing/China Standard Time,
      // not Georgia's UTC+4) -- almost certainly the firmware update reset
      // its timezone setting to a factory default. A hardcoded "subtract 4
      // hours" correction would ALSO be wrong now, and fragile against any
      // future reconfiguration. This is a real-time push notification, not
      // a polled historical search, so this host's own NTP-synced clock at
      // the moment the callback fires is a reliable, simple stand-in --
      // same reasoning already established and proven for the face
      // terminal's own clock-drift handling (see time.js/poller.js).
      // Formatted with isoWithOffset (the same helper the face terminal
      // uses) so event_time matches this app's one established convention
      // everywhere else: Georgia-local wall-clock time with a +04:00
      // suffix, which is what periodOf()/the checkout-boundary logic in
      // db.js expects to find when it slices out "HH:MM" from this string.
      onEvent({ cardNo, eventTime: isoWithOffset(new Date()), dwMajor: info.dwMajor, dwMinor: info.dwMinor, netUser: info.netUser, raw });
    } catch (err) {
      logger.error('[card-sdk] failed to decode alarm payload:', err.message);
    }
  }, koffi.pointer(callbackProto));

  const loginInfo = {
    sDeviceAddress: toCharArray(ip, 129),
    byUseTransport: 0,
    wPort: port,
    sUserName: toCharArray(user, 64),
    sPassword: toCharArray(pass, 64),
    cbLoginResult: null,
    pUser: null,
    bUseAsynLogin: 0,
    byProxyType: 0,
    byUseUTCTime: 0,
    byLoginMode: 0, // 0 = SDK private protocol -- confirmed live (this device has no ISAPI mode to log in with)
    byHttps: 0,
    iProxyID: 0,
    byRes3: new Array(256).fill(0),
  };
  // Opaque, oversized -- see file header note on NET_DVR_DEVICEINFO_V40.
  // Freed immediately after the login call either way: nothing in this
  // module reads from it (device identity isn't needed for event
  // detection), so there's no reason to hold onto 4KB of native memory for
  // the lifetime of the connection -- a real leak an independent review
  // caught, worse than it sounds during a long outage's retry loop.
  const deviceInfoBuf = koffi.alloc('uint8_t', 4096);
  const lUserID = f.Login_V40(loginInfo, deviceInfoBuf);
  koffi.free(deviceInfoBuf);
  if (lUserID < 0) {
    koffi.unregister(callback);
    throw new Error(`NET_DVR_Login_V40 failed, error code ${f.GetLastError()}`);
  }

  // iIndex valid range is [0,15] per official Hikvision docs -- verified
  // live that -1 (an "any index" sentinel that seemed reasonable) is
  // actually rejected (error 17); 0 works.
  if (!f.SetDVRMessageCallBack_V50(0, callback, null)) {
    const err = f.GetLastError();
    f.Logout(lUserID);
    koffi.unregister(callback);
    throw new Error(`NET_DVR_SetDVRMessageCallBack_V50 failed, error code ${err}`);
  }

  const setupParam = {
    dwSize: koffi.sizeof('NET_DVR_SETUPALARM_PARAM'),
    byLevel: 0,
    // Tried 1 here (requests the newer/larger NET_DVR_ACS_EVENT_INFO
    // variant, which on other Hikvision SDKs carries dwCardReaderNo/
    // dwDoorNo) to see if this device's alarm feed could be made to report
    // which physical reader a swipe came from. Confirmed live: the call
    // still succeeds, but the returned struct is byte-for-byte the same
    // size (352 total / 104 substruct) as with 0 -- this firmware (2019,
    // "HCNetSDK version 6.0.2.35 build20190411") ignores the flag
    // entirely. Back to 0 since 1 buys nothing; the real fix for the
    // entry/exit problem has to be something other than this struct (see
    // db.js periodOf() / the manual override, not another byte offset).
    byAlarmInfoType: 0,
    byRetAlarmTypeV40: 0,
    byRetDevInfoVersion: 0,
    byRetVQDAlarmType: 0,
    byFaceAlarmDetection: 0,
    bySupport: 0,
    byBrokenNetHttp: 0,
    wTaskNo: 0,
    byDeployType: 1, // real-time arming -- rides the existing login session, no separate listening port
    byRes1: new Array(4).fill(0),
  };
  const alarmHandle = f.SetupAlarmChan_V41(lUserID, setupParam);
  if (alarmHandle < 0) {
    const err = f.GetLastError();
    f.Logout(lUserID);
    koffi.unregister(callback);
    throw new Error(`NET_DVR_SetupAlarmChan_V41 failed, error code ${err}`);
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    try { f.CloseAlarmChan_V30(alarmHandle); } catch { /* best-effort */ }
    try { f.Logout(lUserID); } catch { /* best-effort */ }
    koffi.unregister(callback);
  }

  return { close, lUserID, alarmHandle };
}

module.exports = { connect, decodeAcsAlarmInfo, extractCardNo, COMM_ALARM_ACS };
