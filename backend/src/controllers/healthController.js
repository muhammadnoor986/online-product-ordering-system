const mongoose = require("mongoose");

// readyState 1 means "connected"
const getHealth = (req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;

  res.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? "ok" : "degraded",
    message: databaseConnected
      ? "API is working"
      : "API is running but the database is not connected",
    database: databaseConnected ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
};

module.exports = { getHealth };
