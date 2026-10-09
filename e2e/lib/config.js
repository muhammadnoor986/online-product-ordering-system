const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertRunDatabase,
  databaseNameOf,
  parseEnvFile,
  withDatabase,
} = require("./guard");
const { getFreePort } = require("./ports");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");
const FRONTEND_DIR = path.join(REPO_ROOT, "frontend");

// Works out everything one E2E run needs. Nothing is started and nothing is written here.
//
// Where does MongoDB live? The same server your development setup uses is fine (only a NEW, separate
// database is created on it), so the connection string is taken from, in this order:
//   1. E2E_MONGODB_URI (set it yourself to use another MongoDB server)
//   2. MONGODB_URI in backend/.env (the file is only READ, it is not loaded or changed)
//   3. MONGODB_URI in the environment
// Only the server part is used. The database name is replaced by a new per-run one.
const resolveConfig = async (env = process.env) => {
  const developmentNames = new Set();
  let fileUri;
  const envFile = path.join(BACKEND_DIR, ".env");
  if (fs.existsSync(envFile)) {
    fileUri = parseEnvFile(fs.readFileSync(envFile, "utf8")).MONGODB_URI;
    if (fileUri) developmentNames.add(databaseNameOf(fileUri));
  }
  if (env.MONGODB_URI) developmentNames.add(databaseNameOf(env.MONGODB_URI));

  const baseUri = env.E2E_MONGODB_URI || fileUri || env.MONGODB_URI;
  if (!baseUri) {
    throw new Error(
      "No MongoDB server is configured for the E2E tests. Set E2E_MONGODB_URI, or put MONGODB_URI in backend/.env."
    );
  }

  const runId = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const databaseName = `online_production_test_e2e_${runId}`;
  const developmentDatabaseNames = [...developmentNames];
  assertRunDatabase(databaseName, developmentDatabaseNames);

  const apiPort = await getFreePort();
  const appPort = await getFreePort({ avoid: [apiPort] });

  return {
    runId,
    databaseName,
    developmentDatabaseNames,
    mongoUri: withDatabase(baseUri, databaseName),
    // A new random secret for every run. It is never written to a file or printed.
    jwtSecret: crypto.randomBytes(48).toString("hex"),
    apiPort,
    appPort,
    apiUrl: `http://localhost:${apiPort}/api`,
    appUrl: `http://localhost:${appPort}`,
  };
};

module.exports = { REPO_ROOT, BACKEND_DIR, FRONTEND_DIR, resolveConfig };
