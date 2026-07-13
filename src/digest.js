// Minimal HTTP Digest auth client for Hikvision ISAPI.
//
// Hikvision devices challenge every request with `WWW-Authenticate: Digest ...`
// on the first (unauthenticated) try. We parse that challenge, compute the
// digest response per RFC 7616, and retry once with an `Authorization` header.
// We don't cache the nonce across calls — re-challenging on every request is
// simpler and the extra round trip is irrelevant on a LAN.

const crypto = require('crypto');

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function parseChallenge(header) {
  // header looks like: Digest qop="auth", realm="...", nonce="...", ...
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(header)) !== null) {
    out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

let cnonceCounter = 0;
function nextCnonce() {
  cnonceCounter += 1;
  return crypto.createHash('sha1').update(`${process.pid}-${cnonceCounter}-${crypto.randomBytes(8).toString('hex')}`).digest('hex').slice(0, 16);
}

/**
 * Perform one HTTP request against a Hikvision device with Digest auth,
 * handling the initial 401 challenge automatically.
 *
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.url        full URL, e.g. https://10.10.11.184/ISAPI/...
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {Buffer|string} [opts.body]
 * @param {object} [opts.headers]
 * @returns {Promise<{status:number, headers:Headers, text:string, buffer:Buffer}>}
 */
// req.setTimeout() alone was tried first and did NOT work in production — a
// connection sat ESTABLISHED-but-idle for over a day despite a 10s socket
// timeout being wired up, silently freezing the poller forever (setInterval
// doesn't wait for the previous async tick, so once one call never settles,
// every later tick piles up behind it with nothing ever erroring). Node's
// socket-idle timeout semantics clearly didn't fire the way documented for
// whatever this connection's stuck state actually was. This wraps every
// individual HTTP attempt in an explicit Promise.race against a hard
// deadline, so the *promise* always settles within HARD_TIMEOUT_MS
// regardless of what the underlying socket is actually doing — belt and
// suspenders over the socket-level timeout, not a replacement for it.
const DEFAULT_HARD_TIMEOUT_MS = 10_000;

function withHardTimeout(promise, label, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} hard-timed-out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function digestRequest({ method, url, username, password, body, headers = {}, timeoutMs = DEFAULT_HARD_TIMEOUT_MS }) {
  // Using Node's http/https modules directly (not global fetch) so we can pass
  // rejectUnauthorized: false per-request — the device's cert is self-signed.
  const nodeHttp = url.startsWith('https:') ? require('https') : require('http');
  const { URL } = require('url');

  // Hikvision's firmware expects the real body on the *first* (unauthenticated)
  // attempt too — same as curl --digest does. Sending an empty body there
  // caused it to hang the connection rather than reply with a clean 401.
  const payload = body !== undefined ? Buffer.from(body) : undefined;
  const bodyHeaders = payload ? { 'Content-Length': String(payload.length) } : {};

  function rawRequest(extraHeaders) {
    let req;
    const attempt = new Promise((resolve, reject) => {
      const u = new URL(url);
      req = nodeHttp.request(
        {
          method,
          hostname: u.hostname,
          port: u.port || (url.startsWith('https:') ? 443 : 80),
          path: u.pathname + u.search,
          headers: { ...headers, ...bodyHeaders, ...extraHeaders },
          rejectUnauthorized: false,
          agent: false, // never reuse a pooled connection — a bad/stuck socket must never be handed to a later request
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8') });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
    // If the hard timeout wins the race, kill the underlying socket so it
    // can't linger ESTABLISHED-but-idle forever (which is exactly what we
    // found in production — a connection stuck open for over a day).
    return withHardTimeout(attempt, `${method} ${url}`, timeoutMs).catch((err) => {
      req.destroy();
      throw err;
    });
  }

  const first = await rawRequest({});
  if (first.status !== 401) return first;

  const challengeHeader = first.headers['www-authenticate'];
  if (!challengeHeader) return first;
  // Prefer the Digest challenge if multiple WWW-Authenticate headers are sent.
  const digestHeader = Array.isArray(challengeHeader)
    ? challengeHeader.find((h) => h.startsWith('Digest'))
    : challengeHeader;
  if (!digestHeader || !digestHeader.startsWith('Digest')) return first;

  const chal = parseChallenge(digestHeader);
  const u = new URL(url);
  const uri = u.pathname + u.search;
  const nc = '00000001';
  const cnonce = nextCnonce();
  const ha1 = md5(`${username}:${chal.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  let response;
  let authHeader;
  if (chal.qop) {
    response = md5(`${ha1}:${chal.nonce}:${nc}:${cnonce}:${chal.qop}:${ha2}`);
    authHeader = `Digest username="${username}", realm="${chal.realm}", nonce="${chal.nonce}", uri="${uri}", qop=${chal.qop}, nc=${nc}, cnonce="${cnonce}", response="${response}", opaque="${chal.opaque || ''}"`;
  } else {
    response = md5(`${ha1}:${chal.nonce}:${ha2}`);
    authHeader = `Digest username="${username}", realm="${chal.realm}", nonce="${chal.nonce}", uri="${uri}", response="${response}"`;
  }

  return rawRequest({ Authorization: authHeader });
}

module.exports = { digestRequest };
