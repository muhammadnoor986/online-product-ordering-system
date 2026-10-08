const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const User = require("../src/models/User");
const Order = require("../src/models/Order");
const helpers = require("./helpers");

let request;
let server;
let category;
let product;

before(async () => {
  await helpers.connectTestDatabase();
  server = await helpers.startServer();
  request = helpers.makeClient(server.baseUrl);
  category = await helpers.createCategory();
  product = await helpers.createProduct(category);
});

after(async () => {
  try {
    await helpers.cleanup();
  } finally {
    if (server) await server.close();
    await helpers.disconnect();
  }
});

const char = (codePoint) => String.fromCodePoint(codePoint);
const nameInDb = async (person) => (await User.findById(person.id)).name;
const patchMe = (person, body) => request("PATCH", "/api/auth/me", body, person.token);

describe("PATCH /api/auth/me: who may use it", () => {
  it("a customer can change their own name", async () => {
    const customer = await helpers.createUser("customer");
    const response = await patchMe(customer, { name: "Ayesha Khan" });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.user.name, "Ayesha Khan");
    assert.equal(response.body.user._id, customer.id);
    assert.equal(response.body.user.role, "customer");
    assert.equal(response.body.user.email, customer.user.email);
  });

  it("an admin can change their own name", async () => {
    const admin = await helpers.createUser("admin");
    const response = await patchMe(admin, { name: "Head Admin" });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.name, "Head Admin");
    assert.equal(response.body.user.role, "admin");
    assert.equal(await nameInDb(admin), "Head Admin");
  });

  it("the database really contains the new name, and GET /me returns it", async () => {
    const customer = await helpers.createUser("customer");
    await patchMe(customer, { name: "Saved Name" });
    assert.equal(await nameInDb(customer), "Saved Name");
    const me = await request("GET", "/api/auth/me", undefined, customer.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.name, "Saved Name");
  });

  it("refuses a request without a token, with a bad token, and with a token of a deleted user", async () => {
    const customer = await helpers.createUser("customer");
    const before = await nameInDb(customer);

    const none = await request("PATCH", "/api/auth/me", { name: "Hacker" });
    assert.equal(none.status, 401);
    const bad = await request("PATCH", "/api/auth/me", { name: "Hacker" }, "not-a-real-token");
    assert.equal(bad.status, 401);

    const ghost = await helpers.createUser("customer");
    await User.deleteOne({ _id: ghost.id });
    const deleted = await patchMe(ghost, { name: "Ghost" });
    assert.equal(deleted.status, 401);

    assert.equal(await nameInDb(customer), before);
    assert.equal(await User.findOne({ name: "Hacker" }), null);
    assert.equal(await User.findOne({ name: "Ghost" }), null);
  });
});

describe("PATCH /api/auth/me: only the logged-in user's own record", () => {
  it("changes only the caller; another user keeps their name", async () => {
    const alice = await helpers.createUser("customer");
    const bob = await helpers.createUser("customer");
    const bobBefore = await nameInDb(bob);
    await patchMe(alice, { name: "Alice Changed" });
    assert.equal(await nameInDb(alice), "Alice Changed");
    assert.equal(await nameInDb(bob), bobBefore);
  });

  it("an id in the body or in the address cannot point at someone else", async () => {
    const alice = await helpers.createUser("customer");
    const bob = await helpers.createUser("customer");
    const bobBefore = await nameInDb(bob);
    const aliceBefore = await nameInDb(alice);

    for (const body of [{ name: "Taken Over", _id: bob.id }, { name: "Taken Over", id: bob.id }, { name: "Taken Over", userId: bob.id }]) {
      const response = await patchMe(alice, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    const viaUrl = await request("PATCH", `/api/auth/me/${bob.id}`, { name: "Taken Over" }, alice.token);
    assert.equal(viaUrl.status, 404);
    const viaQuery = await request("PATCH", `/api/auth/me?id=${bob.id}`, { name: "Query Takeover" }, alice.token);
    assert.equal(viaQuery.status, 200);
    assert.equal(viaQuery.body.user._id, alice.id);

    assert.equal(await nameInDb(bob), bobBefore);
    assert.equal(await nameInDb(alice), "Query Takeover");
    assert.notEqual(aliceBefore, "Query Takeover");
  });

  it("a customer cannot use their token to rename an admin", async () => {
    const customer = await helpers.createUser("customer");
    const admin = await helpers.createUser("admin");
    const adminBefore = await nameInDb(admin);
    const response = await patchMe(customer, { name: "Renamed Admin", _id: admin.id });
    assert.equal(response.status, 400);
    assert.equal(await nameInDb(admin), adminBefore);
  });
});

describe("PATCH /api/auth/me: nothing but the name can change", () => {
  const forbidden = [
    { email: "stolen@example.test" },
    { role: "admin" },
    { password: "NewPassword-123" },
    { _id: "000000000000000000000000" },
    { createdAt: "2000-01-01T00:00:00.000Z" },
    { isAdmin: true },
    { __proto__: { role: "admin" }, constructor: "x" },
  ];

  it("refuses any extra field next to the name and changes nothing", async () => {
    for (const extra of forbidden) {
      const customer = await helpers.createUser("customer");
      const before = await User.findById(customer.id).lean();
      const response = await patchMe(customer, { name: "Sneaky", ...extra });
      assert.equal(response.status, 400, JSON.stringify(extra));
      assert.match(response.body.message, /Only the name/);
      assert.deepEqual(await User.findById(customer.id).lean(), before, `unchanged after ${JSON.stringify(extra)}`);
    }
  });

  it("refuses a body that does not contain the name at all", async () => {
    const customer = await helpers.createUser("customer");
    const before = await User.findById(customer.id).lean();
    for (const body of [{ email: "a@b.co" }, { role: "admin" }, { password: "NewPassword-123" }, {}]) {
      const response = await patchMe(customer, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(await User.findById(customer.id).lean(), before);
  });

  it("a customer cannot make themselves admin, and the password hash and email stay the same", async () => {
    const customer = await helpers.createUser("customer");
    const before = await User.findById(customer.id).lean();
    await patchMe(customer, { name: "Fine Name", role: "admin", password: "x" });
    await patchMe(customer, { name: "Fine Name" });
    const after = await User.findById(customer.id).lean();
    assert.equal(after.role, "customer");
    assert.equal(after.email, before.email);
    assert.equal(after.password, before.password);
    assert.equal(after.name, "Fine Name");
  });

  it("the answer never contains the password", async () => {
    const customer = await helpers.createUser("customer");
    const response = await patchMe(customer, { name: "No Secrets" });
    const text = JSON.stringify(response.body);
    assert.equal(Object.hasOwn(response.body.user, "password"), false);
    assert.equal(text.includes("$2"), false, "no bcrypt hash anywhere in the answer");
    assert.equal(text.includes("__v"), false);
  });

  it("login, token and password keep working after a name change", async () => {
    const customer = await helpers.createUser("customer");
    await patchMe(customer, { name: "Still Me" });
    const login = await request("POST", "/api/auth/login", { email: customer.user.email, password: "Test-password-123" });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.name, "Still Me");
    const me = await request("GET", "/api/auth/me", undefined, customer.token);
    assert.equal(me.status, 200);
  });
});

describe("PATCH /api/auth/me: name rules", () => {
  it("trims the name", async () => {
    const customer = await helpers.createUser("customer");
    const response = await patchMe(customer, { name: "   Padded Name \t " });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.name, "Padded Name");
    assert.equal(await nameInDb(customer), "Padded Name");
  });

  it("refuses empty, blank and non-text names, and changes nothing", async () => {
    const customer = await helpers.createUser("customer");
    const before = await nameInDb(customer);
    for (const name of ["", " ", "   ", "\t\n", undefined, null, 0, 12, true, false, [], ["Ali"], {}, { $gt: "" }]) {
      const response = await patchMe(customer, name === undefined ? {} : { name });
      assert.equal(response.status, 400, `name = ${JSON.stringify(name)}`);
      assert.match(response.body.message, /Name is required/);
    }
    assert.equal(await nameInDb(customer), before);
  });

  it("refuses a body that is not an object", async () => {
    const customer = await helpers.createUser("customer");
    const before = await nameInDb(customer);
    for (const body of ["Ali", 5, ["Ali"], null]) {
      const response = await patchMe(customer, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(await nameInDb(customer), before);
  });

  it("refuses broken JSON with a 400", async () => {
    const customer = await helpers.createUser("customer");
    const response = await fetch(`${server.baseUrl}/api/auth/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${customer.token}` },
      body: "{ name: ",
    });
    assert.equal(response.status, 400);
  });

  it("allows exactly 100 characters and refuses 101", async () => {
    const customer = await helpers.createUser("customer");
    const ok = await patchMe(customer, { name: "a".repeat(100) });
    assert.equal(ok.status, 200);
    const tooLong = await patchMe(customer, { name: "a".repeat(101) });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.message, /at most 100/);
    assert.equal(await nameInDb(customer), "a".repeat(100));
    const paddedButShort = await patchMe(customer, { name: ` ${"b".repeat(100)} ` });
    assert.equal(paddedButShort.status, 200, "spaces around the name are trimmed before counting");
  });

  it("refuses control characters, line separators and direction overrides", async () => {
    const customer = await helpers.createUser("customer");
    const before = await nameInDb(customer);
    for (const codePoint of [0x0000, 0x0007, 0x0009, 0x000a, 0x000d, 0x001b, 0x007f, 0x0085, 0x009f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069]) {
      const response = await patchMe(customer, { name: `Ali${char(codePoint)}Khan` });
      assert.equal(response.status, 400, `U+${codePoint.toString(16)}`);
      assert.match(response.body.message, /invalid characters/);
    }
    assert.equal(await nameInDb(customer), before);
  });

  it("accepts ordinary names in other scripts, with joiners and emoji", async () => {
    const customer = await helpers.createUser("customer");
    for (const name of ["علی خان", `علی${char(0x200c)}خان`, "Zoë O'Brien-Smith", "李小龍", `Happy ${char(0x1f600)} Person`]) {
      const response = await patchMe(customer, { name });
      assert.equal(response.status, 200, name);
      assert.equal(await nameInDb(customer), name);
    }
  });

  it("is safe against HTML in the name (stored as plain text)", async () => {
    const customer = await helpers.createUser("customer");
    const response = await patchMe(customer, { name: "<script>alert(1)</script>" });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.name, "<script>alert(1)</script>");
  });
});

describe("PATCH /api/auth/me: old orders keep the name they were placed with", () => {
  it("the order snapshot, the customer's view and the admin's view do not change", async () => {
    const customer = await helpers.createUser("customer");
    const admin = await helpers.createUser("admin");
    const oldName = customer.user.name;
    const order = await helpers.insertOrder(customer, [{ product, quantity: 1 }]);

    await patchMe(customer, { name: "Brand New Name" });

    const stored = await Order.findById(order._id);
    assert.equal(stored.customer.name, oldName);
    assert.equal(stored.customer.email, customer.user.email);

    const mine = await request("GET", `/api/orders/${order._id}`, undefined, customer.token);
    assert.equal(mine.body.order.customer.name, oldName);
    const adminView = await request("GET", `/api/admin/orders/${order._id}`, undefined, admin.token);
    assert.equal(adminView.body.order.customer.name, oldName);
  });

  it("a new order after the change uses the new name", async () => {
    const customer = await helpers.createUser("customer");
    await patchMe(customer, { name: "Newer Name" });
    const me = await request("GET", "/api/auth/me", undefined, customer.token);
    assert.equal(me.body.user.name, "Newer Name");
  });
});

describe("Existing auth behaviour is unchanged", () => {
  it("signup and login still work and GET /me still returns the user", async () => {
    const email = `${helpers.runTag}-signup-check@example.test`;
    const signup = await request("POST", "/api/auth/signup", { name: "New Person", email, password: "Secret-123" });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.user.role, "customer");
    assert.equal(Object.hasOwn(signup.body.user, "password"), false);
    const login = await request("POST", "/api/auth/login", { email, password: "Secret-123" });
    assert.equal(login.status, 200);
    const me = await request("GET", "/api/auth/me", undefined, login.body.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, email);
    const noToken = await request("GET", "/api/auth/me");
    assert.equal(noToken.status, 401);
  });
});
