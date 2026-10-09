// Database startup behaviour. These tests need NO database and NO network:
//   * connectWithRetry is tested with fake "connect" and "sleep" functions;
//   * server.js is started as a real process, but its database library is replaced (by a tiny preload script) with
//     one that always fails, so nothing is ever contacted. This file does not use helpers.js on purpose,
//     because helpers.js connects to the test database.
//
// Run just this file with:  node --test tests/dbStartup.test.js
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawn } = require("node:child_process");

const {
  connectWithRetry,
  safeMessage,
  DEFAULT_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
} = require("../src/utils/connectWithRetry");

const BACKEND_DIR = path.join(__dirname, "..");

// A fake connect that fails `failures` times (with the given error) and then works
const fakeConnect = (failures, makeError = (n) => new Error(`attempt ${n} failed`)) => {
  const state = { calls: 0 };
  const connect = async () => {
    state.calls += 1;
    if (state.calls <= failures) throw makeError(state.calls);
  };
  return { connect, state };
};

const fakeClock = () => {
  const sleeps = [];
  return { sleeps, sleep: async (ms) => { sleeps.push(ms); } };
};

describe("connectWithRetry", () => {
  it("connects at once when the first attempt works: no pause, nothing logged", async () => {
    const { connect, state } = fakeConnect(0);
    const { sleeps, sleep } = fakeClock();
    const lines = [];
    const attempt = await connectWithRetry({ connect, sleep, errorLog: (line) => lines.push(line) });
    assert.equal(attempt, 1);
    assert.equal(state.calls, 1);
    assert.deepEqual(sleeps, []);
    assert.deepEqual(lines, []);
  });

  it("tries again after a failure and returns the number of the attempt that worked", async () => {
    const { connect, state } = fakeConnect(2);
    const { sleeps, sleep } = fakeClock();
    const lines = [];
    const attempt = await connectWithRetry({ connect, sleep, errorLog: (line) => lines.push(line) });
    assert.equal(attempt, 3);
    assert.equal(state.calls, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /attempt 1 of 5 failed/);
    assert.match(lines[1], /attempt 2 of 5 failed/);
  });

  it("the pause doubles after each failure and never exceeds the maximum", async () => {
    const { connect } = fakeConnect(99);
    const { sleeps, sleep } = fakeClock();
    await assert.rejects(connectWithRetry({ connect, sleep, attempts: 7, baseDelayMs: 1000, maxDelayMs: 5000, errorLog: () => {} }));
    assert.deepEqual(sleeps, [1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it("gives up after the last attempt: it throws, makes exactly `attempts` tries and does not pause after the last one", async () => {
    const { connect, state } = fakeConnect(99);
    const { sleeps, sleep } = fakeClock();
    await assert.rejects(
      connectWithRetry({ connect, sleep, attempts: 3, errorLog: () => {} }),
      /Could not connect to MongoDB after 3 attempts\. Last problem: attempt 3 failed/
    );
    assert.equal(state.calls, 3);
    assert.equal(sleeps.length, 2);
  });

  it("the defaults are bounded: 5 attempts, 1 s first pause, 8 s longest pause (at most 15 s of pauses in all)", async () => {
    assert.equal(DEFAULT_ATTEMPTS, 5);
    assert.equal(DEFAULT_BASE_DELAY_MS, 1000);
    assert.equal(DEFAULT_MAX_DELAY_MS, 8000);
    const { connect, state } = fakeConnect(99);
    const { sleeps, sleep } = fakeClock();
    await assert.rejects(connectWithRetry({ connect, sleep, errorLog: () => {} }));
    assert.equal(state.calls, 5);
    assert.deepEqual(sleeps, [1000, 2000, 4000, 8000]);
  });

  it("a single attempt is allowed (no retry)", async () => {
    const { connect, state } = fakeConnect(99);
    const { sleeps, sleep } = fakeClock();
    await assert.rejects(connectWithRetry({ connect, sleep, attempts: 1, errorLog: () => {} }), /after 1 attempt\./);
    assert.equal(state.calls, 1);
    assert.deepEqual(sleeps, []);
  });

  it("refuses bad arguments instead of looping forever", async () => {
    await assert.rejects(connectWithRetry({}), TypeError);
    for (const attempts of [0, -1, 1.5, "3", NaN, Infinity]) {
      await assert.rejects(connectWithRetry({ connect: async () => {}, attempts }), RangeError, `attempts = ${String(attempts)}`);
    }
  });

  it("never prints or throws a connection string, password or secret from an error message", async () => {
    const uri = "mongodb+srv://someuser:LEAKYPASSWORD@cluster0.example.mongodb.net/db?retryWrites=true";
    const { connect } = fakeConnect(99, () => new Error(`bad connection to ${uri} (and mongodb://other:LEAKYTWO@host:27017/x)`));
    const lines = [];
    let thrown;
    try {
      await connectWithRetry({ connect, sleep: async () => {}, attempts: 2, errorLog: (line) => lines.push(line) });
    } catch (error) {
      thrown = error;
    }
    const everything = `${lines.join("\n")}\n${thrown.message}`;
    assert.ok(thrown);
    assert.equal(everything.includes("LEAKYPASSWORD"), false);
    assert.equal(everything.includes("LEAKYTWO"), false);
    assert.equal(everything.includes("someuser"), false);
    assert.match(everything, /mongodb:\/\/\[hidden\]/);
  });

  it("safeMessage copes with odd values and cuts very long text", () => {
    assert.equal(safeMessage(undefined), "undefined");
    assert.equal(safeMessage("plain text"), "plain text");
    assert.equal(safeMessage(new Error("a\nb\r\n  c")), "a b c");
    assert.equal(safeMessage(new Error("x".repeat(1000))).length, 200);
  });
});

// ---------------------------------------------------------------------------
// server.js as a real process, with a database library that always fails
// ---------------------------------------------------------------------------
describe("server.js when the database cannot be reached", () => {
  let workDir;
  before(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-startup-")); });
  after(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

  // Loaded before server.js. It makes every database connection fail at once (nothing is contacted) and makes the pauses
  // between the tries instant, so the whole test takes a moment instead of 15 seconds.
  const preload = () => {
    const file = path.join(workDir, "fail-database.js");
    const mongoosePath = JSON.stringify(path.join(BACKEND_DIR, "node_modules", "mongoose"));
    fs.writeFileSync(
      file,
      [
        `const mongoose = require(${mongoosePath});`,
        `let calls = 0;`,
        `mongoose.connect = async () => { calls += 1; throw new Error("connect ECONNREFUSED while using mongodb://dbuser:LEAKYPASSWORD@127.0.0.1:27017/x"); };`,
        `process.on("exit", () => { process.stdout.write("CONNECT-CALLS=" + calls + "\\n"); });`,
        `const realSetTimeout = global.setTimeout;`,
        `global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 500 ? 0 : ms, ...rest);`,
      ].join("\n")
    );
    return file;
  };

  const freePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });

  it("tries 5 times, then stops with exit code 1, never starts listening, and prints no secret", async () => {
    const port = await freePort();
    const env = { ...process.env };
    for (const name of ["MONGODB_URI", "JWT_SECRET", "JWT_EXPIRES_IN", "PORT", "CLIENT_URL", "TRUST_PROXY", "LOG_REQUESTS", "TEST_DB_NAME"]) delete env[name];
    Object.assign(env, {
      MONGODB_URI: "mongodb://dbuser:LEAKYPASSWORD@127.0.0.1:27017/never-used", // only its shape is checked: the connection is replaced
      JWT_SECRET: crypto.randomBytes(48).toString("hex"),
      PORT: String(port),
    });

    const child = spawn(process.execPath, ["--require", preload(), path.join(BACKEND_DIR, "src", "server.js")], {
      cwd: workDir, // an empty folder: backend/.env is not read
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const finished = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    let giveUp;
    const result = await Promise.race([
      finished,
      new Promise((resolve) => { giveUp = setTimeout(() => resolve({ code: "still running after 20 seconds" }), 20000); }),
    ]);
    clearTimeout(giveUp);
    child.kill();

    assert.equal(result.code, 1, `stdout: ${stdout}\nstderr: ${stderr}`);
    assert.match(stdout, /CONNECT-CALLS=5/);
    assert.match(stderr, /attempt 1 of 5 failed/);
    assert.match(stderr, /attempt 4 of 5 failed/);
    assert.match(stderr, /Could not connect to MongoDB after 5 attempts/);
    assert.match(stderr, /stopping instead of running without a database/);
    assert.equal(stdout.includes("Server running"), false, "it never started listening");
    assert.equal(stdout.includes("MongoDB connected"), false);
    const everything = stdout + stderr;
    for (const secret of ["LEAKYPASSWORD", "dbuser"]) assert.equal(everything.includes(secret), false, `${secret} is not printed`);
  });
});
