// Thin wrapper around the DS-K1T343EWX's ISAPI for the calls we actually need:
// pulling the enrolled-user list (to resolve names) and pulling historical
// AcsEvent records (to backfill anything the live push might have missed,
// e.g. while this service was down).

const { digestRequest } = require('./digest');
const { getDeviceIp } = require('./deviceState');
const { georgiaNaive } = require('./time');

function baseUrl() {
  const protocol = process.env.DEVICE_PROTOCOL || 'http';
  return `${protocol}://${getDeviceIp()}`;
}

async function isapi(method, path, jsonBody) {
  const res = await digestRequest({
    method,
    url: `${baseUrl()}${path}`,
    username: process.env.DEVICE_USER,
    password: process.env.DEVICE_PASS,
    headers: jsonBody ? { 'Content-Type': 'application/json' } : {},
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });
  if (res.status >= 300) {
    throw new Error(`ISAPI ${method} ${path} -> HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  }
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

// Live snapshot from the terminal's own camera (channel 101 — its channel
// name matches this device's serial number). Used to grab a photo at the
// moment a check-in is detected; there's no historical-photo API for
// AcsEvent search results (confirmed: JSON records carry a FaceRect bounding
// box but no picture reference), so this is "as-close-to-the-moment-as-our-
// poll-interval-allows", not the exact verification frame.
async function fetchSnapshot() {
  const res = await digestRequest({
    method: 'GET',
    url: `${baseUrl()}/ISAPI/Streaming/channels/101/picture`,
    username: process.env.DEVICE_USER,
    password: process.env.DEVICE_PASS,
  });
  if (res.status !== 200) throw new Error(`fetchSnapshot -> HTTP ${res.status}`);
  return res.buffer;
}

/** Next free numeric employeeNo — one past the current highest, so new hires never collide. */
async function nextEmployeeNo() {
  const users = await fetchAllUsers();
  const nums = users.map((u) => parseInt(u.employeeNo, 10)).filter(Number.isFinite);
  return String((nums.length ? Math.max(...nums) : 0) + 1);
}

/** Creates or updates an enrolled user (name + door rights). Face photo is a separate call. */
async function upsertDeviceUser({ employeeNo, name }) {
  const now = new Date();
  const tenYearsOut = new Date(now);
  tenYearsOut.setFullYear(tenYearsOut.getFullYear() + 10);
  return isapi('POST', '/ISAPI/AccessControl/UserInfo/Record?format=json', {
    UserInfo: {
      employeeNo: String(employeeNo),
      name,
      userType: 'normal',
      Valid: {
        enable: true,
        // timeType: 'local' means the device reads these as ITS OWN local
        // clock (Georgia) — georgiaNaive gives that regardless of what
        // timezone this machine happens to be configured with.
        beginTime: georgiaNaive(now),
        endTime: georgiaNaive(tenYearsOut),
        timeType: 'local',
      },
      doorRight: '1',
      RightPlan: [{ doorNo: 1, planTemplateNo: '1' }],
    },
  });
}

/** Uploads a face photo for an already-created employeeNo. jpegBuffer must be a real JPEG. */
async function uploadFace({ employeeNo, jpegBuffer }) {
  const boundary = `----faceterminal${Date.now()}`;
  const metaPart = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="FaceDataRecord"\r\n' +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify({ faceLibType: 'blackFD', FDID: '1', FPID: String(employeeNo) }) +
    '\r\n',
  );
  const imagePart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="img"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpegBuffer,
    Buffer.from('\r\n'),
  ]);
  const closing = Buffer.from(`--${boundary}--\r\n`);
  const body = Buffer.concat([metaPart, imagePart, closing]);

  const res = await digestRequest({
    method: 'PUT', // confirmed against the device — POST returns methodNotAllowed here
    url: `${baseUrl()}/ISAPI/Intelligent/FDLib/FDSetUp?format=json`,
    username: process.env.DEVICE_USER,
    password: process.env.DEVICE_PASS,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (res.status >= 300) throw new Error(`uploadFace -> HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  return JSON.parse(res.text);
}

/** Removes an enrolled user entirely (used to clean up a throwaway test user). */
async function deleteDeviceUser(employeeNo) {
  return isapi('PUT', '/ISAPI/AccessControl/UserInfo/Delete?format=json', {
    UserInfoDelCond: { EmployeeNoList: [{ employeeNo: String(employeeNo) }] },
  });
}

module.exports = {
  fetchAllUsers, fetchEvents, fetchSnapshot, nextEmployeeNo, upsertDeviceUser, uploadFace, deleteDeviceUser,
};
