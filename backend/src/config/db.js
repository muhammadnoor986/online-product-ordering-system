const mongoose = require("mongoose");

// How long ONE connection attempt may take before it counts as failed. (Mongoose waits 30 seconds by default;
// with several tries at startup that would be far too long for a host that checks the service's health.)
const SERVER_SELECTION_TIMEOUT_MS = 10000;

// Makes ONE attempt to connect to MongoDB (Atlas or a local server) using the connection string from .env.
// server.js repeats it a few times at startup (utils/connectWithRetry.js); on a serverless host the same function is
// called by utils/ensureDatabase.js, with a small connection pool (see `options`).
const connectDB = async (options = {}) => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing. Add it to backend/.env");
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS, ...options });
  console.log("MongoDB connected");
};

// Is the default connection open right now? (Used by the serverless wiring in app.js.)
const isDatabaseConnected = () => mongoose.connection.readyState === 1;

module.exports = connectDB;
module.exports.isDatabaseConnected = isDatabaseConnected;
