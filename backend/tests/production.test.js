const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const express = require("express");

const helpers = require("./helpers");
const Product = require("../src/models/Product");
const app = require("../src/app");
const { validateEnv, parseTrustProxy, parseLogRequests } = require("../src/config/env");
const securityHeaders = require("../src/middleware/securityHeaders");
const { createRequestLogger, cleanPath } = require("../src/middleware/requestLogger");
const { createShutdown, registerShutdownHandlers } = require("../src/utils/gracefulShutdown");
const { loginLimiter, changePasswordLimiter, clock } = require("../src/middleware/rateLimiter");

const BACKEND_DIR = path.join(__dirname, "..");
const GOOD_SECRET = "a".repeat(8) + "0123456789abcdef".repeat(2) + "Z9"; // 42 characters, no placeholder words
const goodEnv = () => ({
  MONGODB_URI: "mongodb://127.0.0.1:27017/some_database",
  JWT_SECRET: GOOD_SECRET,
  JWT_EXPIRES_IN: "1d",
  PORT: "5000",
  CLIENT_URL: "http://localhost:5173",
});

let request;
let server;

before(async () => {
  await helpers.connectTestDatabase();
  server = await helpers.startServer();
  request = helpers.makeClient(server.baseUrl);
});

after(async () => {
  app.set("trust proxy", false);
  try {
    await helpers.cleanup();
  } finally {
    if (server) await server.close();
    await helpers.disconnect();
  }
});

// ---------------------------------------------------------------------------
// 1. Startup configuration check
// ---------------------------------------------------------------------------
describe("Startup configuration: validateEnv", () => {
  const problemsOf = (env) => validateEnv(env).errors;
  const mentions = (errors, name) => errors.some((message) => message.includes(name));

  it("accepts a good configuration and returns the settings the server needs", () => {
    const { errors, values } = validateEnv(goodEnv());
    assert.deepEqual(errors, []);
    assert.deepEqual(values, { port: 5000, trustProxy: false, logRequests: true });
  });

  it("only MONGODB_URI and JWT_SECRET are required; the rest has defaults", () => {
    const { errors, values } = validateEnv({ MONGODB_URI: "mongodb://localhost/x", JWT_SECRET: GOOD_SECRET });
    assert.deepEqual(errors, []);
    assert.equal(values.port, 5000);
    const nothing = validateEnv({});
    assert.equal(nothing.errors.length, 2);
    assert.ok(mentions(nothing.errors, "MONGODB_URI") && mentions(nothing.errors, "JWT_SECRET"));
  });

  it("reports a missing or blank MONGODB_URI", () => {
    for (const value of [undefined, "", "   "]) {
      const errors = problemsOf({ ...goodEnv(), MONGODB_URI: value });
      assert.equal(errors.length, 1, JSON.stringify(value));
      assert.match(errors[0], /MONGODB_URI is missing/);
    }
  });

  it("reports a MONGODB_URI that is not a MongoDB address", () => {
    for (const value of ["localhost:27017", "http://localhost", "mysql://x/y", "just text"]) {
      assert.ok(mentions(problemsOf({ ...goodEnv(), MONGODB_URI: value }), "MONGODB_URI must start with"), value);
    }
    for (const value of ["mongodb://localhost", "mongodb+srv://u:p@cluster.example.net/db?retryWrites=true"]) {
      assert.deepEqual(problemsOf({ ...goodEnv(), MONGODB_URI: value }), [], value);
    }
  });

  it("reports a missing or blank JWT_SECRET", () => {
    for (const value of [undefined, "", "     "]) {
      const errors = problemsOf({ ...goodEnv(), JWT_SECRET: value });
      assert.equal(errors.length, 1, JSON.stringify(value));
      assert.match(errors[0], /JWT_SECRET is missing/);
    }
  });

  it("refuses a JWT_SECRET shorter than 32 characters, and accepts exactly 32", () => {
    for (const length of [1, 10, 31]) {
      const errors = problemsOf({ ...goodEnv(), JWT_SECRET: "k".repeat(length) });
      assert.equal(errors.length, 1, `length ${length}`);
      assert.match(errors[0], /JWT_SECRET is too short.*32/);
    }
    assert.deepEqual(problemsOf({ ...goodEnv(), JWT_SECRET: "k".repeat(32) }), []);
    assert.deepEqual(problemsOf({ ...goodEnv(), JWT_SECRET: "k".repeat(200) }), []);
  });

  it("refuses the placeholder secret from .env.example, even though it is long enough", () => {
    for (const value of ["replace_with_a_long_random_secret", "please-change-me-to-something-long-and-random", "your_secret_goes_here_for_the_token_x", "an-example-secret-value-that-is-long-enough"]) {
      assert.ok(value.length >= 32, value);
      assert.ok(mentions(problemsOf({ ...goodEnv(), JWT_SECRET: value }), "placeholder"), value);
    }
  });

  it("checks JWT_EXPIRES_IN: valid lifetimes pass, odd ones are refused", () => {
    for (const value of [undefined, "", "1d", "12h", "30m", "90s", "2 days", "1w", "7d"]) {
      assert.deepEqual(problemsOf({ ...goodEnv(), JWT_EXPIRES_IN: value }), [], JSON.stringify(value));
    }
    for (const value of ["abc", "1x", "0", "0s", "-1d", "3600", "1.5.5d", "d1", "one day", "500ms"]) {
      const errors = problemsOf({ ...goodEnv(), JWT_EXPIRES_IN: value });
      assert.equal(errors.length, 1, JSON.stringify(value));
      assert.match(errors[0], /JWT_EXPIRES_IN is not valid/);
    }
  });

  it("checks PORT: whole numbers from 1 to 65535 only", () => {
    for (const [value, expected] of [["3000", 3000], ["1", 1], ["65535", 65535], [undefined, 5000], ["", 5000], [" 8080 ", 8080]]) {
      const { errors, values } = validateEnv({ ...goodEnv(), PORT: value });
      assert.deepEqual(errors, [], JSON.stringify(value));
      assert.equal(values.port, expected);
    }
    for (const value of ["0", "65536", "-1", "abc", "3000.5", "80a", "1e3", "0x50", "99999"]) {
      const errors = problemsOf({ ...goodEnv(), PORT: value });
      assert.equal(errors.length, 1, JSON.stringify(value));
      assert.match(errors[0], /PORT must be a whole number between 1 and 65535/);
    }
  });

  it("checks CLIENT_URL: an origin only (a trailing slash would silently break CORS)", () => {
    for (const value of ["http://localhost:5173", "https://shop.example.com", "http://127.0.0.1:3000", undefined, ""]) {
      assert.deepEqual(problemsOf({ ...goodEnv(), CLIENT_URL: value }), [], JSON.stringify(value));
    }
    for (const value of ["http://localhost:5173/", "localhost:5173", "http://shop.example.com/app", "ftp://shop.example.com", "not a url", "http://localhost:5173?x=1"]) {
      assert.ok(mentions(problemsOf({ ...goodEnv(), CLIENT_URL: value }), "CLIENT_URL"), value);
    }
  });

  it("reports ALL problems together, not one at a time", () => {
    const errors = problemsOf({
      MONGODB_URI: "",
      JWT_SECRET: "short",
      JWT_EXPIRES_IN: "never",
      PORT: "99999",
      CLIENT_URL: "http://localhost:5173/",
      TRUST_PROXY: "true",
      LOG_REQUESTS: "maybe",
    });
    assert.equal(errors.length, 7, JSON.stringify(errors));
    for (const name of ["MONGODB_URI", "JWT_SECRET", "JWT_EXPIRES_IN", "PORT", "CLIENT_URL", "TRUST_PROXY", "LOG_REQUESTS"]) {
      assert.ok(mentions(errors, name), `${name} is reported`);
    }
  });

  it("never puts a value from the environment into an error message", () => {
    const env = {
      MONGODB_URI: "ftp://dbuser:LEAKY-db-password@host/db",
      JWT_SECRET: "LEAKY-short-secret",
      JWT_EXPIRES_IN: "LEAKY-lifetime",
      PORT: "LEAKY-port",
      CLIENT_URL: "LEAKY-client-url/",
      TRUST_PROXY: "LEAKY-proxy",
      LOG_REQUESTS: "LEAKY-log",
    };
    const errors = problemsOf(env);
    assert.equal(errors.length, 7);
    const text = errors.join("\n");
    assert.equal(text.includes("LEAKY"), false);
    for (const value of Object.values(env)) assert.equal(text.includes(value), false, value);

    // a VALID secret next to another problem is not printed either
    const other = problemsOf({ ...goodEnv(), JWT_SECRET: GOOD_SECRET, PORT: "nope" }).join("\n");
    assert.equal(other.includes(GOOD_SECRET), false);
    assert.equal(other.includes("mongodb://"), false);
  });

  it("the project's own .env passes the check (so the server will start)", () => {
    assert.deepEqual(validateEnv(process.env).errors, []);
  });

  it(".env.example is consistent: only its placeholder JWT_SECRET is refused", () => {
    const text = fs.readFileSync(path.join(BACKEND_DIR, ".env.example"), "utf8");
    const env = {};
    for (const line of text.split(/\r?\n/)) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      if (match) env[match[1]] = match[2];
    }
    for (const name of ["PORT", "MONGODB_URI", "CLIENT_URL", "JWT_SECRET", "JWT_EXPIRES_IN", "TRUST_PROXY", "LOG_REQUESTS"]) {
      assert.ok(Object.hasOwn(env, name), `${name} is documented in .env.example`);
    }
    const errors = validateEnv(env).errors;
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /placeholder/);
    assert.deepEqual(validateEnv({ ...env, JWT_SECRET: GOOD_SECRET }).errors, []);
  });
});

describe("Startup configuration: TRUST_PROXY and LOG_REQUESTS settings", () => {
  it("TRUST_PROXY: nothing, false and 0 trust nobody", () => {
    for (const value of [undefined, null, "", "  ", "false", "FALSE", "0"]) {
      assert.deepEqual(parseTrustProxy(value), { value: false, error: "" }, JSON.stringify(value));
    }
  });

  it("TRUST_PROXY: a number of proxies, or a list of trusted addresses", () => {
    assert.deepEqual(parseTrustProxy("1"), { value: 1, error: "" });
    assert.deepEqual(parseTrustProxy(" 2 "), { value: 2, error: "" });
    assert.deepEqual(parseTrustProxy("loopback"), { value: "loopback", error: "" });
    assert.deepEqual(parseTrustProxy("loopback, 10.0.0.0/8"), { value: "loopback,10.0.0.0/8", error: "" });
    assert.deepEqual(parseTrustProxy("203.0.113.7"), { value: "203.0.113.7", error: "" });
    assert.deepEqual(parseTrustProxy("2001:db8::1"), { value: "2001:db8::1", error: "" });
    assert.deepEqual(parseTrustProxy("2001:db8::/32"), { value: "2001:db8::/32", error: "" });
  });

  it('TRUST_PROXY: "true" and other odd values are refused, and trust nobody', () => {
    for (const value of ["true", "TRUE", "yes", "11", "999", "-1", "1.5", "loopback,", ",loopback", "10.0.0.0/33", "10.0.0.0/8/8", "not-an-ip", "300.1.1.1", "*", "loopback;uniquelocal"]) {
      const result = parseTrustProxy(value);
      assert.equal(result.value, false, value);
      assert.match(result.error, /TRUST_PROXY must be/, value);
    }
    assert.match(parseTrustProxy("true").error, /any X-Forwarded-For header/);
  });

  it("LOG_REQUESTS: on by default, only true or false are accepted", () => {
    assert.deepEqual(parseLogRequests(undefined), { value: true, error: "" });
    assert.deepEqual(parseLogRequests(""), { value: true, error: "" });
    assert.deepEqual(parseLogRequests("true"), { value: true, error: "" });
    assert.deepEqual(parseLogRequests("false"), { value: false, error: "" });
    assert.deepEqual(parseLogRequests(" FALSE "), { value: false, error: "" });
    assert.match(parseLogRequests("0").error, /LOG_REQUESTS must be true or false/);
  });

  it("the test helper switched request logging off for these tests", () => {
    assert.equal(process.env.LOG_REQUESTS, "false");
  });
});

// ---------------------------------------------------------------------------
// 2. Security headers
// ---------------------------------------------------------------------------
describe("Security headers", () => {
  const get = (urlPath, options = {}) => fetch(server.baseUrl + urlPath, options);

  const expectSafeHeaders = (response, label) => {
    assert.equal(response.headers.get("x-powered-by"), null, `${label}: x-powered-by is gone`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${label}: nosniff`);
    assert.equal(response.headers.get("x-frame-options"), "DENY", `${label}: frame denial`);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", `${label}: referrer policy`);
  };

  it("a normal answer has the safe headers, no x-powered-by, and is NOT marked no-store", async () => {
    for (const urlPath of ["/api/health", "/api/products", "/api/categories"]) {
      const response = await get(urlPath);
      assert.equal(response.status, 200, urlPath);
      expectSafeHeaders(response, urlPath);
      assert.notEqual(response.headers.get("cache-control"), "no-store", `${urlPath} keeps normal caching`);
    }
  });

  it("a 404 answer has the safe headers", async () => {
    const response = await get("/api/does-not-exist");
    assert.equal(response.status, 404);
    expectSafeHeaders(response, "404");
    assert.notEqual(response.headers.get("cache-control"), "no-store");
    assert.equal((await get("/nothing-here")).status, 404);
    expectSafeHeaders(await get("/nothing-here"), "404 outside /api");
  });

  it("error answers (400, 401, 409-style validation) have the safe headers", async () => {
    const badInput = await fetch(`${server.baseUrl}/api/products?minPrice=abc`);
    assert.equal(badInput.status, 400);
    expectSafeHeaders(badInput, "400");
    const noToken = await get("/api/cart");
    assert.equal(noToken.status, 401);
    expectSafeHeaders(noToken, "401");
    const brokenJson = await fetch(`${server.baseUrl}/api/products`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{ nope" });
    assert.equal(brokenJson.status, 400);
    expectSafeHeaders(brokenJson, "broken JSON");
    assert.notEqual(noToken.headers.get("cache-control"), "no-store", "a cart error is not an auth answer");
  });

  it("every answer under /api/auth is no-store: success, errors, and any letter case", async () => {
    const customer = await helpers.createUser("customer");
    const cases = [
      ["POST", "/api/auth/login", { email: customer.user.email, password: "Test-password-123" }, 200],
      ["POST", "/api/auth/login", { email: customer.user.email, password: "Wrong-password-1" }, 401],
      ["POST", "/api/auth/login", {}, 400],
      ["GET", "/api/auth/me", undefined, 401],
      ["GET", "/api/auth/me?x=1", undefined, 401],
      ["GET", "/API/AUTH/me", undefined, 401],
      ["GET", "/api/auth/nothing", undefined, 404],
    ];
    for (const [method, urlPath, body, status] of cases) {
      const response = await fetch(server.baseUrl + urlPath, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      assert.equal(response.status, status, `${method} ${urlPath}`);
      assert.equal(response.headers.get("cache-control"), "no-store", `${method} ${urlPath}`);
      expectSafeHeaders(response, `${method} ${urlPath}`);
    }
    const withToken = await fetch(`${server.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${customer.token}` } });
    assert.equal(withToken.status, 200);
    assert.equal(withToken.headers.get("cache-control"), "no-store");
  });

  it("no-store is NOT added to similar paths outside /api/auth", async () => {
    for (const urlPath of ["/api/authors", "/api/authentication/me", "/auth/me", "/api/products?q=/api/auth"]) {
      const response = await get(urlPath);
      assert.notEqual(response.headers.get("cache-control"), "no-store", urlPath);
    }
  });

  it("the middleware sets the headers before the route runs (so errors from routes keep them)", async () => {
    const small = express();
    small.disable("x-powered-by");
    small.use(securityHeaders);
    small.get("/boom", () => { throw new Error("route failed"); });
    const listener = await new Promise((resolve) => { const s = http.createServer(small); s.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}/boom`);
      assert.equal(response.status, 500);
      expectSafeHeaders(response, "500");
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  });

  it("CORS still works (the allowed origin is echoed, the preflight is answered)", async () => {
    const origin = process.env.CLIENT_URL || "http://localhost:5173";
    const actual = await get("/api/health", { headers: { Origin: origin } });
    assert.equal(actual.headers.get("access-control-allow-origin"), origin);
    const preflight = await get("/api/auth/login", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" },
    });
    assert.ok(preflight.status === 204 || preflight.status === 200, `preflight status ${preflight.status}`);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    expectSafeHeaders(preflight, "preflight");
  });
});

// ---------------------------------------------------------------------------
// 3. TRUST_PROXY and the IP address the limiter uses
// ---------------------------------------------------------------------------
describe("TRUST_PROXY and req.ip", () => {
  // A tiny app configured exactly the way app.js configures the real one
  const askIp = async (setting, headers) => {
    const small = express();
    small.set("trust proxy", parseTrustProxy(setting).value);
    small.get("/ip", (req, res) => res.json({ ip: req.ip }));
    const listener = await new Promise((resolve) => { const s = http.createServer(small); s.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}/ip`, { headers });
      return (await response.json()).ip;
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  };
  const SOCKET_IP = /^(::ffff:)?127\.0\.0\.1$/;

  it("the real app trusts no proxy by default", () => {
    assert.equal(app.get("trust proxy"), false);
  });

  it("disabled: X-Forwarded-For is ignored", async () => {
    for (const setting of [undefined, "false", "0"]) {
      assert.match(await askIp(setting, { "X-Forwarded-For": "203.0.113.50" }), SOCKET_IP, String(setting));
    }
  });

  it("one proxy: the address the proxy appended is used, not what the client claimed first", async () => {
    assert.equal(await askIp("1", { "X-Forwarded-For": "203.0.113.50" }), "203.0.113.50");
    assert.equal(await askIp("1", { "X-Forwarded-For": "9.9.9.9, 203.0.113.50" }), "203.0.113.50");
    assert.match(await askIp("1", {}), SOCKET_IP, "no header: the socket address");
  });

  it("a list of trusted proxies only trusts those", async () => {
    assert.equal(await askIp("loopback", { "X-Forwarded-For": "203.0.113.50" }), "203.0.113.50");
    assert.equal(await askIp("127.0.0.1", { "X-Forwarded-For": "203.0.113.50" }), "203.0.113.50");
    assert.match(await askIp("10.0.0.0/8", { "X-Forwarded-For": "203.0.113.50" }), SOCKET_IP, "this proxy is not in the list");
  });

  it("an invalid setting falls back to trusting nobody", async () => {
    assert.match(await askIp("true", { "X-Forwarded-For": "203.0.113.50" }), SOCKET_IP);
    assert.match(await askIp("garbage", { "X-Forwarded-For": "203.0.113.50" }), SOCKET_IP);
  });

  describe("the login limiter uses the address Express works out", () => {
    beforeEach(() => {
      clock.now = () => 1_800_000_000_000;
      loginLimiter.clear();
      changePasswordLimiter.clear();
    });
    after(() => {
      app.set("trust proxy", false);
      loginLimiter.clear();
      clock.now = () => Date.now();
    });

    const loginFrom = async (email, forwardedFor, password = "Wrong-password-1") => {
      const response = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}) },
        body: JSON.stringify({ email, password }),
      });
      return response.status;
    };

    it("proxy disabled: changing X-Forwarded-For does NOT escape the limit", async () => {
      app.set("trust proxy", false);
      const person = await helpers.createUser("customer");
      for (let i = 0; i < 10; i++) assert.equal(await loginFrom(person.user.email, `198.51.100.${i + 1}`), 401, `attempt ${i + 1}`);
      assert.equal(await loginFrom(person.user.email, "198.51.100.200"), 429, "a new forged address is still the same visitor");
      assert.equal(await loginFrom(person.user.email, undefined, "Test-password-123"), 429);
    });

    it("proxy enabled (1): each real client address has its own count", async () => {
      app.set("trust proxy", 1);
      const person = await helpers.createUser("customer");
      for (let i = 0; i < 10; i++) assert.equal(await loginFrom(person.user.email, "203.0.113.5"), 401, `attempt ${i + 1}`);
      assert.equal(await loginFrom(person.user.email, "203.0.113.5"), 429, "that client is blocked");
      assert.equal(await loginFrom(person.user.email, "203.0.113.6"), 401, "another client is not");
      assert.equal(await loginFrom(person.user.email, "203.0.113.6", "Test-password-123"), 200);
    });

    it("proxy enabled (1): a client cannot hide behind a made-up first address", async () => {
      app.set("trust proxy", 1);
      const person = await helpers.createUser("customer");
      for (let i = 0; i < 10; i++) await loginFrom(person.user.email, `${i + 1}.1.1.1, 203.0.113.9`);
      assert.equal(await loginFrom(person.user.email, "99.9.9.9, 203.0.113.9"), 429);
    });

    it("the change-password limiter uses the same address too", async () => {
      app.set("trust proxy", 1);
      const person = await helpers.createUser("customer");
      const change = async (ip) => {
        const response = await fetch(`${server.baseUrl}/api/auth/change-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${person.token}`, "X-Forwarded-For": ip },
          body: JSON.stringify({ currentPassword: "Wrong-guess-1", newPassword: "Another-pass-123" }),
        });
        return response.status;
      };
      for (let i = 0; i < 10; i++) assert.equal(await change("203.0.113.5"), 400);
      assert.equal(await change("203.0.113.5"), 429);
      assert.equal(await change("203.0.113.77"), 400, "another client address is counted separately");
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Request logging
// ---------------------------------------------------------------------------
describe("Request logger", () => {
  // Fake request/response that THROW if the logger reads anything besides what it should
  const strict = (allowed, extra = {}) =>
    new Proxy({ ...extra }, {
      get(target, property) {
        if (property in target) return target[property];
        throw new Error(`the logger touched .${String(property)}`);
      },
    });

  const runOnce = ({ method = "GET", originalUrl = "/api/products", statusCode = 200, start = 1000, end = 1018 }) => {
    const lines = [];
    let time = start;
    const logger = createRequestLogger({ log: (line) => lines.push(line), now: () => time });
    const res = new EventEmitter();
    res.statusCode = statusCode;
    const req = strict(["method", "originalUrl"], { method, originalUrl });
    let nextCalled = false;
    logger(req, res, () => { nextCalled = true; });
    time = end;
    res.emit("finish");
    return { lines, nextCalled };
  };

  it("logs method, path, status and duration in one line, and calls next()", () => {
    const { lines, nextCalled } = runOnce({});
    assert.deepEqual(lines, ["GET /api/products 200 18ms"]);
    assert.equal(nextCalled, true);
    assert.deepEqual(runOnce({ method: "POST", originalUrl: "/api/auth/login", statusCode: 401, start: 5, end: 12 }).lines, ["POST /api/auth/login 401 7ms"]);
    assert.deepEqual(runOnce({ method: "PATCH", originalUrl: "/api/admin/orders/abc/status", statusCode: 409, start: 0, end: 0 }).lines, ["PATCH /api/admin/orders/abc/status 409 0ms"]);
  });

  it("logs nothing until the answer is finished, and exactly one line per request", () => {
    const lines = [];
    const logger = createRequestLogger({ log: (line) => lines.push(line), now: () => 1 });
    const res = new EventEmitter();
    res.statusCode = 200;
    logger(strict([], { method: "GET", originalUrl: "/x" }), res, () => {});
    assert.deepEqual(lines, []);
    res.emit("finish");
    assert.equal(lines.length, 1);
  });

  it("never reads headers, the body, cookies or anything else (the fake request would throw)", () => {
    assert.doesNotThrow(() => runOnce({ originalUrl: "/api/anything?token=abc" }));
  });

  it("the query string and the fragment are not logged", () => {
    for (const url of ["/api/products?search=secret-word&token=abc123", "/api/auth/me?password=hunter2", "/api/x?a=1#frag", "/api/products?"]) {
      const { lines } = runOnce({ originalUrl: url });
      const text = lines.join("");
      assert.equal(text.includes("?"), false, url);
      assert.equal(text.includes("secret-word") || text.includes("abc123") || text.includes("hunter2") || text.includes("frag"), false, url);
    }
    assert.equal(cleanPath("/api/products?search=a"), "/api/products");
  });

  it("control characters in a path cannot forge a second log line, and a huge path is cut", () => {
    const forged = cleanPath("/api/x\r\nGET /api/admin 200 1ms");
    assert.equal(/[\r\n]/.test(forged), false);
    assert.equal(cleanPath("/a" + String.fromCharCode(0) + "b" + String.fromCharCode(0x202e) + "c"), "/a?b?c");
    assert.equal(cleanPath(`/${"x".repeat(500)}`).length, 203);
  });

  it("works through a real HTTP request: no body, password, token, cookie or query string reaches the log", async () => {
    const lines = [];
    const small = express();
    small.use(createRequestLogger({ log: (line) => lines.push(line) }));
    small.use(express.json());
    small.post("/api/auth/login", (req, res) => res.status(401).json({ message: "Invalid email or password" }));
    small.get("/api/products", (req, res) => res.json({ ok: true }));
    const listener = await new Promise((resolve) => { const s = http.createServer(small); s.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${listener.address().port}`;
    try {
      await fetch(`${base}/api/auth/login?password=QUERYSECRET`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer HEADERSECRET.TOKEN.VALUE", Cookie: "session=COOKIESECRET" },
        body: JSON.stringify({ email: "someone@example.test", password: "BODYSECRET" }),
      });
      await fetch(`${base}/api/products?search=SEARCHSECRET`, { headers: { Authorization: "Bearer HEADERSECRET.TOKEN.VALUE" } });
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^POST \/api\/auth\/login 401 \d+ms$/);
    assert.match(lines[1], /^GET \/api\/products 200 \d+ms$/);
    const text = lines.join("\n");
    for (const secret of ["QUERYSECRET", "HEADERSECRET", "COOKIESECRET", "BODYSECRET", "SEARCHSECRET", "someone@example.test", "Bearer", "password"]) {
      assert.equal(text.includes(secret), false, secret);
    }
  });

  it("the default sink is console.log", () => {
    const original = console.log;
    const seen = [];
    console.log = (line) => seen.push(line);
    try {
      const logger = createRequestLogger();
      const res = new EventEmitter();
      res.statusCode = 204;
      logger(strict([], { method: "GET", originalUrl: "/ping" }), res, () => {});
      res.emit("finish");
    } finally {
      console.log = original;
    }
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^GET \/ping 204 \d+ms$/);
  });
});

// ---------------------------------------------------------------------------
// 5. Graceful shutdown
// ---------------------------------------------------------------------------
describe("Graceful shutdown", () => {
  // A fake http.Server that records what is done to it, in order
  const fakeServer = (events, { closeCallsBack = true, closeError = null } = {}) => ({
    pendingClose: null,
    close(callback) {
      events.push("server.close");
      this.pendingClose = () => callback(closeError);
      if (closeCallsBack) setImmediate(() => this.pendingClose());
    },
    closeIdleConnections() { events.push("closeIdleConnections"); },
    closeAllConnections() { events.push("closeAllConnections"); },
  });

  const build = (overrides = {}) => {
    const events = overrides.events || [];
    const logs = [];
    const errors = [];
    const exits = [];
    const timers = [];
    const server = overrides.server || fakeServer(events);
    const shutdown = createShutdown({
      server,
      closeDatabase: overrides.closeDatabase || (async () => { events.push("database.close"); }),
      exit: (code) => { events.push(`exit(${code})`); exits.push(code); },
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line),
      timeoutMs: overrides.timeoutMs || 10000,
      setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } }; timers.push(timer); return timer; },
      clearTimer: (timer) => { timer.cleared = true; },
    });
    return { shutdown, events, logs, errors, exits, timers, server };
  };

  it("stops the server, then closes the database, then exits with 0", async () => {
    const { shutdown, events, logs, exits, timers } = build();
    await shutdown("SIGTERM");
    assert.deepEqual(events, ["server.close", "closeIdleConnections", "database.close", "exit(0)"]);
    assert.deepEqual(exits, [0]);
    assert.match(logs[0], /SIGTERM received: shutting down/);
    assert.equal(logs[logs.length - 1], "Shutdown complete.");
    assert.equal(timers.length, 1);
    assert.equal(timers[0].cleared, true, "the safety timer is cleared after a clean shutdown");
    assert.equal(timers[0].unrefCalled, true, "the safety timer never keeps the process alive by itself");
    assert.equal(timers[0].ms, 10000);
  });

  it("waits for the running requests: the database is closed only AFTER the server has closed", async () => {
    const events = [];
    const server = fakeServer(events, { closeCallsBack: false });
    const { shutdown } = build({ server, events });
    const running = shutdown("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["server.close", "closeIdleConnections"], "the server is closing, the database is still open");
    server.pendingClose();
    await running;
    assert.deepEqual(events, ["server.close", "closeIdleConnections", "database.close", "exit(0)"]);
  });

  it("a second signal does not start a second shutdown: it forces the exit", async () => {
    const events = [];
    const server = fakeServer(events, { closeCallsBack: false });
    const { shutdown, exits, errors } = build({ server, events });
    shutdown("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));
    await shutdown("SIGINT");
    assert.deepEqual(exits, [1]);
    assert.match(errors[0], /received again: forcing exit/);
    assert.equal(events.filter((e) => e === "server.close").length, 1, "the server is closed only once");
  });

  it("never hangs: when the server will not close, the timer forces the exit with 1", async () => {
    const events = [];
    const server = fakeServer(events, { closeCallsBack: false });
    const { shutdown, timers, exits, errors } = build({ server, events, timeoutMs: 3000 });
    shutdown("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers[0].ms, 3000);
    timers[0].fn();
    assert.deepEqual(exits, [1]);
    assert.match(errors[0], /longer than 3 seconds/);
    assert.ok(events.includes("closeAllConnections"), "stubborn connections are cut");
    assert.equal(events.includes("database.close"), false);
  });

  it("a server that was not running is fine; any other close error exits with 1", async () => {
    const notRunning = build({ server: fakeServer([], { closeError: Object.assign(new Error("not running"), { code: "ERR_SERVER_NOT_RUNNING" }) }) });
    await notRunning.shutdown("SIGINT");
    assert.deepEqual(notRunning.exits, [0]);

    const broken = build({ server: fakeServer([], { closeError: new Error("close exploded") }) });
    await broken.shutdown("SIGINT");
    assert.deepEqual(broken.exits, [1]);
    assert.match(broken.errors[0], /Shutdown failed: close exploded/);
    assert.equal(broken.timers[0].cleared, true);
  });

  it("a database that cannot be closed exits with 1 and says why (without secrets)", async () => {
    const { shutdown, exits, errors } = build({ closeDatabase: async () => { throw new Error("socket hang up"); } });
    await shutdown("SIGTERM");
    assert.deepEqual(exits, [1]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Shutdown failed: socket hang up/);
  });

  it("works without the optional server methods (older Node versions)", async () => {
    const events = [];
    const bare = { close(callback) { events.push("close"); setImmediate(() => callback()); } };
    const { shutdown, exits } = build({ server: bare });
    await shutdown("SIGINT");
    assert.deepEqual(exits, [0]);
  });

  it("SIGINT and SIGTERM are wired to the shutdown, once each, and the handler does not exit by itself", () => {
    const fakeProcess = new EventEmitter();
    const calls = [];
    registerShutdownHandlers(fakeProcess, (signal) => calls.push(signal));
    assert.equal(fakeProcess.listenerCount("SIGINT"), 1);
    assert.equal(fakeProcess.listenerCount("SIGTERM"), 1);
    fakeProcess.emit("SIGINT");
    fakeProcess.emit("SIGTERM");
    assert.deepEqual(calls, ["SIGINT", "SIGTERM"]);
    assert.equal(fakeProcess.listenerCount("SIGHUP"), 0, "no other signals are touched");
  });

  it("with a REAL http server and an idle keep-alive connection: the server closes, the database close is requested, exit(0)", async () => {
    const listener = http.createServer((req, res) => res.end("hello"));
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    const agent = new http.Agent({ keepAlive: true });
    await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, agent }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject);
    });

    const exits = [];
    let databaseClosed = 0;
    const shutdown = createShutdown({
      server: listener,
      closeDatabase: async () => { databaseClosed += 1; },
      exit: (code) => exits.push(code),
      log: () => {},
      errorLog: () => {},
      timeoutMs: 5000,
    });
    await shutdown("SIGTERM");
    agent.destroy();

    assert.equal(listener.listening, false, "the HTTP server is closed");
    assert.equal(databaseClosed, 1, "the database close was requested once");
    assert.deepEqual(exits, [0]);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), "no new connections are accepted");
  });
});

// ---------------------------------------------------------------------------
// 6. Product indexes
// ---------------------------------------------------------------------------
describe("Product indexes", () => {
  const keysOf = (indexes) => indexes.map((entry) => JSON.stringify(Array.isArray(entry) ? entry[0] : entry.key));

  it("the schema declares the active + newest-first index and keeps the category index", () => {
    const declared = keysOf(Product.schema.indexes());
    assert.ok(declared.includes(JSON.stringify({ isActive: 1, createdAt: -1, _id: -1 })), declared.join(" "));
    assert.ok(declared.includes(JSON.stringify({ category: 1 })), declared.join(" "));
  });

  it("no speculative indexes: exactly the category index and the list index are declared", () => {
    assert.equal(Product.schema.indexes().length, 2, keysOf(Product.schema.indexes()).join(" "));
  });

  it("the indexes really exist in the (test) database", async () => {
    await Product.init();
    const live = keysOf(await Product.collection.indexes());
    assert.ok(live.includes(JSON.stringify({ isActive: 1, createdAt: -1, _id: -1 })), live.join(" "));
    assert.ok(live.includes(JSON.stringify({ category: 1 })), live.join(" "));
    assert.ok(live.includes(JSON.stringify({ _id: 1 })));
  });

  it("the list query can read products in order straight from the index (no separate sort step)", async () => {
    await Product.init();
    const category = await helpers.createCategory();
    for (let i = 0; i < 3; i++) await helpers.createProduct(category, { isActive: i !== 1 });
    const plan = await Product.find({ isActive: true })
      .sort({ createdAt: -1, _id: -1 })
      .hint({ isActive: 1, createdAt: -1, _id: -1 })
      .limit(5)
      .explain("queryPlanner");
    const text = JSON.stringify(plan);
    assert.ok(text.includes("IXSCAN"), "uses the index");
    assert.equal(text.includes("\"SORT\""), false, "needs no in-memory sort");

    const real = await Product.find({ isActive: true }).sort({ createdAt: -1, _id: -1 }).limit(5).explain("queryPlanner");
    assert.ok(JSON.stringify(real).includes("IXSCAN"), "the planner chooses an index for the real query");
  });

  it("the product list API still answers exactly as before (active products, newest first)", async () => {
    const category = await helpers.createCategory();
    const first = await helpers.createProduct(category);
    const second = await helpers.createProduct(category);
    const hidden = await helpers.createProduct(category, { isActive: false });
    const response = await request("GET", `/api/products?category=${category._id}&limit=10`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.products.map((p) => p._id), [String(second._id), String(first._id)]);
    assert.equal(response.body.products.some((p) => p._id === String(hidden._id)), false);
  });
});

// ---------------------------------------------------------------------------
// 7. The real server.js, started as a separate process
// ---------------------------------------------------------------------------
describe("server.js as a real process", () => {
  // An empty folder as the working directory, so the child does NOT read backend/.env
  // and only sees the settings the test gives it
  let emptyDir;
  before(() => { emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase9-")); });
  after(() => { fs.rmSync(emptyDir, { recursive: true, force: true }); });

  const baseEnv = () => {
    const env = { ...process.env };
    for (const name of ["MONGODB_URI", "JWT_SECRET", "JWT_EXPIRES_IN", "PORT", "CLIENT_URL", "TRUST_PROXY", "LOG_REQUESTS", "TEST_DB_NAME"]) delete env[name];
    return env;
  };

  // The same MongoDB server, but the TEST database, so this can never touch your real data
  const testDatabaseUri = () => {
    const match = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/.exec(process.env.MONGODB_URI || "");
    if (!match) return null;
    assert.ok(/test/i.test(helpers.TEST_DB_NAME));
    return `${match[1]}/${helpers.TEST_DB_NAME}${match[3] || ""}`;
  };

  const freePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });

  // A tiny script loaded before server.js. When the test writes "SIGTERM" to the child's input,
  // it triggers the process's OWN SIGTERM listeners (process.emit), which works on every
  // operating system. (A real kill signal cannot be delivered to a Windows process.)
  const triggerScript = () => {
    const file = path.join(emptyDir, "trigger-signal.js");
    fs.writeFileSync(file, 'process.stdin.setEncoding("utf8"); process.stdin.on("data", (text) => { if (text.includes("SIGTERM")) process.emit("SIGTERM"); });');
    return file;
  };

  const run = (env, { until, timeoutMs = 20000, preload } = {}) => {
    const args = [...(preload ? ["--require", preload] : []), path.join(BACKEND_DIR, "src", "server.js")];
    const child = spawn(process.execPath, args, { cwd: emptyDir, env, stdio: ["pipe", "pipe", "pipe"] });
    const output = { stdout: "", stderr: "" };
    child.stdout.on("data", (chunk) => { output.stdout += chunk; });
    child.stderr.on("data", (chunk) => { output.stderr += chunk; });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const ready = until
      ? new Promise((resolve, reject) => {
          const started = Date.now();
          const timer = setInterval(() => {
            if (until(output)) { clearInterval(timer); resolve(); }
            else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`timed out; output so far:\n${output.stdout}\n${output.stderr}`)); }
          }, 50);
        })
      : Promise.resolve();
    return { child, output, exited, ready };
  };

  it("refuses to start with a bad configuration: exit code 1, every problem listed, no secret printed", async () => {
    const env = {
      ...baseEnv(),
      JWT_SECRET: "LEAKY-short-secret",
      JWT_EXPIRES_IN: "LEAKY-lifetime",
      PORT: "LEAKY-port",
      TRUST_PROXY: "true",
    };
    const { exited, output } = run(env);
    const { code } = await exited;
    assert.equal(code, 1);
    const text = output.stderr;
    for (const name of ["MONGODB_URI", "JWT_SECRET", "JWT_EXPIRES_IN", "PORT", "TRUST_PROXY"]) assert.ok(text.includes(name), `${name} is listed`);
    assert.match(text, /backend\/\.env has problems/);
    assert.equal((output.stdout + output.stderr).includes("LEAKY"), false, "no value is printed");
    assert.equal(output.stdout.includes("Server running"), false);
    assert.equal(output.stdout.includes("MongoDB connected"), false, "it stopped before connecting to anything");
  });

  it("refuses the placeholder secret from .env.example at startup", async () => {
    const env = { ...baseEnv(), MONGODB_URI: "mongodb://127.0.0.1:1/nothing", JWT_SECRET: "replace_with_a_long_random_secret" };
    const { exited, output } = run(env);
    assert.equal((await exited).code, 1);
    assert.match(output.stderr, /placeholder/);
  });

  it("starts with a good configuration: logs safe request lines, sends safe headers, and never prints secrets", async (t) => {
    const uri = testDatabaseUri();
    if (!uri) return t.skip("MONGODB_URI has an unusual shape");
    const port = await freePort();
    const env = { ...baseEnv(), MONGODB_URI: uri, JWT_SECRET: process.env.JWT_SECRET, JWT_EXPIRES_IN: "1d", PORT: String(port), CLIENT_URL: "http://localhost:5173" };
    const { child, output, exited, ready } = run(env, { until: (o) => o.stdout.includes("Server running on") });
    try {
      await ready;
      const base = `http://127.0.0.1:${port}`;

      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, 200);
      assert.equal(health.headers.get("x-powered-by"), null);
      assert.equal(health.headers.get("x-content-type-options"), "nosniff");

      await fetch(`${base}/api/products?search=SEARCHSECRET`, { headers: { Authorization: "Bearer HEADERSECRET.TOKEN.VALUE" } });
      const login = await fetch(`${base}/api/auth/login?password=QUERYSECRET`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer HEADERSECRET.TOKEN.VALUE" },
        body: JSON.stringify({ email: "nobody@example.test", password: "BODYSECRET" }),
      });
      assert.equal(login.status, 401);
      assert.equal(login.headers.get("cache-control"), "no-store");
      await new Promise((resolve) => setTimeout(resolve, 200));

      const lines = output.stdout.split(/\r?\n/);
      assert.ok(lines.some((line) => /^GET \/api\/health 200 \d+ms$/.test(line)), "health request logged");
      assert.ok(lines.some((line) => /^GET \/api\/products 200 \d+ms$/.test(line)), "products request logged without its query");
      assert.ok(lines.some((line) => /^POST \/api\/auth\/login 401 \d+ms$/.test(line)), "login request logged without its query");

      const everything = output.stdout + output.stderr;
      for (const secret of ["SEARCHSECRET", "HEADERSECRET", "QUERYSECRET", "BODYSECRET", "nobody@example.test", process.env.JWT_SECRET, process.env.MONGODB_URI]) {
        assert.equal(everything.includes(secret), false, "a secret value appears in the output");
      }
    } finally {
      child.kill();
      await exited;
    }
  });

  it("server.js wires the shutdown to SIGTERM: the real process closes the server and database and exits 0 (every OS)", async (t) => {
    const uri = testDatabaseUri();
    if (!uri) return t.skip("MONGODB_URI has an unusual shape");
    const port = await freePort();
    const env = { ...baseEnv(), MONGODB_URI: uri, JWT_SECRET: process.env.JWT_SECRET, PORT: String(port) };
    const { child, output, exited, ready } = run(env, { preload: triggerScript(), until: (o) => o.stdout.includes("Server running on") });
    try {
      await ready;
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
      child.stdin.write("SIGTERM please");
      // If server.js did not register the handlers, nothing would stop it: fail instead of waiting forever
      const { code } = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve({ code: "still running 15 seconds after SIGTERM" }), 15000)),
      ]);
      assert.equal(code, 0);
      assert.match(output.stdout, /SIGTERM received: shutting down/);
      assert.ok(output.stdout.includes("Shutdown complete."));
      await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`), "the port is closed afterwards");
    } finally {
      child.kill();
    }
  });

  it("a real SIGTERM also works where the operating system can deliver it (not on Windows)", async (t) => {
    if (process.platform === "win32") return t.skip("Windows ends the process instead of delivering SIGTERM; the previous test covers the wiring");
    const uri = testDatabaseUri();
    if (!uri) return t.skip("MONGODB_URI has an unusual shape");
    const port = await freePort();
    const env = { ...baseEnv(), MONGODB_URI: uri, JWT_SECRET: process.env.JWT_SECRET, PORT: String(port) };
    const { child, output, exited, ready } = run(env, { until: (o) => o.stdout.includes("Server running on") });
    try {
      await ready;
      child.kill("SIGTERM");
      const { code } = await exited;
      assert.equal(code, 0);
      assert.match(output.stdout, /SIGTERM received: shutting down/);
      assert.match(output.stdout, /Shutdown complete\./);
    } finally {
      child.kill();
    }
  });
});
