// Connects to the database with a few tries, for the moment the server starts.
//
// Why: a host may start the API a little before the database accepts
// connections, and a free database can need a few seconds to wake up. A short, bounded series
// of tries covers that. If the database still cannot be reached, this throws, and server.js
// stops the process with exit code 1, so the host restarts it. (The old behaviour was to keep
// running with no database at all, forever, because Mongoose does not try the first connection again.)
//
// Everything it touches is passed in, so the tests need no database, no network and no waiting.
//
//   connect       async function that makes one connection attempt (it throws when it fails)
//   attempts      how many tries in all (default 5)
//   baseDelayMs   the pause after the first failure; it doubles after each further failure
//   maxDelayMs    the longest pause (default 8 seconds)
//   sleep         waits for the given milliseconds
//   errorLog      where the progress lines go (never a secret: see safeMessage)

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 8000;

// The text of an error, made safe to print: a connection string (it holds the password) is hidden,
// white space is flattened, and the length is limited.
const safeMessage = (error) =>
  String(error && error.message ? error.message : error)
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://[hidden]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Returns the number of the attempt that worked. Throws an Error (with a safe message) when every attempt failed.
const connectWithRetry = async ({
  connect,
  attempts = DEFAULT_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  sleep = defaultSleep,
  errorLog = (line) => console.error(line),
} = {}) => {
  if (typeof connect !== "function") throw new TypeError("connectWithRetry needs a connect function");
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts must be a whole number of 1 or more");

  for (let attempt = 1; ; attempt++) {
    try {
      await connect();
      return attempt;
    } catch (error) {
      if (attempt >= attempts) {
        throw new Error(`Could not connect to MongoDB after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}. Last problem: ${safeMessage(error)}`);
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      errorLog(`MongoDB connection attempt ${attempt} of ${attempts} failed: ${safeMessage(error)}. Trying again in ${Math.round(delay / 100) / 10}s...`);
      await sleep(delay);
    }
  }
};

module.exports = { connectWithRetry, safeMessage, DEFAULT_ATTEMPTS, DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS };
