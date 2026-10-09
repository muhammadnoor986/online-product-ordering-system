const { createRequire } = require("node:module");
const path = require("node:path");
const { BACKEND_DIR } = require("./config");
const { assertNotDevelopmentServer, assertRunDatabase } = require("./guard");

// The E2E code uses the backend's own libraries and models (mongoose, bcrypt, the Mongoose models),
// so tests create exactly the kind of documents the real server reads.
// (createRequire starts the lookup inside backend/, where those packages are installed.)
const backendRequire = createRequire(path.join(BACKEND_DIR, "package.json"));

// Reads the run's settings from the environment that run.js gave this process, and checks
// every safety rule again. A suite started by hand, without the runner, is refused.
const readRunSettings = (env = process.env) => {
  for (const name of ["E2E_APP_URL", "E2E_API_URL", "E2E_MONGODB_URI", "E2E_DB_NAME", "E2E_RUN_DIR"]) {
    if (!env[name]) {
      throw new Error(`${name} is missing. Start the E2E tests with "npm run test:e2e" (not by running a suite file directly).`);
    }
  }
  const developmentNames = (env.E2E_DEV_DB_NAMES || "").split(",").filter(Boolean);
  assertRunDatabase(env.E2E_DB_NAME, developmentNames);
  assertNotDevelopmentServer(env.E2E_APP_URL, "the E2E frontend");
  assertNotDevelopmentServer(env.E2E_API_URL, "the E2E backend");
  return {
    appUrl: env.E2E_APP_URL,
    apiUrl: env.E2E_API_URL,
    mongoUri: env.E2E_MONGODB_URI,
    databaseName: env.E2E_DB_NAME,
    developmentNames,
    runDir: env.E2E_RUN_DIR,
    browserPath: env.E2E_BROWSER || "",
    artifactsDir: env.E2E_ARTIFACTS_DIR || "",
  };
};

// Connects to the run's database (and ONLY that one). Returns the Mongoose library.
const connectRunDatabase = async (settings) => {
  assertRunDatabase(settings.databaseName, settings.developmentNames);
  const mongoose = backendRequire("mongoose");
  await mongoose.connect(settings.mongoUri, { dbName: settings.databaseName });
  if (mongoose.connection.name !== settings.databaseName) {
    await mongoose.disconnect();
    throw new Error("E2E safety check failed: connected to a different database than the run's database.");
  }
  return mongoose;
};

// Removes the whole database of this run. Refuses anything that is not a per-run E2E database.
const dropRunDatabase = async (settings) => {
  assertRunDatabase(settings.databaseName, settings.developmentNames);
  const mongoose = backendRequire("mongoose");
  const connection = await mongoose.createConnection(settings.mongoUri, { dbName: settings.databaseName }).asPromise();
  try {
    if (connection.name !== settings.databaseName) {
      throw new Error("E2E safety check failed: connected to a different database than the run's database.");
    }
    await connection.dropDatabase();
  } finally {
    await connection.close();
  }
};

module.exports = { backendRequire, readRunSettings, connectRunDatabase, dropRunDatabase };
