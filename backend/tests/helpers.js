// Shared test helpers. Run all tests with:  npm test   (inside the backend folder)
//
// SAFETY: tests run against a SEPARATE database (default name: online_production_test)
// on the same MongoDB server. They refuse to start if that name is the development
// database or does not contain the word "test".
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

// No request log lines in the test output (the app reads this when it is first loaded)
process.env.LOG_REQUESTS = "false";

const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const User = require("../src/models/User");
const Category = require("../src/models/Category");
const Product = require("../src/models/Product");
const Cart = require("../src/models/Cart");
const Order = require("../src/models/Order");
const orderNumbers = require("../src/utils/generateOrderNumber");
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
  await Promise.all([User.init(), Category.init(), Product.init(), Cart.init(), Order.init()]);
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
  await Order.deleteMany({ user: { $in: userIds } });
  await Cart.deleteMany({ user: { $in: userIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await Product.deleteMany({ name: new RegExp(`^T${runTag} `) });
  await Category.deleteMany({ name: new RegExp(`^T${runTag} `) });
};

// Valid delivery details for checkout. Pass overrides to break or change a field.
const validDelivery = (overrides = {}) => ({
  fullName: "Test Customer",
  phone: "+92 300 1234567",
  addressLine1: "House 12, Street 5, Test Town",
  addressLine2: "",
  city: "Lahore",
  postalCode: "54000",
  notes: "",
  ...overrides,
});

// Puts lines straight into a customer cart (faster than adding them one by one through the API).
// lines: [{ product, quantity }]
const putInCart = async (customer, lines) => {
  await Cart.deleteMany({ user: customer.user._id });
  return Cart.create({
    user: customer.user._id,
    items: lines.map((line) => ({ product: line.product._id, quantity: line.quantity })),
  });
};

// Inserts a valid order straight into the database (no stock changes), for list/cancel tests.
// lines: [{ product, quantity }]
const insertOrder = (customer, lines, overrides = {}) => {
  const items = lines.map((line) => ({
    product: line.product._id,
    name: line.product.name,
    imageUrl: line.product.imageUrl || "",
    price: line.product.price,
    quantity: line.quantity,
    lineTotal: Math.round(line.product.price * line.quantity * 100) / 100,
  }));
  const subtotal = Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) / 100;
  return Order.create({
    orderNumber: orderNumbers.generateOrderNumber(),
    user: customer.user._id,
    customer: { name: customer.user.name, email: customer.user.email },
    items,
    delivery: validDelivery({ phone: "+92 300 7654321", addressLine1: "SECRET-ADDRESS-LINE-1" }),
    paymentMethod: "cod",
    subtotal,
    shippingFee: 0,
    total: subtotal,
    statusHistory: [{ status: "pending", changedAt: new Date(), changedBy: customer.user._id }],
    ...overrides,
  });
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
  validDelivery,
  putInCart,
  insertOrder,
  cleanup,
  disconnect,
};
