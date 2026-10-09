const crypto = require("node:crypto");
const { it } = require("node:test");
const { backendRequire, connectRunDatabase, readRunSettings } = require("./db");
const { findBrowser, launchBrowser } = require("./browser");
const { createPage } = require("./page");
const { redact } = require("./guard");
const { scaled } = require("./timeouts");

// Everything a browser suite needs, in one object.
//
//   let S;                                                       // set in before()
//   before(async () => { S = await startSuite("step4Details"); });
//   section(() => S, "A. access", async () => { S.check("name of the check", condition); });
//   after(async () => { await S.finish(); });
//
// What startSuite does: reads the run's settings (and refuses to continue if any safety rule
// fails), connects to the run's own database, starts a browser with a temporary profile, and
// creates a tag that makes all of this suite's data recognizable.
const startSuite = async (name) => {
  const settings = readRunSettings();
  const mongoose = await connectRunDatabase(settings);
  const models = {
    User: backendRequire("./src/models/User.js"),
    Category: backendRequire("./src/models/Category.js"),
    Product: backendRequire("./src/models/Product.js"),
    Cart: backendRequire("./src/models/Cart.js"),
    Order: backendRequire("./src/models/Order.js"),
  };
  const bcrypt = backendRequire("bcrypt");
  const { generateOrderNumber } = backendRequire("./src/utils/generateOrderNumber.js");

  const browserPath = findBrowser({ ...process.env, E2E_BROWSER: settings.browserPath });
  const browser = await launchBrowser({ browserPath, runDir: settings.runDir });
  const page = await createPage(browser.cdp, {
    appUrl: settings.appUrl,
    apiUrl: settings.apiUrl,
    artifactsDir: settings.artifactsDir,
    suiteName: name,
  });
  await page.viewport(1280, 900);

  // Marks everything this suite creates. It is part of every e-mail address and name.
  const tag = `ZZE2E${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  // A new random password for the accounts of this run (never printed, never reused)
  const password = `Pw-${crypto.randomBytes(9).toString("base64url")}-9`;
  const users = {};

  // S inherits from the page helpers (so S.interceptor = ... and S.apiCalls reach the page itself)
  const S = Object.assign(Object.create(page), {
    name,
    settings,
    mongoose,
    models,
    tag,
    password,
    users,
    passed: 0,
    failures: [],

    // ---- test data --------------------------------------------------------
    emailOf: (who) => `${tag}.${who}@example.com`.toLowerCase(),

    newUser: async (who, role = "customer") => {
      users[who] = await models.User.create({
        name: `${who} tester`,
        email: S.emailOf(who),
        password: await bcrypt.hash(password, 4), // low cost = fast tests
        role,
      });
      return users[who];
    },

    // Inserts a valid order straight into the database. lines: [[product, quantity], ...]
    insertOrder: (user, lines, overrides = {}) => {
      const items = lines.map(([product, quantity]) => ({
        product: product._id,
        name: product.name,
        imageUrl: "",
        price: product.price,
        quantity,
        lineTotal: Math.round(product.price * quantity * 100) / 100,
      }));
      const subtotal = Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) / 100;
      return models.Order.create({
        orderNumber: generateOrderNumber(),
        user: user._id,
        customer: { name: user.name, email: user.email },
        items,
        delivery: { fullName: "Private Person", phone: "+92 345 5550199", addressLine1: "PRIVATE-STREET-77", addressLine2: "", city: "Lahore", postalCode: "54000", notes: "" },
        paymentMethod: "cod",
        subtotal,
        shippingFee: 0,
        total: subtotal,
        statusHistory: [{ status: "pending", changedAt: new Date(), changedBy: user._id }],
        ...overrides,
      });
    },

    // ---- logging in through the real page ---------------------------------
    uiLogin: async (who) => {
      await S.goto(`${S.appUrl}/login`);
      await S.setValue("#email", S.emailOf(who));
      await S.setValue("#password", password);
      await S.click("button[type=submit]");
      await S.waitFor("location.pathname !== '/login' && !!document.querySelector('.navbar-user')", `login of ${who}`);
    },
    uiLogout: async () => {
      await S.clickByText(".navbar-links button", "Logout");
      await S.waitFor("!document.querySelector('.navbar-user')", "logout");
    },

    // ---- checks -----------------------------------------------------------
    // A check does not stop the section when it fails: every check of the section is reported.
    check: (label, condition, detail = "") => {
      if (condition) {
        S.passed += 1;
      } else {
        S.failures.push(`${label}${detail ? `  -> ${String(detail).slice(0, 400)}` : ""}`);
      }
    },

    // Removes everything this suite created (only documents that carry this suite's tag).
    // The runner also drops the whole run database afterwards; this keeps a suite tidy on its own.
    removeOwnData: async () => {
      const mark = new RegExp(`^${tag}`, "i");
      const owners = await models.User.find({ email: new RegExp(`^${tag.toLowerCase()}\\.`) }).select("_id");
      const ownerIds = owners.map((owner) => owner._id);
      await models.Order.deleteMany({ user: { $in: ownerIds } });
      await models.Cart.deleteMany({ user: { $in: ownerIds } });
      await models.Product.deleteMany({ name: mark });
      await models.Category.deleteMany({ name: mark });
      await models.User.deleteMany({ _id: { $in: ownerIds } });
    },

    // Closes the browser and the database connection. Safe to call when something went wrong.
    finish: async () => {
      const problems = [];
      try { await S.removeOwnData(); } catch (error) { problems.push(`data cleanup: ${error.message}`); }
      try { await browser.close(); } catch (error) { problems.push(`browser: ${error.message}`); }
      try { await mongoose.disconnect(); } catch (error) { problems.push(`database: ${error.message}`); }
      const safeProblems = redact(problems.join("; "), [settings.mongoUri]);
      console.log(`[${name}] ${S.passed} checks passed, ${S.failures.length} failed${problems.length ? `; cleanup problems: ${safeProblems}` : ""}`);
      if (problems.length) throw new Error(`Cleanup problems: ${safeProblems}`);
    },
  });
  return S;
};

// One part of a suite. Parts run in order and share the browser and the data.
// If any check of the part fails, the part fails and lists them.
// (A section that is still running after 3 minutes is stopped and reported as failed, so nothing can hang forever.)
const section = (S, title, body) =>
  it(title, { timeout: scaled(180000) }, async () => {
    const before = S().failures.length;
    await body();
    const failed = S().failures.slice(before);
    if (failed.length > 0) {
      throw new Error(`${failed.length} check(s) failed:\n  - ${failed.join("\n  - ")}`);
    }
  });

module.exports = { startSuite, section };
