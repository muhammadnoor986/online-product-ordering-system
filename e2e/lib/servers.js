const fs = require("node:fs");
const path = require("node:path");
const { BACKEND_DIR, FRONTEND_DIR } = require("./config");
const { assertNotDevelopmentServer } = require("./guard");
const { startNodeProcess } = require("./processes");
const { scaled } = require("./timeouts");

// Settings that must never leak from your own shell into the E2E servers
const REMOVED_FROM_ENVIRONMENT = [
  "MONGODB_URI", "JWT_SECRET", "JWT_EXPIRES_IN", "PORT", "CLIENT_URL", "TRUST_PROXY", "LOG_REQUESTS",
  "ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_NAME", "TEST_DB_NAME", "VITE_API_URL",
];

const cleanEnvironment = () => {
  const env = { ...process.env };
  for (const name of REMOVED_FROM_ENVIRONMENT) delete env[name];
  return env;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Asks `url` again and again until `accept(response)` says yes. Fails (with the reason) when the
// time runs out, or when the process that should answer has already stopped.
const waitForHttp = async (url, { label, handle, accept = async (response) => response.ok, timeoutMs = scaled(40000) }) => {
  const startedAt = Date.now();
  let lastProblem = "no answer yet";
  while (Date.now() - startedAt < timeoutMs) {
    if (handle && handle.hasExited) {
      throw new Error(`${label} stopped while starting.\n${handle.safeOutput()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (await accept(response)) return;
      lastProblem = `answered ${response.status}`;
    } catch (error) {
      lastProblem = error.cause && error.cause.code ? error.cause.code : error.message;
    }
    await sleep(200);
  }
  throw new Error(`${label} was not ready after ${Math.round(timeoutMs / 1000)} seconds (${lastProblem}).\n${handle ? handle.safeOutput() : ""}`);
};

// Starts the real backend (backend/src/server.js, unchanged) for this run only:
// its own port, the new E2E database, and a random secret.
// It runs in an empty folder, so it cannot read backend/.env.
// `onStarted(handle)` is called the moment the process exists, BEFORE waiting for it to be ready,
// so the caller can always stop it, even when it never becomes ready.
const startBackend = async (config, runDir, onStarted = () => {}) => {
  assertNotDevelopmentServer(config.apiUrl, "the E2E backend");
  const cwd = path.join(runDir, "backend-cwd");
  fs.mkdirSync(cwd, { recursive: true });

  const env = {
    ...cleanEnvironment(),
    MONGODB_URI: config.mongoUri,
    JWT_SECRET: config.jwtSecret,
    JWT_EXPIRES_IN: "1d",
    PORT: String(config.apiPort),
    CLIENT_URL: config.appUrl,
    TRUST_PROXY: "false",
    LOG_REQUESTS: "false",
  };
  const handle = startNodeProcess("backend", [path.join(BACKEND_DIR, "src", "server.js")], {
    cwd,
    env,
    secrets: [config.jwtSecret, config.mongoUri],
  });
  onStarted(handle);

  await waitForHttp(`${config.apiUrl}/health`, {
    label: "The E2E backend",
    handle,
    accept: async (response) => response.ok && (await response.json()).database === "connected",
  });
  return handle;
};

// Starts the real frontend (Vite, unchanged) for this run only. It is told where the E2E backend
// is through VITE_API_URL, the setting the frontend already has.
const startFrontend = async (config, onStarted = () => {}) => {
  assertNotDevelopmentServer(config.appUrl, "the E2E frontend");
  const viteScript = path.join(FRONTEND_DIR, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteScript)) {
    throw new Error("Vite is not installed. Run `npm install` in the frontend folder first.");
  }

  const env = { ...cleanEnvironment(), VITE_API_URL: config.apiUrl };
  const handle = startNodeProcess(
    "frontend",
    [viteScript, "--port", String(config.appPort), "--strictPort", "--host", "localhost"],
    { cwd: FRONTEND_DIR, env, secrets: [config.jwtSecret, config.mongoUri] }
  );
  onStarted(handle);

  await waitForHttp(`${config.appUrl}/`, { label: "The E2E frontend", handle });
  return handle;
};

module.exports = { startBackend, startFrontend, waitForHttp, cleanEnvironment };
