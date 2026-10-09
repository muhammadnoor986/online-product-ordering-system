// The admin edit-product form must never bring back stock that was sold while the form was open
// (the original "stale form" bug), must refuse a stock change made from outdated numbers, and must
// still work on current data. Adding a product still takes its initial stock.
// (Moved into the repository from the old scratch folder, where it was "staleFormE2E".)
//
// Run it with:  npm run test:e2e -- staleFormE2E
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");

describe("stale admin product form", () => {
  let S;
  const sec = (title, body) => section(() => S, title, body);

  let category;
  let product;

  before(async () => {
    S = await startSuite("staleFormE2E");
    await S.newUser("admin", "admin");
    category = await S.models.Category.create({ name: `${S.tag} Cat` });
    product = await S.models.Product.create({ name: `${S.tag} Widget`, description: "d", price: 100, stock: 10, category: category._id });
  });

  after(async () => {
    if (S) await S.finish();
  });

  // ---- helpers of this suite -------------------------------------------------------
  const rowSelector = ".admin-table tbody tr";
  const rowButton = (name, label) =>
    S.js(`(()=>{const row=[...document.querySelectorAll(${JSON.stringify(rowSelector)})].find(r=>r.querySelector('.admin-cell-name')?.textContent.trim()===${JSON.stringify(name)});if(!row)throw new Error('no row '+${JSON.stringify(name)});const btn=[...row.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!btn)throw new Error('no button '+${JSON.stringify(label)});btn.click();return true;})()`);
  const rowText = (name) =>
    S.js(`(()=>{const row=[...document.querySelectorAll(${JSON.stringify(rowSelector)})].find(r=>r.querySelector('.admin-cell-name')?.textContent.trim()===${JSON.stringify(name)});return row?row.innerText:null})()`);
  const dbProduct = () => S.models.Product.findById(product._id);
  const name = () => `${S.tag} Widget`;
  const openForm = async () => {
    await rowButton(name(), "Edit");
    await S.waitFor("!!document.querySelector('.admin-form')", "the edit form");
  };
  const submit = () => S.click(".admin-form button[type=submit]");

  // Waiting for the products list to be (re)loaded: first for the page's NEW request to the list, then for the table to be
  // there and stop loading, and a moment later once more to see that it stayed so.
  const listCalls = () => S.apiCalls.filter((call) => /^GET .*\/api\/products\?/.test(call)).length;
  let seenCalls = 0;
  const waitList = async (label) => {
    const startedAt = Date.now();
    while (listCalls() <= seenCalls) {
      if (Date.now() - startedAt > 10000) throw new Error(`the page did not ask the server for the list (${label})`);
      await S.sleep(50);
    }
    const condition = "!!document.querySelector('.admin-table') && !/Loading products/.test(document.body.innerText)";
    await S.waitFor(condition, label);
    await S.sleep(100);
    await S.waitFor(condition, `${label} (and staying)`);
    seenCalls = listCalls();
  };

  // ---- the scenarios ---------------------------------------------------------------
  sec("0. admin login and the product list", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.js("localStorage.clear()");
    await S.uiLogin("admin");
    S.check("the admin is logged in (name link goes to the profile)", (await S.userLink()).href === "/profile");
    S.resetCalls();
    seenCalls = 0;
    // The page must be completely loaded before the test changes data behind its back
    await S.gotoSettled(`${S.appUrl}/admin/products`);
    await S.waitFor("!!document.querySelector('.admin-search')", "the products page");
    seenCalls = listCalls();
    await S.setValue("#admin-search", S.tag);
    await S.clickByText(".admin-search button", "Search");
    await waitList("the search result");
    S.check("the product is in the list", (await rowText(name())) !== null);
  });

  sec("1. price-only edit while a customer bought stock (the original bug)", async () => {
    await openForm();
    S.check("the form was opened showing stock 10", (await S.js(`${S.q("#product-stock")}.value`)) === "10");
    await S.models.Product.updateOne({ _id: product._id }, { $inc: { stock: -4 } }); // a customer buys 4 while the form is open
    await S.setValue("#product-price", "150");
    await submit();
    await S.waitFor("document.body.innerText.includes('was updated')", "the saved notice");
    S.check("the price edit was saved", (await dbProduct()).price === 150);
    const stock = (await dbProduct()).stock;
    S.check("stock stayed at 6 (the 4 sold units were NOT brought back)", stock === 6, `stock is ${stock}`);
  });

  sec("2. stock edited from a stale form", async () => {
    await waitList("the list after the save");
    await openForm();
    S.check("form shows the real stock 6", (await S.js(`${S.q("#product-stock")}.value`)) === "6");
    await S.models.Product.updateOne({ _id: product._id }, { $inc: { stock: -2 } }); // another sale: real stock 4
    await S.setValue("#product-stock", "20");
    await S.setValue("#product-price", "175");
    await submit();
    await S.waitFor("!!document.querySelector('.admin-form .status-error')", "the stale-data error");
    const message = await S.js("document.querySelector('.admin-form .status-error').textContent");
    S.check("the form shows a clear message including the real stock", /stock changed/i.test(message) && /now 4/.test(message), message);
    S.check("the form stays open so nothing typed is lost", (await S.has(".admin-form")) && (await S.js(`${S.q("#product-stock")}.value`)) === "20");
    const afterRefused = await dbProduct();
    S.check("nothing was saved: stock still 4 and price still 150", afterRefused.stock === 4 && afterRefused.price === 150, JSON.stringify({ s: afterRefused.stock, p: afterRefused.price }));
    // (the page refreshes the list behind the form after the refusal: wait for it instead of a fixed pause)
    await S.waitFor(
      `[...document.querySelectorAll('.admin-table tbody tr')].some(r=>r.querySelector('.admin-cell-name')?.textContent.trim()===${JSON.stringify(name())} && /\\b4\\b/.test(r.innerText))`,
      "the list behind the form to show the real stock 4"
    );
    S.check("the list behind the form refreshed to the real numbers (stock 4)", /\b4\b/.test(await rowText(name())), await rowText(name()));
  });

  sec("3. reopening the form shows the real stock and a change then works", async () => {
    await S.clickByText(".admin-form button", "Cancel");
    await openForm();
    S.check("reopened form shows stock 4", (await S.js(`${S.q("#product-stock")}.value`)) === "4");
    await S.setValue("#product-stock", "12");
    await submit();
    await S.waitFor("document.body.innerText.includes('was updated')", "the saved notice");
    S.check("an intentional stock change on current data is saved (4 -> 12)", (await dbProduct()).stock === 12);
  });

  sec("4. adding a product still takes the initial stock", async () => {
    await waitList("the list after the save");
    await S.clickByText("button", "Add Product");
    await S.waitFor("!!document.querySelector('.admin-form')", "the add form");
    await S.setValue("#product-name", `${S.tag} Brand New`);
    await S.setValue("#product-description", "new");
    await S.setValue("#product-price", "10");
    await S.setValue("#product-stock", "25");
    await S.setValue("#product-category", String(category._id));
    await submit();
    await S.waitFor("document.body.innerText.includes('was created')", "the created notice");
    const created = await S.models.Product.findOne({ name: `${S.tag} Brand New` });
    S.check("new product has stock 25", !!created && created.stock === 25);
  });

  sec("whole-run checks", async () => {
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
    S.check("the browser console stayed clean (no errors, warnings or exceptions)", S.consoleProblems.length === 0, S.consoleProblems.slice(0, 3).join(" | "));
  });
});
