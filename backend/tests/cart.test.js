const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const Cart = require("../src/models/Cart");
const Product = require("../src/models/Product");
const AppError = require("../src/utils/AppError");
const { errorHandler } = require("../src/middleware/errorHandler");
const helpers = require("./helpers");

let request; // request(method, path, body, token) -> { status, body }
let server;
let category;

before(async () => {
  await helpers.connectTestDatabase();
  server = await helpers.startServer();
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

// Small helpers used by many tests
const addToCart = (customer, product, quantity) =>
  request("POST", "/api/cart/items", { productId: String(product._id), quantity }, customer.token);
const getCart = (customer) => request("GET", "/api/cart", undefined, customer.token);
const lineFor = (cart, product) => cart.items.find((item) => item.productId === String(product._id));
const assertErrorBody = (response) => {
  assert.equal(typeof response.body.message, "string");
  assert.equal(response.body.stack, undefined);
  assert.equal(response.body.success, undefined);
};

describe("Cart authentication and roles", () => {
  let product;
  let customer;
  let admin;

  before(async () => {
    product = await helpers.createProduct(category);
    customer = await helpers.createUser("customer");
    admin = await helpers.createUser("admin");
  });

  const id = () => String(product._id);
  const endpoints = () => [
    ["GET", "/api/cart", undefined],
    ["POST", "/api/cart/items", { productId: id(), quantity: 1 }],
    ["PUT", `/api/cart/items/${id()}`, { quantity: 1 }],
    ["DELETE", `/api/cart/items/${id()}`, undefined],
    ["DELETE", "/api/cart", undefined],
  ];

  it("returns 401 on every cart endpoint without a token", async () => {
    for (const [method, url, body] of endpoints()) {
      const response = await request(method, url, body);
      assert.equal(response.status, 401, `${method} ${url}`);
      assertErrorBody(response);
    }
  });

  it("returns 401 for an invalid token", async () => {
    const response = await request("GET", "/api/cart", undefined, "not.a.real-token");
    assert.equal(response.status, 401);
  });

  it("returns 403 on every cart endpoint for an admin", async () => {
    for (const [method, url, body] of endpoints()) {
      const response = await request(method, url, body, admin.token);
      assert.equal(response.status, 403, `${method} ${url}`);
      assertErrorBody(response);
    }
    assert.equal(await Cart.countDocuments({ user: admin.user._id }), 0, "admin must not get a cart");
  });

  it("lets a customer open the cart", async () => {
    const response = await getCart(customer);
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });
});

describe("Cart creation and adding products", () => {
  let customer;
  let cheap;
  let other;
  let bigStock;

  before(async () => {
    customer = await helpers.createUser("customer");
    cheap = await helpers.createProduct(category, { name: `T${helpers.runTag} cheap`, price: 250.75, stock: 10 });
    other = await helpers.createProduct(category, { price: 99.99, stock: 5 });
    bigStock = await helpers.createProduct(category, { stock: 500 });
  });

  it("GET without a cart returns an empty cart and does not create one", async () => {
    const response = await getCart(customer);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.cart, { items: [], itemCount: 0, subtotal: 0, hasProblems: false });
    assert.equal(await Cart.countDocuments({ user: customer.user._id }), 0);
  });

  it("adding the first product creates the cart (201)", async () => {
    const response = await addToCart(customer, cheap, 2);
    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.cart.items.length, 1);
    assert.equal(response.body.cart.items[0].quantity, 2);
    assert.equal(await Cart.countDocuments({ user: customer.user._id }), 1);
  });

  it("adding the same product again increases the quantity (200), not a second line", async () => {
    const response = await addToCart(customer, cheap, 3);
    assert.equal(response.status, 200);
    assert.equal(response.body.cart.items.length, 1);
    assert.equal(response.body.cart.items[0].quantity, 5);
  });

  it("defaults the quantity to 1 when it is omitted", async () => {
    const response = await request("POST", "/api/cart/items", { productId: String(other._id) }, customer.token);
    assert.equal(response.status, 201);
    assert.equal(lineFor(response.body.cart, other).quantity, 1);
  });

  it("accepts quantities from 1 to 99 and rejects 100 or more", async () => {
    const user = await helpers.createUser("customer");
    assert.equal((await addToCart(user, bigStock, 1)).status, 201);
    assert.equal((await addToCart(user, bigStock, 98)).status, 200); // 1 + 98 = 99, the maximum
    const tooMany = await addToCart(user, bigStock, 1); // would be 100
    assert.equal(tooMany.status, 400);
    assertErrorBody(tooMany);

    const another = await helpers.createUser("customer");
    assert.equal((await addToCart(another, bigStock, 99)).status, 201);
    assert.equal((await addToCart(another, bigStock, 100)).status, 400, "100 in one request");
  });

  it("rejects invalid quantities with 400", async () => {
    for (const quantity of [0, -1, 1.5, "2", null, NaN, true, [1], { n: 1 }]) {
      const user = await helpers.createUser("customer");
      const response = await request(
        "POST",
        "/api/cart/items",
        { productId: String(bigStock._id), quantity },
        user.token
      );
      assert.equal(response.status, 400, `quantity ${JSON.stringify(quantity)}`);
      assert.equal(await Cart.countDocuments({ user: user.user._id }), 0, "failed add must not create a cart");
    }
  });

  it("rejects a missing, malformed or non-string product id with 400", async () => {
    for (const productId of [undefined, "", "abc", "123", 12345, { $ne: null }, ["x"]]) {
      const response = await request("POST", "/api/cart/items", { productId, quantity: 1 }, customer.token);
      assert.equal(response.status, 400, `productId ${JSON.stringify(productId)}`);
    }
    const noBody = await request("POST", "/api/cart/items", undefined, customer.token);
    assert.equal(noBody.status, 400);
  });

  it("returns 404 for a well-formed id that matches no product", async () => {
    const response = await request("POST", "/api/cart/items", { productId: "a".repeat(24), quantity: 1 }, customer.token);
    assert.equal(response.status, 404);
  });

  it("never trusts price, name or user from the request body", async () => {
    const user = await helpers.createUser("customer");
    const victim = await helpers.createUser("customer");
    const response = await request(
      "POST",
      "/api/cart/items",
      {
        productId: String(other._id),
        quantity: 1,
        price: 0.01,
        name: "Hacked",
        lineTotal: 0,
        user: victim.id,
        userId: victim.id,
      },
      user.token
    );
    assert.equal(response.status, 201);
    assert.equal(response.body.cart.items[0].price, 99.99);
    assert.notEqual(response.body.cart.items[0].name, "Hacked");

    const saved = await Cart.findOne({ user: user.user._id });
    assert.deepEqual(Object.keys(saved.items[0].toObject()).sort(), ["product", "quantity"]);
    assert.equal(await Cart.countDocuments({ user: victim.user._id }), 0, "the other user's cart is untouched");
  });

  it("limits a cart to 50 different products", async () => {
    const user = await helpers.createUser("customer");
    const products = await Product.insertMany(
      Array.from({ length: 51 }, (_, index) => ({
        name: `T${helpers.runTag} bulk ${index}`,
        description: "bulk",
        price: 1,
        stock: 5,
        category: category._id,
      }))
    );

    // The model itself refuses more than 50 lines
    await assert.rejects(
      Cart.create({ user: user.user._id, items: products.map((p) => ({ product: p._id, quantity: 1 })) }),
      (error) => error.name === "ValidationError"
    );

    // 49 lines straight into the database, then the API adds the 50th and rejects the 51st
    await Cart.create({ user: user.user._id, items: products.slice(0, 49).map((p) => ({ product: p._id, quantity: 1 })) });
    assert.equal((await addToCart(user, products[49], 1)).status, 201);

    const rejected = await addToCart(user, products[50], 1);
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.message, /at most 50/);
    assert.equal((await Cart.findOne({ user: user.user._id })).items.length, 50);

    // Increasing a product that is already in a full cart is still allowed
    assert.equal((await addToCart(user, products[0], 2)).status, 200);
  });
});

describe("Cart and stock", () => {
  let customer;
  let stocked; // stock 10

  before(async () => {
    customer = await helpers.createUser("customer");
    stocked = await helpers.createProduct(category, { stock: 10 });
  });

  it("cannot add more than the available stock (409 with details)", async () => {
    const response = await addToCart(customer, stocked, 11);
    assert.equal(response.status, 409);
    assert.match(response.body.message, /Only 10/);
    assert.equal(response.body.details.length, 1);
    assert.deepEqual(response.body.details[0], {
      productId: String(stocked._id),
      name: stocked.name,
      reason: "insufficient_stock",
      requested: 11,
      available: 10,
    });
    assert.equal(await Cart.countDocuments({ user: customer.user._id }), 0, "failed add must not create a cart");
  });

  it("counts what is already in the cart when merging", async () => {
    assert.equal((await addToCart(customer, stocked, 6)).status, 201);
    const response = await addToCart(customer, stocked, 6); // 6 + 6 = 12 > 10
    assert.equal(response.status, 409);
    assert.match(response.body.message, /already have 6/);
    assert.equal(lineFor((await getCart(customer)).body.cart, stocked).quantity, 6, "quantity unchanged");
  });

  it("allows exactly the available stock", async () => {
    const response = await addToCart(customer, stocked, 4); // 6 + 4 = 10
    assert.equal(response.status, 200);
    assert.equal(lineFor(response.body.cart, stocked).quantity, 10);
  });

  it("cannot update the quantity above stock", async () => {
    const response = await request("PUT", `/api/cart/items/${stocked._id}`, { quantity: 11 }, customer.token);
    assert.equal(response.status, 409);
    assert.equal(response.body.details[0].reason, "insufficient_stock");
    assert.equal(lineFor((await getCart(customer)).body.cart, stocked).quantity, 10, "quantity unchanged");
  });

  it("cannot add a product with zero stock", async () => {
    const user = await helpers.createUser("customer");
    const soldOut = await helpers.createProduct(category, { stock: 0 });
    const response = await addToCart(user, soldOut, 1);
    assert.equal(response.status, 409);
    assert.equal(response.body.details[0].reason, "out_of_stock");
    assert.equal(await Cart.countDocuments({ user: user.user._id }), 0);
  });

  it("cannot add an inactive product", async () => {
    const user = await helpers.createUser("customer");
    const hidden = await helpers.createProduct(category, { stock: 10, isActive: false });
    const response = await addToCart(user, hidden, 1);
    assert.equal(response.status, 409);
    assert.equal(response.body.details[0].reason, "inactive");
    assert.equal(await Cart.countDocuments({ user: user.user._id }), 0);
  });
});

describe("Cart operations: update, remove, clear", () => {
  let customer;
  let first;
  let second;

  before(async () => {
    customer = await helpers.createUser("customer");
    first = await helpers.createProduct(category, { price: 10, stock: 20 });
    second = await helpers.createProduct(category, { price: 20, stock: 20 });
    await addToCart(customer, first, 2);
    await addToCart(customer, second, 1);
  });

  it("updates a quantity (up and down) and returns the new cart", async () => {
    const up = await request("PUT", `/api/cart/items/${first._id}`, { quantity: 7 }, customer.token);
    assert.equal(up.status, 200);
    assert.equal(lineFor(up.body.cart, first).quantity, 7);
    assert.equal(up.body.cart.itemCount, 8);

    const down = await request("PUT", `/api/cart/items/${first._id}`, { quantity: 1 }, customer.token);
    assert.equal(down.status, 200);
    assert.equal(lineFor(down.body.cart, first).quantity, 1);
  });

  it("accepts an upper-case product id in the URL", async () => {
    const response = await request(
      "PUT",
      `/api/cart/items/${String(first._id).toUpperCase()}`,
      { quantity: 3 },
      customer.token
    );
    assert.equal(response.status, 200);
    assert.equal(lineFor(response.body.cart, first).quantity, 3);
  });

  it("rejects invalid quantities on update with 400", async () => {
    for (const quantity of [0, -2, 100, 1.5, "3", null, undefined]) {
      const response = await request("PUT", `/api/cart/items/${first._id}`, { quantity }, customer.token);
      assert.equal(response.status, 400, `quantity ${JSON.stringify(quantity)}`);
    }
    assert.equal(lineFor((await getCart(customer)).body.cart, first).quantity, 3, "unchanged");
  });

  it("rejects a malformed product id with 400 and an item that is not in the cart with 404", async () => {
    assert.equal((await request("PUT", "/api/cart/items/abc", { quantity: 1 }, customer.token)).status, 400);
    assert.equal((await request("DELETE", "/api/cart/items/abc", undefined, customer.token)).status, 400);
    const notInCart = await helpers.createProduct(category);
    assert.equal((await request("PUT", `/api/cart/items/${notInCart._id}`, { quantity: 1 }, customer.token)).status, 404);
    assert.equal((await request("DELETE", `/api/cart/items/${notInCart._id}`, undefined, customer.token)).status, 404);
  });

  it("returns 404 on update when the user has no cart at all, and creates no cart", async () => {
    const user = await helpers.createUser("customer");
    const response = await request("PUT", `/api/cart/items/${first._id}`, { quantity: 1 }, user.token);
    assert.equal(response.status, 404);
    assert.equal(await Cart.countDocuments({ user: user.user._id }), 0);
  });

  it("cannot update an item whose product has become inactive (409)", async () => {
    const user = await helpers.createUser("customer");
    const product = await helpers.createProduct(category, { stock: 10 });
    await addToCart(user, product, 1);
    await Product.updateOne({ _id: product._id }, { isActive: false });
    const response = await request("PUT", `/api/cart/items/${product._id}`, { quantity: 2 }, user.token);
    assert.equal(response.status, 409);
    assert.equal(response.body.details[0].reason, "inactive");
  });

  it("removes one item and keeps the others", async () => {
    const response = await request("DELETE", `/api/cart/items/${first._id}`, undefined, customer.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.cart.items.length, 1);
    assert.equal(lineFor(response.body.cart, first), undefined);
    assert.ok(lineFor(response.body.cart, second));

    const again = await request("DELETE", `/api/cart/items/${first._id}`, undefined, customer.token);
    assert.equal(again.status, 404, "removing it a second time");
  });

  it("clears the whole cart, and clearing an empty or missing cart still succeeds", async () => {
    const cleared = await request("DELETE", "/api/cart", undefined, customer.token);
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.cart, { items: [], itemCount: 0, subtotal: 0, hasProblems: false });
    assert.equal((await Cart.findOne({ user: customer.user._id })).items.length, 0);

    assert.equal((await request("DELETE", "/api/cart", undefined, customer.token)).status, 200, "already empty");

    const noCartUser = await helpers.createUser("customer");
    assert.equal((await request("DELETE", "/api/cart", undefined, noCartUser.token)).status, 200, "no cart");
    assert.equal(await Cart.countDocuments({ user: noCartUser.user._id }), 0);
  });
});

describe("Cart user isolation", () => {
  let userA;
  let userB;
  let onlyA;
  let onlyB;
  let shared;

  before(async () => {
    userA = await helpers.createUser("customer");
    userB = await helpers.createUser("customer");
    onlyA = await helpers.createProduct(category, { stock: 20 });
    onlyB = await helpers.createProduct(category, { stock: 20 });
    shared = await helpers.createProduct(category, { stock: 20 });
    await addToCart(userA, onlyA, 2);
    await addToCart(userA, shared, 1);
    await addToCart(userB, onlyB, 3);
    await addToCart(userB, shared, 4);
  });

  const snapshotOfB = async () => {
    const cart = await Cart.findOne({ user: userB.user._id });
    return JSON.stringify(cart.items);
  };

  it("each user only sees their own cart", async () => {
    const a = (await getCart(userA)).body.cart;
    const b = (await getCart(userB)).body.cart;
    assert.deepEqual(a.items.map((i) => i.productId).sort(), [String(onlyA._id), String(shared._id)].sort());
    assert.deepEqual(b.items.map((i) => i.productId).sort(), [String(onlyB._id), String(shared._id)].sort());
    assert.equal(lineFor(a, shared).quantity, 1);
    assert.equal(lineFor(b, shared).quantity, 4);
  });

  it("user A cannot modify user B's cart", async () => {
    const before = await snapshotOfB();

    // A's product id for B's item: the item is not in A's cart, so 404
    assert.equal((await request("PUT", `/api/cart/items/${onlyB._id}`, { quantity: 9 }, userA.token)).status, 404);
    assert.equal((await request("DELETE", `/api/cart/items/${onlyB._id}`, undefined, userA.token)).status, 404);

    // Sending B's id in the body or the query changes nothing about whose cart is used
    const sneaky = await request(
      "POST",
      `/api/cart/items?user=${userB.id}`,
      { productId: String(onlyB._id), quantity: 1, user: userB.id, userId: userB.id },
      userA.token
    );
    assert.equal(sneaky.status, 201);
    assert.ok(lineFor(sneaky.body.cart, onlyB), "it went into A's own cart");

    // Updating a shared product only changes A's line
    assert.equal((await request("PUT", `/api/cart/items/${shared._id}`, { quantity: 7 }, userA.token)).status, 200);

    assert.equal(await snapshotOfB(), before, "B's cart is byte-for-byte unchanged");
  });

  it("user A cannot delete user B's cart", async () => {
    const before = await snapshotOfB();
    const response = await request("DELETE", "/api/cart", undefined, userA.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.cart.items.length, 0, "A's own cart is cleared");
    assert.equal(await snapshotOfB(), before, "B's cart is untouched");
    assert.equal((await getCart(userB)).body.cart.items.length, 2);
  });
});

describe("Cart GET shows current product data", () => {
  let customer;
  let product;

  before(async () => {
    customer = await helpers.createUser("customer");
    product = await helpers.createProduct(category, { name: `T${helpers.runTag} Original`, price: 250.75, stock: 10 });
  });

  it("returns name, price, image, stock, status, quantity, lineTotal, subtotal and itemCount", async () => {
    await Product.updateOne({ _id: product._id }, { imageUrl: "https://example.com/p.jpg" });
    const second = await helpers.createProduct(category, { price: 99.99, stock: 5 });
    await addToCart(customer, product, 2);
    await addToCart(customer, second, 3);

    const { status, body } = await getCart(customer);
    assert.equal(status, 200);
    assert.equal(body.success, true);

    const line = lineFor(body.cart, product);
    assert.deepEqual(line, {
      productId: String(product._id),
      name: `T${helpers.runTag} Original`,
      price: 250.75,
      imageUrl: "https://example.com/p.jpg",
      stock: 10,
      isActive: true,
      quantity: 2,
      lineTotal: 501.5,
      isAvailable: true,
      problem: null,
    });
    assert.equal(lineFor(body.cart, second).lineTotal, 299.97);
    assert.equal(body.cart.itemCount, 5);
    assert.equal(body.cart.subtotal, 801.47);
    assert.equal(body.cart.hasProblems, false);
  });

  it("shows the CURRENT name, price and stock, not what they were when added", async () => {
    await Product.updateOne({ _id: product._id }, { name: `T${helpers.runTag} Renamed`, price: 300, stock: 8 });
    const line = lineFor((await getCart(customer)).body.cart, product);
    assert.equal(line.name, `T${helpers.runTag} Renamed`);
    assert.equal(line.price, 300);
    assert.equal(line.stock, 8);
    assert.equal(line.lineTotal, 600);
  });

  it("flags problems instead of silently changing the cart", async () => {
    const user = await helpers.createUser("customer");
    const fine = await helpers.createProduct(category, { price: 10, stock: 10 });
    const hidden = await helpers.createProduct(category, { price: 20, stock: 10 });
    const soldOut = await helpers.createProduct(category, { price: 30, stock: 10 });
    const lowStock = await helpers.createProduct(category, { price: 40, stock: 10 });
    const vanished = await helpers.createProduct(category, { price: 50, stock: 10 });
    for (const p of [fine, hidden, soldOut, lowStock, vanished]) await addToCart(user, p, 2);

    await Product.updateOne({ _id: hidden._id }, { isActive: false });
    await Product.updateOne({ _id: soldOut._id }, { stock: 0 });
    await Product.updateOne({ _id: lowStock._id }, { stock: 1 });
    await Product.deleteOne({ _id: vanished._id });

    const cartBefore = await Cart.findOne({ user: user.user._id });
    const { status, body } = await getCart(user);
    const cartAfter = await Cart.findOne({ user: user.user._id });

    assert.equal(status, 200);
    assert.equal(body.cart.items.length, 5, "nothing is removed");
    assert.equal(lineFor(body.cart, fine).problem, null);
    assert.equal(lineFor(body.cart, hidden).problem, "inactive");
    assert.equal(lineFor(body.cart, hidden).isAvailable, false);
    assert.equal(lineFor(body.cart, soldOut).problem, "out_of_stock");
    assert.equal(lineFor(body.cart, lowStock).problem, "insufficient_stock");
    assert.equal(lineFor(body.cart, vanished).problem, "not_found");
    assert.equal(body.cart.hasProblems, true);
    assert.equal(body.cart.itemCount, 10, "counts every unit in the cart");
    assert.equal(body.cart.subtotal, 20, "only the buyable line (2 x 10) is in the subtotal");

    assert.equal(cartAfter.__v, cartBefore.__v, "GET did not modify the cart");
    assert.equal(String(cartAfter.updatedAt), String(cartBefore.updatedAt));
    assert.equal(JSON.stringify(cartAfter.items), JSON.stringify(cartBefore.items));
  });

  it("adds money without floating point noise (0.1 + 0.2 = 0.3)", async () => {
    const user = await helpers.createUser("customer");
    const a = await helpers.createProduct(category, { price: 0.1 });
    const b = await helpers.createProduct(category, { price: 0.2 });
    await addToCart(user, a, 1);
    await addToCart(user, b, 1);
    assert.equal((await getCart(user)).body.cart.subtotal, 0.3);
  });
});

describe("Cart concurrency", () => {
  it("many simultaneous adds never lose an update or exceed stock", async () => {
    const user = await helpers.createUser("customer");
    const product = await helpers.createProduct(category, { stock: 5 });

    const responses = await Promise.all(Array.from({ length: 8 }, () => addToCart(user, product, 1)));
    const successes = responses.filter((r) => r.status === 200 || r.status === 201).length;

    for (const response of responses) {
      assert.ok([200, 201, 409].includes(response.status), `unexpected status ${response.status}`);
    }
    const saved = await Cart.findOne({ user: user.user._id });
    assert.equal(saved.items.length, 1, "still one line");
    assert.equal(saved.items[0].quantity, successes, "every successful add is counted exactly once");
    assert.ok(successes >= 1 && successes <= 5, `quantity ${successes} must be within stock (5)`);
  });

  it("a stale copy of the cart cannot overwrite a newer save (VersionError)", async () => {
    const user = await helpers.createUser("customer");
    const product = await helpers.createProduct(category, { stock: 50 });
    await addToCart(user, product, 1);

    const first = await Cart.findOne({ user: user.user._id });
    const stale = await Cart.findOne({ user: user.user._id });

    first.items[0].quantity = 2;
    await first.save();

    stale.items[0].quantity = 3;
    await assert.rejects(stale.save(), (error) => error.name === "VersionError");

    assert.equal((await Cart.findOne({ user: user.user._id })).items[0].quantity, 2, "the newer save won");
  });
});

describe("Error handler additions", () => {
  // A tiny fake of Express's `res` that remembers what was sent
  const run = (error) => {
    const sent = {};
    const res = {
      status(code) {
        sent.status = code;
        return this;
      },
      json(body) {
        sent.body = body;
      },
    };
    errorHandler(error, {}, res, () => {});
    return sent;
  };

  it("turns a VersionError into a 409", () => {
    const error = new Error("No matching document found for id");
    error.name = "VersionError";
    const sent = run(error);
    assert.equal(sent.status, 409);
    assert.match(sent.body.message, /changed at the same time/);
    assert.equal(sent.body.details, undefined);
  });

  it("includes `details` when an AppError has them", () => {
    const sent = run(new AppError("Only 2 in stock", 409, [{ reason: "insufficient_stock" }]));
    assert.equal(sent.status, 409);
    assert.deepEqual(sent.body, { message: "Only 2 in stock", details: [{ reason: "insufficient_stock" }] });
  });

  it("is unchanged for an AppError without details (backward compatible)", () => {
    const sent = run(new AppError("Not found", 404));
    assert.equal(sent.status, 404);
    assert.deepEqual(sent.body, { message: "Not found" });
  });

  it("never leaks the message or details of a server error", () => {
    const error = new AppError("secret database detail", 500, [{ leak: true }]);
    const original = console.error;
    console.error = () => {}; // the handler logs 500 errors; keep the test output clean
    let sent;
    try {
      sent = run(error);
    } finally {
      console.error = original;
    }
    assert.equal(sent.status, 500);
    assert.deepEqual(sent.body, { message: "Internal server error" });
  });
});
