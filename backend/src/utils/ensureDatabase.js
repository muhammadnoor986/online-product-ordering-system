// Database access for a SERVERLESS host (Vercel Functions), where there is no "start the server, connect once" moment.
//
// How it differs from server.js: server.js connects first (with a few tries) and only then listens; if the database stays
// unreachable it stops the process. A serverless function cannot do that: it is started by a request, may be frozen
// between requests and may be started many times at once. So here
//   * the connection is made on the FIRST request of an instance and then REUSED by every later request (one shared
//     promise: requests that arrive while it is connecting wait for the same attempt, nobody opens a second connection),
//   * a failed attempt is forgotten, so the NEXT request tries again (nothing is retried in a loop inside one request),
//   * nothing ever calls process.exit(): a database problem answers that request with HTTP 503 and the function carries on,
//   * the settings are checked once, and a wrong configuration answers 503 with a message in the log (names only,
//     never values) instead of failing in some random place later.
//
// Everything it touches is passed in, so the tests need no database and no network.
const AppError = require("./AppError");
const { validateEnv } = require("../config/env");

// The same check as server.js (validateEnv), plus the one setting that is optional on a laptop and not on Vercel.
// CLIENT_URL decides which website may call the API: without it the browser would block the real website.
// Returns a list of messages (empty = fine). The messages name settings, never their values.
const checkServerlessEnv = (env = process.env) => {
  const { errors } = validateEnv(env);
  const clientUrlMissing = env.CLIENT_URL === undefined || env.CLIENT_URL === null || String(env.CLIENT_URL).trim() === "";
  if (clientUrlMissing) {
    errors.push("CLIENT_URL is missing. Set it to the exact address of the deployed website (no path, no slash at the end)");
  }
  return errors;
};

// isConnected() -> true when the connection is already open. connect() -> makes ONE attempt (throws when it fails).
// Returns an async function that resolves when the database is ready, or rejects with the attempt's error.
const createEnsureDatabase = ({ isConnected, connect }) => {
  let pending = null;
  return async () => {
    if (isConnected()) return;
    if (!pending) {
      pending = Promise.resolve()
        .then(connect)
        .finally(() => { pending = null; }); // success: the next call finds isConnected(); failure: the next call tries again
    }
    await pending;
  };
};

// Express middleware. Run it before the routes. `ensureDatabase` comes from createEnsureDatabase.
const createDatabaseMiddleware = ({ ensureDatabase, getEnvProblems = checkServerlessEnv, log = (line) => console.error(line) }) => {
  let envProblems = null; // checked once per function instance

  return async (req, res, next) => {
    try {
      if (envProblems === null) {
        envProblems = getEnvProblems();
        if (envProblems.length > 0) {
          log(`The API is not configured correctly:\n  - ${envProblems.join("\n  - ")}`);
        }
      }
      if (envProblems.length > 0) {
        throw new AppError("The server is not configured correctly. See the function logs.", 503);
      }

      await ensureDatabase();
      next();
    } catch (error) {
      if (error instanceof AppError) return next(error);
      // Do not show connection details to visitors. The reason goes to the log without any connection string.
      log(`Database connection failed: ${String(error && error.message ? error.message : error).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://[hidden]").slice(0, 200)}`);
      next(new AppError("The database is not reachable right now. Please try again in a moment.", 503));
    }
  };
};

module.exports = { checkServerlessEnv, createEnsureDatabase, createDatabaseMiddleware };
