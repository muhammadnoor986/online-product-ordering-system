const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");

const Order = require("../src/models/Order");
const Product = require("../src/models/Product");
const User = require("../src/models/User");
const orderService = require("../src/services/orderService");
const generateToken = require("../src/utils/generateToken");
const { ORDER_STATUSES, ORDER_TRANSITIONS } = require("../src/constants/orderStatus");
const helpers = require("./helpers");

let request; // request(method, path, body, token) -> { status, body }
let baseUrl;
let server;
let category;
let admin;

before(async () => {
  await helpers.connectTestDatabase();
  server = await helpers.startServer();
  baseUrl = server.baseUrl;
  request = helpers.makeClient(server.baseUrl);
  category = await helpers.createCategory();
  admin = await helpers.createUser("admin");
});

after(async () => {
  try {
    await helpers.cleanup();
  } finally {
    if (server) await server.close();
    await helpers.disconnect();
  }
});

// ---- helpers -------------------------------------------------------------
// A word that only THIS scenario uses. Searching for it keeps a test away from the orders of
// other scenarios (and of other test files running at the same time in the same database).
const unique = (label) => `${label}${helpers.runTag}`;

// A customer with a chosen name (so that searches can find exactly them)
const makeCustomer = async (name, emailKey) => {
  const user = await User.create({
    name,
    email: `${helpers.runTag}-${emailKey}@example.test`,
    password: await bcrypt.hash("Test-password-123", 4),
    role: "customer",
  });
  return { user, id: String(user._id), token: generateToken(user) };
};

const queryString = (query) => new URLSearchParams(query).toString();
const adminList = (query = {}, token = admin.token) => request("GET", `/api/admin/orders?${queryString(query)}`, undefined, token);
const adminGet = (id, token = admin.token) => request("GET", `/api/admin/orders/${id}`, undefined, token);
const advance = (id, status, note, token = admin.token) =>
  request("PATCH", `/api/admin/orders/${id}/status`, note === undefined ? { status } : { status, note }, token);
const adminCancel = (id, body, token = admin.token) => request("POST", `/api/admin/orders/${id}/cancel`, body, token);
const customerCancel = (customer, id) => request("POST", `/api/orders/${id}/cancel`, undefined, customer.token);
const stockOf = async (product) => (await Product.findById(product._id)).stock;
const silenceErrors = (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  return logs;
};

// An order in the database (no stock is touched)
const makeOrder = async (customer, lines, overrides = {}) => {
  const product = lines || [[await helpers.createProduct(category, { stock: 20, price: 100 }), 2]];
  return helpers.insertOrder(
    customer,
    product.map(([p, quantity]) => ({ product: p, quantity })),
    overrides
  );
};

// A REAL order made through checkout, so the stock is really taken
const checkoutOrder = async (customer, lines) => {
  await helpers.putInCart(customer, lines.map(([product, quantity]) => ({ product, quantity })));
  const response = await request("POST", "/api/orders", { delivery: helpers.validDelivery(), paymentMethod: "cod" }, customer.token);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.order;
};

// Walks an order forward to a status through the real endpoint
const walkTo = async (id, target) => {
  const path = ["confirmed", "processing", "shipped", "delivered"];
  for (const step of path) {
    const response = await advance(id, step);
    assert.equal(response.status, 200, `to ${step}: ${JSON.stringify(response.body)}`);
    if (step === target) return response.body.order;
  }
  return null;
};

// ===========================================================================
describe("Admin orders: who may use them", () => {
  let customer;
  let order;

  before(async () => {
    customer = await helpers.createUser("customer");
    order = await makeOrder(customer);
  });

  const calls = (id) => [
    ["GET", "/api/admin/orders", undefined],
    ["GET", `/api/admin/orders/${id}`, undefined],
    ["PATCH", `/api/admin/orders/${id}/status`, { status: "confirmed" }],
    ["POST", `/api/admin/orders/${id}/cancel`, {}],
  ];

  it("returns 401 on every admin order endpoint without a token, and with a bad token", async () => {
    for (const [method, url, body] of calls(order._id)) {
      assert.equal((await request(method, url, body)).status, 401, `${method} ${url}`);
      assert.equal((await request(method, url, body, "not.a.real-token")).status, 401, `${method} ${url} bad token`);
    }
  });

  it("returns 403 on every admin order endpoint for a customer, and changes nothing", async () => {
    for (const [method, url, body] of calls(order._id)) {
      const response = await request(method, url, body, customer.token);
      assert.equal(response.status, 403, `${method} ${url}`);
      assert.equal(typeof response.body.message, "string");
    }
    const after = await Order.findById(order._id);
    assert.equal(after.status, "pending");
    assert.equal(after.statusHistory.length, 1);
  });

  it("a customer cannot reach the admin routes with the customer order routes either", async () => {
    assert.equal((await request("PATCH", `/api/orders/${order._id}/status`, { status: "confirmed" }, customer.token)).status, 404);
    assert.equal((await request("GET", "/api/admin/orders/", undefined, customer.token)).status, 403);
  });

  it("admins still cannot use the CUSTOMER order endpoints (unchanged)", async () => {
    assert.equal((await request("GET", "/api/orders", undefined, admin.token)).status, 403);
    assert.equal((await request("POST", `/api/orders/${order._id}/cancel`, undefined, admin.token)).status, 403);
  });

  it("an admin is allowed in", async () => {
    assert.equal((await adminGet(order._id)).status, 200);
  });

  it("answers the browser's permission check for PATCH (CORS), so the admin page can call it", async () => {
    const response = await fetch(`${baseUrl}/api/admin/orders/${order._id}/status`, {
      method: "OPTIONS",
      headers: {
        Origin: process.env.CLIENT_URL || "http://localhost:5173",
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.equal(response.status, 204);
    assert.match(response.headers.get("access-control-allow-methods"), /PATCH/);
  });

  it("the Order collection has the indexes for the admin list", async () => {
    const indexes = (await Order.collection.indexes()).map((index) => JSON.stringify(index.key));
    assert.ok(indexes.includes('{"status":1,"createdAt":-1}'), indexes.join(" "));
    assert.ok(indexes.includes('{"createdAt":-1}'), indexes.join(" "));
  });
});

// ===========================================================================
describe("Admin orders: list, pagination and sorting", () => {
  const word = unique("Pager");
  let alice;
  let bob;
  let created = []; // oldest first

  before(async () => {
    alice = await makeCustomer(`Alice ${word}`, "pager-a");
    bob = await makeCustomer(`Bob ${word}`, "pager-b");
    const product = await helpers.createProduct(category, { stock: 100, price: 10 });
    const base = Date.now() - 30 * 24 * 3600 * 1000;
    for (let i = 0; i < 25; i++) {
      created.push(
        await makeOrder(i % 2 === 0 ? alice : bob, [[product, (i % 3) + 1]], { createdAt: new Date(base + i * 60 * 1000) })
      );
    }
  });

  it("shows the orders of ALL customers, newest first, 10 per page by default", async () => {
    const response = await adminList({ search: word });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.orders.length, 10);
    assert.deepEqual(response.body.pagination, { page: 1, limit: 10, total: 25, totalPages: 3, hasNextPage: true });
    const expected = [...created].reverse().slice(0, 10).map((o) => o.orderNumber);
    assert.deepEqual(response.body.orders.map((o) => o.orderNumber), expected);
    const customers = new Set(response.body.orders.map((o) => o.customer.name));
    assert.equal(customers.size, 2, "orders of both customers are listed");
  });

  it("paginates", async () => {
    const second = await adminList({ search: word, page: 2 });
    assert.equal(second.body.orders.length, 10);
    assert.deepEqual(second.body.orders.map((o) => o.orderNumber), [...created].reverse().slice(10, 20).map((o) => o.orderNumber));
    const third = await adminList({ search: word, page: 3 });
    assert.equal(third.body.orders.length, 5);
    assert.equal(third.body.pagination.hasNextPage, false);
    const small = await adminList({ search: word, limit: 4, page: 7 });
    assert.equal(small.body.orders.length, 1);
    assert.equal(small.body.pagination.totalPages, 7);
    const beyond = await adminList({ search: word, page: 99 });
    assert.equal(beyond.status, 200);
    assert.deepEqual(beyond.body.orders, []);
  });

  it("caps the page size at 50", async () => {
    const response = await adminList({ search: word, limit: 500 });
    assert.equal(response.status, 200);
    assert.equal(response.body.pagination.limit, 50);
    assert.equal(response.body.orders.length, 25);
  });

  it("sorts oldest first on request", async () => {
    const response = await adminList({ search: word, sort: "oldest", limit: 5 });
    assert.deepEqual(response.body.orders.map((o) => o.orderNumber), created.slice(0, 5).map((o) => o.orderNumber));
    const newest = await adminList({ search: word, sort: "newest", limit: 1 });
    assert.equal(newest.body.orders[0].orderNumber, created[24].orderNumber);
  });

  it("rejects bad page, limit and sort values with 400", async () => {
    for (const query of ["page=0", "page=-1", "page=abc", "page=1.5", "page=", "limit=0", "limit=-5", "limit=abc", "limit=2.5", "sort=random", "sort=", "sort=newest&sort=oldest"]) {
      const response = await request("GET", `/api/admin/orders?${query}`, undefined, admin.token);
      assert.equal(response.status, 400, query);
      assert.equal(typeof response.body.message, "string");
    }
  });

  it("each row has what an admin needs, and no address or item list", async () => {
    const response = await adminList({ search: word, limit: 1 });
    const row = response.body.orders[0];
    assert.deepEqual(Object.keys(row).sort(), [
      "_id", "allowedNextStatuses", "createdAt", "customer", "itemCount", "orderNumber", "paymentMethod", "paymentStatus", "status", "total",
    ]);
    assert.deepEqual(Object.keys(row.customer).sort(), ["email", "name"]);
    assert.equal(row.itemCount, created[24].items[0].quantity);
    assert.deepEqual(row.allowedNextStatuses, ["confirmed", "cancelled"]);
    const text = JSON.stringify(response.body);
    for (const leaked of ["SECRET-ADDRESS-LINE-1", "7654321", "password", "__v", "statusHistory", "stockRestored"]) {
      assert.ok(!text.includes(leaked), `the list must not contain ${leaked}`);
    }
  });

  it("every row shows the right next statuses for its status", async () => {
    const customer = await makeCustomer(`Next ${unique("Nexts")}`, "nexts");
    for (const status of ORDER_STATUSES) await makeOrder(customer, undefined, { status });
    const response = await adminList({ search: unique("Nexts"), limit: 50 });
    assert.equal(response.body.orders.length, 6);
    for (const row of response.body.orders) {
      assert.deepEqual(row.allowedNextStatuses, [...ORDER_TRANSITIONS[row.status]], row.status);
    }
  });
});

// ===========================================================================
describe("Admin orders: search", () => {
  const word = unique("Finder");
  let target;
  let other;
  let targetOrder;
  let otherOrder;

  before(async () => {
    target = await makeCustomer(`Zainab Qureshi ${word}`, "finder-target");
    other = await makeCustomer(`Someone Else ${word}`, "finder-other");
    targetOrder = await makeOrder(target, undefined, {
      delivery: helpers.validDelivery({ fullName: "Receiver Zainab", phone: "+92 345 1112223" }),
    });
    otherOrder = await makeOrder(other, undefined, {
      delivery: helpers.validDelivery({ fullName: "Another Person", phone: "0300-5554443" }),
    });
  });

  const ids = (response) => response.body.orders.map((o) => String(o._id));

  it("finds an order by its full order number", async () => {
    const response = await adminList({ search: targetOrder.orderNumber });
    assert.deepEqual(ids(response), [String(targetOrder._id)]);
  });

  it("finds an order by part of its number, in any letter case", async () => {
    const part = targetOrder.orderNumber.slice(-6).toLowerCase();
    const response = await adminList({ search: part });
    assert.ok(ids(response).includes(String(targetOrder._id)));
    assert.ok(response.body.orders.every((o) => o.orderNumber.toLowerCase().includes(part)));
  });

  it("finds by the customer's name (any case, part of it)", async () => {
    for (const term of ["zainab qureshi", "QURESHI", `zainab qureshi ${word}`]) {
      const response = await adminList({ search: term });
      assert.ok(ids(response).includes(String(targetOrder._id)), term);
    }
  });

  it("finds by the customer's e-mail", async () => {
    const response = await adminList({ search: target.user.email.toUpperCase() });
    assert.deepEqual(ids(response), [String(targetOrder._id)]);
  });

  it("finds by the name typed for delivery", async () => {
    const response = await adminList({ search: "receiver zainab" });
    assert.ok(ids(response).includes(String(targetOrder._id)));
  });

  it("finds by phone number, typed with or without the spaces and dashes", async () => {
    for (const term of ["+92 345 1112223", "345 1112223", "3451112223", "345-111-2223", "1112223"]) {
      const response = await adminList({ search: term });
      assert.ok(ids(response).includes(String(targetOrder._id)), `phone search "${term}"`);
      assert.ok(!ids(response).includes(String(otherOrder._id)), `phone search "${term}" must not find the other order`);
    }
    const dashed = await adminList({ search: "03005554443" });
    assert.ok(ids(dashed).includes(String(otherOrder._id)), "0300-5554443 stored with a dash is found without it");
  });

  it("a search that matches nothing returns an empty list (not an error)", async () => {
    const response = await adminList({ search: "no-such-order-anywhere-zzzzzz" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.orders, []);
    assert.equal(response.body.pagination.total, 0);
    assert.equal(response.body.pagination.totalPages, 0);
  });

  it("special characters are searched as plain text, never as a pattern", async () => {
    for (const term of [".*", "(", ")", "[", "]", "\\", "^", "$", "|", "?", "{", "(a+)+$", "a**", ".*.*.*"]) {
      const response = await adminList({ search: term });
      assert.equal(response.status, 200, `search ${term}`);
      assert.equal(response.body.pagination.total, 0, `"${term}" must not match everything`);
    }
  });

  it("a plus sign is searched as a plain character (phone numbers start with one), not as a pattern", async () => {
    const response = await adminList({ search: "+", limit: 50 });
    assert.equal(response.status, 200);
    assert.ok(response.body.pagination.total > 0, "orders whose phone contains + are found");
    // every order found really contains a "+" in one of the searched fields
    for (const row of response.body.orders.slice(0, 10)) {
      const detail = (await adminGet(row._id)).body.order;
      const haystack = [detail.orderNumber, detail.customer.name, detail.customer.email, detail.delivery.fullName, detail.delivery.phone].join("|");
      assert.ok(haystack.includes("+"), row.orderNumber);
    }
  });

  it("blank search is ignored; letters in other alphabets work", async () => {
    const blank = await adminList({ search: "   " });
    assert.equal(blank.status, 200);
    const urdu = await adminList({ search: "علی" });
    assert.equal(urdu.status, 200);
  });

  it("rejects a search that is too long, or not text", async () => {
    assert.equal((await adminList({ search: "a".repeat(101) })).status, 400);
    assert.equal((await adminList({ search: "a".repeat(100) })).status, 200);
    assert.equal((await request("GET", "/api/admin/orders?search=a&search=b", undefined, admin.token)).status, 400);
  });

  it("bracket-style parameters are ignored (they cannot inject query operators)", async () => {
    for (const query of ["search[$ne]=x", "status[$ne]=pending", "paymentStatus[$ne]=paid", "search[$regex]=.*", "$where=1", "user=abc"]) {
      const response = await request("GET", `/api/admin/orders?${query}&limit=1`, undefined, admin.token);
      assert.equal(response.status, 200, query);
    }
  });
});

// ===========================================================================
describe("Admin orders: status and payment filters, status counts", () => {
  const word = unique("Filter");
  let customer;

  before(async () => {
    customer = await makeCustomer(`Filter ${word}`, "filter");
    const plan = [["pending", 3], ["confirmed", 2], ["processing", 1], ["shipped", 2], ["delivered", 4], ["cancelled", 2]];
    for (const [status, count] of plan) {
      for (let i = 0; i < count; i++) {
        await makeOrder(customer, undefined, { status, paymentStatus: status === "delivered" ? "paid" : "pending" });
      }
    }
  });

  it("filters by status", async () => {
    for (const [status, count] of [["pending", 3], ["confirmed", 2], ["processing", 1], ["shipped", 2], ["delivered", 4], ["cancelled", 2]]) {
      const response = await adminList({ search: word, status });
      assert.equal(response.body.pagination.total, count, status);
      assert.ok(response.body.orders.every((o) => o.status === status));
    }
  });

  it("filters by payment status, and combines the filters", async () => {
    const paid = await adminList({ search: word, paymentStatus: "paid" });
    assert.equal(paid.body.pagination.total, 4);
    assert.ok(paid.body.orders.every((o) => o.paymentStatus === "paid" && o.status === "delivered"));
    const unpaid = await adminList({ search: word, paymentStatus: "pending" });
    assert.equal(unpaid.body.pagination.total, 10);
    const none = await adminList({ search: word, status: "pending", paymentStatus: "paid" });
    assert.equal(none.body.pagination.total, 0);
    const both = await adminList({ search: word, status: "cancelled", paymentStatus: "pending" });
    assert.equal(both.body.pagination.total, 2);
  });

  it("rejects unknown or repeated filter values with 400", async () => {
    for (const query of ["status=shipping", "status=PENDING", "status=", "status=pending&status=confirmed", "paymentStatus=settled", "paymentStatus=", "paymentStatus=paid&paymentStatus=pending"]) {
      assert.equal((await request("GET", `/api/admin/orders?${query}`, undefined, admin.token)).status, 400, query);
    }
  });

  it("statusCounts has all six statuses, with zeros where there are none", async () => {
    const response = await adminList({ search: word });
    assert.deepEqual(response.body.statusCounts, { pending: 3, confirmed: 2, processing: 1, shipped: 2, delivered: 4, cancelled: 2 });
    const empty = await adminList({ search: "nothing-matches-this-zzzz" });
    assert.deepEqual(empty.body.statusCounts, { pending: 0, confirmed: 0, processing: 0, shipped: 0, delivered: 0, cancelled: 0 });
  });

  it("statusCounts ignore the status filter (so filter tabs keep their numbers)", async () => {
    const response = await adminList({ search: word, status: "delivered" });
    assert.equal(response.body.pagination.total, 4);
    assert.deepEqual(response.body.statusCounts, { pending: 3, confirmed: 2, processing: 1, shipped: 2, delivered: 4, cancelled: 2 });
  });

  it("statusCounts do follow the search and the payment filter", async () => {
    const response = await adminList({ search: word, paymentStatus: "paid" });
    assert.deepEqual(response.body.statusCounts, { pending: 0, confirmed: 0, processing: 0, shipped: 0, delivered: 4, cancelled: 0 });
  });
});

// ===========================================================================
describe("Admin orders: details", () => {
  let customer;
  let order;
  let product;

  before(async () => {
    customer = await makeCustomer(`Detail ${unique("Detail")}`, "detail");
    product = await helpers.createProduct(category, { price: 250.75, stock: 10, imageUrl: "https://example.com/a.jpg" });
    order = await makeOrder(customer, [[product, 3]]);
  });

  it("shows the complete order: customer, delivery, items, payment, totals, status", async () => {
    const response = await adminGet(order._id);
    assert.equal(response.status, 200);
    const o = response.body.order;
    assert.equal(o.orderNumber, order.orderNumber);
    assert.equal(o.status, "pending");
    assert.equal(o.paymentMethod, "cod");
    assert.equal(o.paymentStatus, "pending");
    assert.deepEqual(o.customer, { name: customer.user.name, email: customer.user.email });
    assert.equal(o.userId, customer.id);
    assert.equal(o.delivery.phone, "+92 300 7654321");
    assert.equal(o.delivery.addressLine1, "SECRET-ADDRESS-LINE-1");
    assert.equal(o.delivery.city, "Lahore");
    assert.deepEqual(o.items, [
      { productId: String(product._id), name: product.name, imageUrl: "https://example.com/a.jpg", price: 250.75, quantity: 3, lineTotal: 752.25 },
    ]);
    assert.equal(o.subtotal, 752.25);
    assert.equal(o.shippingFee, 0);
    assert.equal(o.total, 752.25);
    assert.equal(o.stockRestored, false);
    assert.deepEqual(o.allowedNextStatuses, ["confirmed", "cancelled"]);
    assert.equal(o.canCancel, true);
    assert.ok(o.createdAt && o.updatedAt);
  });

  it("names who made each status change", async () => {
    const o = (await adminGet(order._id)).body.order;
    assert.equal(o.statusHistory.length, 1);
    assert.deepEqual(o.statusHistory[0].changedBy, { id: customer.id, name: customer.user.name, role: "customer" });
    await advance(order._id, "confirmed", "Checked by phone");
    const after = (await adminGet(order._id)).body.order;
    assert.equal(after.statusHistory.length, 2);
    assert.deepEqual(after.statusHistory[1].changedBy, { id: admin.id, name: admin.user.name, role: "admin" });
    assert.equal(after.statusHistory[1].note, "Checked by phone");
  });

  it("shows 'Unknown user' for a history entry of a user who no longer exists", async () => {
    const ghost = await makeOrder(customer, undefined, {
      statusHistory: [{ status: "pending", changedAt: new Date(), changedBy: "a".repeat(24) }],
    });
    const o = (await adminGet(ghost._id)).body.order;
    assert.deepEqual(o.statusHistory[0].changedBy, { id: "a".repeat(24), name: "Unknown user", role: null });
  });

  it("never exposes passwords or database internals", async () => {
    const text = JSON.stringify((await adminGet(order._id)).body);
    for (const secret of ["password", "__v", "$2b$", "Test-password"]) assert.ok(!text.includes(secret), secret);
  });

  it("reports canCancel correctly for every status", async () => {
    for (const status of ORDER_STATUSES) {
      const o = await makeOrder(customer, undefined, { status });
      const view = (await adminGet(o._id)).body.order;
      assert.equal(view.canCancel, ["pending", "confirmed", "processing"].includes(status), status);
    }
  });

  it("rejects bad ids with 400 and unknown ids with 404, on every endpoint", async () => {
    for (const id of ["abc", "123", "g".repeat(24), "a".repeat(23), "a".repeat(25), "null", "undefined", "%20", "$ne"]) {
      const safe = encodeURIComponent(id);
      assert.equal((await adminGet(safe)).status, 400, `GET ${id}`);
      assert.equal((await request("PATCH", `/api/admin/orders/${safe}/status`, { status: "confirmed" }, admin.token)).status, 400, `PATCH ${id}`);
      assert.equal((await request("POST", `/api/admin/orders/${safe}/cancel`, {}, admin.token)).status, 400, `POST ${id}`);
    }
    const unknown = "e".repeat(24);
    assert.equal((await adminGet(unknown)).status, 404);
    assert.equal((await advance(unknown, "confirmed")).status, 404);
    assert.equal((await adminCancel(unknown, {})).status, 404);
  });

  it("accepts an upper-case id", async () => {
    assert.equal((await adminGet(String(order._id).toUpperCase())).status, 200);
  });
});

// ===========================================================================
describe("Admin orders: moving an order forward, one step at a time", () => {
  let customer;

  before(async () => {
    customer = await helpers.createUser("customer");
  });

  it("walks an order through pending > confirmed > processing > shipped > delivered", async () => {
    const order = await makeOrder(customer);
    for (const step of ["confirmed", "processing", "shipped", "delivered"]) {
      const response = await advance(order._id, step);
      assert.equal(response.status, 200, step);
      assert.equal(response.body.order.status, step);
      assert.equal(response.body.message, `Order is now ${step}`);
    }
    const stored = await Order.findById(order._id);
    assert.deepEqual(stored.statusHistory.map((entry) => entry.status), ["pending", "confirmed", "processing", "shipped", "delivered"]);
    assert.ok(stored.statusHistory.slice(1).every((entry) => String(entry.changedBy) === admin.id));
  });

  it("refuses EVERY other combination of statuses (all 36), and changes nothing", async () => {
    const allowedForward = { pending: "confirmed", confirmed: "processing", processing: "shipped", shipped: "delivered" };
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (to === "cancelled") continue; // cancelling has its own endpoint, tested below
        const order = await makeOrder(customer, undefined, { status: from, paymentStatus: from === "delivered" ? "paid" : "pending" });
        const before = await Order.findById(order._id);
        const response = await advance(order._id, to);

        if (allowedForward[from] === to) {
          assert.equal(response.status, 200, `${from} -> ${to}`);
        } else {
          assert.equal(response.status, 409, `${from} -> ${to} must be refused`);
          assert.equal(response.body.details[0].reason, "invalid_transition");
          assert.equal(response.body.details[0].currentStatus, from);
          const after = await Order.findById(order._id);
          assert.equal(after.status, from, `${from} -> ${to} left the status alone`);
          assert.equal(after.statusHistory.length, before.statusHistory.length, "no history entry for a refused change");
          assert.equal(after.paymentStatus, before.paymentStatus);
        }
      }
    }
  });

  it("explains why: skipping, going back, repeating, and final statuses", async () => {
    const pending = await makeOrder(customer);
    const skip = await advance(pending._id, "shipped");
    assert.equal(skip.status, 409);
    assert.match(skip.body.message, /can only move to: confirmed/);

    const confirmed = await makeOrder(customer, undefined, { status: "confirmed" });
    const back = await advance(confirmed._id, "pending");
    assert.equal(back.status, 409);
    const same = await advance(confirmed._id, "confirmed");
    assert.equal(same.status, 409);
    assert.match(same.body.message, /already confirmed/);

    for (const status of ["delivered", "cancelled"]) {
      const final = await makeOrder(customer, undefined, { status });
      const response = await advance(final._id, "shipped");
      assert.equal(response.status, 409);
      assert.match(response.body.message, /can no longer be changed/);
      assert.deepEqual(response.body.details[0].allowedNextStatuses, []);
    }
  });

  it("a delivered order cannot be modified in any way", async () => {
    const delivered = await makeOrder(customer, undefined, { status: "delivered", paymentStatus: "paid" });
    for (const status of ["pending", "confirmed", "processing", "shipped", "delivered"]) {
      assert.equal((await advance(delivered._id, status)).status, 409, status);
    }
    assert.equal((await adminCancel(delivered._id, {})).status, 409);
    const stored = await Order.findById(delivered._id);
    assert.equal(stored.status, "delivered");
    assert.equal(stored.paymentStatus, "paid");
    assert.equal(stored.statusHistory.length, 1);
  });

  it("cancelling through the status endpoint is refused, and points to the cancel endpoint", async () => {
    const order = await makeOrder(customer);
    const response = await advance(order._id, "cancelled");
    assert.equal(response.status, 400);
    assert.match(response.body.message, /cancel endpoint/);
    assert.equal((await Order.findById(order._id)).status, "pending");
  });

  it("rejects a missing, unknown or wrongly typed status with 400", async () => {
    const order = await makeOrder(customer);
    for (const body of [{}, { status: "" }, { status: "shipping" }, { status: "CONFIRMED" }, { status: " confirmed" }, { status: 1 }, { status: null }, { status: true },
      { status: ["confirmed"] }, { status: { $ne: "x" } }, { status: "constructor" }, { status: "__proto__" }, { note: "only a note" }]) {
      const response = await request("PATCH", `/api/admin/orders/${order._id}/status`, body, admin.token);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    for (const raw of ["[]", "null", '"text"', "42"]) {
      const response = await fetch(`${baseUrl}/api/admin/orders/${order._id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}` },
        body: raw,
      });
      assert.equal(response.status, 400, raw);
    }
    const noBody = await request("PATCH", `/api/admin/orders/${order._id}/status`, undefined, admin.token);
    assert.equal(noBody.status, 400);
    const stored = await Order.findById(order._id);
    assert.equal(stored.status, "pending");
    assert.equal(stored.statusHistory.length, 1);
  });

  it("stores an admin note (trimmed) in the history, and refuses bad notes", async () => {
    const order = await makeOrder(customer);
    const good = await advance(order._id, "confirmed", "  Called the customer\r\nAll good  ");
    assert.equal(good.status, 200);
    assert.equal(good.body.order.statusHistory[1].note, "Called the customer\nAll good");

    const next = await makeOrder(customer);
    const bad = [
      "x".repeat(301), 5, true, ["a"], { a: 1 }, null,
      "bell" + String.fromCharCode(7) + "ring", "nul" + String.fromCharCode(0) + "l", "tab\there",
      "line" + String.fromCharCode(0x2028) + "sep", "esc" + String.fromCharCode(0x1b) + "[31m", "c1" + String.fromCharCode(0x85) + "x",
      "bidi" + String.fromCharCode(0x202e) + "x",
    ];
    for (const note of bad) {
      const response = await advance(next._id, "confirmed", note);
      assert.equal(response.status, 400, `note ${JSON.stringify(note).slice(0, 30)}`);
    }
    assert.equal((await Order.findById(next._id)).status, "pending", "a bad note changes nothing");
    assert.equal((await advance(next._id, "confirmed", "x".repeat(300))).status, 200, "300 characters is allowed");
  });

  it("ignores every other field in the body: totals, items, customer, user, payment, protected fields", async () => {
    const order = await makeOrder(customer);
    const before = (await Order.findById(order._id)).toObject();
    const response = await request(
      "PATCH",
      `/api/admin/orders/${order._id}/status`,
      {
        status: "confirmed",
        total: 1, subtotal: 1, shippingFee: 500, items: [], customer: { name: "Hacker", email: "h@example.test" },
        user: "a".repeat(24), orderNumber: "ORD-HACKED", paymentStatus: "paid", paymentMethod: "card",
        stockRestored: true, delivery: { city: "Elsewhere", phone: "000" }, statusHistory: [], createdAt: "2000-01-01", _id: "b".repeat(24),
      },
      admin.token
    );
    assert.equal(response.status, 200);
    const after = (await Order.findById(order._id)).toObject();
    assert.equal(after.status, "confirmed");
    for (const field of ["total", "subtotal", "shippingFee", "orderNumber", "paymentStatus", "paymentMethod", "stockRestored"]) {
      assert.equal(after[field], before[field], field);
    }
    assert.equal(String(after.user), String(before.user));
    assert.deepEqual(after.customer, before.customer);
    assert.deepEqual(after.delivery, before.delivery);
    assert.deepEqual(after.items, before.items);
    assert.equal(String(after._id), String(before._id));
    assert.equal(after.statusHistory.length, 2, "exactly one history entry was added");
    assert.equal(after.createdAt.getTime(), before.createdAt.getTime());
  });

  it("the customer sees the new status, and can no longer cancel once it is confirmed", async () => {
    const order = await makeOrder(customer);
    await advance(order._id, "confirmed");
    const seen = await request("GET", `/api/orders/${order._id}`, undefined, customer.token);
    assert.equal(seen.body.order.status, "confirmed");
    assert.equal(seen.body.order.canCancel, false);
    assert.equal((await request("POST", `/api/orders/${order._id}/cancel`, undefined, customer.token)).status, 409);
    assert.deepEqual(seen.body.order.statusHistory.map((h) => h.status), ["pending", "confirmed"]);
    assert.ok(!JSON.stringify(seen.body).includes("changedBy"), "the customer never sees who changed it");
  });
});

// ===========================================================================
describe("Admin orders: Cash on Delivery payment", () => {
  let customer;

  before(async () => {
    customer = await helpers.createUser("customer");
  });

  it("stays unpaid at every step, and becomes PAID exactly when the order is delivered", async () => {
    const order = await makeOrder(customer);
    for (const step of ["confirmed", "processing", "shipped"]) {
      const response = await advance(order._id, step);
      assert.equal(response.body.order.paymentStatus, "pending", `still unpaid at ${step}`);
      assert.equal((await Order.findById(order._id)).paymentStatus, "pending");
    }
    const delivered = await advance(order._id, "delivered");
    assert.equal(delivered.status, 200);
    assert.equal(delivered.body.order.status, "delivered");
    assert.equal(delivered.body.order.paymentStatus, "paid");

    const stored = await Order.findById(order._id);
    assert.equal(stored.paymentStatus, "paid");
    assert.equal(stored.status, "delivered");
  });

  it("the customer sees it as delivered and paid", async () => {
    const order = await makeOrder(customer);
    await walkTo(order._id, "delivered");
    const seen = await request("GET", `/api/orders/${order._id}`, undefined, customer.token);
    assert.equal(seen.body.order.status, "delivered");
    assert.equal(seen.body.order.paymentStatus, "paid");
  });

  it("an order that is refused never becomes paid", async () => {
    const order = await makeOrder(customer, undefined, { status: "processing" });
    assert.equal((await advance(order._id, "delivered")).status, 409);
    assert.equal((await Order.findById(order._id)).paymentStatus, "pending");
  });

  it("a cancelled COD order is never marked paid", async () => {
    const order = await makeOrder(customer);
    assert.equal((await adminCancel(order._id, {})).status, 200);
    const stored = await Order.findById(order._id);
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.paymentStatus, "pending");
  });

  it("status and payment change in ONE step: 8 racing 'delivered' requests give one winner and one paid order", async () => {
    const order = await makeOrder(customer, undefined, { status: "shipped" });
    const results = await Promise.all(Array.from({ length: 8 }, () => advance(order._id, "delivered")));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409]);
    const stored = await Order.findById(order._id);
    assert.equal(stored.status, "delivered");
    assert.equal(stored.paymentStatus, "paid");
    assert.equal(stored.statusHistory.filter((h) => h.status === "delivered").length, 1);
  });

  it("there is no way to set the payment status directly", async () => {
    const order = await makeOrder(customer);
    for (const [method, url, body] of [
      ["PATCH", `/api/admin/orders/${order._id}`, { paymentStatus: "paid" }],
      ["PATCH", `/api/admin/orders/${order._id}/payment`, { paymentStatus: "paid" }],
      ["PUT", `/api/admin/orders/${order._id}/status`, { paymentStatus: "paid" }],
      ["POST", `/api/admin/orders/${order._id}/pay`, {}],
      ["DELETE", `/api/admin/orders/${order._id}`, undefined],
    ]) {
      assert.equal((await request(method, url, body, admin.token)).status, 404, `${method} ${url}`);
    }
    assert.equal((await Order.findById(order._id)).paymentStatus, "pending");
  });
});

// ===========================================================================
describe("Admin orders: cancelling", () => {
  let customer;

  before(async () => {
    customer = await helpers.createUser("customer");
  });

  it("can cancel from pending, confirmed and processing", async () => {
    for (const status of ["pending", "confirmed", "processing"]) {
      const order = await makeOrder(customer, undefined, { status });
      const response = await adminCancel(order._id, {});
      assert.equal(response.status, 200, status);
      assert.equal(response.body.order.status, "cancelled");
      assert.equal(response.body.message, "Order cancelled");
      assert.deepEqual(response.body.warnings, []);
      assert.equal(response.body.order.canCancel, false);
      assert.deepEqual(response.body.order.allowedNextStatuses, []);
    }
  });

  it("can NOT cancel from shipped, delivered or cancelled (and nothing changes)", async () => {
    for (const status of ["shipped", "delivered", "cancelled"]) {
      const order = await makeOrder(customer, undefined, { status });
      const response = await adminCancel(order._id, {});
      assert.equal(response.status, 409, status);
      const stored = await Order.findById(order._id);
      assert.equal(stored.status, status);
      assert.equal(stored.stockRestored, false);
      assert.equal(stored.statusHistory.length, 1);
    }
    const already = await makeOrder(customer, undefined, { status: "cancelled" });
    assert.match((await adminCancel(already._id, {})).body.message, /already been cancelled/);
    const shipped = await makeOrder(customer, undefined, { status: "shipped" });
    assert.match((await adminCancel(shipped._id, {})).body.message, /can no longer be cancelled because it is shipped/);
  });

  it("gives the stock back (every product of the order) from each cancellable status", async () => {
    for (const target of [null, "confirmed", "processing"]) {
      const a = await helpers.createProduct(category, { stock: 10 });
      const b = await helpers.createProduct(category, { stock: 7 });
      const order = await checkoutOrder(customer, [[a, 3], [b, 7]]);
      assert.deepEqual([await stockOf(a), await stockOf(b)], [7, 0]);
      if (target) await walkTo(order._id, target);

      const response = await adminCancel(order._id, {});
      assert.equal(response.status, 200, String(target));
      assert.deepEqual([await stockOf(a), await stockOf(b)], [10, 7], `restored after cancelling from ${target || "pending"}`);
      assert.equal(response.body.order.stockRestored, true);
    }
  });

  it("restores stock exactly once, even if the cancel is repeated or raced", async () => {
    const product = await helpers.createProduct(category, { stock: 10 });
    const order = await checkoutOrder(customer, [[product, 4]]);
    assert.equal(await stockOf(product), 6);

    const results = await Promise.all(Array.from({ length: 6 }, () => adminCancel(order._id, {})));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409]);
    assert.equal(await stockOf(product), 10, "restored once: 6 + 4, never more");

    assert.equal((await adminCancel(order._id, {})).status, 409);
    assert.equal(await stockOf(product), 10, "a later repeat changes nothing");
    const stored = await Order.findById(order._id);
    assert.equal(stored.statusHistory.filter((h) => h.status === "cancelled").length, 1);
  });

  it("restores stock even when the product has been hidden meanwhile", async () => {
    const product = await helpers.createProduct(category, { stock: 5 });
    const order = await checkoutOrder(customer, [[product, 2]]);
    await Product.updateOne({ _id: product._id }, { isActive: false });
    assert.equal((await adminCancel(order._id, {})).status, 200);
    assert.equal(await stockOf(product), 5);
  });

  it("records who cancelled and the note", async () => {
    const order = await makeOrder(customer);
    const response = await adminCancel(order._id, { note: "  Customer asked by phone  " });
    const entry = response.body.order.statusHistory.at(-1);
    assert.equal(entry.status, "cancelled");
    assert.equal(entry.note, "Customer asked by phone");
    assert.deepEqual(entry.changedBy, { id: admin.id, name: admin.user.name, role: "admin" });
  });

  it("refuses a bad note, and changes nothing", async () => {
    const order = await makeOrder(customer);
    for (const note of ["x".repeat(301), 5, ["a"], null, "bell" + String.fromCharCode(7)]) {
      assert.equal((await adminCancel(order._id, { note })).status, 400);
    }
    assert.equal((await Order.findById(order._id)).status, "pending");
  });

  it("ignores everything else in the body", async () => {
    const order = await makeOrder(customer);
    const response = await adminCancel(order._id, { status: "delivered", paymentStatus: "paid", stockRestored: false, total: 0, user: "x" });
    assert.equal(response.status, 200);
    const stored = await Order.findById(order._id);
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.paymentStatus, "pending");
  });

  it("works without any body", async () => {
    const order = await makeOrder(customer);
    assert.equal((await adminCancel(order._id, undefined)).status, 200);
  });

  it("warns the admin when some stock could NOT be restored (the order is still cancelled)", async (t) => {
    const logs = silenceErrors(t);
    const kept = await helpers.createProduct(category, { stock: 10 });
    const doomed = await helpers.createProduct(category, { stock: 10 });
    const order = await checkoutOrder(customer, [[kept, 2], [doomed, 3]]);
    await Product.deleteOne({ _id: doomed._id }); // the product disappears from the database

    const response = await adminCancel(order._id, {});
    assert.equal(response.status, 200);
    assert.equal(response.body.order.status, "cancelled");
    assert.deepEqual(response.body.warnings, [{ type: "stock_not_restored", productId: String(doomed._id), quantity: 3 }]);
    assert.match(response.body.message, /stock of 1 product\(s\) could not be restored/);
    assert.equal(await stockOf(kept), 10, "the other product was restored");
    assert.ok(logs.some((line) => line.includes(String(doomed._id))), "and it was logged");
    assert.ok(!logs.join("\n").includes(customer.user.email), "no personal data in the log");
  });

  it("the customer's own cancel is unchanged (pending only, still restores stock)", async () => {
    const product = await helpers.createProduct(category, { stock: 10 });
    const order = await checkoutOrder(customer, [[product, 3]]);
    const response = await customerCancel(customer, order._id);
    assert.equal(response.status, 200);
    assert.equal(response.body.order.status, "cancelled");
    assert.equal(await stockOf(product), 10);
    assert.ok(!("warnings" in response.body), "the customer response has no new fields");

    const confirmed = await makeOrder(customer, undefined, { status: "confirmed" });
    assert.equal((await customerCancel(customer, confirmed._id)).status, 409);
  });

  it("orderService.cancelOrder still answers with just the order (backward compatible)", async () => {
    const order = await makeOrder(customer);
    const result = await orderService.cancelOrder({ orderId: order._id, actorId: customer.user._id, ownerId: customer.user._id });
    assert.equal(result.status, "cancelled");
    assert.equal(result.stockRestoreFailed, undefined);
  });
});

// ===========================================================================
describe("Admin orders: two people at once", () => {
  let customer;
  let second;

  before(async () => {
    customer = await helpers.createUser("customer");
    second = await helpers.createUser("admin");
  });

  it("two admins press 'Confirm' together: exactly one succeeds", async () => {
    const order = await makeOrder(customer);
    const results = await Promise.all([advance(order._id, "confirmed"), advance(order._id, "confirmed", undefined, second.token)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const stored = await Order.findById(order._id);
    assert.equal(stored.statusHistory.filter((h) => h.status === "confirmed").length, 1);
  });

  it("5 admins press 'Confirm' together: exactly one history entry", async () => {
    const order = await makeOrder(customer);
    const results = await Promise.all(Array.from({ length: 5 }, () => advance(order._id, "confirmed")));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.ok(results.every((r) => [200, 409].includes(r.status)));
    assert.equal((await Order.findById(order._id)).statusHistory.length, 2);
  });

  it("an admin confirms while the customer cancels: exactly one wins, and the stock is always right", async () => {
    let cancelWon = 0;
    let confirmWon = 0;
    for (let round = 0; round < 12; round++) {
      const product = await helpers.createProduct(category, { stock: 10 });
      const order = await checkoutOrder(customer, [[product, 3]]);

      const [confirmResult, cancelResult] = await Promise.all([advance(order._id, "confirmed"), customerCancel(customer, order._id)]);
      const statuses = [confirmResult.status, cancelResult.status].sort();
      assert.deepEqual(statuses, [200, 409], `round ${round}: ${statuses}`);

      const stored = await Order.findById(order._id);
      if (cancelResult.status === 200) {
        cancelWon += 1;
        assert.equal(stored.status, "cancelled");
        assert.equal(await stockOf(product), 10, "cancelled: the stock is back");
      } else {
        confirmWon += 1;
        assert.equal(stored.status, "confirmed");
        assert.equal(await stockOf(product), 7, "confirmed: the stock stays reserved");
      }
    }
    assert.equal(cancelWon + confirmWon, 12);
  });

  it("an admin ships while another admin cancels: exactly one wins, stock is right either way", async () => {
    for (let round = 0; round < 8; round++) {
      const product = await helpers.createProduct(category, { stock: 10 });
      const order = await checkoutOrder(customer, [[product, 2]]);
      await walkTo(order._id, "processing");

      const [ship, cancel] = await Promise.all([advance(order._id, "shipped"), adminCancel(order._id, {}, second.token)]);
      assert.deepEqual([ship.status, cancel.status].sort(), [200, 409], `round ${round}`);
      const stored = await Order.findById(order._id);
      if (cancel.status === 200) {
        assert.equal(stored.status, "cancelled");
        assert.equal(await stockOf(product), 10);
      } else {
        assert.equal(stored.status, "shipped");
        assert.equal(await stockOf(product), 8);
      }
    }
  });

  it("many orders cancelled in parallel give back every unit exactly once", async () => {
    const product = await helpers.createProduct(category, { stock: 30 });
    const customers = await Promise.all(Array.from({ length: 6 }, () => helpers.createUser("customer")));
    const orders = await Promise.all(customers.map((c) => checkoutOrder(c, [[product, 3]])));
    assert.equal(await stockOf(product), 12);
    await Promise.all(orders.flatMap((o) => [adminCancel(o._id, {}), adminCancel(o._id, {})]));
    assert.equal(await stockOf(product), 30);
  });
});

// ===========================================================================
describe("Admin orders: the status table is the only one", () => {
  it("the admin controller derives what can be cancelled from the shared table", () => {
    const cancellable = ORDER_STATUSES.filter((status) => ORDER_TRANSITIONS[status].includes("cancelled"));
    assert.deepEqual(cancellable, ["pending", "confirmed", "processing"]);
  });

  it("changeOrderStatus refuses 'cancelled' and unknown values by itself, even if called directly", async () => {
    const customer = await helpers.createUser("customer");
    const order = await makeOrder(customer);
    for (const toStatus of ["cancelled", "teleported", undefined, "", null]) {
      await assert.rejects(
        orderService.changeOrderStatus({ orderId: order._id, toStatus, actorId: admin.user._id }),
        (error) => error.statusCode === 400,
        String(toStatus)
      );
    }
    assert.equal((await Order.findById(order._id)).status, "pending");
  });
});
