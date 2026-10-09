#!/usr/bin/env node
// Runs the browser (E2E) tests in complete isolation from your development setup.
//
//   npm run test:e2e                  runs every suite in e2e/suites
//   npm run test:e2e -- step4Details  runs the suites whose file name contains that text
//
// What this does, in order:
//   1. checks that Node, a browser and a MongoDB server are available
//   2. creates a NEW database just for this run (its name contains "test" and "e2e"; it is dropped at the end)
//   3. starts its own backend and its own frontend on free ports (never 5000 or 5173)
//   4. runs the suites one after another (node --test, one at a time)
//   5. stops everything and removes the database, the temporary browser profiles and the run folder
//
// Your development backend, frontend and database are never used or touched.

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { resolveConfig } = require("./lib/config");
const { dropRunDatabase } = require("./lib/db");
const { findBrowser, createRunDir, removeRunDir, stopLeftoverBrowsers } = require("./lib/browser");
const { startBackend, startFrontend, cleanEnvironment } = require("./lib/servers");
const { stopProcess, killTree } = require("./lib/processes");
const { redact } = require("./lib/guard");

const SUITES_DIR = path.join(__dirname, "suites");
const ARTIFACTS_DIR = path.join(__dirname, "artifacts");

const log = (line) => console.log(`[e2e] ${line}`);

const main = async () => {
  // ---- 1. what is needed ---------------------------------------------------
  if (typeof WebSocket !== "function") {
    console.error("[e2e] The E2E tests need Node.js 22 or newer (they use Node's built-in WebSocket). Your version: " + process.version);
    return 1;
  }

  const filters = process.argv.slice(2).filter((argument) => !argument.startsWith("-")).map((text) => text.toLowerCase());
  const allSuites = fs.existsSync(SUITES_DIR) ? fs.readdirSync(SUITES_DIR).filter((file) => file.endsWith(".e2e.js")).sort() : [];
  const suiteFiles = filters.length === 0 ? allSuites : allSuites.filter((file) => filters.some((text) => file.toLowerCase().includes(text)));
  if (suiteFiles.length === 0) {
    console.error(`[e2e] No suite matches "${filters.join(" ")}". Available suites: ${allSuites.map((file) => file.replace(".e2e.js", "")).join(", ") || "(none)"}`);
    return 1;
  }

  let browserPath;
  let config;
  try {
    browserPath = findBrowser();
    config = await resolveConfig();
  } catch (error) {
    console.error(`[e2e] ${redact(error.message)}`);
    return 1;
  }
  const secrets = [config.jwtSecret, config.mongoUri];

  // ---- 2. the run folder and the cleanup that must always happen --------------------
  const runDir = createRunDir();
  const running = { backend: null, frontend: null, tests: null };
  let teardownPromise = null;
  let teardownProblems = [];
  const teardownWarnings = [];

  const teardown = () => {
    if (teardownPromise) return teardownPromise;
    teardownPromise = (async () => {
      if (running.tests && running.tests.exitCode === null && running.tests.signalCode === null) killTree(running.tests.pid); // only while it still runs
      // The servers first, so nothing writes to the database while it is removed
      try { if (running.frontend) { await stopProcess(running.frontend); log("frontend stopped"); } } catch (error) { teardownProblems.push(`frontend: ${error.message}`); }
      try { if (running.backend) { await stopProcess(running.backend); log("backend stopped"); } } catch (error) { teardownProblems.push(`backend: ${error.message}`); }
      try {
        const left = stopLeftoverBrowsers(runDir);
        if (left > 0) log(`${left} leftover browser(s) stopped`);
      } catch (error) { teardownProblems.push(`browser: ${error.message}`); }
      try {
        await dropRunDatabase({ databaseName: config.databaseName, mongoUri: config.mongoUri, developmentNames: config.developmentDatabaseNames });
        log(`test database ${config.databaseName} dropped`);
      } catch (error) { teardownProblems.push(`database: ${redact(error.message, secrets)}`); }
      try {
        await removeRunDir(runDir);
        log("temporary run folder and browser profiles removed");
      } catch (error) {
        // Windows (or a virus scanner) can hold files for a while on a busy machine. The tests are not at fault, so this is a
        // warning with the folder's path, not a failure. It only holds temporary browser files and is safe to delete by hand.
        teardownWarnings.push(`the temporary folder ${runDir} could not be removed yet (${error.message}). It only contains temporary browser files: delete it when convenient.`);
      }
    })();
    return teardownPromise;
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      log(`${signal} received: cleaning up...`);
      teardown().finally(() => process.exit(130));
    });
  }

  // ---- 3. start everything, run the tests, always clean up -----------------------------------
  let exitCode = 1;
  try {
    log(`run ${config.runId}`);
    log(`new test database: ${config.databaseName} (the development database "${config.developmentDatabaseNames.join('", "') || "none found"}" is not used)`);
    log(`backend ${config.apiUrl}   frontend ${config.appUrl}   browser ${path.basename(browserPath)}`);

    // Each process is remembered as soon as it exists, so it is stopped even if it never gets ready
    await startBackend(config, runDir, (handle) => { running.backend = handle; });
    log("backend ready");
    await startFrontend(config, (handle) => { running.frontend = handle; });
    log("frontend ready");

    const env = {
      ...cleanEnvironment(),
      E2E_APP_URL: config.appUrl,
      E2E_API_URL: config.apiUrl,
      E2E_MONGODB_URI: config.mongoUri,
      E2E_DB_NAME: config.databaseName,
      E2E_DEV_DB_NAMES: config.developmentDatabaseNames.join(","),
      E2E_RUN_DIR: runDir,
      E2E_BROWSER: browserPath,
    };
    if (process.env.E2E_SCREENSHOTS === "1") env.E2E_ARTIFACTS_DIR = ARTIFACTS_DIR;

    const testTimeout = Number(process.env.E2E_TEST_TIMEOUT_MS) || 240000;
    // --test-force-exit: the test process ends when the tests are done, even if a browser connection is still open
    const args = ["--test", "--test-concurrency=1", "--test-force-exit", `--test-timeout=${testTimeout}`, ...suiteFiles.map((file) => path.join(SUITES_DIR, file))];
    log(`running: ${suiteFiles.map((file) => file.replace(".e2e.js", "")).join(", ")}`);

    // A hard limit for the whole test process, so a stuck suite can never block the runner forever
    const runLimit = Number(process.env.E2E_RUN_TIMEOUT_MS) || 30 * 60 * 1000;
    exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd: path.join(__dirname, ".."), env, stdio: "inherit", windowsHide: true });
      running.tests = child;
      const limitTimer = setTimeout(() => {
        console.error(`[e2e] the tests did not finish within ${Math.round(runLimit / 1000)} seconds: stopping them`);
        killTree(child.pid);
      }, runLimit);
      child.once("exit", (code) => { clearTimeout(limitTimer); resolve(code === null ? 1 : code); });
      child.once("error", () => { clearTimeout(limitTimer); resolve(1); });
    });
  } catch (error) {
    console.error(`[e2e] ${redact(error.message, secrets)}`);
    exitCode = 1;
  } finally {
    await teardown();
  }

  for (const warning of teardownWarnings) console.error(`[e2e] WARNING: ${warning}`);
  if (teardownProblems.length > 0) {
    console.error(`[e2e] cleanup problems:\n  - ${teardownProblems.join("\n  - ")}`);
    if (exitCode === 0) exitCode = 1;
  } else {
    log("cleanup complete");
  }
  log(exitCode === 0 ? "ALL E2E SUITES PASSED" : "E2E FAILED");
  return exitCode;
};

main().then((code) => process.exit(code));
