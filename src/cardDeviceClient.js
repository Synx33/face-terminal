// Thin wrapper around the DS-K2802 card-reader controller's ISAPI. Mirrors
// deviceClient.js (the DS-K1T343EWX face terminal's client) almost exactly —
// both are Hikvision AccessControl-family devices speaking the same ISAPI
// dialect (HTTP digest auth, AcsEvent search, UserInfo person records), per
// Hikvision's own DS-K2800-series manual (§7.9 "Searching Access Control
// Event", §7.5 "Person and Card Management" — same feature set/wording as
// the face terminal's manual).
//
// What's CONFIRMED to work as-is (proven against the actual face terminal
// already, and structurally identical per the DS-K2800 manual): fetchEvents,
// fetchAllUsers, createDeviceUser, modifyDeviceUser, deleteDeviceUser.
//
// What's UNVERIFIED (built from Hikvision's general ISAPI CardInfo
// convention, never tested against real hardware — the device wasn't
// reachable on the network while this was written): setCardForUser. Run
// scripts/diagnose-card-device.js against the real controller once it's on
// the network and fix this up from what it actually returns before relying
// on it.

const { digestRequest } = require('./digest');
const { getCardDeviceIp } = require('./cardDeviceState');
const { georgiaNaive } = require('./time');
const authState = require('./deviceAuthState').createAuthState('card');

function baseUrl() {
  const protocol = process.env.CARD_DEVICE_PROTOCOL || process.env.DEVICE_PROTOCOL || 'http';
  return `${protocol}://${getCardDeviceIp()}`;
}

function credentials() {
  return {
    username: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER,
    password: process.env.CARD_DEVICE_PASS || process.env.DEVICE_PASS,
  };
}

class DeviceAuthError extends Error {}

async function isapi(method, path, jsonBody) {
  const res = await digestRequest({
    method,
    url: `${baseUrl()}${path}`,
    ...credentials(),
    headers: jsonBody ? { 'Content-Type': 'application/json' } : {},
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });
  if (res.status === 401) {
    authState.recordAuthFailure();
    throw new DeviceAuthError(`card device ISAPI ${method} ${path} -> HTTP 401: authentication failed — check the card reader's username/password in Settings`);
  }
  if (res.status >= 300) {
    throw new Error(`card device ISAPI ${method} ${path} -> HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  }
  authState.recordAuthSuccess();
  return JSON.parse(res.text);
}

/** Pulls the full enrolled-user list (paginated) as [{employeeNo, name}]. */
async function fetchAllUsers() {
  const users = [];
  let position = 0;
  const pageSize = 30;
  while (true) {
    const doc = await isapi('POST', '/ISAPI/AccessControl/UserInfo/Search?format=json', {
      UserInfoSearchCond: { searchID: '1', searchResultPosition: position, maxResults: pageSize },
    });
    const list = doc.UserInfoSearch?.UserInfo || [];
    for (const u of list) users.push({ employeeNo: u.employeeNo, name: u.name });
    position += list.length;
    if (list.length < pageSize || position >= (doc.UserInfoSearch?.totalMatches ?? position)) break;
  }
  return users;
}

/** Pulls AcsEvent history in [startTime, endTime) (ISO 8601 with offset), paginated. */
async function fetchEvents({ startTime, endTime, maxResults = 30 }) {
  const events = [];
  let position = 0;
  while (true) {
    const doc = await isapi('POST', '/ISAPI/AccessControl/AcsEvent?format=json', {
      AcsEventCond: {
        searchID: '1', searchResultPosition: position, maxResults, major: 0, minor: 0, startTime, endTime,
      },
    });
    const list = doc.AcsEvent?.InfoList || [];
    events.push(...list);
    position += list.length;
    if (list.length < maxResults || position >= (doc.AcsEvent?.totalMatches ?? position)) break;
  }
  return events;
}

/** Next free numeric employeeNo — one past the current highest, so new hires never collide. Kept separate from deviceClient's version (own device, own numbering) even though the two happen to share the same employeeNo space today by convention. */
async function nextEmployeeNo() {
  const users = await fetchAllUsers();
  const nums = users.map((u) => parseInt(u.employeeNo, 10)).filter(Number.isFinite);
  return String((nums.length ? Math.max(...nums) : 0) + 1);
}

function userInfoRecord({ employeeNo, name }) {
  const now = new Date();
  const tenYearsOut = new Date(now);
  tenYearsOut.setFullYear(tenYearsOut.getFullYear() + 10);
  return {
    UserInfo: {
      employeeNo: String(employeeNo),
      name,
      userType: 'normal',
      Valid: {
        enable: true,
        beginTime: georgiaNaive(now),
        endTime: georgiaNaive(tenYearsOut),
        timeType: 'local',
      },
      doorRight: '1',
      RightPlan: [{ doorNo: 1, planTemplateNo: '1' }],
    },
  };
}

/** Creates a brand-new enrolled user (employeeNo MUST NOT already exist — same create-only contract confirmed against the face terminal's identical endpoint). */
async function createDeviceUser({ employeeNo, name }) {
  return isapi('POST', '/ISAPI/AccessControl/UserInfo/Record?format=json', userInfoRecord({ employeeNo, name }));
}

/** Updates an already-enrolled user's name/rights. */
async function modifyDeviceUser({ employeeNo, name }) {
  return isapi('PUT', '/ISAPI/AccessControl/UserInfo/Modify?format=json', userInfoRecord({ employeeNo, name }));
}

/** Removes an enrolled user entirely. */
async function deleteDeviceUser(employeeNo) {
  return isapi('PUT', '/ISAPI/AccessControl/UserInfo/Delete?format=json', {
    UserInfoDelCond: { EmployeeNoList: [{ employeeNo: String(employeeNo) }] },
  });
}

// UNVERIFIED — see the file-level comment. Built from Hikvision's documented
// general AccessControl/CardInfo convention (the same shape used across
// their access-control product line for linking a physical card number to
// an already-created UserInfo employeeNo), NOT confirmed against this
// specific device. employeeNo MUST already exist (createDeviceUser first).
// If this throws or silently fails to link once tested for real, the local
// employees.card_no mapping (db.js) still lets check-ins resolve correctly
// on our side even if the device's own on-screen name display doesn't show
// anything for that card — see hikParser.js's isCheckin() comment.
async function setCardForUser({ employeeNo, cardNo }) {
  return isapi('POST', '/ISAPI/AccessControl/CardInfo/SetUp?format=json', {
    CardInfo: {
      employeeNo: String(employeeNo),
      cardNo: String(cardNo),
      cardType: 'normalCard',
    },
  });
}

module.exports = {
  fetchAllUsers, fetchEvents, nextEmployeeNo, createDeviceUser, modifyDeviceUser, deleteDeviceUser, setCardForUser,
  DeviceAuthError, authState,
};
