const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const Product = require("../src/models/Product");
const stockService = require("../src/services/stockService");
const helpers = require("./helpers");

let request;
let server;
let category;
let admin;

before(async () => {
  await helpers.connectTestDatabase();
  server = await helpers.startServer();
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

const stockOf = async (product) => (await Product.findById(product._id)).stock;
const lines = (...pairs) => pairs.map(([product, quantity]) => ({ product: product._id, quantity }));

describe("stockService.reserveStock", () => {
  it("takes the exact quantity for one product", async () => {
    const product = await helpers.createProduct(category, { stock: 10 });
    const reserved = await stockService.reserveStock(lines([product, 3]));
    assert.equal(reserved.length, 1);
    assert.equal(await stockOf(product), 7);
  });

  it("takes the exact quantity for several products", async () => {
    const a = await helpers.createProduct(category, { stock: 10 });
    const b = await helpers.createProduct(category, { stock: 5 });
    await stockService.reserveStock(lines([a, 2], [b, 5]));
    assert.equal(await stockOf(a), 8);
    assert.equal(await stockOf(b), 0);
  });

  it("can take all of the stock, but never more (stock never goes negative)", async () => {
    const product = await helpers.createProduct(category, { stock: 3 });
    await stockService.reserveStock(lines([product, 3]));
    assert.equal(await stockOf(product), 0);

    await assert.rejects(stockService.reserveStock(lines([product, 1])), (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.details[0].reason, "out_of_stock");
      return true;
    });
    assert.equal(await stockOf(product), 0, "still zero, not -1");
  });

  it("refuses a quantity above the stock and changes nothing", async () => {
    const product = await helpers.createProduct(category, { stock: 4 });
    await assert.rejects(stockService.reserveStock(lines([product, 5])), (error) => {
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details, [
        { productId: String(product._id), name: product.name, reason: "insufficient_stock", requested: 5, available: 4 },
      ]);
      return true;
    });
    assert.equal(await stockOf(product), 4);
  });

  it("refuses an inactive product", async () => {
    const product = await helpers.createProduct(category, { stock: 10, isActive: false });
    await assert.rejects(stockService.reserveStock(lines([product, 1])), (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.details[0].reason, "inactive");
      assert.equal(error.details[0].available, 0);
      return true;
    });
    assert.equal(await stockOf(product), 10);
  });

  it("refuses a product that does not exist", async () => {
    const ghost = { _id: "a".repeat(24) };
    await assert.rejects(stockService.reserveStock(lines([ghost, 1])), (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.details[0].reason, "not_found");
      return true;
    });
  });

  it("gives back what it already took when a LATER product fails (no partial deduction)", async () => {
    const first = await helpers.createProduct(category, { stock: 10 }); // created first = smaller id = reserved first
    const second = await helpers.createProduct(category, { stock: 1 });
    await assert.rejects(stockService.reserveStock(lines([second, 5], [first, 4])), (error) => error.statusCode === 409);
    assert.equal(await stockOf(first), 10, "the first product was reserved, then given back");
    assert.equal(await stockOf(second), 1);
  });

  it("reports every problem at once, and leaves all stock untouched", async () => {
    const fine = await helpers.createProduct(category, { stock: 10 });
    const soldOut = await helpers.createProduct(category, { stock: 0 });
    const low = await helpers.createProduct(category, { stock: 2 });
    const hidden = await helpers.createProduct(category, { stock: 10, isActive: false });

    await assert.rejects(
      stockService.reserveStock(lines([fine, 3], [soldOut, 1], [low, 5], [hidden, 1])),
      (error) => {
        assert.equal(error.statusCode, 409);
        const reasons = Object.fromEntries(error.details.map((d) => [d.productId, d.reason]));
        assert.deepEqual(reasons, {
          [String(soldOut._id)]: "out_of_stock",
          [String(low._id)]: "insufficient_stock",
          [String(hidden._id)]: "inactive",
        });
        return true;
      }
    );
    assert.equal(await stockOf(fine), 10);
    assert.equal(await stockOf(low), 2);
  });

  it("refuses zero, negative, fractional or non-number quantities (they could ADD stock)", async () => {
    const product = await helpers.createProduct(category, { stock: 10 });
    for (const quantity of [0, -1, -100, 1.5, "2", null, NaN, Infinity, undefined]) {
      await assert.rejects(stockService.reserveStock([{ product: product._id, quantity }]), Error, `reserve ${quantity}`);
      await assert.rejects(stockService.releaseStock([{ product: product._id, quantity }]), Error, `release ${quantity}`);
    }
    assert.equal(await stockOf(product), 10, "stock never changed");
  });
});

describe("stockService.releaseStock", () => {
  it("gives stock back, also for a product that is inactive now", async () => {
    const product = await helpers.createProduct(category, { stock: 2 });
    await Product.updateOne({ _id: product._id }, { isActive: false });
    const { failed } = await stockService.releaseStock(lines([product, 3]));
    assert.deepEqual(failed, []);
    assert.equal(await stockOf(product), 5);
  });

  it("retries once when the first attempt fails", async (t) => {
    const product = await helpers.createProduct(category, { stock: 1 });
    const original = Product.updateOne.bind(Product);
    let calls = 0;
    t.mock.method(Product, "updateOne", (...args) => {
      calls += 1;
      if (calls === 1) throw new Error("simulated network blip");
      return original(...args);
    });

    const { failed } = await stockService.releaseStock(lines([product, 4]));
    assert.deepEqual(failed, []);
    assert.equal(calls, 2);
    t.mock.restoreAll();
    assert.equal(await stockOf(product), 5);
  });

  it("never throws; reports and logs (ids and quantities only) when it cannot restore", async (t) => {
    const logs = [];
    t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));

    const ghost = { _id: "b".repeat(24) };
    const result = await stockService.releaseStock(lines([ghost, 2]));

    assert.equal(result.failed.length, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`product ${"b".repeat(24)}, quantity 2`));
    assert.doesNotMatch(logs[0], /@|phone|address|password|token/i, "no personal data in the log");
  });
});

describe("stock under concurrency", () => {
  it("20 simultaneous reservations of 1 unit against stock 5: exactly 5 succeed", async () => {
    const product = await helpers.createProduct(category, { stock: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => stockService.reserveStock(lines([product, 1])))
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected");

    assert.equal(succeeded, 5);
    assert.equal(failed.length, 15);
    assert.ok(failed.every((r) => r.reason.statusCode === 409));
    assert.equal(await stockOf(product), 0, "exactly zero: not negative, nothing left over");
  });

  it("two buyers who want the same two products in opposite order: one wins everything, the other nothing", async () => {
    const a = await helpers.createProduct(category, { stock: 1 });
    const b = await helpers.createProduct(category, { stock: 1 });
    const results = await Promise.allSettled([
      stockService.reserveStock(lines([a, 1], [b, 1])),
      stockService.reserveStock(lines([b, 1], [a, 1])),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await stockOf(a), 0);
    assert.equal(await stockOf(b), 0);
  });

  it("many mixed reserve and release calls keep the arithmetic exact", async () => {
    const product = await helpers.createProduct(category, { stock: 100 });
    await Promise.all([
      ...Array.from({ length: 30 }, () => stockService.reserveStock(lines([product, 2]))),
      ...Array.from({ length: 10 }, () => stockService.releaseStock(lines([product, 3]))),
    ]);
    assert.equal(await stockOf(product), 100 - 30 * 2 + 10 * 3);
  });
});

describe("Admin stock edits cannot restore old stock (compare-and-set)", () => {
  let product;

  const edit = (body, token = admin.token) => request("PUT", `/api/products/${product._id}`, body, token);

  before(async () => {
    product = await helpers.createProduct(category, { stock: 10, price: 100 });
  });

  it("a stale form cannot overwrite stock that orders have changed since it was opened", async () => {
    // The admin opens the form while stock is 10 ...
    // ... then customers buy 3 units ...
    await Product.updateOne({ _id: product._id }, { $inc: { stock: -3 } });
    assert.equal(await stockOf(product), 7);

    // ... and the admin saves a change to the stock from the old value (10 -> 12)
    const stale = await edit({ price: 55, stock: 12, previousStock: 10 });
    assert.equal(stale.status, 409);
    assert.match(stale.body.message, /stock changed/i);
    assert.deepEqual(stale.body.details, [{ reason: "stock_changed", currentStock: 7 }]);

    const saved = await Product.findById(product._id);
    assert.equal(saved.stock, 7, "the newer stock is kept");
    assert.equal(saved.price, 100, "nothing else was changed either (the whole edit is refused)");
  });

  it("an old client that sends the stale stock without previousStock is refused", async () => {
    const response = await edit({ price: 55, stock: 10 }); // stock differs from the real 7
    assert.equal(response.status, 400);
    assert.match(response.body.message, /previousStock/);
    assert.equal(await stockOf(product), 7);
    assert.equal((await Product.findById(product._id)).price, 100);
  });

  it("editing other fields without stock never touches stock", async () => {
    const response = await edit({ price: 55, name: `T${helpers.runTag} renamed` });
    assert.equal(response.status, 200);
    assert.equal(response.body.product.price, 55);
    assert.equal(response.body.product.stock, 7);
    assert.equal(await stockOf(product), 7);
  });

  it("sending the stock it already has changes nothing (and needs no previousStock)", async () => {
    const response = await edit({ stock: 7, price: 56 });
    assert.equal(response.status, 200);
    assert.equal(response.body.product.stock, 7);
    assert.equal(response.body.product.price, 56);
  });

  it("a stock change that is based on the current stock is applied", async () => {
    const response = await edit({ stock: 20, previousStock: 7 });
    assert.equal(response.status, 200);
    assert.equal(response.body.product.stock, 20, "the response shows the real, current stock");
    assert.equal(await stockOf(product), 20);
  });

  it("a purchase that lands between the stock check and the save is not overwritten", async (t) => {
    const item = await helpers.createProduct(category, { stock: 7 });
    const original = Product.updateOne.bind(Product);
    let injected = false;
    // Right after the admin's compare-and-set succeeds, a customer buys 1 unit
    t.mock.method(Product, "updateOne", async (filter, update, ...rest) => {
      const result = await original(filter, update, ...rest);
      if (!injected && update && update.$set && update.$set.stock === 20) {
        injected = true;
        await original({ _id: item._id }, { $inc: { stock: -1 } });
      }
      return result;
    });

    const response = await request("PUT", `/api/products/${item._id}`, { stock: 20, previousStock: 7, price: 77 }, admin.token);
    t.mock.restoreAll();

    assert.equal(injected, true);
    assert.equal(response.status, 200);
    assert.equal(await stockOf(item), 19, "20 set by the admin, minus the 1 unit sold a moment later");
    assert.equal((await Product.findById(item._id)).price, 77, "the other edits were still saved");
  });

  it("a second edit based on the now-old value is refused", async () => {
    const response = await edit({ stock: 30, previousStock: 7 });
    assert.equal(response.status, 409);
    assert.equal(response.body.details[0].currentStock, 20);
    assert.equal(await stockOf(product), 20);
  });

  it("rejects an invalid previousStock", async () => {
    for (const previousStock of [-1, 1.5, "20", null, [20], NaN]) {
      const response = await edit({ stock: 25, previousStock });
      assert.equal(response.status, 400, `previousStock ${JSON.stringify(previousStock)}`);
    }
    assert.equal(await stockOf(product), 20);
  });

  it("two simultaneous edits from the same starting point: exactly one wins", async () => {
    const racing = await helpers.createProduct(category, { stock: 7 });
    const send = (stock) => request("PUT", `/api/products/${racing._id}`, { stock, previousStock: 7 }, admin.token);
    const results = await Promise.all([send(50), send(60)]);

    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const final = await stockOf(racing);
    assert.ok(final === 50 || final === 60, `stock is the winner's value (${final})`);
  });

  it("does not bring back stock that a real checkout took", async () => {
    const item = await helpers.createProduct(category, { stock: 10 });
    const customer = await helpers.createUser("customer");
    await helpers.putInCart(customer, [{ product: item, quantity: 4 }]);
    const order = await request(
      "POST",
      "/api/orders",
      { delivery: helpers.validDelivery(), paymentMethod: "cod" },
      customer.token
    );
    assert.equal(order.status, 201);
    assert.equal(await stockOf(item), 6);

    // an admin form that was opened before the purchase still shows 10
    const stale = await request("PUT", `/api/products/${item._id}`, { stock: 10, previousStock: 10, price: 1 }, admin.token);
    assert.equal(stale.status, 409);
    assert.equal(await stockOf(item), 6, "the 4 sold units stay sold");
  });

  it("customers still cannot edit products at all", async () => {
    const customer = await helpers.createUser("customer");
    const response = await edit({ stock: 99, previousStock: 20 }, customer.token);
    assert.equal(response.status, 403);
    assert.equal(await stockOf(product), 20);
  });

  it("creating a product with its initial stock still works", async () => {
    const response = await request(
      "POST",
      "/api/products",
      { name: `T${helpers.runTag} created`, description: "d", price: 9, stock: 12, category: String(category._id) },
      admin.token
    );
    assert.equal(response.status, 201);
    assert.equal(response.body.product.stock, 12);
  });
});
