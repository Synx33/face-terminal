// Connects to the DS-K2802 card-reader controller and prints every
// real-time access-control event it sees for 60 seconds, decoded. Use this
// after setting up CARD_DEVICE_IP (and vendor/hcnetsdk/win64/, see README)
// to confirm the connection actually works and to see what a REAL card
// swipe looks like decoded, before relying on it silently inside the app.
//
// Run from the install directory so .env is picked up:
//   node --env-file=.env scripts\diagnose-card-sdk.js
//
// What a healthy run looks like:
//   1. "connected, lUserID = N" -- login succeeded.
//   2. Swipe a real card at the reader within the 60s window.
//   3. An "EVENT" line prints with a non-null cardNo matching the card's
//      actual printed/encoded number, and a timestamp matching right now.
// If nothing prints for a genuine swipe, or cardNo is always null even for
// a real swipe, that's the thing to investigate next -- see cardSdk.js's
// extractCardNo() comment for how that field is currently located.

const cardSdk = require('../src/cardSdk');

const ip = process.env.CARD_DEVICE_IP;
if (!ip) {
  console.error('CARD_DEVICE_IP is not set in .env -- nothing to connect to.');
  process.exit(1);
}

console.log(`connecting to ${ip}:8000 ...`);
let conn;
try {
  conn = cardSdk.connect(
    {
      ip,
      user: process.env.CARD_DEVICE_USER || process.env.DEVICE_USER,
      pass: process.env.CARD_DEVICE_PASS || process.env.DEVICE_PASS,
    },
    (event) => {
      console.log('\n=== EVENT ===');
      console.log('  cardNo:  ', event.cardNo ?? '(none -- not a card swipe, e.g. a login/operation event)');
      console.log('  time:    ', event.eventTime.toISOString());
      console.log('  major:   ', event.dwMajor);
      console.log('  minor:   ', event.dwMinor);
    },
  );
} catch (err) {
  console.error('FAILED TO CONNECT:', err.message);
  process.exit(1);
}

console.log(`connected, lUserID = ${conn.lUserID}, alarmHandle = ${conn.alarmHandle}`);
console.log('listening for 60 seconds -- swipe a real card at the reader now...\n');

setTimeout(() => {
  conn.close();
  console.log('\ndone, connection closed cleanly.');
}, 60_000);
