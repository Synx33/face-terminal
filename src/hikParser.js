// Normalizes an AcsEvent search-result record (ISAPI
// AccessControl/AcsEvent) into the flat shape our db/dashboard use.
//
// Confirmed against the DS-K1T343EWX directly: events with a populated
// `name`/`employeeNoString` are actual identity verifications (face/card
// match) — door-status and tamper events never carry those fields. That's
// the signal isCheckin() uses to tell "this is a check-in" from
// "this is just a door/relay event".
//
// We use AcsEvent search exclusively (polling — see poller.js) rather than
// the device's httpHosts push mechanism: arming push notifications flooded
// us with an unrelated historical backlog instead of real-time events.

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function deepFind(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Tries each key in order and returns the first present value. Kept generic
// (rather than one fixed field name) because this device has already shown
// two different names for the same field across contexts — e.g.
// employeeNoString vs. employeeNo — so a bit of alias tolerance here is
// cheap insurance, not speculative generality.
function firstOf(doc, keys) {
  for (const key of keys) {
    const v = deepFind(doc, key);
    if (v !== undefined && v !== null) return String(v);
  }
  return null;
}

function parseJsonEvent(doc) {
  return {
    eventTime: firstOf(doc, ['time']),
    deviceIp: firstOf(doc, ['ipAddress']),
    deviceSerial: firstOf(doc, ['deviceID', 'macAddress']),
    majorEvent: toInt(firstOf(doc, ['major'])),
    minorEvent: toInt(firstOf(doc, ['minor'])),
    verifyMode: firstOf(doc, ['currentVerifyMode']),
    doorNo: toInt(firstOf(doc, ['doorNo'])),
    readerNo: toInt(firstOf(doc, ['cardReaderNo'])),
    employeeNo: firstOf(doc, ['employeeNoString', 'employeeNo']),
    name: firstOf(doc, ['name']),
    cardNo: firstOf(doc, ['cardNo']),
    serialNo: toInt(firstOf(doc, ['serialNo'])),
    raw: JSON.stringify(doc),
  };
}

// A bare cardNo counts too, alongside name/employeeNo — added for the
// DS-K2802 card-reader controller, where the device itself may or may not
// resolve the swipe to an employeeNo the same reliable way the face
// terminal's own UserInfo lookup does (unverified until tested against real
// hardware — see scripts/diagnose-card-device.js). Treating any of the three
// as "an identification was attempted" lets db.js's insertCheckin() resolve
// the person locally via its own card_no mapping even if the device didn't,
// rather than silently dropping the event here before it ever gets a chance to.
/** True if this event represents an identified person (a check-in), not a bare door/tamper event. */
function isCheckin(parsed) {
  return Boolean(parsed.name || parsed.employeeNo || parsed.cardNo);
}

module.exports = { parseJsonEvent, isCheckin };
