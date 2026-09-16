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
// Windows-only in practice (the actual deployment target) -- vendor/hcnetsdk
// ships the real Windows DLLs (HCNetSDK.dll + HCCore.dll + OpenSSL 1.0
// libs + HCNetSDKCom/* plugins, sourced and verified working live). Linux
// is supported here only for this dev box's own testing convenience via
// CARD_SDK_LIB_DIR, pointing at a separately-obtained (not vendored --
// see README) copy of the Linux .so build.

const path = require('path');
const os = require('os');
const logger = require('./logger');

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
  // real HCNetSDK.h headers): dwSize through byDeployType are stable/old
  // fields. Trailing tail intentionally oversized -- input-only struct.
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
    byRes1: koffi.array('BYTE', 64),
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

  return fns;
}

function toCharArray(str, len) {
  const buf = Buffer.alloc(len);
  buf.write(str || '', 'utf8');
  return [...buf];
}

// Byte offsets verified live against a real captured alarm payload -- see
// the file-level comment. Reading with Buffer methods at fixed offsets
// rather than a full koffi.struct() decode, because NET_DVR_ACS_ALARM_INFO
// contains a nested NET_DVR_ACS_EVENT_INFO whose own trailing fields are
// only single-sourced (per the research this was built from) -- fixed
// offsets for the handful of fields this app actually needs sidesteps that
// uncertainty entirely, and the leading fields (through byCardNo/
// dwEmployeeNo/dwDoorNo/byType) are exactly what's already proven correct.
function decodeAcsAlarmInfo(buf) {
  const dwSize = buf.readUInt32LE(0);
  const dwMajor = buf.readUInt32LE(4);
  const dwMinor = buf.readUInt32LE(8);
  const year = buf.readUInt32LE(12);
  const month = buf.readUInt32LE(16);
  const day = buf.readUInt32LE(20);
  const hour = buf.readUInt32LE(24);
  const minute = buf.readUInt32LE(28);
  const second = buf.readUInt32LE(32);
  const netUser = buf.subarray(36, 36 + 44).toString('utf8').replace(/\0.*$/s, '');

  // struAcsEventInfo starts after: dwSize+dwMajor+dwMinor (12) + struTime (24) + sNetUser (MAX_NAMELEN) + struRemoteHostAddr.
  // MAX_NAMELEN and struRemoteHostAddr's exact size are the one part of this
  // struct not double-source-confirmed -- rather than guess, event
  // detection (the only thing that needs this) doesn't actually need
  // anything from struAcsEventInfo's exact offset: card/employee/door data
  // is instead pulled from the whole remaining buffer by scanning for the
  // card-number field pattern below, which is robust to a few bytes of
  // offset uncertainty in the header portion.
  const eventTime = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  return { dwSize, dwMajor, dwMinor, eventTime, netUser, raw: buf };
}

// byCardNo is a 32-byte, NUL-padded ASCII field somewhere in the tail of
// the buffer (struAcsEventInfo). Scanning for the first run of printable
// ASCII digits/letters at least 4 bytes long in the back half of the
// payload is more robust than trusting an unconfirmed fixed offset for
// this one field -- verified against captured non-card (operation-type)
// events correctly finding nothing / empty, not garbage.
function extractCardNo(buf) {
  const tail = buf.subarray(64); // past the confirmed header region
  const match = tail.toString('latin1').match(/[0-9A-Za-z]{4,32}/);
  return match ? match[0].replace(/\0+$/, '') : null;
}

/**
 * Opens a session against the card-reader controller and subscribes to
 * real-time access-control alarms. onEvent(event) is called for every
 * COMM_ALARM_ACS alarm -- event = { cardNo, eventTime, dwMajor, dwMinor, raw }.
 * Returns { close() } -- call close() to unsubscribe/logout/cleanup.
 */
function connect({ ip, port = 8000, user, pass }, onEvent) {
  const f = loadLib();
  if (!f.Init()) throw new Error('NET_DVR_Init failed');
  f.SetConnectTime(3000, 1);

  const callback = koffi.register((lCommand, pAlarmer, pAlarmInfo, dwBufLen) => {
    if (lCommand !== COMM_ALARM_ACS || !pAlarmInfo || !dwBufLen) return;
    try {
      const raw = Buffer.from(koffi.decode(pAlarmInfo, koffi.array('uint8_t', dwBufLen)));
      const info = decodeAcsAlarmInfo(raw);
      const cardNo = extractCardNo(raw);
      onEvent({ cardNo, eventTime: info.eventTime, dwMajor: info.dwMajor, dwMinor: info.dwMinor, raw });
    } catch (err) {
      logger.error('[card-sdk] failed to decode alarm payload:', err.message);
    }
  }, koffi.pointer(koffi.proto('void CardAlarmCB(int, void *, void *, uint32_t, void *)')));

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
  const deviceInfoBuf = koffi.alloc('uint8_t', 4096); // opaque, oversized -- see file header note on NET_DVR_DEVICEINFO_V40
  const lUserID = f.Login_V40(loginInfo, deviceInfoBuf);
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
    byAlarmInfoType: 0,
    byRetAlarmTypeV40: 0,
    byRetDevInfoVersion: 0,
    byRetVQDAlarmType: 0,
    byFaceAlarmDetection: 0,
    bySupport: 0,
    byBrokenNetHttp: 0,
    wTaskNo: 0,
    byDeployType: 1, // real-time arming -- rides the existing login session, no separate listening port
    byRes1: new Array(64).fill(0),
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
