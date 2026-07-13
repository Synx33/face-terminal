// The device is in Georgia (Asia/Tbilisi, fixed UTC+4, no DST). Deliberately
// NOT using this machine's configured timezone (date.getTimezoneOffset())
// anywhere below: this app ships on a laptop that gets moved between
// networks, and there's no guarantee whoever sets it up at the install site
// remembers to set the OS timezone to Georgia — Windows defaults to
// whatever region it was originally set up in. Computing from the absolute
// UTC instant instead means this is correct regardless of the machine's
// timezone setting; it only depends on the system clock's absolute time
// being right, which NTP handles automatically.
const GEORGIA_OFFSET_HOURS = 4;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DDTHH:MM:SS" in Georgia local time, no offset suffix — for fields the device treats as implicitly local (e.g. UserInfo.Valid). */
function georgiaNaive(date) {
  const shifted = new Date(date.getTime() + GEORGIA_OFFSET_HOURS * 3600_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

/** ISAPI wants local time with an explicit UTC offset for AcsEvent search (e.g. 2026-07-11T16:20:00+04:00). */
function isoWithOffset(date) {
  return `${georgiaNaive(date)}+04:00`;
}

module.exports = { isoWithOffset, georgiaNaive, GEORGIA_OFFSET_HOURS };
