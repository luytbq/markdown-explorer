import crypto from 'node:crypto';

const SESSION_SECONDS = 7 * 24 * 60 * 60;

/**
 * Failed guesses are limited globally, not per client. Behind a tunnel every
 * request arrives from the tunnel's own loopback connection, so a per-address
 * limit would see one client and either never trip or lock out everybody.
 * A global limit refuses new sign-ins while it holds, but a session that
 * already exists keeps working, so the owner is never locked out of a tab they
 * already have open.
 */
const LIMITS = [
  { windowMs: 60 * 1000, max: 5 },
  { windowMs: 60 * 60 * 1000, max: 30 },
];
const LONGEST_WINDOW_MS = Math.max(...LIMITS.map((l) => l.windowMs));

const digest = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Sessions live in memory, so restarting the server signs everyone out. That is
 * the honest lifetime for a credential the server minted itself, and it means a
 * changed --password cannot leave an old session valid.
 */
export function createAuth({ password, mount = '', now = Date.now }) {
  if (typeof password !== 'string' || password === '') throw new Error('A password must not be empty');

  // Comparing digests gives timingSafeEqual two buffers of one length, whatever
  // was typed, so the comparison leaks neither the contents nor the length.
  const expected = digest(password);
  const sessions = new Map(); // token --> expiry in ms
  let failures = [];

  // Cookies ignore the port, so two instances on one machine would overwrite
  // each other's session under a shared name. The listening port tells them apart.
  const cookieName = (req) => `mdx-session-${req.socket.localPort}`;
  const cookie = (req, value, maxAge) =>
    `${cookieName(req)}=${value}; Path=${mount}/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

  function authenticated(req) {
    const token = readCookie(req, cookieName(req));
    if (!token) return false;
    const expiry = sessions.get(token);
    if (expiry === undefined) return false;
    if (expiry <= now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  /**
   * Seconds until another guess is accepted, or 0 if one is accepted now.
   *
   * A limit holds while its max-th most recent failure is still inside the
   * window, and lifts the moment that one leaves it. The oldest failure is the
   * wrong clock: with more than max in the window, it leaves while enough newer
   * ones remain to keep the limit holding.
   */
  function retryAfter() {
    const t = now();
    failures = failures.filter((at) => t - at < LONGEST_WINDOW_MS);
    let wait = 0;
    for (const { windowMs, max } of LIMITS) {
      const holding = failures[failures.length - max];
      if (holding !== undefined && t - holding < windowMs) {
        wait = Math.max(wait, Math.ceil((holding + windowMs - t) / 1000));
      }
    }
    return wait;
  }

  /** A Set-Cookie value for a new session, or null for a wrong password. */
  function login(req, candidate) {
    if (!crypto.timingSafeEqual(digest(candidate), expected)) {
      failures.push(now());
      return null;
    }
    const t = now();
    for (const [token, expiry] of sessions) if (expiry <= t) sessions.delete(token);

    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, t + SESSION_SECONDS * 1000);
    return cookie(req, token, SESSION_SECONDS);
  }

  /** Ends the request's session, and returns the Set-Cookie value that clears it. */
  function logout(req) {
    const token = readCookie(req, cookieName(req));
    if (token) sessions.delete(token);
    return cookie(req, '', 0);
  }

  return { authenticated, retryAfter, login, logout };
}
