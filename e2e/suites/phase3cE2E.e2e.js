// The admin product and category screens (/admin/products, /admin/categories): who may open them, the
// lists (paging, search, inactive products), adding / editing / deleting categories, adding / editing /
// deactivating / reactivating products, form errors, server failures, other pages still working, and
// four screen widths.
// (Moved into the repository from the old scratch folder, where it was "phase3cE2E".)
//
// Run it with:  npm run test:e2e -- phase3cE2E
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");
const { startImageServer } = require("../lib/imageServer");

describe("admin products and categories", () => {
  let S;
  let images;
  const sec = (title, body) => section(() => S, title, body);

  // Data of this suite
  let catA;
  let catB;
  let catC;
  let brandNew;
  const DASH = String.fromCharCode(8212); // the dash the page shows for an empty description

  before(async () => {
    S = await startSuite("phase3cE2E");
    images = await startImageServer();
    await S.newUser("admin", "admin");
    await S.newUser("customer");
  });

  after(async () => {
    try {
      if (S) await S.finish();
    } finally {
      if (images) await images.close();
    }
  });

  // ---- helpers of this suite -------------------------------------------------------
  const rowSelector = ".admin-table tbody tr";
  const rowButton = (name, label) =>
    S.js(`(()=>{const row=[...document.querySelectorAll(${JSON.stringify(rowSelector)})].find(r=>r.querySelector('.admin-cell-name')?.textContent.trim()===${JSON.stringify(name)});if(!row)throw new Error('no row '+${JSON.stringify(name)});const btn=[...row.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!btn)throw new Error('no button '+${JSON.stringify(label)});btn.click();return true;})()`);
  const rowText = (name) =>
    S.js(`(()=>{const row=[...document.querySelectorAll(${JSON.stringify(rowSelector)})].find(r=>r.querySelector('.admin-cell-name')?.textContent.trim()===${JSON.stringify(name)});return row?row.innerText:null})()`);
  const rowCount = () => S.js(`document.querySelectorAll(${JSON.stringify(rowSelector)}).length`);
  const noLoading = "!/Loading (products|categories)/.test(document.body.innerText)";
  const stubConfirm = (answer) => S.js(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(m); return ${answer}; }; true`);
  const confirms = () => S.js("window.__confirms");
  const waitConfirms = (n) => S.waitFor(`window.__confirms.length >= ${n}`, `${n} confirmation question(s)`);
  const fillProduct = async (v) => {
    if (v.name !== undefined) await S.setValue("#product-name", v.name);
    if (v.description !== undefined) await S.setValue("#product-description", v.description);
    if (v.price !== undefined) await S.setValue("#product-price", v.price);
    if (v.stock !== undefined) await S.setValue("#product-stock", v.stock);
    if (v.imageUrl !== undefined) await S.setValue("#product-imageUrl", v.imageUrl);
    if (v.category !== undefined) await S.setValue("#product-category", v.category);
  };
  const submitForm = () => S.click(".admin-form button[type=submit]");
  const publicProducts = async (search) => (await (await fetch(`${S.apiUrl}/products?search=${encodeURIComponent(search)}`)).json()).products;

  // Waiting for a list to be (re)loaded: first for the page's NEW request to the list, then for the table to be
  // there and stop loading, and a moment later once more to see that it stayed so. (Looking only at the table could
  // be fooled by the OLD list, which is still on the screen while the new one is on its way.)
  const listCalls = (kind) =>
    S.apiCalls.filter((call) => (kind === "products" ? /^GET .*\/api\/products\?/.test(call) : /^GET .*\/api\/categories(\?|$)/.test(call))).length;
  const seen = { products: 0, categories: 0 };
  const markSeen = (kind) => { seen[kind] = listCalls(kind); };
  const forgetCalls = () => { S.resetCalls(); seen.products = 0; seen.categories = 0; };
  const waitList = async (kind, label) => {
    const startedAt = Date.now();
    while (listCalls(kind) <= seen[kind]) {
      if (Date.now() - startedAt > 10000) throw new Error(`the page did not ask the server for the ${kind} list (${label || "list"})`);
      await S.sleep(50);
    }
    const condition = `!!document.querySelector('.admin-table') && ${noLoading}`;
    await S.waitFor(condition, label || `the ${kind} table`);
    await S.sleep(100);
    await S.waitFor(condition, `${label || `the ${kind} table`} (and staying)`);
    markSeen(kind);
  };
  const openProducts = async () => {
    await S.goto(`${S.appUrl}/admin/products`);
    await waitList("products", "the products table");
  };
  const searchProducts = async (text) => {
    await S.setValue("#admin-search", text);
    await S.clickByText(".admin-search button", "Search");
    await waitList("products", `the search for "${text}"`);
  };

  // Where a page ends up after the app has finished redirecting
  const redirectedTo = async (target, expected) => {
    await S.goto(`${S.appUrl}${target}`);
    try {
      await S.settleAt(expected);
    } catch (error) { /* the page stayed where it was: the check below reports the address */ }
    return S.url();
  };
  const adminLinks = async () => (await S.navbarLinks()).filter((link) => (link.href || "").startsWith("/admin"));
  const linkTo = async (href) => (await S.navbarLinks()).find((link) => link.href === href);

  // ---- A -------------------------------------------------------------------------
  sec("A. who may open the admin pages", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.js("localStorage.clear()");
    S.check("anonymous visiting /admin/products -> redirected to /login", (await redirectedTo("/admin/products", "/login")) === "/login");
    S.check("anonymous visiting /admin/categories -> redirected to /login", (await redirectedTo("/admin/categories", "/login")) === "/login");

    await S.uiLogin("customer");
    // (The old suite compared the whole navbar with "Products". Customers now also have Cart and My Orders, and their
    // name link, so the links are checked one by one: no admin link at all, and the customer links with their addresses.)
    const customerNavbar = async (when) => {
      const links = await S.navbarLinks();
      S.check(`customer navbar has NO admin links ${when}`, (await adminLinks()).length === 0 && !links.some((link) => /^Admin/.test(link.text)), JSON.stringify(links));
      const cart = await linkTo("/cart");
      S.check(
        `customer navbar has Products, Cart and My Orders, pointing to the right pages ${when}`,
        (await linkTo("/")).text === "Products" && !!cart && /^Cart/.test(cart.text) && (await linkTo("/orders")).text === "My Orders",
        JSON.stringify(links)
      );
      S.check(`customer name link goes to the profile ${when}`, (await S.userLink()).href === "/profile");
    };
    await customerNavbar("after login");
    S.check("16. customer visiting /admin/products -> redirected to /", (await redirectedTo("/admin/products", "/")) === "/");
    S.check("17. customer visiting /admin/categories -> redirected to /", (await redirectedTo("/admin/categories", "/")) === "/");
    await S.waitFor("!!document.querySelector('.filters')", "the product page");
    S.check("customer still sees the normal product page after redirect", (await S.text()).includes("Products"));
    await customerNavbar("after the redirects");
    await S.js("history.pushState({}, '', '/admin/products'); dispatchEvent(new PopStateEvent('popstate'))");
    await S.settleAt("/");
    S.check("customer typing the admin URL inside the app -> redirected to /", (await S.url()) === "/");
    await S.uiLogout();
  });

  // ---- B -------------------------------------------------------------------------
  sec("B. admin login, navigation and empty lists", async () => {
    await S.uiLogin("admin");
    // (The old suite compared the whole navbar with "Products|Admin Products|Admin Categories". Admins now also have
    // Admin Orders and their name link, so each admin link is checked with its text and address.)
    const links = await adminLinks();
    S.check(
      "admin navbar shows Admin Products, Admin Categories and Admin Orders, pointing to the right pages",
      JSON.stringify(links) === JSON.stringify([
        { text: "Admin Products", href: "/admin/products" },
        { text: "Admin Categories", href: "/admin/categories" },
        { text: "Admin Orders", href: "/admin/orders" },
      ]),
      JSON.stringify(links)
    );
    S.check("admin navbar still has the Products link", (await linkTo("/")).text === "Products");
    const userLink = await S.userLink();
    S.check("admin name link goes to the profile and says admin", userLink.href === "/profile" && userLink.text.endsWith("(admin)"), JSON.stringify(userLink));

    forgetCalls();
    await S.clickByText(".navbar-links a", "Admin Products");
    await S.waitFor("location.pathname === '/admin/products'", "the way to the admin products");
    S.check("18. admin can open /admin/products", true);
    await S.waitFor(`${noLoading} && !!document.querySelector('h1')`, "the admin products");
    S.check("page heading 'Manage Products'", (await S.text()).includes("Manage Products"));

    // The run's own database is empty here: every suite removes its data, and this suite has not created any yet.
    const products = await S.models.Product.countDocuments();
    const categories = await S.models.Category.countDocuments();
    S.check("empty products -> friendly empty state", products === 0 && (await S.text()).includes("There are no products yet"), `${products} products`);
    await S.clickByText(".navbar-links a", "Admin Categories");
    await S.waitFor("location.pathname === '/admin/categories'", "the way to the admin categories");
    await S.waitFor(`${noLoading} && !!document.querySelector('h1')`, "the admin categories");
    S.check("18b. admin can open /admin/categories", (await S.text()).includes("Manage Categories"));
    S.check("empty categories -> friendly empty state", categories === 0 && (await S.text()).includes("There are no categories yet"), `${categories} categories`);
  });

  // ---- C -------------------------------------------------------------------------
  sec("C. admin categories", async () => {
    // The data of this suite (known creation dates, so "newest first" is always the same order)
    catA = await S.models.Category.create({ name: `${S.tag} Alpha Cat`, description: "first" });
    catB = await S.models.Category.create({ name: `${S.tag} Beta Cat` });
    catC = await S.models.Category.create({ name: `${S.tag} Gamma Cat` });
    const base = Date.now() - 3600e3;
    let step = 0;
    const make = (name, category, extra = {}) =>
      S.models.Product.create({ name: `${S.tag} ${name}`, description: `desc ${name}`, price: 100, stock: 5, category: category._id, imageUrl: images.url, createdAt: new Date(base + 1000 * step++), ...extra });
    for (let i = 1; i <= 8; i++) await make(`Item ${String(i).padStart(2, "0")}`, catA);
    for (let i = 9; i <= 11; i++) await make(`Item ${String(i).padStart(2, "0")}`, catA, { isActive: false });
    await make("Other Item", catB, { imageUrl: "" });

    forgetCalls();
    await S.goto(`${S.appUrl}/admin/categories`);
    await waitList("categories", "the categories table");
    let t = await S.text();
    S.check("categories listed with name and description", t.includes(`${S.tag} Alpha Cat`) && t.includes("first") && t.includes(`${S.tag} Beta Cat`) && (await rowText(`${S.tag} Beta Cat`)).includes(DASH));
    await S.shot("cat-desktop");

    await S.clickByText("button", "Add Category");
    await S.waitFor("!!document.querySelector('.admin-form')", "the category form");
    S.check("Add Category opens the form", (await S.text()).includes("Add Category"));
    await S.click(".admin-form button[type=submit]");
    await S.waitFor("document.body.innerText.includes('Category name is required')", "the name-required message");
    S.check("empty name -> validation message (client side)", (await S.models.Category.countDocuments({ name: new RegExp(`^${S.tag}`) })) === 3);
    await S.setValue("#category-name", `  ${S.tag} Temp Cat  `);
    await S.setValue("#category-description", "temporary");
    await S.click(".admin-form button[type=submit]");
    await S.waitFor("document.body.innerText.includes('was created')", "the created notice");
    await waitList("categories", "the table after create");
    S.check("11. create category -> success message, form closed, row appears", !(await S.has(".admin-form")) && (await rowText(`${S.tag} Temp Cat`)) !== null);
    S.check("category trimmed + stored", !!(await S.models.Category.findOne({ name: `${S.tag} Temp Cat`, description: "temporary" })));

    await S.clickByText("button", "Add Category");
    await S.waitFor("!!document.querySelector('.admin-form')", "the second form");
    await S.setValue("#category-name", `${S.tag} ALPHA cat`);
    await S.click(".admin-form button[type=submit]");
    await S.waitFor("!!document.querySelector('.admin-form .status-error')", "the duplicate error in the form");
    S.check("duplicate name (different case) -> server message shown in form, form stays open", (await S.js("document.querySelector('.admin-form .status-error').textContent")).includes("already exists"));
    await S.clickByText(".admin-form button", "Cancel");
    S.check("Cancel closes the form", !(await S.has(".admin-form")));

    await rowButton(`${S.tag} Temp Cat`, "Edit");
    await S.waitFor("!!document.querySelector('.admin-form')", "the edit form");
    S.check("Edit prefills the form", (await S.js(`${S.q("#category-name")}.value`)) === `${S.tag} Temp Cat` && (await S.js(`${S.q("#category-description")}.value`)) === "temporary");
    S.check("edit form title", (await S.text()).includes("Edit Category"));
    await S.setValue("#category-name", `${S.tag} Renamed Cat`);
    await S.setValue("#category-description", "");
    await S.click(".admin-form button[type=submit]");
    await S.waitFor("document.body.innerText.includes('was updated')", "the updated notice");
    await waitList("categories", "the table after edit");
    S.check("12. edit category -> row renamed", (await rowText(`${S.tag} Renamed Cat`)) !== null && (await rowText(`${S.tag} Temp Cat`)) === null);
    S.check("12b. description cleared in DB", (await S.models.Category.findOne({ name: `${S.tag} Renamed Cat` })).description === "");

    await stubConfirm(false);
    await rowButton(`${S.tag} Renamed Cat`, "Delete");
    await waitConfirms(1);
    S.check("delete asks for confirmation (message mentions the name)", (await confirms()).length === 1 && (await confirms())[0].includes(`${S.tag} Renamed Cat`));
    S.check("cancelling the confirmation keeps the category", !!(await S.models.Category.findOne({ name: `${S.tag} Renamed Cat` })) && !S.apiCalls.some((call) => call.startsWith("DELETE ")));
    await stubConfirm(true);
    await rowButton(`${S.tag} Renamed Cat`, "Delete");
    await S.waitFor("document.body.innerText.includes('was deleted')", "the deleted notice");
    await waitList("categories", "the table after delete");
    S.check("13. delete unused category -> removed", (await rowText(`${S.tag} Renamed Cat`)) === null && !(await S.models.Category.findOne({ name: `${S.tag} Renamed Cat` })));

    await rowButton(`${S.tag} Alpha Cat`, "Delete");
    await S.waitFor("!!document.querySelector('.status-error')", "the 409 notice");
    t = await S.js("document.querySelector('.status-error').textContent");
    S.check("14. delete category in use -> backend's friendly 409 message shown", /Cannot delete this category because \d+ product\(s\) still use it/.test(t), t);
    S.check("14b. category still exists afterwards", !!(await S.models.Category.findOne({ name: `${S.tag} Alpha Cat` })) && (await rowText(`${S.tag} Alpha Cat`)) !== null);
  });

  // ---- D -------------------------------------------------------------------------
  sec("D. admin products list", async () => {
    forgetCalls();
    await openProducts();
    await searchProducts(S.tag);
    let t = await S.text();
    S.check("shows active AND inactive products (12 total), 10 per page", (await rowCount()) === 10 && t.includes("12 products (active and inactive)"), `${await rowCount()}`);
    S.check("pagination 'Page 1 of 2'", t.includes("Page 1 of 2"));
    S.check("table has all columns", (await S.js("[...document.querySelectorAll('.admin-table th')].map(th=>th.textContent).join('|')")) === "Image|Name|Category|Price|Stock|Status|Actions");
    const row1 = await rowText(`${S.tag} Item 05`);
    S.check("row shows category, price, stock, status", row1.includes(`${S.tag} Alpha Cat`) && row1.includes("Rs. 100") && row1.includes("5") && row1.includes("Active"), row1);
    S.check("row image rendered", await S.has(".admin-table tbody img"));
    await S.shot("prod-desktop");
    await S.clickByText(".pagination button", "Next");
    await S.waitFor("document.body.innerText.includes('Page 2 of 2')", "page 2");
    await waitList("products", "page 2");
    S.check("Next -> page 2 with the remaining 2 products", (await rowCount()) === 2);
    S.check("inactive products are visibly marked", (await S.js("document.querySelectorAll('.admin-table .badge-inactive').length")) + (await S.js("document.querySelectorAll('.admin-table .badge-in').length")) === 2);
    await S.clickByText(".pagination button", "Previous");
    await waitList("products", "page 1 again");
    const inactiveBadges = await S.js("document.querySelectorAll('.admin-table .badge-inactive').length");
    S.check("page 1 inactive badge count matches DB (items 09-11 sort first by newest)", inactiveBadges === 3, `${inactiveBadges}`);
    S.check("inactive row text says Inactive and offers Reactivate", await S.js("(()=>{const r=[...document.querySelectorAll('.admin-table tbody tr.row-inactive')][0];return !!r && r.innerText.includes('Inactive') && r.innerText.includes('Reactivate')})()"));
    await S.setValue("#admin-search", "zzzz-nothing-matches");
    await S.clickByText(".admin-search button", "Search");
    await S.waitFor("document.body.innerText.includes('No products match your search')", "the no-match message");
    markSeen("products");
    S.check("search without results -> friendly message", true);
    await searchProducts(`${S.tag} Item 09`);
    S.check("admin search can find an INACTIVE product", (await rowCount()) === 1 && (await rowText(`${S.tag} Item 09`)).includes("Inactive"));
    await searchProducts(S.tag);
  });

  // ---- E -------------------------------------------------------------------------
  sec("E. add and edit a product", async () => {
    forgetCalls();
    await openProducts();
    await searchProducts(S.tag);
    await S.clickByText("button", "Add Product");
    await S.waitFor("!!document.querySelector('.admin-form')", "the product form");
    S.check("Add Product opens form with title, default blank values, no isActive checkbox", (await S.text()).includes("Add Product") && !(await S.has("#product-isActive")));
    const optionTexts = await S.js("[...document.querySelectorAll('#product-category option')].map(o=>o.textContent)");
    S.check("category dropdown lists categories", optionTexts[0] === "Select a category" && optionTexts.includes(`${S.tag} Alpha Cat`) && optionTexts.includes(`${S.tag} Beta Cat`));
    const countBeforeInvalid = await S.models.Product.countDocuments({ name: new RegExp(`^${S.tag}`) });
    const writesBefore = S.apiCalls.filter((call) => /^(POST|PUT) /.test(call)).length;
    await submitForm();
    await S.waitFor("document.querySelectorAll('.field-error').length >= 5", "5 field errors");
    let t = await S.text();
    S.check(
      "empty form -> errors for name, description, price, stock, category",
      t.includes("Name is required") && t.includes("Description is required") && t.includes("Price must be a number") && t.includes("Stock must be a whole number") && t.includes("Please choose a category"),
      t.slice(0, 600)
    );
    await fillProduct({ name: "Bad Product", description: "d", price: "-5", stock: "1.5", imageUrl: "ftp://nope", category: String(catA._id) });
    await submitForm();
    await S.waitFor("document.body.innerText.includes('Image URL must start with')", "the image error");
    t = await S.text();
    S.check("negative price / decimal stock / bad URL -> field errors", t.includes("Price must be a number of 0 or more") && t.includes("Stock must be a whole number of 0 or more") && t.includes("Image URL must start with"));
    await fillProduct({ price: "abc" });
    await submitForm();
    await S.waitFor("document.body.innerText.includes('Price must be a number')", "the price message");
    S.check("non-numeric price rejected too", (await S.text()).includes("Price must be a number"));
    await fillProduct({ stock: "-1" });
    await submitForm();
    await S.waitFor("document.body.innerText.includes('Stock must be a whole number of 0 or more')", "the stock message");
    S.check("negative stock rejected", (await S.text()).includes("Stock must be a whole number of 0 or more"));
    S.check(
      "no invalid product was sent to the server",
      (await S.models.Product.countDocuments({ name: new RegExp(`^${S.tag}`) })) === countBeforeInvalid && S.apiCalls.filter((call) => /^(POST|PUT) /.test(call)).length === writesBefore
    );
    await S.shot("prod-form-errors");

    await fillProduct({ name: `${S.tag} Brand New`, description: "A brand new product", price: "1499.5", stock: "7", imageUrl: images.url, category: String(catB._id) });
    await submitForm();
    await S.waitFor("document.body.innerText.includes('was created')", "the created notice");
    await waitList("products", "the table after create");
    S.check("4. create product -> success notice, form closed", !(await S.has(".admin-form")));
    brandNew = await S.models.Product.findOne({ name: `${S.tag} Brand New` });
    S.check("created product stored correctly (price, stock, category, active by default)", brandNew && brandNew.price === 1499.5 && brandNew.stock === 7 && String(brandNew.category) === String(catB._id) && brandNew.isActive === true);
    S.check("new product appears in the list (first page, newest first)", (await rowText(`${S.tag} Brand New`)) !== null && (await rowText(`${S.tag} Brand New`)).includes("Rs. 1,499.5"));
    S.check("customer API shows the new product", (await publicProducts(`${S.tag} Brand New`)).length === 1);

    // ---- edit
    await rowButton(`${S.tag} Brand New`, "Edit");
    await S.waitFor("!!document.querySelector('.admin-form')", "the edit form");
    const prefill = await S.js(`({name:${S.q("#product-name")}.value,desc:${S.q("#product-description")}.value,price:${S.q("#product-price")}.value,stock:${S.q("#product-stock")}.value,img:${S.q("#product-imageUrl")}.value,cat:${S.q("#product-category")}.value,active:${S.q("#product-isActive")}.checked})`);
    S.check(
      "Edit prefills every field incl. category + active checkbox",
      prefill.name === `${S.tag} Brand New` && prefill.desc === "A brand new product" && prefill.price === "1499.5" && prefill.stock === "7" && prefill.img === images.url && prefill.cat === String(catB._id) && prefill.active === true,
      JSON.stringify(prefill)
    );
    S.check("edit form title", (await S.text()).includes("Edit Product"));
    await fillProduct({ name: `${S.tag} Brand New v2`, price: "2000", stock: "0", category: String(catA._id), imageUrl: "" });
    await submitForm();
    await S.waitFor("document.body.innerText.includes('was updated')", "the updated notice");
    await waitList("products", "the table after edit");
    const edited = await S.models.Product.findById(brandNew._id);
    S.check("5. edit saves name, price, stock=0, category change, cleared image", edited.name === `${S.tag} Brand New v2` && edited.price === 2000 && edited.stock === 0 && String(edited.category) === String(catA._id) && edited.imageUrl === "");
    S.check("list reflects the edit", (await rowText(`${S.tag} Brand New v2`)).includes(`${S.tag} Alpha Cat`));

    // edit -> untick active
    await rowButton(`${S.tag} Brand New v2`, "Edit");
    await S.waitFor("!!document.querySelector('.admin-form')", "the second edit form");
    await S.click("#product-isActive");
    await submitForm();
    await S.waitFor("document.body.innerText.includes('was updated')", "the second updated notice");
    await waitList("products", "the table after the second edit");
    S.check("unticking Active in the edit form makes the product inactive", (await S.models.Product.findById(brandNew._id)).isActive === false && (await rowText(`${S.tag} Brand New v2`)).includes("Inactive"));

    // a server error inside the form (the category is removed behind the page's back)
    await rowButton(`${S.tag} Brand New v2`, "Edit");
    await S.waitFor("!!document.querySelector('.admin-form')", "the third edit form");
    await fillProduct({ category: String(catC._id) });
    await S.models.Category.deleteOne({ _id: catC._id });
    await submitForm();
    await S.waitFor("!!document.querySelector('.admin-form .status-error')", "the server error in the form");
    S.check(
      "server rejection (category vanished) -> message in form, form stays open, data kept",
      (await S.js("document.querySelector('.admin-form .status-error').textContent")).includes("Category does not exist") && (await S.has(".admin-form")) && (await S.js(`${S.q("#product-name")}.value`)) === `${S.tag} Brand New v2`
    );
    await S.setOffline(true);
    await submitForm();
    await S.waitFor("document.querySelector('.admin-form .status-error')?.textContent.includes('Cannot reach the server')", "the offline error in the form");
    S.check("failed request (offline) -> friendly message in form, nothing raw", !(await S.text()).includes("Network Error") && !(await S.text()).includes("AxiosError"));
    await S.setOffline(false);
    await S.clickByText(".admin-form button", "Cancel");
  });

  // ---- F -------------------------------------------------------------------------
  sec("F. deactivate and reactivate", async () => {
    const target = `${S.tag} Item 02`;
    const targetDoc = await S.models.Product.findOne({ name: target });
    forgetCalls();
    await openProducts();
    await searchProducts(target);
    await stubConfirm(false);
    await rowButton(target, "Deactivate");
    await waitConfirms(1);
    S.check("6a. Deactivate asks for confirmation", (await confirms()).length === 1 && /Deactivate/.test((await confirms())[0]) && (await confirms())[0].includes(target));
    S.check("6b. cancelling does nothing", (await S.models.Product.findById(targetDoc._id)).isActive === true && (await rowText(target)).includes("Active") && !S.apiCalls.some((call) => call.startsWith("PUT ")));
    await stubConfirm(true);
    await rowButton(target, "Deactivate");
    await S.waitFor("document.body.innerText.includes('was deactivated')", "the deactivated notice");
    await waitList("products", "the table after deactivate");
    S.check("6. Deactivate -> success notice, DB isActive=false, row shows Inactive + Reactivate", (await S.models.Product.findById(targetDoc._id)).isActive === false && (await rowText(target)).includes("Inactive") && (await rowText(target)).includes("Reactivate"));
    S.check("6c. product is no longer in the public API", (await publicProducts(target)).length === 0);
    S.check("6d. product was NOT physically deleted", !!(await S.models.Product.findById(targetDoc._id)));
    await rowButton(target, "Reactivate");
    await S.waitFor("document.body.innerText.includes('was reactivated')", "the reactivated notice");
    await waitList("products", "the table after reactivate");
    S.check("7a. Reactivate asks for confirmation", /Reactivate/.test((await confirms())[1] || ""));
    S.check("7. Reactivate -> DB isActive=true, row Active + Deactivate", (await S.models.Product.findById(targetDoc._id)).isActive === true && (await rowText(target)).includes("Deactivate"));
    S.check("7b. product is public again", (await publicProducts(target)).length === 1);

    // a toggle that fails: the product is removed from the database behind the page's back
    await rowButton(target, "Deactivate");
    await S.waitFor("document.body.innerText.includes('was deactivated')", "the second deactivated notice");
    await waitList("products", "the table after the second deactivate");
    await S.waitFor(
      `[...document.querySelectorAll('.admin-table tbody tr')].some(r=>r.querySelector('.admin-cell-name')?.textContent.trim()===${JSON.stringify(target)} && r.innerText.includes('Reactivate'))`,
      "the row to offer Reactivate"
    );
    await S.models.Product.deleteOne({ _id: targetDoc._id });
    await rowButton(target, "Reactivate");
    await S.waitFor("!!document.querySelector('.status-error')", "the toggle error");
    S.check("failed toggle (product vanished) -> friendly error notice shown", (await S.js("document.querySelector('.status-error').textContent")).includes("Product not found"));
  });

  // ---- G -------------------------------------------------------------------------
  sec("G. failed requests and a bad token", async () => {
    // The home page must have finished loading its products and checking the login before the browser goes offline;
    // otherwise those requests could still be running and fail (or pass) at the wrong moment.
    await S.gotoSettled(`${S.appUrl}/`);
    await S.waitFor("!!document.querySelector('.navbar-user')", "the login to be still there");
    // The error box of the list, with the button the next step clicks. (If it does not show up, the failure message of
    // waitFor lists the address, the page text and the latest API calls.)
    const tryAgainShown = "[...document.querySelectorAll('.message-box-error button')].some(b=>b.textContent.trim()==='Try again')";
    await S.setOffline(true);
    await S.clickByText(".navbar-links a", "Admin Products");
    await S.waitFor(tryAgainShown, "the products list error with its 'Try again' button");
    let t = await S.text();
    S.check("products list failure -> friendly error + Try again, no raw error", t.includes("Cannot reach the server") && t.includes("Try again") && !t.includes("AxiosError") && !t.includes("Network Error"));
    await S.setOffline(false);
    markSeen("products");
    await S.clickByText(".message-box-error button", "Try again");
    await waitList("products", "the products after Try again");
    S.check("Try again recovers once online", (await rowCount()) > 0);

    await S.setOffline(true);
    await S.clickByText(".navbar-links a", "Admin Categories");
    await S.waitFor(tryAgainShown, "the categories list error with its 'Try again' button");
    S.check("categories list failure -> friendly error + Try again", (await S.text()).includes("Cannot reach the server") && (await S.text()).includes("Try again"));
    await S.setOffline(false);
    markSeen("categories");
    await S.clickByText(".message-box-error button", "Try again");
    await waitList("categories", "the categories after Try again");
    S.check("categories Try again recovers", (await rowCount()) > 0);

    // an invalid token on an admin page
    await S.js("localStorage.setItem('token','not-a-real-token')");
    await S.clickByText(".navbar-links a", "Admin Products");
    await S.waitFor("!!document.querySelector('.message-box-error')", "the bad-token error");
    t = await S.text();
    S.check("invalid token on admin page -> backend 401 message shown, not a crash", t.includes("Invalid or expired token"));
  });

  // ---- H -------------------------------------------------------------------------
  sec("H. other pages still work", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.js("localStorage.clear()");
    await S.uiLogin("customer");
    await S.goto(`${S.appUrl}/?search=${encodeURIComponent(`${S.tag} Item 01`)}`);
    await S.waitFor("document.querySelectorAll('.product-card').length === 1 && !document.body.innerText.includes('Loading products')", "the customer list");
    S.check("20. customer product listing works", true);
    const item01 = await S.models.Product.findOne({ name: `${S.tag} Item 01` });
    await S.clickByText(".product-card a.button", "View Details");
    await S.waitFor("!!document.querySelector('.product-details')", "the details");
    S.check("21. product details works", (await S.url()) === `/products/${item01._id}`);
    S.check("customer product list never shows inactive (Item 09 hidden)", (await publicProducts(`${S.tag} Item 09`)).length === 0);
    await S.goto(`${S.appUrl}/health`);
    await S.waitFor("document.body.innerText.includes('API is working')", "the health page");
    S.check("22. /health works", true);
    await S.uiLogout();
    S.check(
      "19. logout works (token removed, Login/Sign up visible)",
      !(await S.js("localStorage.getItem('token')")) && (await S.userLink()) === null && (await S.navbarLinks()).map((link) => link.text).join("|") === "Products|Login|Sign up"
    );
    await S.uiLogin("admin");
    S.check("19b. admin can log back in", (await adminLinks()).some((link) => link.text === "Admin Products"));
    forgetCalls();
    await S.goto(`${S.appUrl}/admin/categories`);
    await waitList("categories", "the categories after a reload");
    S.check("admin session survives a reload on an admin page", (await S.url()) === "/admin/categories");
  });

  // ---- I -------------------------------------------------------------------------
  sec("I. screen widths", async () => {
    for (const [label, w, h, mobile] of [["mobile", 375, 800, true], ["tablet", 768, 1000, false], ["laptop", 1024, 800, false], ["desktop", 1280, 900, false]]) {
      await S.resize(w, h, mobile);
      forgetCalls();
      await openProducts();
      await searchProducts(S.tag);
      S.check(`${label} (${w}px): admin products no horizontal scroll`, await S.noHScroll());
      const display = await S.js("getComputedStyle(document.querySelector('.admin-table tbody tr')).display");
      const stacked = label === "mobile" || label === "tablet";
      S.check(`${label}: products ${stacked ? "shown as stacked cards" : "shown as a table"} (tr display=${display})`, stacked ? display === "block" : display === "table-row");
      if (stacked) {
        const headerHidden = await S.js("document.querySelector('.admin-table thead').getBoundingClientRect().width <= 1");
        S.check("mobile: table header hidden, cells carry data-label captions", headerHidden && (await S.js("getComputedStyle(document.querySelector('.admin-table td'), '::before').content")) !== "none");
      }
      await S.shot(`prod-${label}`);
      await S.clickByText("button", "Add Product");
      await S.waitFor("!!document.querySelector('.admin-form')", `the form (${label})`);
      S.check(`${label}: add-product form no horizontal scroll`, await S.noHScroll());
      const formRowCols = await S.js("getComputedStyle(document.querySelector('.form-row')).gridTemplateColumns.split(' ').length");
      S.check(`${label}: price/stock ${label === "mobile" ? "stacked" : "side by side"}`, label === "mobile" ? formRowCols === 1 : formRowCols === 2);
      const tooSmall = await S.js("[...document.querySelectorAll('.admin-form button, .admin-form input, .admin-form select, .admin-form textarea')].filter(e=>e.offsetParent && e.getBoundingClientRect().height < 32 && e.type !== 'checkbox').length");
      S.check(`${label}: form controls are tap-friendly (>=32px)`, tooSmall === 0, `${tooSmall}`);
      await S.shot(`form-${label}`);
      await S.goto(`${S.appUrl}/admin/categories`);
      await waitList("categories", `the categories (${label})`);
      S.check(`${label} (${w}px): admin categories no horizontal scroll`, await S.noHScroll());
      await S.shot(`cat-${label}`);
      S.check(`${label}: navbar no horizontal scroll with admin links`, await S.noHScroll());
    }
  });

  // ---- whole run -------------------------------------------------------------------
  sec("whole-run checks", async () => {
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
    S.check("the browser console stayed clean (no errors, warnings or exceptions)", S.consoleProblems.length === 0, S.consoleProblems.slice(0, 3).join(" | "));
  });
});
