const express = require("express");
const cors = require("cors");
const healthRoutes = require("./routes/healthRoutes");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const app = express();

// Only allow our React app to call this API
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173" }));
app.use(express.json());

app.use("/api/health", healthRoutes);

// These two must stay last
app.use(notFound);
app.use(errorHandler);

module.exports = app;
