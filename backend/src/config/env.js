const net = require("node:net");
const jwt = require("jsonwebtoken");

// Checks the settings the server needs BEFORE it starts, so a mistake in backend/.env is
// reported at once, with every problem listed, instead of breaking the first login later.
//
// Everything here is a pure function (no process.exit, no printing) so it can be tested.
// server.js is the only place that calls validateEnv and stops the server.
//
// The messages name the variable and say what is wrong. They never contain the VALUE of a
// variable, so passwords and secrets cannot end up in a log.

const JWT_SECRET_MIN_LENGTH = 32;
const DEFAULT_PORT = 5000;

// A value is "missing" when it is not set or only spaces
const isBlank = (value) => value === undefined || value === null || String(value).trim() === "";

// The word list that marks the secret from .env.example (or a similar placeholder)
const PLACEHOLDER_SECRET = /(replace|change[-_ ]?me|your[-_ ]?secret|example|placeholder)/i;

// ---------------------------------------------------------------------------
// TRUST_PROXY
// ---------------------------------------------------------------------------
// Behind a reverse proxy (nginx, a hosting platform, ...) every request seems to come from the
// proxy's address. Express can read the real address from the X-Forwarded-For header, but ONLY
// if it is told which proxies to trust. A client can send that header itself, so trusting it
// blindly would let anyone pretend to be another IP address (and dodge the login limiter).
//
//   unset / false   do not trust any proxy (the default; X-Forwarded-For is ignored)
//   1, 2, 3 ...     the number of proxies between the internet and this server (recommended)
//   a list          trusted proxy addresses: loopback, linklocal, uniquelocal, an IP or a CIDR range
// The plain value "true" is refused on purpose: it trusts whatever the client claims.
const TRUST_PROXY_KEYWORDS = ["loopback", "linklocal", "uniquelocal"];
const TRUST_PROXY_HELP =
  "TRUST_PROXY must be false, the number of proxies in front of the server (for example 1), " +
  "or a comma-separated list of trusted proxy addresses";

const isTrustedAddress = (token) => {
  if (TRUST_PROXY_KEYWORDS.includes(token)) return true;
  const [address, prefix, ...rest] = token.split("/");
  if (rest.length > 0 || !net.isIP(address)) return false;
  if (prefix === undefined) return true;
  const maxPrefix = net.isIPv4(address) ? 32 : 128;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= maxPrefix;
};

// Returns { value, error }. `value` is what to give to app.set("trust proxy", value).
// An invalid setting gives value = false (trust nobody), the safe choice.
const parseTrustProxy = (raw) => {
  if (isBlank(raw)) return { value: false, error: "" };
  const text = String(raw).trim();

  if (text.toLowerCase() === "false") return { value: false, error: "" };

  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops > 10) return { value: false, error: TRUST_PROXY_HELP };
    return { value: hops === 0 ? false : hops, error: "" };
  }

  if (text.toLowerCase() === "true") {
    return {
      value: false,
      error: `${TRUST_PROXY_HELP}. "true" is not accepted because it trusts any X-Forwarded-For header a client sends`,
    };
  }

  const tokens = text.split(",").map((token) => token.trim().toLowerCase());
  if (tokens.every((token) => token !== "" && isTrustedAddress(token))) {
    return { value: tokens.join(","), error: "" };
  }
  return { value: false, error: TRUST_PROXY_HELP };
};

// ---------------------------------------------------------------------------
// LOG_REQUESTS
// ---------------------------------------------------------------------------
// Request logging is on unless LOG_REQUESTS=false. (The tests switch it off.)
const parseLogRequests = (raw) => {
  if (isBlank(raw)) return { value: true, error: "" };
  const text = String(raw).trim().toLowerCase();
  if (text === "true") return { value: true, error: "" };
  if (text === "false") return { value: false, error: "" };
  return { value: true, error: "LOG_REQUESTS must be true or false" };
};

// ---------------------------------------------------------------------------
// JWT_EXPIRES_IN
// ---------------------------------------------------------------------------
// Uses the same library that signs the tokens, so "valid" means "the library accepts it".
// A bare number such as 3600 is refused: the library would read it as MILLISECONDS (3.6 seconds).
const isValidTokenLifetime = (text) => {
  if (/^\d+$/.test(text)) return false;
  try {
    const token = jwt.sign({}, "x".repeat(JWT_SECRET_MIN_LENGTH), { expiresIn: text });
    const { exp, iat } = jwt.decode(token);
    return Number.isFinite(exp) && Number.isFinite(iat) && exp - iat >= 1;
  } catch (error) {
    return false;
  }
};

// ---------------------------------------------------------------------------
// The whole check
// ---------------------------------------------------------------------------
// env: normally process.env.
// Returns { errors, values }:
//   errors  a list of messages (empty = the configuration is fine)
//   values  the settings the server itself needs: { port, trustProxy, logRequests }
const validateEnv = (env = process.env) => {
  const errors = [];

  // MONGODB_URI
  if (isBlank(env.MONGODB_URI)) {
    errors.push("MONGODB_URI is missing. Add your MongoDB connection string to backend/.env");
  } else if (!/^mongodb(\+srv)?:\/\//i.test(String(env.MONGODB_URI).trim())) {
    errors.push("MONGODB_URI must start with mongodb:// or mongodb+srv://");
  }

  // JWT_SECRET
  if (isBlank(env.JWT_SECRET)) {
    errors.push("JWT_SECRET is missing. Add a long random secret to backend/.env");
  } else if (String(env.JWT_SECRET).length < JWT_SECRET_MIN_LENGTH) {
    errors.push(`JWT_SECRET is too short. Use at least ${JWT_SECRET_MIN_LENGTH} characters`);
  } else if (PLACEHOLDER_SECRET.test(String(env.JWT_SECRET))) {
    errors.push("JWT_SECRET still looks like the placeholder from .env.example. Generate a real random secret");
  }

  // JWT_EXPIRES_IN (optional; the default is 1d)
  if (!isBlank(env.JWT_EXPIRES_IN) && !isValidTokenLifetime(String(env.JWT_EXPIRES_IN).trim())) {
    errors.push('JWT_EXPIRES_IN is not valid. Use a number with a unit, for example 1d, 12h or 30m');
  }

  // PORT (optional; the default is 5000)
  let port = DEFAULT_PORT;
  if (!isBlank(env.PORT)) {
    const text = String(env.PORT).trim();
    if (/^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 65535) {
      port = Number(text);
    } else {
      errors.push("PORT must be a whole number between 1 and 65535");
    }
  }

  // CLIENT_URL (optional). It must be an ORIGIN, because the browser compares it letter for letter
  // with the page's address. A trailing slash or a path would silently block the whole frontend.
  if (!isBlank(env.CLIENT_URL)) {
    const text = String(env.CLIENT_URL).trim();
    let valid = false;
    try {
      const url = new URL(text);
      valid = (url.protocol === "http:" || url.protocol === "https:") && url.origin === text;
    } catch (error) {
      valid = false;
    }
    if (!valid) {
      errors.push("CLIENT_URL must be a web address without a path or a trailing slash, for example http://localhost:5173");
    }
  }

  // TRUST_PROXY and LOG_REQUESTS
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (trustProxy.error) errors.push(trustProxy.error);
  const logRequests = parseLogRequests(env.LOG_REQUESTS);
  if (logRequests.error) errors.push(logRequests.error);

  return { errors, values: { port, trustProxy: trustProxy.value, logRequests: logRequests.value } };
};

module.exports = {
  JWT_SECRET_MIN_LENGTH,
  DEFAULT_PORT,
  validateEnv,
  parseTrustProxy,
  parseLogRequests,
};
