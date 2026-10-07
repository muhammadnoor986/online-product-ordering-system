const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const Cart = require("../src/models/Cart");
const Order = require("../src/models/Order");
const Product = require("../src/models/Product");
const stockService = require("../src/services/stockService");
const cartService = require("../src/services/cartService");
const orderNumbers = require("../src/utils/generateOrderNumber");
const helpers = require("./helpers");

let request; // request(method, path, body, token) -> { status, body }
let baseUrl;
let server;
let category;

before(async () => {
  await helpers.connectTestDatabase();
  server = await helpers.startServer();
  baseUrl = server.baseUrl;
  request = helpers.makeClient(server.baseUrl);
  category = await helpers.createCategory();
});

after(async () => {
  try {
    await helpers.cleanup();
  } finally {
    if (server) await server.close();
    await helpers.disconnect();
  }
});

// ---- small helpers -------------------------------------------------------
const checkoutBody = (overrides = {}) => ({ delivery: helpers.validDelivery(), paymentMethod: "cod", ...overrides });
const checkout = (customer, body = checkoutBody()) => request("POST", "/api/orders", body, customer.token);
const getOrder = (customer, id) => request("GET", `/api/orders/${id}`, undefined, customer.token);
const cancel = (customer, id, body) => request("POST", `/api/orders/${id}/cancel`, body, customer.token);
const stockOf = async (product) => (await Product.findById(product._id)).stock;
const cartLines = async (customer) => {
  const cart = await Cart.findOne({ user: customer.user._id });
  return cart ? cart.items.map((i) => ({ product: String(i.product), quantity: i.quantity })) : [];
};
const orderCount = (customer) => Order.countDocuments({ user: customer.user._id });
const silenceErrors = (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  return logs;
};

// A customer with a cart and a product, for tests that need "one normal checkout"
const setup = async ({ stock = 10, price = 100, quantity = 2, productOverrides = {} } = {}) => {
  const customer = await helpers.createUser("customer");
  const product = await helpers.createProduct(category, { stock, price, ...productOverrides });
  await helpers.putInCart(customer, [{ product, quantity }]);
  return { customer, product };
};

// Stock never disappears: what is left + what non-cancelled orders hold = what we started with
const assertStockConserved = async (product, initialStock) => {
  const orders = await Order.find({ "items.product": product._id, status: { $ne: "cancelled" } });
  const ordered = orders.reduce(
    (sum, order) => sum + order.items.filter((i) => String(i.product) === String(product._id)).reduce((s, i) => s + i.quantity, 0),
    0
  );
  const current = await stockOf(product);
  assert.ok(current >= 0, `stock must never be negative (is ${current})`);
  assert.equal(current + ordered, initialStock, `stock ${current} + ordered ${ordered} should equal ${initialStock}`);
};

// ===========================================================================
describe("Order API: authentication and roles", () => {
  let customer;
  let admin;
  let order;

  before(async () => {
    customer = await helpers.createUser("customer");
    admin = await helpers.createUser("admin");
    const product = await helpers.createProduct(category);
    order = await helpers.insertOrder(customer, [{ product, quantity: 1 }]);
  });

  const endpoints = () => [
    ["POST", "/api/orders", checkoutBody()],
    ["GET", "/api/orders", undefined],
    ["GET", `/api/orders/${order._id}`, undefined],
    ["POST", `/api/orders/${order._id}/cancel`, undefined],
  ];

  it("returns 401 on every order endpoint without a token", async () => {
    for (const [method, url, body] of endpoints()) {
      const response = await request(method, url, body);
      assert.equal(response.status, 401, `${method} ${url}`);
      assert.equal(typeof response.body.message, "string");
    }
  });

  it("returns 401 for an invalid token", async () => {
    assert.equal((await request("GET", "/api/orders", undefined, "not.a.token")).status, 401);
  });

  it("returns 403 on every order endpoint for an admin, and changes nothing", async () => {
    for (const [method, url, body] of endpoints()) {
      const response = await request(method, url, body, admin.token);
      assert.equal(response.status, 403, `${method} ${url}`);
    }
    assert.equal(await orderCount(admin), 0);
    assert.equal((await Order.findById(order._id)).status, "pending", "the admin's cancel attempt did nothing");
  });

  it("lets a customer use the endpoints", async () => {
    assert.equal((await request("GET", "/api/orders", undefined, customer.token)).status, 200);
  });

  it("has NO route for a customer to change status, payment or the order itself", async () => {
    const id = order._id;
    const attempts = [
      ["PUT", `/api/orders/${id}`, { status: "delivered" }],
      ["PATCH", `/api/orders/${id}`, { status: "delivered", paymentStatus: "paid" }],
      ["DELETE", `/api/orders/${id}`, undefined],
      ["POST", `/api/orders/${id}/status`, { status: "delivered" }],
      ["PATCH", `/api/orders/${id}/status`, { status: "delivered" }],
      ["POST", `/api/orders/${id}/pay`, { paymentStatus: "paid" }],
      ["PUT", `/api/orders/${id}/payment`, { paymentStatus: "paid" }],
      ["PUT", "/api/orders", { status: "delivered" }],
    ];
    for (const [method, url, body] of attempts) {
      const response = await request(method, url, body, customer.token);
      assert.equal(response.status, 404, `${method} ${url}`);
    }
    const after = await Order.findById(id);
    assert.equal(after.status, "pending");
    assert.equal(after.paymentStatus, "pending");
  });
});

// ===========================================================================
describe("Checkout: input validation", () => {
  let customer;
  let product;
  let initialStock;

  before(async () => {
    ({ customer, product } = await setup({ stock: 10, quantity: 2 }));
    initialStock = 10;
  });

  // After every rejected request: no order, stock untouched, cart untouched
  const assertNothingChanged = async () => {
    assert.equal(await orderCount(customer), 0);
    assert.equal(await stockOf(product), initialStock);
    assert.deepEqual(await cartLines(customer), [{ product: String(product._id), quantity: 2 }]);
  };

  const rejected = async (body, label, status = 400) => {
    const response = await checkout(customer, body);
    assert.equal(response.status, status, `${label} -> ${response.status} ${JSON.stringify(response.body)}`);
    assert.equal(typeof response.body.message, "string");
    await assertNothingChanged();
    return response;
  };

  it("rejects a missing or non-object delivery", async () => {
    for (const delivery of [undefined, null, "Lahore", 42, true, [], [helpers.validDelivery()]]) {
      await rejected({ delivery, paymentMethod: "cod" }, `delivery ${JSON.stringify(delivery)}`);
    }
  });

  it("rejects bodies that are not objects or are malformed JSON", async () => {
    for (const raw of ["[]", "null", '"text"', "42", "{not json", ""]) {
      const response = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${customer.token}` },
        body: raw,
      });
      assert.equal(response.status, 400, `raw body ${JSON.stringify(raw)}`);
    }
    await assertNothingChanged();
  });

  it("rejects required delivery fields that are missing, blank or the wrong type", async () => {
    for (const field of ["fullName", "phone", "addressLine1", "city"]) {
      for (const value of [undefined, "", "   ", null, 123, true, {}, [], ["x"]]) {
        const delivery = helpers.validDelivery({ [field]: value });
        if (value === undefined) delete delivery[field];
        const response = await rejected({ delivery, paymentMethod: "cod" }, `${field}=${JSON.stringify(value)}`);
        assert.ok(response.body.details.some((d) => d.field === `delivery.${field}`), `details mention ${field}`);
      }
    }
  });

  it("rejects optional fields of the wrong type", async () => {
    for (const field of ["addressLine2", "postalCode", "notes"]) {
      for (const value of [null, 123, true, {}, []]) {
        await rejected({ delivery: helpers.validDelivery({ [field]: value }), paymentMethod: "cod" }, `${field}=${JSON.stringify(value)}`);
      }
    }
  });

  it("rejects values that are too short or too long", async () => {
    const cases = {
      fullName: ["A", "A".repeat(101)],
      addressLine1: ["abcd", "A".repeat(201)],
      addressLine2: ["A".repeat(201)],
      city: ["L", "A".repeat(61)],
      postalCode: ["1".repeat(13)],
      notes: ["n".repeat(301)],
    };
    for (const [field, values] of Object.entries(cases)) {
      for (const value of values) {
        await rejected({ delivery: helpers.validDelivery({ [field]: value }), paymentMethod: "cod" }, `${field} length ${value.length}`);
      }
    }
  });

  it("accepts values exactly at the limits", async (t) => {
    const delivery = helpers.validDelivery({
      fullName: "A".repeat(100),
      addressLine1: "B".repeat(200),
      addressLine2: "C".repeat(200),
      city: "D".repeat(60),
      postalCode: "1".repeat(12),
      notes: "n".repeat(300),
    });
    const user = await helpers.createUser("customer");
    const item = await helpers.createProduct(category, { stock: 5 });
    await helpers.putInCart(user, [{ product: item, quantity: 1 }]);
    assert.equal((await checkout(user, { delivery, paymentMethod: "cod" })).status, 201);
  });

  it("rejects invalid phone numbers", async () => {
    for (const phone of ["abc", "12345", "+++1234567", "123456", "1".repeat(21), "12-34", "phone: 0300 1234567", "0300 123 4567 ext 99999", "(((())))", "<script>"]) {
      await rejected({ delivery: helpers.validDelivery({ phone }), paymentMethod: "cod" }, `phone ${phone}`);
    }
  });

  it("rejects an invalid postal code", async () => {
    for (const postalCode of ["54000;", "<b>", "54_000"]) {
      await rejected({ delivery: helpers.validDelivery({ postalCode }), paymentMethod: "cod" }, `postal ${postalCode}`);
    }
  });

  it("rejects control characters (and newlines anywhere except the notes)", async () => {
    for (const field of ["fullName", "phone", "addressLine1", "addressLine2", "city", "postalCode"]) {
      for (const bad of ["\u0000", "\t", "\n", "\r\n", "\u0007", "\u001b[31m", "\u007f"]) {
        const base = field === "phone" ? "+92 300 1234567" : field === "postalCode" ? "54000" : "Some value";
        await rejected({ delivery: helpers.validDelivery({ [field]: `${base}${bad}x` }), paymentMethod: "cod" }, `${field} with control char`);
      }
    }
    for (const bad of ["\u0000", "\t", "\u0007", "\u001b"]) {
      await rejected({ delivery: helpers.validDelivery({ notes: `ring${bad}the bell` }), paymentMethod: "cod" }, "notes control char");
    }
  });

  it("also rejects Unicode control characters: C1 controls, line/paragraph separators and text-direction overrides", async () => {
    const unicodeBad = ["\u0080", "\u0085", "\u009b", "\u009f", "\u2028", "\u2029", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"];
    for (const field of ["fullName", "phone", "addressLine1", "addressLine2", "city", "postalCode", "notes"]) {
      for (const bad of unicodeBad) {
        const value = field === "phone" ? `+92 300${bad}1234567` : field === "postalCode" ? `54${bad}000` : `Some${bad}value here`;
        // (the bad character is in the MIDDLE: a leading or trailing one would simply be trimmed away)
        await rejected({ delivery: helpers.validDelivery({ [field]: value }), paymentMethod: "cod" }, `${field} with U+${bad.charCodeAt(0).toString(16)}`);
      }
    }
  });

  it("still accepts Urdu / Persian text, including the zero-width joiner marks those scripts need", async () => {
    const user = await helpers.createUser("customer");
    const item = await helpers.createProduct(category, { stock: 5 });
    await helpers.putInCart(user, [{ product: item, quantity: 1 }]);
    const response = await checkout(
      user,
      checkoutBody({
        delivery: helpers.validDelivery({
          fullName: "علی\u200cخان", // contains a zero-width non-joiner (U+200C)
          addressLine1: "مکان نمبر 12، گلی 5، لاہور",
          city: "لاہور",
          notes: "گھنٹی بجائیں\n\u200fدروازہ نمبر 3",
        }),
      })
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.order.delivery.fullName, "علی\u200cخان");
    assert.equal(response.body.order.delivery.city, "لاہور");
  });

  it("allows newlines in the notes (and stores them tidied)", async () => {
    const user = await helpers.createUser("customer");
    const item = await helpers.createProduct(category, { stock: 5 });
    await helpers.putInCart(user, [{ product: item, quantity: 1 }]);
    const response = await checkout(user, checkoutBody({ delivery: helpers.validDelivery({ notes: "  Call first\r\nGate 3  " }) }));
    assert.equal(response.status, 201);
    assert.equal(response.body.order.delivery.notes, "Call first\nGate 3");
  });

  it("rejects an invalid payment method", async () => {
    for (const paymentMethod of [undefined, null, "", "card", "COD", "Cod", " cod", "cod ", "paypal", "stripe", 1, true, ["cod"], { method: "cod" }]) {
      const body = { delivery: helpers.validDelivery(), paymentMethod };
      if (paymentMethod === undefined) delete body.paymentMethod;
      await rejected(body, `paymentMethod ${JSON.stringify(paymentMethod)}`);
    }
  });

  it("rejects an invalid expectedTotal", async () => {
    for (const expectedTotal of ["12", "", null, -1, NaN, Infinity, [], [100], {}, true]) {
      await rejected(checkoutBody({ expectedTotal }), `expectedTotal ${JSON.stringify(expectedTotal)}`);
    }
  });

  it("explains each problem per field and never echoes what was typed", async () => {
    const response = await rejected(
      { delivery: helpers.validDelivery({ fullName: "", phone: "SECRET-TYPED-VALUE-123" }), paymentMethod: "bitcoin" },
      "several problems"
    );
    const fields = response.body.details.map((d) => d.field).sort();
    assert.deepEqual(fields, ["delivery.fullName", "delivery.phone", "paymentMethod"]);
    assert.doesNotMatch(JSON.stringify(response.body), /SECRET-TYPED-VALUE|bitcoin/);
  });

  it("ignores unknown delivery fields (they are never stored)", async () => {
    const user = await helpers.createUser("customer");
    const item = await helpers.createProduct(category, { stock: 5 });
    await helpers.putInCart(user, [{ product: item, quantity: 1 }]);
    const delivery = { ...helpers.validDelivery(), _id: "x", status: "delivered", total: 1, extra: "yes", __proto__: { admin: true }, "$set": { a: 1 } };
    const response = await checkout(user, { delivery, paymentMethod: "cod" });
    assert.equal(response.status, 201);
    const stored = (await Order.findOne({ user: user.user._id })).toObject().delivery;
    assert.deepEqual(Object.keys(stored).sort(), ["addressLine1", "addressLine2", "city", "fullName", "notes", "phone", "postalCode"]);
  });
});

// ===========================================================================
describe("Checkout: empty cart", () => {
  it("rejects a customer who has no cart at all", async () => {
    const customer = await helpers.createUser("customer");
    const response = await checkout(customer);
    assert.equal(response.status, 400);
    assert.match(response.body.message, /cart is empty/i);
    assert.equal(await orderCount(customer), 0);
    assert.equal(await Cart.countDocuments({ user: customer.user._id }), 0, "no cart is created");
  });

  it("rejects a cart that exists but has no items", async () => {
    const customer = await helpers.createUser("customer");
    await Cart.create({ user: customer.user._id, items: [] });
    const response = await checkout(customer);
    assert.equal(response.status, 400);
    assert.match(response.body.message, /cart is empty/i);
    assert.equal(await orderCount(customer), 0);
  });

  it("does not use somebody else's cart", async () => {
    const owner = await helpers.createUser("customer");
    const thief = await helpers.createUser("customer");
    const product = await helpers.createProduct(category, { stock: 5 });
    await helpers.putInCart(owner, [{ product, quantity: 1 }]);

    const response = await checkout(thief, checkoutBody({ user: owner.id, userId: owner.id, cart: owner.id }));
    assert.equal(response.status, 400);
    assert.equal(await orderCount(owner), 0);
    assert.equal(await orderCount(thief), 0);
    assert.equal(await stockOf(product), 5);
    assert.deepEqual(await cartLines(owner), [{ product: String(product._id), quantity: 1 }]);
  });
});

// ===========================================================================
describe("Checkout: a successful order", () => {
  let customer;
  let a;
  let b;
  let c;
  let d;
  let response;

  before(async () => {
    customer = await helpers.createUser("customer");
    a = await helpers.createProduct(category, { name: `T${helpers.runTag} Alpha`, price: 250.75, stock: 10, imageUrl: "https://example.com/a.jpg" });
    b = await helpers.createProduct(category, { name: `T${helpers.runTag} Beta`, price: 99.99, stock: 5 });
    c = await helpers.createProduct(category, { price: 0.1, stock: 3 });
    d = await helpers.createProduct(category, { price: 0.2, stock: 3 });
    await helpers.putInCart(customer, [
      { product: a, quantity: 2 },
      { product: b, quantity: 3 },
      { product: c, quantity: 1 },
      { product: d, quantity: 1 },
    ]);
    response = await checkout(customer, checkoutBody({ delivery: helpers.validDelivery({ fullName: "  Ayesha Khan  ", notes: "Gate 3" }) }));
  });

  it("returns 201 with the order", () => {
    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.match(response.body.message, /placed/i);
  });

  it("starts as a pending COD order with payment pending", () => {
    const order = response.body.order;
    assert.equal(order.status, "pending");
    assert.equal(order.paymentMethod, "cod");
    assert.equal(order.paymentStatus, "pending");
    assert.equal(order.canCancel, true);
    assert.equal(order.statusHistory.length, 1);
    assert.equal(order.statusHistory[0].status, "pending");
  });

  it("calculates every line and the totals on the server, with shipping 0", () => {
    const order = response.body.order;
    assert.deepEqual(
      order.items.map((i) => [i.name.replace(`T${helpers.runTag} `, ""), i.price, i.quantity, i.lineTotal]).slice(0, 2),
      [["Alpha", 250.75, 2, 501.5], ["Beta", 99.99, 3, 299.97]]
    );
    assert.equal(order.items[2].lineTotal, 0.1);
    assert.equal(order.subtotal, 801.77, "501.5 + 299.97 + 0.1 + 0.2, without floating point noise");
    assert.equal(order.shippingFee, 0);
    assert.equal(order.total, 801.77);
  });

  it("snapshots the customer and the (trimmed) delivery details", () => {
    const order = response.body.order;
    assert.deepEqual(order.customer, { name: customer.user.name, email: customer.user.email });
    assert.equal(order.delivery.fullName, "Ayesha Khan");
    assert.equal(order.delivery.city, "Lahore");
    assert.equal(order.delivery.notes, "Gate 3");
    assert.equal(order.items[0].imageUrl, "https://example.com/a.jpg");
    assert.equal(order.items[0].productId, String(a._id));
  });

  it("gets a server-made order number", () => {
    assert.match(response.body.order.orderNumber, orderNumbers.ORDER_NUMBER_PATTERN);
  });

  it("does not expose internal fields", () => {
    const text = JSON.stringify(response.body.order);
    for (const secret of ["stockRestored", "changedBy", "__v", `"user"`]) {
      assert.ok(!text.includes(secret), `response must not contain ${secret}`);
    }
  });

  it("is stored in the database for this customer only, with the same values", async () => {
    const stored = await Order.find({ user: customer.user._id });
    assert.equal(stored.length, 1);
    assert.equal(String(stored[0]._id), response.body.order._id);
    assert.equal(stored[0].stockRestored, false);
    assert.equal(stored[0].total, 801.77);
    assert.equal(String(stored[0].statusHistory[0].changedBy), customer.id);
  });

  it("deducts exactly the ordered quantities from stock", async () => {
    assert.equal(await stockOf(a), 8);
    assert.equal(await stockOf(b), 2);
    assert.equal(await stockOf(c), 2);
    assert.equal(await stockOf(d), 2);
  });

  it("empties the cart (the document stays, with no items) and returns the empty cart", async () => {
    assert.deepEqual(response.body.cart, { items: [], itemCount: 0, subtotal: 0, hasProblems: false });
    assert.deepEqual(await cartLines(customer), []);
    const cart = await request("GET", "/api/cart", undefined, customer.token);
    assert.equal(cart.body.cart.items.length, 0);
  });

  it("can buy the entire remaining stock", async () => {
    const user = await helpers.createUser("customer");
    const item = await helpers.createProduct(category, { stock: 3 });
    await helpers.putInCart(user, [{ product: item, quantity: 3 }]);
    assert.equal((await checkout(user)).status, 201);
    assert.equal(await stockOf(item), 0);
  });

  it("a second checkout right afterwards has an empty cart", async () => {
    const again = await checkout(customer);
    assert.equal(again.status, 400);
    assert.equal(await orderCount(customer), 1);
  });
});

// ===========================================================================
describe("Checkout: nothing from the request body can override server values", () => {
  it("ignores user, snapshots, prices, totals, status, payment and flags", async () => {
    const { customer, product } = await setup({ stock: 10, price: 100, quantity: 2 });
    const stranger = await helpers.createUser("customer");

    const hostile = {
      ...checkoutBody(),
      user: stranger.id,
      userId: stranger.id,
      customer: { name: "Evil", email: "evil@example.test" },
      orderNumber: "ORD-HACKED-000000",
      items: [{ product: String(product._id), name: "Free stuff", price: 0.01, quantity: 99, lineTotal: 0.01 }],
      product: String(product._id),
      name: "Free stuff",
      price: 0.01,
      imageUrl: "https://evil.example/x.png",
      lineTotal: 0.01,
      subtotal: 0.01,
      shippingFee: -500,
      total: 0.01,
      status: "delivered",
      statusHistory: [{ status: "delivered" }],
      paymentStatus: "paid",
      stockRestored: true,
      stock: 100000,
      _id: "a".repeat(24),
      createdAt: "2000-01-01",
      role: "admin",
    };
    const response = await checkout(customer, hostile);
    assert.equal(response.status, 201);

    const stored = await Order.findOne({ user: customer.user._id });
    assert.equal(String(stored.user), customer.id, "the owner is the logged-in customer");
    assert.equal(await orderCount(stranger), 0);
    assert.deepEqual({ name: stored.customer.name, email: stored.customer.email }, { name: customer.user.name, email: customer.user.email });
    assert.match(stored.orderNumber, orderNumbers.ORDER_NUMBER_PATTERN);
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].name, product.name);
    assert.equal(stored.items[0].price, 100);
    assert.equal(stored.items[0].quantity, 2, "the quantity comes from the cart, not the body");
    assert.equal(stored.items[0].lineTotal, 200);
    assert.equal(stored.items[0].imageUrl, "");
    assert.equal(stored.subtotal, 200);
    assert.equal(stored.shippingFee, 0);
    assert.equal(stored.total, 200);
    assert.equal(stored.status, "pending");
    assert.equal(stored.statusHistory.length, 1);
    assert.equal(stored.statusHistory[0].status, "pending");
    assert.equal(stored.paymentStatus, "pending");
    assert.equal(stored.stockRestored, false);
    assert.notEqual(String(stored._id), "a".repeat(24));
    assert.ok(stored.createdAt.getFullYear() >= 2026);
    assert.equal(await stockOf(product), 8, "stock moved by exactly the cart quantity");
  });
});

// ===========================================================================
describe("Checkout: expectedTotal (price change protection)", () => {
  it("accepts the right total", async () => {
    const { customer } = await setup({ price: 19.99, quantity: 3 }); // 59.97
    const response = await checkout(customer, checkoutBody({ expectedTotal: 59.97 }));
    assert.equal(response.status, 201);
    assert.equal(response.body.order.total, 59.97);
  });

  it("works without expectedTotal", async () => {
    const { customer } = await setup();
    assert.equal((await checkout(customer, checkoutBody())).status, 201);
  });

  it("refuses a wrong total with 409 and the current total, changing nothing", async () => {
    const { customer, product } = await setup({ price: 100, quantity: 2, stock: 10 });
    const response = await checkout(customer, checkoutBody({ expectedTotal: 150 }));
    assert.equal(response.status, 409);
    assert.deepEqual(response.body.details, [{ reason: "price_changed", expectedTotal: 150, currentTotal: 200 }]);
    assert.equal(await orderCount(customer), 0);
    assert.equal(await stockOf(product), 10);
    assert.deepEqual(await cartLines(customer), [{ product: String(product._id), quantity: 2 }]);
  });

  it("catches a price that changed after the customer looked at the cart", async () => {
    const { customer, product } = await setup({ price: 100, quantity: 2 });
    const customerSawTotal = 200;
    await Product.updateOne({ _id: product._id }, { price: 120 });

    const response = await checkout(customer, checkoutBody({ expectedTotal: customerSawTotal }));
    assert.equal(response.status, 409);
    assert.equal(response.body.details[0].currentTotal, 240);
    assert.equal(await orderCount(customer), 0);

    // after reviewing the new total the customer can order
    const retry = await checkout(customer, checkoutBody({ expectedTotal: 240 }));
    assert.equal(retry.status, 201);
    assert.equal(retry.body.order.total, 240);
  });
});

// ===========================================================================
describe("Checkout: stock and availability problems", () => {
  const scenario = async () => {
    const customer = await helpers.createUser("customer");
    const fine = await helpers.createProduct(category, { stock: 10 });
    const target = await helpers.createProduct(category, { stock: 10 });
    await helpers.putInCart(customer, [{ product: fine, quantity: 2 }, { product: target, quantity: 3 }]);
    return { customer, fine, target };
  };

  const assertRefusedAndUntouched = async ({ customer, fine, target }, response, reason) => {
    assert.equal(response.status, 409);
    assert.ok(response.body.details.some((d) => d.productId === String(target._id) && d.reason === reason), `reason ${reason}`);
    assert.ok(!response.body.details.some((d) => d.productId === String(fine._id)), "the fine product is not listed");
    assert.equal(await orderCount(customer), 0);
    assert.equal(await stockOf(fine), 10, "no partial deduction");
    assert.deepEqual(
      (await cartLines(customer)).sort((x, y) => x.product.localeCompare(y.product)),
      [{ product: String(fine._id), quantity: 2 }, { product: String(target._id), quantity: 3 }].sort((x, y) => x.product.localeCompare(y.product)),
      "the cart is left exactly as it was"
    );
  };

  it("refuses an inactive product", async () => {
    const s = await scenario();
    await Product.updateOne({ _id: s.target._id }, { isActive: false });
    await assertRefusedAndUntouched(s, await checkout(s.customer), "inactive");
    assert.equal(await stockOf(s.target), 10);
  });

  it("refuses an out-of-stock product", async () => {
    const s = await scenario();
    await Product.updateOne({ _id: s.target._id }, { stock: 0 });
    await assertRefusedAndUntouched(s, await checkout(s.customer), "out_of_stock");
  });

  it("refuses a quantity above the current stock", async () => {
    const s = await scenario();
    await Product.updateOne({ _id: s.target._id }, { stock: 2 });
    const response = await checkout(s.customer);
    await assertRefusedAndUntouched(s, response, "insufficient_stock");
    const detail = response.body.details.find((d) => d.productId === String(s.target._id));
    assert.equal(detail.requested, 3);
    assert.equal(detail.available, 2);
    assert.equal(await stockOf(s.target), 2);
  });

  it("refuses a product that no longer exists", async () => {
    const s = await scenario();
    await Product.deleteOne({ _id: s.target._id });
    const response = await checkout(s.customer);
    assert.equal(response.status, 409);
    assert.equal(response.body.details[0].reason, "not_found");
    assert.equal(await orderCount(s.customer), 0);
    assert.equal(await stockOf(s.fine), 10);
  });

  it("lists several problems together", async () => {
    const customer = await helpers.createUser("customer");
    const ok = await helpers.createProduct(category, { stock: 10 });
    const hidden = await helpers.createProduct(category, { stock: 10 });
    const soldOut = await helpers.createProduct(category, { stock: 10 });
    const low = await helpers.createProduct(category, { stock: 10 });
    const gone = await helpers.createProduct(category, { stock: 10 });
    await helpers.putInCart(customer, [
      { product: ok, quantity: 1 }, { product: hidden, quantity: 1 }, { product: soldOut, quantity: 1 },
      { product: low, quantity: 5 }, { product: gone, quantity: 1 },
    ]);
    await Product.updateOne({ _id: hidden._id }, { isActive: false });
    await Product.updateOne({ _id: soldOut._id }, { stock: 0 });
    await Product.updateOne({ _id: low._id }, { stock: 2 });
    await Product.deleteOne({ _id: gone._id });

    const response = await checkout(customer);
    assert.equal(response.status, 409);
    const reasons = Object.fromEntries(response.body.details.map((d) => [d.productId, d.reason]));
    assert.deepEqual(reasons, {
      [String(hidden._id)]: "inactive",
      [String(soldOut._id)]: "out_of_stock",
      [String(low._id)]: "insufficient_stock",
      [String(gone._id)]: "not_found",
    });
    assert.equal(await stockOf(ok), 10);
    assert.equal(await orderCount(customer), 0);
    assert.equal((await cartLines(customer)).length, 5);
  });

  it("never lets stock go negative however it is attacked", async () => {
    const customer = await helpers.createUser("customer");
    const product = await helpers.createProduct(category, { stock: 1 });
    await helpers.putInCart(customer, [{ product, quantity: 5 }]);
    assert.equal((await checkout(customer)).status, 409);
    assert.equal(await stockOf(product), 1);
  });
});

// ===========================================================================
describe("Checkout: undoing work when something fails midway", () => {
  it("a later product failing during the reservation leaves NO partial deduction and restores the cart", async (t) => {
    const customer = await helpers.createUser("customer");
    const first = await helpers.createProduct(category, { stock: 10 }); // smaller id: reserved first
    const second = await helpers.createProduct(category, { stock: 10 });
    await helpers.putInCart(customer, [{ product: first, quantity: 4 }, { product: second, quantity: 3 }]);

    // Everything looks fine when checkout validates; then someone else buys the second
    // product's stock right before our reservation (a real race, forced to happen here).
    const original = stockService.reserveStock;
    t.mock.method(stockService, "reserveStock", async (items) => {
      await Product.updateOne({ _id: second._id }, { stock: 0 });
      return original(items);
    });

    const response = await checkout(customer);
    t.mock.restoreAll();

    assert.equal(response.status, 409);
    assert.ok(response.body.details.some((d) => d.productId === String(second._id) && d.reason === "out_of_stock"));
    assert.equal(await stockOf(first), 10, "the first product was taken, then given back");
    assert.equal(await stockOf(second), 0, "only the other buyer's change is there");
    assert.equal(await orderCount(customer), 0);
    assert.deepEqual(
      (await cartLines(customer)).sort((x, y) => x.product.localeCompare(y.product)),
      [{ product: String(first._id), quantity: 4 }, { product: String(second._id), quantity: 3 }]
    );
  });

  it("order creation failing releases the stock and restores the cart", async (t) => {
    const logs = silenceErrors(t);
    const { customer, product } = await setup({ stock: 10, quantity: 4 });
    t.mock.method(Order, "create", async () => {
      throw new Error("simulated database failure");
    });

    const response = await checkout(customer);
    t.mock.restoreAll();

    assert.equal(response.status, 500);
    assert.equal(response.body.message, "Internal server error", "no internal detail is shown");
    assert.equal(await stockOf(product), 10);
    assert.deepEqual(await cartLines(customer), [{ product: String(product._id), quantity: 4 }]);
    assert.equal(await orderCount(customer), 0);
    assert.ok(logs.length > 0, "the failure is logged");
  });

  it("a model validation failure is reported as a server error, not blamed on the customer", async (t) => {
    silenceErrors(t);
    const { customer, product } = await setup({ stock: 10, quantity: 2 });
    const original = Order.create.bind(Order);
    t.mock.method(Order, "create", async (data) => original({ ...data, total: data.total + 50 })); // inconsistent total

    const response = await checkout(customer);
    t.mock.restoreAll();

    assert.equal(response.status, 500);
    assert.doesNotMatch(JSON.stringify(response.body), /subtotal|total must/i);
    assert.equal(await stockOf(product), 10);
    assert.deepEqual(await cartLines(customer), [{ product: String(product._id), quantity: 2 }]);
  });

  it("the restored cart MERGES with items the customer added in the meantime (no duplicate lines)", async (t) => {
    silenceErrors(t);
    const customer = await helpers.createUser("customer");
    const a = await helpers.createProduct(category, { stock: 10 });
    const b = await helpers.createProduct(category, { stock: 10 });
    const extra = await helpers.createProduct(category, { stock: 10 });
    await helpers.putInCart(customer, [{ product: a, quantity: 2 }, { product: b, quantity: 3 }]);

    // While the cart is claimed (empty), the customer adds the same product `a` and a new one
    const original = stockService.reserveStock;
    t.mock.method(stockService, "reserveStock", async () => {
      assert.equal((await request("POST", "/api/cart/items", { productId: String(a._id), quantity: 1 }, customer.token)).status, 201);
      assert.equal((await request("POST", "/api/cart/items", { productId: String(extra._id), quantity: 2 }, customer.token)).status, 201);
      await Product.updateOne({ _id: b._id }, { stock: 0 });
      return original([{ product: b._id, quantity: 3 }]);
    });

    const response = await checkout(customer);
    t.mock.restoreAll();

    assert.equal(response.status, 409);
    const lines = (await cartLines(customer)).sort((x, y) => x.product.localeCompare(y.product));
    assert.deepEqual(
      lines,
      [
        { product: String(a._id), quantity: 3 }, // 2 claimed + 1 added meanwhile, merged into ONE line
        { product: String(b._id), quantity: 3 },
        { product: String(extra._id), quantity: 2 },
      ].sort((x, y) => x.product.localeCompare(y.product))
    );
  });

  it("the restored cart respects the 99-per-product and 50-products limits", async (t) => {
    const logs = silenceErrors(t);
    const customer = await helpers.createUser("customer");
    const a = await helpers.createProduct(category, { stock: 500 });
    const b = await helpers.createProduct(category, { stock: 500 });
    await helpers.putInCart(customer, [{ product: a, quantity: 90 }, { product: b, quantity: 5 }]);
    const fillers = await Product.insertMany(
      Array.from({ length: 49 }, (_, i) => ({ name: `T${helpers.runTag} filler ${i}`, description: "f", price: 1, stock: 5, category: category._id }))
    );

    const original = stockService.reserveStock;
    t.mock.method(stockService, "reserveStock", async () => {
      // meanwhile the cart gets 49 other products and 20 more of `a` (cart = 50 lines, a = 20)
      await Cart.updateOne(
        { user: customer.user._id },
        { $set: { items: [{ product: a._id, quantity: 20 }, ...fillers.map((p) => ({ product: p._id, quantity: 1 }))] } }
      );
      await Product.updateOne({ _id: b._id }, { stock: 0 });
      return original([{ product: b._id, quantity: 5 }]);
    });

    const response = await checkout(customer);
    t.mock.restoreAll();

    assert.equal(response.status, 409, "the customer still gets the real reason");
    const cart = await Cart.findOne({ user: customer.user._id });
    assert.equal(cart.items.length, 50, "never more than 50 lines");
    assert.equal(new Set(cart.items.map((i) => String(i.product))).size, 50, "no duplicate lines");
    assert.equal(cart.items.find((i) => String(i.product) === String(a._id)).quantity, 99, "capped at 99 (20 + 90 would be 110)");
    assert.ok(logs.some((l) => /could not be put back/.test(l)), "the line that did not fit is logged");
  });

  it("if the cart cannot be restored: a server error, and a diagnostic with no personal data", async (t) => {
    const logs = silenceErrors(t);
    const { customer, product } = await setup({ stock: 10, quantity: 4 });
    t.mock.method(Order, "create", async () => {
      throw new Error("simulated database failure");
    });
    t.mock.method(cartService, "restoreCartItems", async () => {
      throw new Error("simulated restore failure");
    });

    const response = await checkout(customer);
    t.mock.restoreAll();

    assert.equal(response.status, 500);
    assert.equal(await stockOf(product), 10, "stock is still given back");
    const log = logs.join("\n");
    assert.match(log, /could not restore the cart/);
    assert.ok(log.includes(String(product._id)), "product id and quantity are logged so it can be fixed");
    assert.ok(!log.includes(customer.user.email), "the email address is not logged");
    assert.ok(!log.includes(customer.user.name), "the name is not logged");
    assert.doesNotMatch(log, /\+92|Lahore|House 12/, "no phone or address in the log");
  });

  it("failed checkouts never log delivery details", async (t) => {
    const logs = silenceErrors(t);
    const { customer } = await setup();
    t.mock.method(Order, "create", async () => {
      throw new Error("simulated database failure");
    });
    await checkout(customer, checkoutBody({ delivery: helpers.validDelivery({ phone: "+92 311 9998887", addressLine1: "PRIVATE-STREET-77" }) }));
    t.mock.restoreAll();
    assert.doesNotMatch(logs.join("\n"), /9998887|PRIVATE-STREET-77/);
  });
});

// ===========================================================================
describe("Order numbers", () => {
  it("are different for every order and never taken from the client", async () => {
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      const { customer } = await setup({ quantity: 1 });
      const response = await checkout(customer, checkoutBody({ orderNumber: "ORD-20000101-AAAAAA" }));
      assert.equal(response.status, 201);
      assert.match(response.body.order.orderNumber, orderNumbers.ORDER_NUMBER_PATTERN);
      assert.notEqual(response.body.order.orderNumber, "ORD-20000101-AAAAAA");
      seen.add(response.body.order.orderNumber);
    }
    assert.equal(seen.size, 12);
  });

  it("start with today's UTC date", async () => {
    const { customer } = await setup();
    const response = await checkout(customer);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    assert.ok(response.body.order.orderNumber.startsWith(`ORD-${today}-`));
  });

  it("a collision is retried with a new number and stock is deducted only ONCE", async (t) => {
    const existingOwner = await helpers.createUser("customer");
    const filler = await helpers.createProduct(category);
    const taken = await helpers.insertOrder(existingOwner, [{ product: filler, quantity: 1 }]);

    const { customer, product } = await setup({ stock: 10, quantity: 3 });
    const original = orderNumbers.generateOrderNumber;
    let calls = 0;
    t.mock.method(orderNumbers, "generateOrderNumber", () => {
      calls += 1;
      return calls <= 2 ? taken.orderNumber : original();
    });
    const reserveSpy = t.mock.method(stockService, "reserveStock");

    const response = await checkout(customer);
    t.mock.restoreAll();

    assert.equal(response.status, 201);
    assert.equal(calls, 3, "two collisions, then a fresh number");
    assert.notEqual(response.body.order.orderNumber, taken.orderNumber);
    assert.equal(reserveSpy.mock.callCount(), 1, "stock was reserved a single time");
    assert.equal(await stockOf(product), 7, "10 - 3, not 10 - 9");
    assert.equal(await orderCount(customer), 1);
  });

  it("gives up after 5 collisions with a 503, and restores both stock and cart", async (t) => {
    silenceErrors(t);
    const existingOwner = await helpers.createUser("customer");
    const filler = await helpers.createProduct(category);
    const taken = await helpers.insertOrder(existingOwner, [{ product: filler, quantity: 1 }]);

    const { customer, product } = await setup({ stock: 10, quantity: 3 });
    let calls = 0;
    t.mock.method(orderNumbers, "generateOrderNumber", () => {
      calls += 1;
      return taken.orderNumber;
    });

    const response = await checkout(customer);
    t.mock.restoreAll();

    assert.equal(response.status, 503);
    assert.equal(calls, 5, "exactly 5 attempts");
    assert.equal(await stockOf(product), 10);
    assert.deepEqual(await cartLines(customer), [{ product: String(product._id), quantity: 3 }]);
    assert.equal(await orderCount(customer), 0);
  });

  it("only a collision on the order number is retried (other errors are not)", async (t) => {
    silenceErrors(t);
    const { customer } = await setup();
    let creates = 0;
    t.mock.method(Order, "create", async () => {
      creates += 1;
      const error = new Error("duplicate on something else");
      error.code = 11000;
      error.keyPattern = { someOtherField: 1 };
      throw error;
    });
    const response = await checkout(customer);
    t.mock.restoreAll();
    assert.equal(creates, 1, "no retry for a different duplicate");
    assert.ok(response.status >= 400);
  });
});

// ===========================================================================
describe("Checkout under concurrency", () => {
  it("a double click: 2 identical checkouts of one cart create exactly one order", async () => {
    const { customer, product } = await setup({ stock: 10, quantity: 3 });
    const results = await Promise.all([checkout(customer), checkout(customer)]);

    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1, `statuses ${statuses}`);
    assert.ok(statuses.every((s) => [201, 400, 409].includes(s)), `statuses ${statuses}`);
    assert.equal(await orderCount(customer), 1);
    assert.equal(await stockOf(product), 7, "deducted once");
    assert.deepEqual(await cartLines(customer), []);
  });

  it("5 identical checkouts at once still create exactly one order", async () => {
    const { customer, product } = await setup({ stock: 10, quantity: 2 });
    const results = await Promise.all(Array.from({ length: 5 }, () => checkout(customer)));
    const statuses = results.map((r) => r.status).sort();

    assert.equal(statuses.filter((s) => s === 201).length, 1, `statuses ${statuses}`);
    assert.ok(statuses.every((s) => [201, 400, 409].includes(s)), `statuses ${statuses}`);
    assert.equal(await orderCount(customer), 1);
    assert.equal(await stockOf(product), 8);
  });

  it("the last unit: two customers race, exactly one wins, the other keeps their cart", async () => {
    const product = await helpers.createProduct(category, { stock: 1 });
    const a = await helpers.createUser("customer");
    const b = await helpers.createUser("customer");
    await helpers.putInCart(a, [{ product, quantity: 1 }]);
    await helpers.putInCart(b, [{ product, quantity: 1 }]);

    const [ra, rb] = await Promise.all([checkout(a), checkout(b)]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    assert.equal(await stockOf(product), 0);
    const loser = ra.status === 409 ? a : b;
    const winner = ra.status === 201 ? a : b;
    assert.equal(await orderCount(winner), 1);
    assert.equal(await orderCount(loser), 0);
    assert.deepEqual(await cartLines(loser), [{ product: String(product._id), quantity: 1 }], "the loser still has the item");
    await assertStockConserved(product, 1);
  });

  it("10 customers compete for 5 units: exactly 5 orders, 5 refusals, stock exactly 0", async () => {
    const product = await helpers.createProduct(category, { stock: 5 });
    const customers = await Promise.all(Array.from({ length: 10 }, () => helpers.createUser("customer")));
    await Promise.all(customers.map((c) => helpers.putInCart(c, [{ product, quantity: 1 }])));

    const results = await Promise.all(customers.map((c) => checkout(c)));
    const created = results.filter((r) => r.status === 201).length;
    const refused = results.filter((r) => r.status === 409).length;

    assert.equal(created, 5, `statuses ${results.map((r) => r.status)}`);
    assert.equal(refused, 5);
    assert.equal(await stockOf(product), 0);
    await assertStockConserved(product, 5);
    for (const [index, result] of results.entries()) {
      if (result.status === 409) assert.equal((await cartLines(customers[index])).length, 1, "losers keep their cart");
    }
  });

  it("buyers of different quantities never oversell (stock 10, six buyers want 3 each)", async () => {
    const product = await helpers.createProduct(category, { stock: 10 });
    const customers = await Promise.all(Array.from({ length: 6 }, () => helpers.createUser("customer")));
    await Promise.all(customers.map((c) => helpers.putInCart(c, [{ product, quantity: 3 }])));

    const results = await Promise.all(customers.map((c) => checkout(c)));
    assert.equal(results.filter((r) => r.status === 201).length, 3, "only 3 x 3 = 9 units fit into 10");
    assert.equal(await stockOf(product), 1);
    await assertStockConserved(product, 10);
  });

  it("a checkout racing a cart edit ends in a consistent state", async () => {
    for (let round = 0; round < 6; round++) {
      const { customer, product } = await setup({ stock: 20, quantity: 2 });
      const [order, edit] = await Promise.all([
        checkout(customer),
        request("PUT", `/api/cart/items/${product._id}`, { quantity: 5 }, customer.token),
      ]);

      assert.ok([201, 400, 409].includes(order.status), `checkout ${order.status}`);
      assert.ok([200, 404, 409].includes(edit.status), `edit ${edit.status}`);
      await assertStockConserved(product, 20);

      const lines = await cartLines(customer);
      if (order.status === 201) {
        assert.deepEqual(lines, [], "the cart was handed over to the order");
        assert.ok([2, 5].includes(order.body.order.items[0].quantity), "the order holds a quantity the cart really had");
      } else {
        assert.equal(lines.length, 1, "no order: the cart is intact");
        assert.equal(await orderCount(customer), 0);
      }
    }
  });
});

// ===========================================================================
describe("Cancelling an order", () => {
  it("a customer can cancel a pending order: stock comes back exactly once", async () => {
    const { customer, product } = await setup({ stock: 10, quantity: 4 });
    const placed = await checkout(customer);
    assert.equal(await stockOf(product), 6);

    const response = await cancel(customer, placed.body.order._id);
    assert.equal(response.status, 200);
    assert.equal(response.body.order.status, "cancelled");
    assert.equal(response.body.order.canCancel, false);
    assert.equal(response.body.order.paymentStatus, "pending", "a cancelled COD order is never 'paid'");
    assert.deepEqual(response.body.order.statusHistory.map((h) => h.status), ["pending", "cancelled"]);
    assert.ok(!JSON.stringify(response.body).includes("changedBy"));

    assert.equal(await stockOf(product), 10);
    const stored = await Order.findById(placed.body.order._id);
    assert.equal(stored.stockRestored, true);
    assert.equal(stored.status, "cancelled");
    assert.equal(String(stored.statusHistory[1].changedBy), customer.id);
  });

  it("a second cancellation is refused and cannot restore stock again", async () => {
    const { customer, product } = await setup({ stock: 10, quantity: 4 });
    const placed = await checkout(customer);
    assert.equal((await cancel(customer, placed.body.order._id)).status, 200);

    const again = await cancel(customer, placed.body.order._id);
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already been cancelled/);
    assert.equal(await stockOf(product), 10, "still 10, not 14");
  });

  it("restores stock even when the product is inactive by then", async () => {
    const { customer, product } = await setup({ stock: 10, quantity: 2 });
    const placed = await checkout(customer);
    await Product.updateOne({ _id: product._id }, { isActive: false });
    assert.equal((await cancel(customer, placed.body.order._id)).status, 200);
    assert.equal(await stockOf(product), 10);
  });

  it("restores the quantities of every line of a multi-product order", async () => {
    const customer = await helpers.createUser("customer");
    const a = await helpers.createProduct(category, { stock: 10 });
    const b = await helpers.createProduct(category, { stock: 7 });
    await helpers.putInCart(customer, [{ product: a, quantity: 2 }, { product: b, quantity: 7 }]);
    const placed = await checkout(customer);
    assert.deepEqual([await stockOf(a), await stockOf(b)], [8, 0]);

    await cancel(customer, placed.body.order._id);
    assert.deepEqual([await stockOf(a), await stockOf(b)], [10, 7]);
  });

  it("refuses to cancel any order that is no longer pending, and changes nothing", async () => {
    for (const status of ["confirmed", "processing", "shipped", "delivered"]) {
      const { customer, product } = await setup({ stock: 10, quantity: 2 });
      const placed = await checkout(customer);
      await Order.updateOne({ _id: placed.body.order._id }, { status });

      const response = await cancel(customer, placed.body.order._id);
      assert.equal(response.status, 409, status);
      assert.match(response.body.message, new RegExp(status));

      const stored = await Order.findById(placed.body.order._id);
      assert.equal(stored.status, status, "status unchanged");
      assert.equal(stored.stockRestored, false);
      assert.equal(await stockOf(product), 8, "stock unchanged");
    }
  });

  it("cannot cancel another customer's order (404), and nothing changes", async () => {
    const { customer, product } = await setup({ stock: 10, quantity: 2 });
    const placed = await checkout(customer);
    const stranger = await helpers.createUser("customer");

    const response = await cancel(stranger, placed.body.order._id);
    assert.equal(response.status, 404);
    const stored = await Order.findById(placed.body.order._id);
    assert.equal(stored.status, "pending");
    assert.equal(await stockOf(product), 8);
  });

  it("ignores anything in the body of a cancel request", async () => {
    const { customer } = await setup({ quantity: 1 });
    const placed = await checkout(customer);
    const response = await cancel(customer, placed.body.order._id, {
      status: "delivered",
      paymentStatus: "paid",
      stockRestored: false,
      user: "someone-else",
      total: 0,
    });
    assert.equal(response.status, 200);
    const stored = await Order.findById(placed.body.order._id);
    assert.equal(stored.status, "cancelled", "the body cannot choose another status");
    assert.equal(stored.paymentStatus, "pending", "and cannot mark the order paid");
    assert.equal(stored.stockRestored, true);
    assert.equal(String(stored.user), customer.id);
  });

  it("rejects a malformed or unknown order id", async () => {
    const customer = await helpers.createUser("customer");
    for (const id of ["abc", "123", "g".repeat(24), "a".repeat(23), "a".repeat(25), "%00", "null", "undefined", "../x"]) {
      const response = await cancel(customer, encodeURIComponent(id));
      assert.equal(response.status, 400, `cancel id ${id}`);
    }
    assert.equal((await cancel(customer, "a".repeat(24))).status, 404);
  });

  it("freed stock can be bought again", async () => {
    const product = await helpers.createProduct(category, { stock: 1 });
    const first = await helpers.createUser("customer");
    const second = await helpers.createUser("customer");
    await helpers.putInCart(first, [{ product, quantity: 1 }]);
    await helpers.putInCart(second, [{ product, quantity: 1 }]);

    const placed = await checkout(first);
    assert.equal((await checkout(second)).status, 409, "sold out");
    await cancel(first, placed.body.order._id);
    assert.equal((await checkout(second)).status, 201, "available again");
    await assertStockConserved(product, 1);
  });
});

describe("Cancelling under concurrency", () => {
  it("5 simultaneous cancels: exactly one succeeds and stock is restored exactly once", async () => {
    const { customer, product } = await setup({ stock: 10, quantity: 4 });
    const placed = await checkout(customer);
    assert.equal(await stockOf(product), 6);

    const results = await Promise.all(Array.from({ length: 5 }, () => cancel(customer, placed.body.order._id)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409, 409, 409, 409]);

    assert.equal(await stockOf(product), 10, "restored once: 6 + 4, never 6 + 20");
    const stored = await Order.findById(placed.body.order._id);
    assert.equal(stored.statusHistory.filter((h) => h.status === "cancelled").length, 1, "one cancelled entry");
  });

  it("many orders cancelled in parallel restore every unit exactly once", async () => {
    const product = await helpers.createProduct(category, { stock: 20 });
    const customers = await Promise.all(Array.from({ length: 8 }, () => helpers.createUser("customer")));
    await Promise.all(customers.map((c) => helpers.putInCart(c, [{ product, quantity: 2 }])));
    const placed = await Promise.all(customers.map((c) => checkout(c)));
    assert.ok(placed.every((r) => r.status === 201));
    assert.equal(await stockOf(product), 4);

    // each customer double-clicks "cancel"
    await Promise.all(customers.flatMap((c, i) => [cancel(c, placed[i].body.order._id), cancel(c, placed[i].body.order._id)]));
    assert.equal(await stockOf(product), 20);
    await assertStockConserved(product, 20);
  });
});

// ===========================================================================
describe("My orders: list", () => {
  let customer;
  let other;
  let product;
  const base = Date.now() - 10 * 24 * 3600 * 1000;

  before(async () => {
    customer = await helpers.createUser("customer");
    other = await helpers.createUser("customer");
    product = await helpers.createProduct(category, { price: 10 });
    for (let i = 0; i < 13; i++) {
      await helpers.insertOrder(customer, [{ product, quantity: i + 1 }], {
        createdAt: new Date(base + i * 60000),
        status: i % 3 === 0 ? "confirmed" : "pending",
      });
    }
    await helpers.insertOrder(other, [{ product, quantity: 1 }]);
  });

  const list = (query = "", token = customer.token) => request("GET", `/api/orders${query}`, undefined, token);

  it("returns only my orders, newest first, 10 per page by default", async () => {
    const response = await list();
    assert.equal(response.status, 200);
    assert.equal(response.body.orders.length, 10);
    assert.deepEqual(response.body.pagination, { page: 1, limit: 10, total: 13, totalPages: 2, hasNextPage: true });
    const quantities = response.body.orders.map((o) => o.items[0].quantity);
    assert.deepEqual(quantities, [13, 12, 11, 10, 9, 8, 7, 6, 5, 4], "newest first");
  });

  it("paginates", async () => {
    const second = await list("?page=2");
    assert.equal(second.body.orders.length, 3);
    assert.equal(second.body.pagination.hasNextPage, false);
    assert.deepEqual(second.body.orders.map((o) => o.items[0].quantity), [3, 2, 1]);

    const small = await list("?limit=5&page=3");
    assert.equal(small.body.orders.length, 3);
    assert.equal(small.body.pagination.totalPages, 3);

    const beyond = await list("?page=99");
    assert.equal(beyond.status, 200);
    assert.deepEqual(beyond.body.orders, []);
  });

  it("caps the page size at 50", async () => {
    const response = await list("?limit=500");
    assert.equal(response.status, 200);
    assert.equal(response.body.pagination.limit, 50);
  });

  it("filters by status", async () => {
    const confirmed = await list("?status=confirmed");
    assert.equal(confirmed.body.pagination.total, 5);
    assert.ok(confirmed.body.orders.every((o) => o.status === "confirmed"));
    const pending = await list("?status=pending&limit=50");
    assert.equal(pending.body.pagination.total, 8);
    const none = await list("?status=delivered");
    assert.deepEqual(none.body.orders, []);
  });

  it("rejects invalid status, page and limit with 400", async () => {
    for (const query of ["?status=shipping", "?status=PENDING", "?status=", "?status=pending&status=confirmed",
      "?page=0", "?page=-1", "?page=abc", "?page=1.5", "?page=", "?limit=0", "?limit=-5", "?limit=abc", "?limit=2.5"]) {
      const response = await list(query);
      assert.equal(response.status, 400, query);
      assert.equal(typeof response.body.message, "string");
    }
  });

  it("ignores bracket-style parameters, so query operators cannot be injected", async () => {
    // Express reads "status[$ne]" as an unrelated key, never as { status: { $ne: ... } }
    for (const query of ["?status[$ne]=pending", "?status[]=pending", "?status[$regex]=.*", "?user=" + other.id, "?user[$ne]=x", "?limit[$gt]=0"]) {
      const response = await list(query);
      assert.equal(response.status, 200, query);
      assert.equal(response.body.pagination.total, 13, "unfiltered, and still only my own orders: " + query);
    }
  });

  it("only shows my own orders (user isolation)", async () => {
    const mine = await list("?limit=50");
    const theirs = await list("?limit=50", other.token);
    assert.equal(mine.body.pagination.total, 13);
    assert.equal(theirs.body.pagination.total, 1);
    const mineIds = new Set(mine.body.orders.map((o) => o._id));
    assert.ok(!theirs.body.orders.some((o) => mineIds.has(o._id)));
  });

  it("does NOT include phone, address, email or other details in the list", async () => {
    const response = await list("?limit=50");
    const text = JSON.stringify(response.body);
    for (const leaked of ["SECRET-ADDRESS-LINE-1", "+92 300 7654321", customer.user.email, "Lahore", "delivery", "statusHistory", "changedBy", "stockRestored"]) {
      assert.ok(!text.includes(leaked), `the list must not contain "${leaked}"`);
    }
  });

  it("shows the summary fields and a correct canCancel", async () => {
    const response = await list("?limit=50");
    for (const order of response.body.orders) {
      assert.match(order.orderNumber, orderNumbers.ORDER_NUMBER_PATTERN);
      assert.equal(order.itemCount, order.items[0].quantity);
      assert.equal(order.total, order.items[0].quantity * 10);
      assert.equal(order.canCancel, order.status === "pending");
    }
  });
});

// ===========================================================================
describe("My orders: details", () => {
  let customer;
  let stranger;
  let product;
  let placed;

  before(async () => {
    customer = await helpers.createUser("customer");
    stranger = await helpers.createUser("customer");
    product = await helpers.createProduct(category, { stock: 10, price: 40 });
    await helpers.putInCart(customer, [{ product, quantity: 2 }]);
    placed = await checkout(customer, checkoutBody({ delivery: helpers.validDelivery({ phone: "0300 5554443", addressLine1: "42 Garden Road" }) }));
  });

  it("shows the owner the full order, including delivery details", async () => {
    const response = await getOrder(customer, placed.body.order._id);
    assert.equal(response.status, 200);
    const order = response.body.order;
    assert.equal(order.orderNumber, placed.body.order.orderNumber);
    assert.equal(order.delivery.phone, "0300 5554443");
    assert.equal(order.delivery.addressLine1, "42 Garden Road");
    assert.equal(order.customer.email, customer.user.email);
    assert.equal(order.total, 80);
    assert.deepEqual(order.statusHistory.map((h) => h.status), ["pending"]);
  });

  it("never shows internal fields", async () => {
    const text = JSON.stringify((await getOrder(customer, placed.body.order._id)).body);
    for (const internal of ["changedBy", "stockRestored", "__v", `"user"`, "password"]) {
      assert.ok(!text.includes(internal), `must not contain ${internal}`);
    }
  });

  it("is not available to other customers (404, same as a missing order)", async () => {
    const response = await getOrder(stranger, placed.body.order._id);
    assert.equal(response.status, 404);
    const missing = await getOrder(stranger, "a".repeat(24));
    assert.deepEqual(response.body, missing.body, "indistinguishable from an order that does not exist");
    assert.ok(!JSON.stringify(response.body).includes("0300 5554443"));
  });

  it("rejects malformed ids with 400 and unknown ids with 404", async () => {
    for (const id of ["abc", "12", "g".repeat(24), "a".repeat(25), "null", "%20", "$ne"]) {
      assert.equal((await getOrder(customer, encodeURIComponent(id))).status, 400, id);
    }
    assert.equal((await getOrder(customer, "f".repeat(24))).status, 404);
  });

  it("accepts an upper-case id", async () => {
    const response = await getOrder(customer, placed.body.order._id.toUpperCase());
    assert.equal(response.status, 200);
  });

  it("reports canCancel correctly for each status", async () => {
    for (const [status, expected] of [["pending", true], ["confirmed", false], ["processing", false], ["shipped", false], ["delivered", false], ["cancelled", false]]) {
      const order = await helpers.insertOrder(customer, [{ product, quantity: 1 }], { status });
      const response = await getOrder(customer, order._id);
      assert.equal(response.body.order.canCancel, expected, status);
    }
  });
});

// ===========================================================================
describe("Orders keep the values from the day they were placed", () => {
  it("later product changes (name, price, image, stock, hidden) do not change an old order", async () => {
    const customer = await helpers.createUser("customer");
    const product = await helpers.createProduct(category, {
      name: `T${helpers.runTag} Original`, price: 100, stock: 10, imageUrl: "https://example.com/old.jpg",
    });
    await helpers.putInCart(customer, [{ product, quantity: 2 }]);
    const placed = await checkout(customer);

    await Product.updateOne(
      { _id: product._id },
      { name: `T${helpers.runTag} Renamed`, price: 999, imageUrl: "https://example.com/new.jpg", isActive: false, stock: 0 }
    );

    const order = (await getOrder(customer, placed.body.order._id)).body.order;
    assert.equal(order.items[0].name, `T${helpers.runTag} Original`);
    assert.equal(order.items[0].price, 100);
    assert.equal(order.items[0].imageUrl, "https://example.com/old.jpg");
    assert.equal(order.items[0].lineTotal, 200);
    assert.equal(order.total, 200);

    const list = (await request("GET", "/api/orders", undefined, customer.token)).body.orders[0];
    assert.equal(list.items[0].name, `T${helpers.runTag} Original`);
    assert.equal(list.total, 200);
  });

  it("changing the customer's name or e-mail later does not change the order", async () => {
    const { customer } = await setup();
    const placed = await checkout(customer);
    const User = require("../src/models/User");
    await User.updateOne({ _id: customer.user._id }, { name: "Someone Else" });
    const order = (await getOrder(customer, placed.body.order._id)).body.order;
    assert.equal(order.customer.name, customer.user.name);
  });
});

// ===========================================================================
describe("The Order model protects itself", () => {
  let customer;
  let product;

  before(async () => {
    customer = await helpers.createUser("customer");
    product = await helpers.createProduct(category, { price: 50 });
  });

  it("cannot change protected fields through save()", async () => {
    const order = await helpers.insertOrder(customer, [{ product, quantity: 2 }]);
    const other = await helpers.createUser("customer");

    const loaded = await Order.findById(order._id);
    loaded.total = 1;
    loaded.subtotal = 1;
    loaded.shippingFee = 99;
    loaded.user = other.user._id;
    loaded.orderNumber = "ORD-HACKED";
    loaded.paymentMethod = "cod";
    loaded.customer.name = "Evil";
    loaded.delivery.phone = "000";
    loaded.delivery.addressLine1 = "Elsewhere 1";
    await loaded.save();

    const after = await Order.findById(order._id);
    assert.equal(after.total, 100);
    assert.equal(after.subtotal, 100);
    assert.equal(after.shippingFee, 0);
    assert.equal(String(after.user), customer.id);
    assert.equal(after.orderNumber, order.orderNumber);
    assert.equal(after.customer.name, customer.user.name);
    assert.equal(after.delivery.phone, "+92 300 7654321");
    assert.equal(after.delivery.addressLine1, "SECRET-ADDRESS-LINE-1");
  });

  it("cannot change the items of a saved order through save()", async () => {
    const order = await helpers.insertOrder(customer, [{ product, quantity: 2 }]);
    const loaded = await Order.findById(order._id);
    loaded.items[0].price = 1;
    loaded.items[0].quantity = 99;
    loaded.items[0].lineTotal = 1;
    try {
      await loaded.save();
    } catch (error) {
      // refusing loudly is also fine
    }
    const after = await Order.findById(order._id);
    assert.equal(after.items[0].price, 50);
    assert.equal(after.items[0].quantity, 2);
    assert.equal(after.items[0].lineTotal, 100);
  });

  it("refuses inconsistent or invalid orders", async () => {
    const base = async (overrides) => helpers.insertOrder(customer, [{ product, quantity: 2 }], overrides);
    await assert.rejects(base({ total: 5 }), /Total must equal/);
    await assert.rejects(base({ subtotal: 5, total: 5 }), /Subtotal must equal/);
    await assert.rejects(base({ shippingFee: 10 }), /Total must equal/, "a fee that does not add up");
    await assert.rejects(base({ paymentMethod: "card" }), /paymentMethod/);
    await assert.rejects(base({ paymentStatus: "settled" }), /paymentStatus/);
    await assert.rejects(base({ status: "teleported" }), /status/);
    await assert.rejects(base({ items: [] }), /at least one item/);
    await assert.rejects(base({ orderNumber: undefined }), /orderNumber/);
  });

  it("refuses bad order lines", async () => {
    const line = { product: product._id, name: "x", price: 10, quantity: 1, lineTotal: 10 };
    const make = (item) =>
      Order.create({
        orderNumber: orderNumbers.generateOrderNumber(), user: customer.user._id,
        customer: { name: "n", email: "e@example.test" }, items: [item], delivery: helpers.validDelivery(),
        paymentMethod: "cod", subtotal: item.lineTotal, total: item.lineTotal,
      });
    await assert.rejects(make({ ...line, quantity: 100, lineTotal: 1000 }), /quantity/i);
    await assert.rejects(make({ ...line, quantity: 0, lineTotal: 0 }), /quantity/i);
    await assert.rejects(make({ ...line, quantity: 1.5, lineTotal: 15 }), /whole number/);
    await assert.rejects(make({ ...line, price: -1, lineTotal: -1 }), /price/i);
    await assert.rejects(make({ ...line, lineTotal: 99 }), /Line total must equal/);
    assert.ok(await make(line), "a correct line is accepted");
  });

  it("refuses more than 50 lines", async () => {
    const item = (i) => ({ product: product._id, name: `n${i}`, price: 1, quantity: 1, lineTotal: 1 });
    const items = Array.from({ length: 51 }, (_, i) => item(i));
    await assert.rejects(
      Order.create({
        orderNumber: orderNumbers.generateOrderNumber(), user: customer.user._id,
        customer: { name: "n", email: "e@example.test" }, items, delivery: helpers.validDelivery(),
        paymentMethod: "cod", subtotal: 51, total: 51,
      }),
      /at most 50/
    );
  });

  it("order numbers are unique in the database", async () => {
    const first = await helpers.insertOrder(customer, [{ product, quantity: 1 }]);
    await assert.rejects(
      helpers.insertOrder(customer, [{ product, quantity: 1 }], { orderNumber: first.orderNumber }),
      (error) => error.code === 11000 && Boolean(error.keyPattern.orderNumber)
    );
  });

  it("the model defaults are safe", async () => {
    const order = await helpers.insertOrder(customer, [{ product, quantity: 1 }]);
    assert.equal(order.status, "pending");
    assert.equal(order.paymentStatus, "pending");
    assert.equal(order.stockRestored, false);
    assert.equal(order.shippingFee, 0);
  });
});
