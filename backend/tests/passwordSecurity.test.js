const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const User = require("../src/models/User");
const rateLimiter = require("../src/middleware/rateLimiter");
const { createAttemptLimiter, loginLimiter, changePasswordLimiter, clock } = rateLimiter;
const helpers = require("./helpers");

const OLD_PASSWORD = "Test-password-123"; // the password helpers.createUser gives every user
const NEW_PASSWORD = "Brand-new-pass-456";

let request;
let server;
let now; // the fake time of the limiter (milliseconds)
const realNow = clock.now;

before(async () => {
  await helpers.connectTestDatabase();
  server = await helpers.startServer();
  request = helpers.makeClient(server.baseUrl);
});

after(async () => {
  clock.now = realNow;
  loginLimiter.clear();
  changePasswordLimiter.clear();
  try {
    await helpers.cleanup();
  } finally {
    if (server) await server.close();
    await helpers.disconnect();
  }
});

// Every test starts with empty counters and a clock that only moves when the test says so
beforeEach(() => {
  now = 1_800_000_000_000;
  clock.now = () => now;
  loginLimiter.clear();
  changePasswordLimiter.clear();
});

const change = (person, body, token = person.token) => request("POST", "/api/auth/change-password", body, token);
const login = (email, password) => request("POST", "/api/auth/login", { email, password });
const me = (token) => request("GET", "/api/auth/me", undefined, token);
const rowOf = (person) => User.findById(person.id).lean();

// A token like the ones issued before this phase: no "tv" claim
const legacyToken = (person) => jwt.sign({ userId: person.id, role: person.user.role }, process.env.JWT_SECRET, { expiresIn: "1d" });
const tokenWith = (person, tv) => jwt.sign({ userId: person.id, role: person.user.role, tv }, process.env.JWT_SECRET, { expiresIn: "1d" });

describe("Change password: the happy path (customers and admins)", () => {
  for (const role of ["customer", "admin"]) {
    it(`a ${role} can change their password; the new one works and the old one does not`, async () => {
      const person = await helpers.createUser(role);
      const response = await change(person, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);
      assert.equal(response.body.user._id, person.id);
      assert.equal(response.body.user.role, role);
      assert.equal(typeof response.body.token, "string");

      assert.equal((await login(person.user.email, NEW_PASSWORD)).status, 200);
      assert.equal((await login(person.user.email, OLD_PASSWORD)).status, 401);

      const row = await rowOf(person);
      assert.ok(await bcrypt.compare(NEW_PASSWORD, row.password), "the database holds a hash of the new password");
      assert.notEqual(row.password, NEW_PASSWORD, "never stored as plain text");
      assert.equal(row.tokenVersion, 1);
    });
  }

  it("the old token is rejected afterwards, the fresh token works, on any protected route", async () => {
    const person = await helpers.createUser("customer");
    assert.equal((await me(person.token)).status, 200);

    const response = await change(person, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    const fresh = response.body.token;

    assert.equal((await me(person.token)).status, 401, "old token on /me");
    assert.equal((await request("GET", "/api/orders", undefined, person.token)).status, 401, "old token on /orders");
    assert.equal((await request("GET", "/api/cart", undefined, person.token)).status, 401, "old token on /cart");
    assert.equal((await me(fresh)).status, 200, "fresh token on /me");
    assert.equal((await request("GET", "/api/orders", undefined, fresh)).status, 200, "fresh token on /orders");
  });

  it("a second change with the fresh token works and retires the first fresh token", async () => {
    const person = await helpers.createUser("admin");
    const first = await change(person, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    const second = await change(person, { currentPassword: NEW_PASSWORD, newPassword: "Another-pass-789" }, first.body.token);
    assert.equal(second.status, 200);
    assert.equal((await me(first.body.token)).status, 401);
    assert.equal((await me(second.body.token)).status, 200);
    assert.equal((await rowOf(person)).tokenVersion, 2);
    assert.equal((await request("GET", "/api/admin/orders", undefined, second.body.token)).status, 200);
  });

  it("the answer never contains the password, its hash or the token version", async () => {
    const person = await helpers.createUser("customer");
    const response = await change(person, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    const text = JSON.stringify(response.body);
    assert.equal(Object.hasOwn(response.body.user, "password"), false);
    assert.equal(Object.hasOwn(response.body.user, "tokenVersion"), false);
    assert.equal(text.includes("$2"), false, "no bcrypt hash");
    assert.equal(text.includes(OLD_PASSWORD), false);
    assert.equal(text.includes(NEW_PASSWORD), false);
  });

  it("only the password and the token version change on the user", async () => {
    const person = await helpers.createUser("customer");
    const before = await rowOf(person);
    await change(person, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    const after = await rowOf(person);
    for (const key of ["_id", "name", "email", "role", "createdAt"]) assert.deepEqual(after[key], before[key], key);
    assert.notEqual(after.password, before.password);
  });
});

describe("Change password: refusals", () => {
  const unchanged = async (person, before) => assert.deepEqual(await rowOf(person), before);

  it("a wrong current password is refused with 400 (not 401), and nothing changes", async () => {
    const person = await helpers.createUser("customer");
    const before = await rowOf(person);
    const response = await change(person, { currentPassword: "Wrong-password-1", newPassword: NEW_PASSWORD });
    assert.equal(response.status, 400);
    assert.equal(response.body.message, "Current password is incorrect");
    await unchanged(person, before);
    assert.equal((await me(person.token)).status, 200, "the session is still valid");
    assert.equal((await login(person.user.email, OLD_PASSWORD)).status, 200);
  });

  it("the same new and current password is refused", async () => {
    const person = await helpers.createUser("customer");
    const before = await rowOf(person);
    const response = await change(person, { currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD });
    assert.equal(response.status, 400);
    assert.match(response.body.message, /must be different/);
    await unchanged(person, before);
    assert.equal((await me(person.token)).status, 200);
  });

  it("a weak or oddly sized new password is refused; 8 characters and 72 bytes are fine", async () => {
    const person = await helpers.createUser("customer");
    const before = await rowOf(person);
    for (const weak of ["", "a", "1234567", "short", "       "[0], "abcdefg"]) {
      const response = await change(person, { currentPassword: OLD_PASSWORD, newPassword: weak });
      assert.equal(response.status, 400, JSON.stringify(weak));
      assert.match(response.body.message, /New password is required|at least 8/);
    }
    for (const tooLong of ["a".repeat(73), "é".repeat(37)]) {
      // 73 one-byte characters, and 37 two-byte characters = 74 bytes
      const response = await change(person, { currentPassword: OLD_PASSWORD, newPassword: tooLong });
      assert.equal(response.status, 400);
      assert.match(response.body.message, /at most 72 bytes/);
    }
    await unchanged(person, before);

    const exactly8 = await change(person, { currentPassword: OLD_PASSWORD, newPassword: "abcdefgh" });
    assert.equal(exactly8.status, 200);
    const exactly72 = await change(person, { currentPassword: "abcdefgh", newPassword: "b".repeat(72) }, exactly8.body.token);
    assert.equal(exactly72.status, 200);
    assert.equal((await login(person.user.email, "b".repeat(72))).status, 200);
  });

  it("non-text passwords and missing fields are refused", async () => {
    const person = await helpers.createUser("customer");
    const before = await rowOf(person);
    const notText = [0, 12345678, null, true, false, [], ["Brand-new-pass"], {}, { $gt: "" }];
    for (const value of notText) {
      assert.equal((await change(person, { currentPassword: OLD_PASSWORD, newPassword: value })).status, 400, `newPassword ${JSON.stringify(value)}`);
      assert.equal((await change(person, { currentPassword: value, newPassword: NEW_PASSWORD })).status, 400, `currentPassword ${JSON.stringify(value)}`);
    }
    for (const body of [{}, { currentPassword: OLD_PASSWORD }, { newPassword: NEW_PASSWORD }, [], "text", 5, null]) {
      assert.equal((await change(person, body)).status, 400, JSON.stringify(body));
    }
    await unchanged(person, before);
  });

  it("extra fields are refused and nothing changes", async () => {
    const person = await helpers.createUser("customer");
    const before = await rowOf(person);
    const base = { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD };
    for (const extra of [{ role: "admin" }, { email: "stolen@example.test" }, { name: "Renamed" }, { _id: "000000000000000000000000" }, { tokenVersion: 99 }, { password: "x" }, { userId: person.id }]) {
      const response = await change(person, { ...base, ...extra });
      assert.equal(response.status, 400, JSON.stringify(extra));
      assert.match(response.body.message, /Only the current and the new password/);
    }
    await unchanged(person, before);
    assert.equal((await login(person.user.email, OLD_PASSWORD)).status, 200);
  });

  it("a request without a token or with a bad token is refused", async () => {
    const person = await helpers.createUser("customer");
    const before = await rowOf(person);
    const body = { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD };
    assert.equal((await request("POST", "/api/auth/change-password", body)).status, 401);
    assert.equal((await change(person, body, "not-a-token")).status, 401);
    await unchanged(person, before);
  });

  it("a deleted user's token cannot change anything", async () => {
    const ghost = await helpers.createUser("customer");
    await User.deleteOne({ _id: ghost.id });
    assert.equal((await change(ghost, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })).status, 401);
  });
});

describe("Change password: only the caller's own account", () => {
  it("another user's account is not touched, whatever the request says", async () => {
    const alice = await helpers.createUser("customer");
    const bob = await helpers.createUser("customer");
    const bobBefore = await rowOf(bob);

    // an id or e-mail pointing at bob is refused
    for (const extra of [{ _id: bob.id }, { userId: bob.id }, { email: bob.user.email }]) {
      const response = await change(alice, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, ...extra });
      assert.equal(response.status, 400);
    }
    // an id in the address is not used either
    const viaUrl = await request("POST", `/api/auth/change-password/${bob.id}`, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, alice.token);
    assert.equal(viaUrl.status, 404);
    // a normal change by alice changes alice only
    const ok = await change(alice, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(ok.status, 200);

    assert.deepEqual(await rowOf(bob), bobBefore);
    assert.equal((await login(bob.user.email, OLD_PASSWORD)).status, 200, "bob's password is unchanged");
    assert.equal((await me(bob.token)).status, 200, "bob's session is still valid");
    assert.equal((await login(alice.user.email, NEW_PASSWORD)).status, 200);
  });

  it("alice cannot use bob's password as her current password to take over bob", async () => {
    const alice = await helpers.createUser("customer");
    const bob = await helpers.createUser("customer");
    await User.updateOne({ _id: bob.id }, { $set: { password: await bcrypt.hash("Bobs-own-password-1", 4) } });
    const response = await change(alice, { currentPassword: "Bobs-own-password-1", newPassword: NEW_PASSWORD });
    assert.equal(response.status, 400);
    assert.equal((await login(bob.user.email, "Bobs-own-password-1")).status, 200);
  });
});

describe("Change password: two requests at the same moment", () => {
  it("only one of them can win, and the token version goes up exactly once", async () => {
    const person = await helpers.createUser("customer");
    const results = await Promise.all([
      change(person, { currentPassword: OLD_PASSWORD, newPassword: "First-new-password-1" }),
      change(person, { currentPassword: OLD_PASSWORD, newPassword: "Second-new-password-2" }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 200).length, 1, JSON.stringify(statuses));
    assert.ok(statuses.every((s) => [200, 401, 409].includes(s)), JSON.stringify(statuses));

    const row = await rowOf(person);
    assert.equal(row.tokenVersion, 1);
    const winner = results.find((r) => r.status === 200);
    assert.equal((await me(winner.body.token)).status, 200);
  });
});

describe("Token versions and older tokens", () => {
  it("new login and signup tokens carry the token version", async () => {
    const person = await helpers.createUser("customer");
    const loggedIn = await login(person.user.email, OLD_PASSWORD);
    assert.equal(jwt.decode(loggedIn.body.token).tv, 0);

    const email = `${helpers.runTag}-tv-signup@example.test`;
    const signup = await request("POST", "/api/auth/signup", { name: "Token Check", email, password: "Secret-123" });
    assert.equal(signup.status, 201);
    assert.equal(jwt.decode(signup.body.token).tv, 0);

    const changed = await change(person, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(jwt.decode(changed.body.token).tv, 1);
    assert.equal(jwt.decode((await login(person.user.email, NEW_PASSWORD)).body.token).tv, 1);
  });

  it("an older token WITHOUT a version still works while the user's version is 0", async () => {
    const person = await helpers.createUser("customer");
    const old = legacyToken(person);
    assert.equal(jwt.decode(old).tv, undefined);
    assert.equal((await me(old)).status, 200);
    assert.equal((await request("GET", "/api/orders", undefined, old)).status, 200);
  });

  it("a user stored without a tokenVersion field counts as version 0 for logins, tokens and a password change", async () => {
    const person = await helpers.createUser("customer");
    await User.collection.updateOne({ _id: person.user._id }, { $unset: { tokenVersion: "" } });
    assert.equal(Object.hasOwn(await rowOf(person), "tokenVersion"), false, "the field is really missing");

    const old = legacyToken(person);
    assert.equal((await me(old)).status, 200);
    assert.equal((await me(person.token)).status, 200);
    assert.equal((await login(person.user.email, OLD_PASSWORD)).status, 200);

    const changed = await change(person, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, old);
    assert.equal(changed.status, 200);
    assert.equal((await rowOf(person)).tokenVersion, 1, "the missing field became 1");
    assert.equal((await me(old)).status, 401, "the version-less token is retired");
    assert.equal((await me(changed.body.token)).status, 200);
  });

  it("an older token without a version is rejected once the user's version is above 0", async () => {
    const person = await helpers.createUser("customer");
    await User.updateOne({ _id: person.id }, { $set: { tokenVersion: 1 } });
    assert.equal((await me(legacyToken(person))).status, 401);
    assert.equal((await me(person.token)).status, 401, "the version-0 token from before");
  });

  it("a token whose version does not match is rejected; the matching one works", async () => {
    const person = await helpers.createUser("customer");
    await User.updateOne({ _id: person.id }, { $set: { tokenVersion: 3 } });
    assert.equal((await me(tokenWith(person, 3))).status, 200, "matching");
    for (const wrong of [0, 1, 2, 4, 99, -1, "3", null, 3.5, true, [3], {}]) {
      assert.equal((await me(tokenWith(person, wrong))).status, 401, `tv = ${JSON.stringify(wrong)}`);
    }
  });

  it("a token with a higher version than the user's is rejected too", async () => {
    const person = await helpers.createUser("customer");
    assert.equal((await me(tokenWith(person, 1))).status, 401);
  });

  it("a token signed with another secret is still rejected", async () => {
    const person = await helpers.createUser("customer");
    const forged = jwt.sign({ userId: person.id, role: "customer", tv: 0 }, "some-other-secret", { expiresIn: "1d" });
    assert.equal((await me(forged)).status, 401);
  });
});

describe("The attempt limiter (pure logic, fake clock)", () => {
  const makeLimiter = (options) => {
    let time = 1000;
    const limiter = createAttemptLimiter({ now: () => time, ...options });
    return { limiter, advance: (ms) => { time += ms; } };
  };

  it("blocks after exactly 10 failures, not before", () => {
    const { limiter } = makeLimiter();
    for (let i = 1; i <= 9; i++) {
      limiter.fail("k");
      assert.equal(limiter.check("k").blocked, false, `after ${i} failures`);
    }
    assert.equal(limiter.fail("k"), 10);
    const status = limiter.check("k");
    assert.equal(status.blocked, true);
    assert.equal(status.retryAfterSeconds, 900);
  });

  it("the block ends when the 15-minute window ends (the clock is controlled, nothing is awaited)", () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 0; i < 10; i++) limiter.fail("k");
    advance(15 * 60 * 1000 - 1);
    assert.equal(limiter.check("k").blocked, true);
    assert.equal(limiter.check("k").retryAfterSeconds, 1);
    advance(1);
    assert.equal(limiter.check("k").blocked, false);
    assert.equal(limiter.fail("k"), 1, "a new window starts from zero");
  });

  it("the window starts at the first failure and later failures do not extend it", () => {
    const { limiter, advance } = makeLimiter();
    limiter.fail("k");
    advance(10 * 60 * 1000);
    for (let i = 0; i < 9; i++) limiter.fail("k");
    assert.equal(limiter.check("k").blocked, true);
    assert.equal(limiter.check("k").retryAfterSeconds, 300);
  });

  it("reset forgets the failures; keys are independent", () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 10; i++) limiter.fail("a");
    limiter.fail("b");
    assert.equal(limiter.check("a").blocked, true);
    assert.equal(limiter.check("b").blocked, false);
    limiter.reset("a");
    assert.equal(limiter.check("a").blocked, false);
    assert.equal(limiter.fail("a"), 1);
  });

  it("memory stays bounded when many keys are invented", () => {
    const { limiter } = makeLimiter({ maxEntries: 50 });
    for (let i = 0; i < 500; i++) limiter.fail(`key-${i}`);
    assert.ok(limiter.size() <= 50, `size ${limiter.size()}`);
    const { limiter: other, advance } = makeLimiter({ maxEntries: 5 });
    for (let i = 0; i < 5; i++) other.fail(`k${i}`);
    advance(15 * 60 * 1000);
    other.fail("fresh");
    assert.equal(other.size(), 1, "expired entries are swept first");
  });

  it("the limit and window can be configured", () => {
    const { limiter, advance } = makeLimiter({ maxAttempts: 2, windowMs: 1000 });
    limiter.fail("k");
    assert.equal(limiter.check("k").blocked, false);
    limiter.fail("k");
    assert.equal(limiter.check("k").blocked, true);
    advance(1000);
    assert.equal(limiter.check("k").blocked, false);
  });
});

describe("Login is limited after 10 failed attempts", () => {
  const FIFTEEN_MINUTES = 15 * 60 * 1000;

  it("10 wrong passwords answer 401, the 11th answers 429, even with the right password", async () => {
    const person = await helpers.createUser("customer");
    for (let i = 1; i <= 10; i++) {
      assert.equal((await login(person.user.email, "Wrong-password-" + i)).status, 401, `attempt ${i}`);
    }
    const blocked = await login(person.user.email, "Wrong-password-11");
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.message, /Too many failed attempts/);

    const rightButBlocked = await login(person.user.email, OLD_PASSWORD);
    assert.equal(rightButBlocked.status, 429, "the right password does not help during the block");
    assert.equal(Object.hasOwn(rightButBlocked.body, "token"), false);
  });

  it("the 429 answer has a Retry-After header", async () => {
    const person = await helpers.createUser("customer");
    for (let i = 0; i < 10; i++) await login(person.user.email, "Wrong-password-x");
    const response = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: person.user.email, password: OLD_PASSWORD }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), String(15 * 60));
  });

  it("the block ends after 15 minutes (fake clock)", async () => {
    const person = await helpers.createUser("customer");
    for (let i = 0; i < 10; i++) await login(person.user.email, "Wrong-password-x");
    assert.equal((await login(person.user.email, OLD_PASSWORD)).status, 429);
    now += FIFTEEN_MINUTES - 1000;
    assert.equal((await login(person.user.email, OLD_PASSWORD)).status, 429);
    now += 1000;
    assert.equal((await login(person.user.email, OLD_PASSWORD)).status, 200);
  });

  it("a successful login resets the counter", async () => {
    const person = await helpers.createUser("customer");
    for (let i = 0; i < 9; i++) await login(person.user.email, "Wrong-password-x");
    assert.equal((await login(person.user.email, OLD_PASSWORD)).status, 200);
    for (let i = 1; i <= 10; i++) {
      assert.equal((await login(person.user.email, "Wrong-password-y")).status, 401, `attempt ${i} after the reset`);
    }
    assert.equal((await login(person.user.email, "Wrong-password-y")).status, 429);
  });

  it("someone else's e-mail is not affected, and capital letters in the e-mail count as the same e-mail", async () => {
    const alice = await helpers.createUser("customer");
    const bob = await helpers.createUser("customer");
    for (let i = 0; i < 10; i++) await login(alice.user.email.toUpperCase(), "Wrong-password-x");
    assert.equal((await login(alice.user.email, OLD_PASSWORD)).status, 429, "same e-mail in other letters");
    assert.equal((await login(`  ${alice.user.email}  `, OLD_PASSWORD)).status, 429, "spaces around it");
    assert.equal((await login(bob.user.email, OLD_PASSWORD)).status, 200, "another account");
  });

  it("an e-mail that does not exist is limited too (no way to tell accounts apart)", async () => {
    const ghost = `${helpers.runTag}-nobody@example.test`;
    for (let i = 0; i < 10; i++) assert.equal((await login(ghost, "Wrong-password-x")).status, 401);
    assert.equal((await login(ghost, "Wrong-password-x")).status, 429);
  });

  it("badly formed login requests do not use up attempts", async () => {
    const person = await helpers.createUser("customer");
    for (let i = 0; i < 12; i++) {
      assert.equal((await request("POST", "/api/auth/login", { email: person.user.email })).status, 400);
    }
    assert.equal((await login(person.user.email, OLD_PASSWORD)).status, 200);
  });

  it("an admin is limited in the same way", async () => {
    const admin = await helpers.createUser("admin");
    for (let i = 0; i < 10; i++) await login(admin.user.email, "Wrong-password-x");
    assert.equal((await login(admin.user.email, OLD_PASSWORD)).status, 429);
    now += FIFTEEN_MINUTES;
    assert.equal((await login(admin.user.email, OLD_PASSWORD)).status, 200);
  });
});

describe("Change password is limited after 10 wrong current passwords", () => {
  for (const role of ["customer", "admin"]) {
    it(`a ${role}: 10 wrong guesses answer 400, then 429 even with the right current password`, async () => {
      const person = await helpers.createUser(role);
      const body = (current) => ({ currentPassword: current, newPassword: NEW_PASSWORD });
      for (let i = 1; i <= 10; i++) {
        assert.equal((await change(person, body("Wrong-guess-" + i))).status, 400, `guess ${i}`);
      }
      const blocked = await change(person, body(OLD_PASSWORD));
      assert.equal(blocked.status, 429);
      assert.match(blocked.body.message, /Too many failed attempts/);
      assert.equal((await login(person.user.email, NEW_PASSWORD)).status, 401, "the password was NOT changed");

      now += 15 * 60 * 1000;
      assert.equal((await change(person, body(OLD_PASSWORD))).status, 200);
    });
  }

  it("a successful change resets the counter", async () => {
    const person = await helpers.createUser("customer");
    for (let i = 0; i < 9; i++) await change(person, { currentPassword: "Wrong-guess-x", newPassword: NEW_PASSWORD });
    const ok = await change(person, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(ok.status, 200);
    for (let i = 1; i <= 10; i++) {
      assert.equal((await change(person, { currentPassword: "Wrong-guess-y", newPassword: "Other-new-pass-1" }, ok.body.token)).status, 400, `guess ${i} after the reset`);
    }
    assert.equal((await change(person, { currentPassword: NEW_PASSWORD, newPassword: "Other-new-pass-1" }, ok.body.token)).status, 429);
  });

  it("malformed or same-password requests do not count, and login and change-password count separately", async () => {
    const person = await helpers.createUser("customer");
    for (let i = 0; i < 12; i++) {
      await change(person, { currentPassword: OLD_PASSWORD, newPassword: "short" });
      await change(person, { currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD });
    }
    for (let i = 0; i < 10; i++) await login(person.user.email, "Wrong-password-x");
    assert.equal((await login(person.user.email, OLD_PASSWORD)).status, 429, "login is blocked");
    assert.equal((await change(person, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })).status, 200, "change-password is not");
  });
});
