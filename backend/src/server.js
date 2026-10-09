// Load .env first so every other file can read process.env
require("dotenv").config();

const mongoose = require("mongoose");
const { validateEnv } = require("./config/env");

// Check the settings BEFORE anything starts. Every problem is listed at once, and the secret
// values are never printed. (Tests import app.js directly and do not go through this file.)
const { errors, values } = validateEnv(process.env);
if (errors.length > 0) {
  console.error("The server cannot start because backend/.env has problems:");
  for (const message of errors) console.error(`  - ${message}`);
  console.error("Fix backend/.env (see backend/.env.example) and start the server again.");
  process.exit(1);
}

// Loaded only now, because app.js reads TRUST_PROXY and LOG_REQUESTS when it is first loaded
const app = require("./app");
const connectDB = require("./config/db");
const { createShutdown, registerShutdownHandlers } = require("./utils/gracefulShutdown");
const { connectWithRetry } = require("./utils/connectWithRetry");

const PORT = values.port;

const startServer = async () => {
  // A few tries, then stop. Running without a database would leave the API "up" but useless for good
  // (Mongoose does not try the first connection again), so the process ends with exit code 1 and a host
  // that restarts failed processes can start it again. Nothing listens until the database is connected.
  // (On Vercel this file is not used: app.js connects on the first request instead, see utils/ensureDatabase.js.)
  try {
    await connectWithRetry({ connect: connectDB });
  } catch (error) {
    console.error(error.message);
    console.error("The server is stopping instead of running without a database. Check MONGODB_URI and the database's network access.");
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Ctrl+C or a "stop" request: finish the running requests, close the database, then exit
  const shutdown = createShutdown({
    server,
    closeDatabase: () => mongoose.connection.close(),
  });
  registerShutdownHandlers(process, shutdown);
};

startServer();
