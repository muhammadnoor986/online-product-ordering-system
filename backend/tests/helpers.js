// Shared test helpers. Run all tests with:  npm test   (inside the backend folder)
//
// SAFETY: tests run against a SEPARATE database (default name: online_production_test)
// on the same MongoDB server. They refuse to start if that name is the development
// database or does not contain the word "test".
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const User = require("../src/models/User");
const Category = require("../src/models/Category");
const Product = require("../src/models/Product");
const Cart = require("../src/models/Cart");
const generateToken = require("../src/utils/generateToken");

const TEST_DB_NAME = process.env.TEST_DB_NAME || "online_production_test";

// Unique text for this test run, so test data never collides with anything else
const runTag = crypto.randomBytes(4).toString("hex");

// The database name written in MONGODB_URI (mongodb://host:port/NAME?options)
const getDevelopmentDbName = (uri) => {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]*)/.exec(uri || "");
  return match && match[1] ? match[1] : "test"; // MongoDB's default database name
};

const connectTestDatabase = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is missing. Add it to backend/.env");
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is missing. Add it to backend/.env");

  const developmentDb = getDevelopmentDbName(uri);
  if (!/test/i.test(TEST_DB_NAME) || TEST_DB_NAME === developmentDb) {
    throw new Error(
      `Refusing to run: test database "${TEST_DB_NAME}" must contain "test" and differ from the development database.`
    );
  }

  await mongoose.connect(uri, { dbName: TEST_DB_NAME });
  if (mongoose.connection.name !== TEST_DB_NAME) {
    await mongoose.disconnect();
    throw new Error("Refusing to run: not connected to the test database.");
  }

  // Create the unique indexes (a brand new database has none yet)
  await Promise.all([User.init(), Category.init(), Product.init(), Cart.init()]);
};

// Starts the real Express app on a random free port
const startServer = async () => {
  const app = require("../src/app");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

// Returns a function: request(method, path, body, token) -> { status, body }
const makeClient = (baseUrl) => async (method, urlPath, body, token) => {
  const response = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

let counter = 0;
const nextNumber = () => ++counter;

// Creates a user straight in the test database and a valid login token for it
const createUser = async (role = "customer") => {
  const n = nextNumber();
  const user = await User.create({
    name: `Test ${role} ${n}`,
    email: `${runTag}-${role}-${n}@example.test`,
    password: await bcrypt.hash("Test-password-123", 4), // low cost = fast tests
    role,
  });
  return { user, id: String(user._id), token: generateToken(user) };
};

const createCategory = (suffix = "") =>
  Category.create({ name: `T${runTag} category ${nextNumber()} ${suffix}`.trim() });

const createProduct = async (category, overrides = {}) =>
  Product.create({
    name: `T${runTag} product ${nextNumber()}`,
    description: "Test product",
    price: 100,
    stock: 10,
    category: category._id,
    ...overrides,
  });

// Removes everything this run created (only documents carrying this run's tag)
const cleanup = async () => {
  const users = await User.find({ email: new RegExp(`^${runTag}-`) }).select("_id");
  const userIds = users.map((user) => user._id);
  await Cart.deleteMany({ user: { $in: userIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await Product.deleteMany({ name: new RegExp(`^T${runTag} `) });
  await Category.deleteMany({ name: new RegExp(`^T${runTag} `) });
};

const disconnect = () => mongoose.disconnect();

module.exports = {
  TEST_DB_NAME,
  runTag,
  connectTestDatabase,
  startServer,
  makeClient,
  createUser,
  createCategory,
  createProduct,
  cleanup,
  disconnect,
};
