// Login accounts, password hashing, sessions, and the permission-check
// middleware every route below gates itself on. Kept as its own module
// (rather than folded into server.js) the same way deviceAuthState.js and
// digest.js are already split out -- this is a distinct concern (who is
// allowed to do what) from the route handlers that ask it the question.
//
// Password hashing uses Node's own built-in crypto.scrypt -- deliberately
// not a new dependency (bcrypt/argon2 would need native compilation or
// their own package, and scrypt is already a well-regarded, memory-hard
// KDF built into Node itself). Sessions are opaque random tokens stored in
// the sessions table (see db.js), not JWTs -- a JWT's whole value
// proposition is verifying a token WITHOUT a database round-trip, which
// doesn't matter here (every request already hits SQLite for other data),
// and a DB-backed session can be revoked immediately (delete the row);
// a JWT can't be revoked before it expires without a denylist that ends up
// being the same database lookup anyway.

const crypto = require('crypto');
const cookie = require('cookie');
const db = require('./db');
const logger = require('./logger');

const SESSION_COOKIE_NAME = 'face_terminal_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60_000; // 30 days -- a staff dashboard, not a banking app; re-logging in every visit isn't worth the friction

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

// Timing-safe: a plain `===` on the computed vs. stored hash would leak how
// many leading bytes matched via response-time differences, in principle
// usable to brute-force a password hash byte-by-byte. Unlikely to matter on
// a LAN tool with no internet exposure, but costs nothing to do right.
function verifyPassword(password, stored) {
  const [salt, hashHex] = String(stored || '').split(':');
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// Runs once at startup. If no accounts exist yet (a brand-new install), an
// admin account is created automatically rather than shipping with a
// hardcoded default (which every past known-default-credential incident on
// embedded/self-hosted software starts with -- see this project's own
// device-password handling for how seriously that's already taken
// elsewhere). ADMIN_USER/ADMIN_PASS in .env let the Windows installer set
// a known one deliberately (same pattern as DEVICE_PASS); with neither set
// (e.g. running straight off a fresh clone without the installer), a
// random password is generated and printed to the log ONCE -- loud and
// clear, since there's no other way to ever see it again.
function bootstrapAdmin() {
  if (db.countUsers() > 0) return;
  const username = process.env.ADMIN_USER || 'admin';
  let password = process.env.ADMIN_PASS;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe, no ambiguous punctuation to mis-type
    generated = true;
  }
  db.createUser({
    username,
    passwordHash: hashPassword(password),
    isAdmin: true,
    canView: true,
    canEdit: true,
    canAdd: true,
    canRemove: true,
  });
  if (generated) {
    logger.log(`[auth] no accounts existed yet -- created admin account "${username}" with a generated password: ${password}`);
    logger.log('[auth] write that password down now and change it after logging in (Settings -> Users) -- it is never shown again.');
  } else {
    logger.log(`[auth] no accounts existed yet -- created admin account "${username}" from ADMIN_USER/ADMIN_PASS`);
  }
}

function createSessionForUser(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  db.createSession(token, userId, expiresAt);
  return { token, expiresAt };
}

// The `cookie` package's v2 API (installed here) is a real, non-obvious
// break from the classic cookie.serialize()/cookie.parse() functions most
// existing code/examples still assume -- it's stringifyCookie/parseCookie
// (plus stringifySetCookie for a full Set-Cookie header, which is the one
// actually needed here) now, each cookie's attributes passed as one object
// rather than a separate (name, value, options) argument list. Verified
// live against the installed version (2.0.1), not assumed from memory.
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', cookie.stringifySetCookie({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true, // never readable from client-side JS -- the only thing that should ever see this token is the browser's own cookie jar and this server
    sameSite: 'lax', // blocks the cookie being sent on a cross-site POST (basic CSRF hardening) while still working for normal same-site navigation/fetch
    path: '/',
    maxAge: SESSION_DURATION_MS / 1000,
  }));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookie.stringifySetCookie({
    name: SESSION_COOKIE_NAME, value: '', httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0,
  }));
}

function readSessionToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parsed = cookie.parseCookie(header);
  return parsed[SESSION_COOKIE_NAME] || null;
}

// Attaches req.user when a valid, unexpired session cookie is present;
// otherwise responds 401 (API calls) or redirects to /login.html (page
// loads) without ever reaching the route handler. Static assets the login
// page itself needs (style.css, fonts, favicon, login.html/app.js's own
// bundle) are mounted BEFORE this middleware in server.js specifically so
// an unauthenticated browser can actually render a login form at all.
function requireAuth(req, res, next) {
  const token = readSessionToken(req);
  const session = token ? db.getSessionWithUser(token) : null;
  if (!session || new Date(session.expires_at) < new Date()) {
    if (session) db.deleteSession(token); // expired -- clean it up while we're here
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'გთხოვთ შეხვიდეთ სისტემაში' });
    }
    return res.redirect('/login.html');
  }
  req.user = session;
  req.sessionToken = token;
  next();
}

// Factory, not a single middleware -- each protected route names exactly
// which capability it needs (e.g. requirePermission('can_add')), so the
// permission model stays declarative at the route table instead of buried
// in each handler's body. is_admin always passes every check -- an admin
// can do everything the four specific flags could ever grant, by
// definition of what "admin" means here.
function requirePermission(flag) {
  return (req, res, next) => {
    if (req.user.is_admin || req.user[flag]) return next();
    return res.status(403).json({ error: 'ამ მოქმედებისთვის არ გაქვთ უფლება — მიმართეთ ადმინისტრატორს' });
  };
}

// Separate from requirePermission -- account/device/settings management
// isn't any of the four per-employee capabilities (view/edit/add/remove),
// it's "can touch the things that affect every user of this dashboard, not
// just the data", which only an admin should ever be able to do.
function requireAdmin(req, res, next) {
  if (req.user.is_admin) return next();
  return res.status(403).json({ error: 'ეს მხოლოდ ადმინისტრატორისთვისაა ხელმისაწვდომი' });
}

module.exports = {
  SESSION_COOKIE_NAME,
  hashPassword, verifyPassword, bootstrapAdmin,
  createSessionForUser, setSessionCookie, clearSessionCookie, readSessionToken,
  requireAuth, requirePermission, requireAdmin,
};
