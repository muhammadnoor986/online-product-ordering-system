const express = require("express");
const cors = require("cors");
const healthRoutes = require("./routes/healthRoutes");
const authRoutes = require("./routes/authRoutes");
const categoryRoutes = require("./routes/categoryRoutes");
const productRoutes = require("./routes/productRoutes");
const cartRoutes = require("./routes/cartRoutes");
const orderRoutes = require("./routes/orderRoutes");
const adminOrderRoutes = require("./routes/adminOrderRoutes");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const securityHeaders = require("./middleware/securityHeaders");
const { createRequestLogger } = require("./middleware/requestLogger");
const { parseTrustProxy, parseLogRequests } = require("./config/env");

const app = express();

// Do not tell everybody which framework runs the server
app.disable("x-powered-by");

// Which reverse proxies to trust when working out the visitor's IP address (req.ip). Off by default,
// so a visitor cannot pretend to be someone else with an X-Forwarded-For header. See TRUST_PROXY
// in README.md. (An invalid value is refused when the server starts, in server.js.)
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY).value);

// One line per request (method, path, status, time). Switch off with LOG_REQUESTS=false.
if (parseLogRequests(process.env.LOG_REQUESTS).value) {
  app.use(createRequestLogger());
}

app.use(securityHeaders);

// Only allow our React app to call this API
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173" }));
app.use(express.json());

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin/orders", adminOrderRoutes);

// These two must stay last
app.use(notFound);
app.use(errorHandler);

module.exports = app;
