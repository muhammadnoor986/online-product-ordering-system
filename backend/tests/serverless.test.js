// The serverless (Vercel) database wiring. These tests need NO database and NO internet:
//   * utils/ensureDatabase.js is tested with fake "connect" functions;
//   * app.js is loaded in a child process, with and without VERCEL=1, with the database library replaced by a fake,
//     and asked for /api/health through a real (local) HTTP request. This file does not use helpers.js on purpose,
//     because helpers.js connects to the test database.
//
// Run just this file with:  node --test tests/serverless.test.js
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const { checkServerlessEnv, createEnsureDatabase, createDatabaseMiddleware } = require("../src/utils/ensureDatabase");
const AppError = require("../src/utils/AppError");

const BACKEND_DIR = path.join(__dirname, "..");

const goodEnv = () => ({
  MONGODB_URI: "mongodb+srv://user:pass@cluster.example.mongodb.net/db",
  JWT_SECRET: crypto.randomBytes(48).toString("hex"),
  CLIENT_URL: "https://shop.example.vercel.app",
});

describe("checkServerlessEnv", () => {
  it("accepts a complete configuration", () => {
    assert.deepEqual(checkServerlessEnv(goodEnv()), []);
  });

  it("reports the settings that are missing, by name, together", () => {
    const problems = checkServerlessEnv({}).join("\n");
    for (const name of ["MONGODB_URI", "JWT_SECRET", "CLIENT_URL"]) assert.ok(problems.includes(name), `${name} is reported`);
  });

  it("requires CLIENT_URL (optional on a laptop, needed so the browser lets the real website call the API)", () => {
    const env = goodEnv();
    delete env.CLIENT_URL;
    assert.equal(checkServerlessEnv(env).length, 1);
    assert.match(checkServerlessEnv({ ...env, CLIENT_URL: "   " })[0], /CLIENT_URL is missing/);
  });

  it("still refuses a CLIENT_URL with a trailing slash (the normal startup rule)", () => {
    assert.match(checkServerlessEnv({ ...goodEnv(), CLIENT_URL: "https://shop.example.vercel.app/" }).join(" "), /CLIENT_URL must be/);
  });

  it("never puts a value into a message", () => {
    const env = { MONGODB_URI: "LEAKYURI", JWT_SECRET: "LEAKYSECRET", CLIENT_URL: "LEAKYURL" };
    assert.equal(checkServerlessEnv(env).join(" ").includes("LEAKY"), false);
  });
});

describe("createEnsureDatabase (one shared connection)", () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it("does not connect when the connection is already open", async () => {
    let calls = 0;
    const ensure = createEnsureDatabase({ isConnected: () => true, connect: async () => { calls += 1; } });
    await ensure();
    await ensure();
    assert.equal(calls, 0);
  });

  it("connects once, then reuses the connection for every later request", async () => {
    let connected = false;
    let calls = 0;
    const ensure = createEnsureDatabase({ isConnected: () => connected, connect: async () => { calls += 1; connected = true; } });
    for (let i = 0; i < 5; i++) await ensure();
    assert.equal(calls, 1);
  });

  it("requests that arrive while it is connecting share ONE attempt (no connection per request)", async () => {
    let connected = false;
    let calls = 0;
    const gate = deferred();
    const ensure = createEnsureDatabase({ isConnected: () => connected, connect: async () => { calls += 1; await gate.promise; connected = true; } });
    const waiting = [ensure(), ensure(), ensure(), ensure()];
    gate.resolve();
    await Promise.all(waiting);
    assert.equal(calls, 1);
  });

  it("a failed attempt rejects every waiting request, and is forgotten: the NEXT request tries again", async () => {
    let connected = false;
    let calls = 0;
    const gate = deferred();
    const ensure = createEnsureDatabase({
      isConnected: () => connected,
      connect: async () => {
        calls += 1;
        if (calls === 1) { await gate.promise; throw new Error("first attempt failed"); }
        connected = true;
      },
    });
    const waiting = [ensure(), ensure()];
    gate.resolve();
    for (const request of waiting) await assert.rejects(request, /first attempt failed/);
    assert.equal(calls, 1);
    await ensure(); // a later request: a new attempt, which works
    assert.equal(calls, 2);
    await ensure();
    assert.equal(calls, 2);
  });

  it("a connect function that throws at once (not async) is handled the same way", async () => {
    let calls = 0;
    const ensure = createEnsureDatabase({ isConnected: () => false, connect: () => { calls += 1; throw new Error("sync failure"); } });
    await assert.rejects(ensure(), /sync failure/);
    await assert.rejects(ensure(), /sync failure/);
    assert.equal(calls, 2);
  });

  it("reconnects when the connection was lost (isConnected turns false again)", async () => {
    let connected = false;
    let calls = 0;
    const ensure = createEnsureDatabase({ isConnected: () => connected, connect: async () => { calls += 1; connected = true; } });
    await ensure();
    connected = false;
    await ensure();
    assert.equal(calls, 2);
  });
});

describe("createDatabaseMiddleware", () => {
  const run = async (middleware) => {
    const outcome = {};
    await middleware({}, {}, (error) => { outcome.called = true; outcome.error = error; });
    return outcome;
  };

  it("calls next() with no error when the database is ready", async () => {
    const outcome = await run(createDatabaseMiddleware({ ensureDatabase: async () => {}, getEnvProblems: () => [], log: () => {} }));
    assert.equal(outcome.called, true);
    assert.equal(outcome.error, undefined);
  });

  it("a database failure becomes a 503 AppError with a safe message, and the reason is logged without a connection string", async () => {
    const lines = [];
    const middleware = createDatabaseMiddleware({
      ensureDatabase: async () => { throw new Error("failed for mongodb+srv://someuser:LEAKYPASSWORD@cluster.example.net/db"); },
      getEnvProblems: () => [],
      log: (line) => lines.push(line),
    });
    const { error } = await run(middleware);
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.message.includes("LEAKYPASSWORD"), false);
    assert.equal(error.message.includes("mongodb"), false);
    assert.equal(lines.join("\n").includes("LEAKYPASSWORD"), false);
    assert.equal(lines.join("\n").includes("someuser"), false);
    assert.match(lines.join("\n"), /Database connection failed/);
  });

  it("a wrong configuration answers 503 without trying the database, and is checked only once", async () => {
    let checks = 0;
    let connects = 0;
    const lines = [];
    const middleware = createDatabaseMiddleware({
      ensureDatabase: async () => { connects += 1; },
      getEnvProblems: () => { checks += 1; return ["JWT_SECRET is missing"]; },
      log: (line) => lines.push(line),
    });
    for (let i = 0; i < 3; i++) {
      const { error } = await run(middleware);
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /not configured correctly/);
    }
    assert.equal(connects, 0);
    assert.equal(checks, 1);
    assert.equal(lines.length, 1, "the problem list is logged once, not on every request");
    assert.match(lines[0], /JWT_SECRET is missing/);
  });

  it("never exits the process", async () => {
    const realExit = process.exit;
    let exited = false;
    process.exit = () => { exited = true; };
    try {
      await run(createDatabaseMiddleware({ ensureDatabase: async () => { throw new Error("down"); }, getEnvProblems: () => [], log: () => {} }));
      await run(createDatabaseMiddleware({ ensureDatabase: async () => {}, getEnvProblems: () => ["x"], log: () => {} }));
    } finally {
      process.exit = realExit;
    }
    assert.equal(exited, false);
  });
});

// ---------------------------------------------------------------------------
// app.js itself, with and without VERCEL=1
// ---------------------------------------------------------------------------
describe("app.js wiring", () => {
  let workDir;
  before(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), "serverless-")); });
  after(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

  // A small program that loads the real app.js with a FAKE database library, sends `requests` requests to
  // /api/health through a real local HTTP server, and prints what happened as one line of JSON.
  const driverFile = () => {
    const file = path.join(workDir, "driver.js");
    const appPath = JSON.stringify(path.join(BACKEND_DIR, "src", "app.js"));
    const mongoosePath = JSON.stringify(path.join(BACKEND_DIR, "node_modules", "mongoose"));
    fs.writeFileSync(
      file,
      `
const http = require("node:http");
const mongoose = require(${mongoosePath});
let connectCalls = 0;
let connected = false;
const failFirst = Number(process.env.TEST_FAIL_FIRST || 0);
let lastOptions = null;
mongoose.connect = async (uri, options) => {
  connectCalls += 1;
  lastOptions = options;
  if (connectCalls <= failFirst) throw new Error("connect ECONNREFUSED to mongodb://dbuser:LEAKYPASSWORD@127.0.0.1:27017/x");
  connected = true;
};
Object.defineProperty(mongoose.connection, "readyState", { get: () => (connected ? 1 : 0) });
const app = require(${appPath});
const server = http.createServer(app).listen(0, "127.0.0.1", async () => {
  const base = "http://127.0.0.1:" + server.address().port;
  const answers = [];
  for (let i = 0; i < Number(process.env.TEST_REQUESTS || 1); i++) {
    const response = await fetch(base + "/api/health");
    answers.push({ status: response.status, body: await response.json() });
  }
  const preflight = await fetch(base + "/api/products", { method: "OPTIONS", headers: { Origin: process.env.CLIENT_URL || "", "Access-Control-Request-Method": "GET" } });
  console.log("RESULT=" + JSON.stringify({ answers, connectCalls, lastOptions, preflightStatus: preflight.status, callsAfterPreflight: connectCalls }));
  server.close();
  process.exit(0);
});
`
    );
    return file;
  };

  const runDriver = (extraEnv) => {
    const env = { ...process.env };
    for (const name of ["MONGODB_URI", "JWT_SECRET", "JWT_EXPIRES_IN", "PORT", "CLIENT_URL", "TRUST_PROXY", "LOG_REQUESTS", "TEST_DB_NAME", "VERCEL"]) delete env[name];
    Object.assign(env, { LOG_REQUESTS: "false" }, extraEnv);
    const result = spawnSync(process.execPath, [driverFile()], { cwd: workDir, env, encoding: "utf8", timeout: 30000 });
    const line = (result.stdout || "").split(/\r?\n/).find((text) => text.startsWith("RESULT="));
    assert.ok(line, `no result. exit=${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    return { ...JSON.parse(line.slice("RESULT=".length)), stderr: result.stderr, stdout: result.stdout, status: result.status };
  };

  it("WITHOUT VERCEL: nothing is added (the database is never contacted by app.js; /api/health just reports it)", () => {
    const result = runDriver(goodEnv());
    assert.equal(result.connectCalls, 0);
    assert.equal(result.answers[0].status, 503);
    assert.equal(result.answers[0].body.database, "disconnected");
  });

  it("ON VERCEL: the first request connects, later requests reuse that connection (one connect in all)", () => {
    const result = runDriver({ ...goodEnv(), VERCEL: "1", TEST_REQUESTS: "5" });
    assert.equal(result.connectCalls, 1);
    assert.deepEqual(result.answers.map((a) => a.status), [200, 200, 200, 200, 200]);
    assert.equal(result.answers[0].body.database, "connected");
    assert.equal(result.status, 0);
  });

  it("ON VERCEL: the connection uses a small pool", () => {
    const result = runDriver({ ...goodEnv(), VERCEL: "1" });
    assert.equal(result.lastOptions.maxPoolSize, 5);
    assert.equal(result.lastOptions.serverSelectionTimeoutMS, 10000);
  });

  it("ON VERCEL: a failed connection answers 503 as JSON (the process is NOT stopped), the next request tries again and works, nothing secret is printed", () => {
    const result = runDriver({ ...goodEnv(), VERCEL: "1", TEST_FAIL_FIRST: "1", TEST_REQUESTS: "3" });
    assert.deepEqual(result.answers.map((a) => a.status), [503, 200, 200]);
    assert.match(result.answers[0].body.message, /database is not reachable/);
    assert.equal(result.connectCalls, 2);
    assert.equal(result.status, 0, "the process finished normally: nothing called process.exit(1)");
    const everything = JSON.stringify(result.answers) + result.stdout + result.stderr;
    for (const secret of ["LEAKYPASSWORD", "dbuser"]) assert.equal(everything.includes(secret), false, `${secret} is not printed or sent`);
  });

  it("ON VERCEL: a wrong configuration answers 503 and never contacts the database", () => {
    const env = goodEnv();
    delete env.JWT_SECRET;
    const result = runDriver({ ...env, VERCEL: "1", TEST_REQUESTS: "2" });
    assert.deepEqual(result.answers.map((a) => a.status), [503, 503]);
    assert.match(result.answers[0].body.message, /not configured correctly/);
    assert.equal(result.connectCalls, 0);
    assert.match(result.stderr, /JWT_SECRET is missing/);
  });

  it("ON VERCEL: a browser preflight (CORS) is answered without touching the database", () => {
    const result = runDriver({ ...goodEnv(), VERCEL: "1" });
    assert.equal(result.preflightStatus, 204);
    assert.equal(result.callsAfterPreflight, result.connectCalls, "the preflight made no extra connection");
  });
});
