const AppError = require("../utils/AppError");

// A small limiter for FAILED attempts (wrong passwords). Needs no extra package.
//
// How it works: every failed attempt for a key (see attemptKey) is counted. The first failure
// starts a window (15 minutes). When the count reaches the limit, further attempts get HTTP 429
// until the window ends, even with the right password. A successful attempt resets the count.
//
// IMPORTANT LIMITS (read before going to production):
//   * The counts live in THIS server process's memory. They are lost when the server restarts,
//     and with several server instances each one counts on its own. That is NOT enough for a
//     multi-instance deployment; a shared store (for example Redis) would be needed there.
//   * The key is IP + e-mail, so one IP trying many different e-mails is not slowed down
//     by this limiter, and behind a proxy every visitor may share one IP unless the proxy
//     setting of Express is configured.

// The clock every limiter uses. Tests replace `clock.now` to move time without waiting.
const clock = { now: () => Date.now() };

const FIFTEEN_MINUTES = 15 * 60 * 1000;

const createAttemptLimiter = ({
  maxAttempts = 10,
  windowMs = FIFTEEN_MINUTES,
  maxEntries = 10000, // keeps memory bounded if someone invents endless keys
  now = () => clock.now(),
} = {}) => {
  const entries = new Map(); // key -> { count, resetAt }

  // The entry of a key, or null when there is none or its window has ended
  const liveEntry = (key) => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.resetAt <= now()) {
      entries.delete(key);
      return null;
    }
    return entry;
  };

  const sweep = () => {
    const time = now();
    for (const [key, entry] of entries) {
      if (entry.resetAt <= time) entries.delete(key);
    }
  };

  return {
    maxAttempts,
    windowMs,

    // { blocked, retryAfterSeconds }
    check(key) {
      const entry = liveEntry(key);
      if (entry && entry.count >= maxAttempts) {
        return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now()) / 1000)) };
      }
      return { blocked: false, retryAfterSeconds: 0 };
    },

    // Counts one failed attempt. Returns the number of failures in the current window.
    fail(key) {
      let entry = liveEntry(key);
      if (!entry) {
        if (entries.size >= maxEntries) sweep();
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value); // drop the oldest
        entry = { count: 0, resetAt: now() + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      return entry.count;
    },

    reset(key) {
      entries.delete(key);
    },

    clear() {
      entries.clear();
    },

    size() {
      return entries.size;
    },
  };
};

// One limiter for each protected action, so a failed login does not use up change-password attempts
const loginLimiter = createAttemptLimiter();
const changePasswordLimiter = createAttemptLimiter();

// IP address + e-mail (lower case, cut to the longest valid e-mail length)
const attemptKey = (req, email) => `${req.ip}|${String(email).trim().toLowerCase().slice(0, 254)}`;

// Throws HTTP 429 (with a Retry-After header) when the key has used up its attempts
const assertNotBlocked = (limiter, key, res) => {
  const { blocked, retryAfterSeconds } = limiter.check(key);
  if (!blocked) return;

  const minutes = Math.ceil(retryAfterSeconds / 60);
  res.set("Retry-After", String(retryAfterSeconds));
  throw new AppError(
    `Too many failed attempts. Please try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
    429
  );
};

module.exports = { clock, createAttemptLimiter, loginLimiter, changePasswordLimiter, attemptKey, assertNotBlocked };
