// The customer product pages and the sign-up / login pages: empty store, health page, wrong product
// addresses, the listing (cards, prices, stock, pictures), search, category and price filters,
// paging, product details, server failures, signup / login / logout, and three screen widths.
// (Moved into the repository from the old scratch folder, where it was "phase3bE2E".)
//
// Run it with:  npm run test:e2e -- phase3bE2E
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");
const { startImageServer } = require("../lib/imageServer");

describe("customer products and auth", () => {
  let S;
  let images;
  const sec = (title, body) => section(() => S, title, body);

  // Data of this suite
  let catA; // "Footwear": 13 active products + 1 inactive
  let catB; // "Bags": 2 active products
  let alpha;
  let sandal;
  let broken;
  let hidden;

  before(async () => {
    S = await startSuite("phase3bE2E");
    images = await startImageServer();
  });

  // The products of this suite. They are created at the start of section B (after section A has looked at the empty store),
  // with known creation dates, so the "newest first" order is always the same.
  const seed = async () => {
    catA = await S.models.Category.create({ name: `${S.tag} Footwear` });
    catB = await S.models.Category.create({ name: `${S.tag} Bags` });
    const base = Date.now() - 3600e3;
    let step = 0;
    const make = (name, price, stock, category, imageUrl, extra = {}) =>
      S.models.Product.create({
        name: `${S.tag} ${name}`,
        description: `Description of ${name}\nsecond line`,
        price,
        stock,
        category: category._id,
        imageUrl,
        createdAt: new Date(base + 1000 * step++),
        ...extra,
      });
    for (let i = 1; i <= 10; i++) await make(`Filler ${String(i).padStart(2, "0")}`, 100 * i, 50, catA, images.url);
    alpha = await make("Alpha Shoe", 2500, 20, catA, images.url);
    sandal = await make("Sandal", 1499.5, 3, catA, ""); // no picture, low stock
    broken = await make("Broken Image Boot", 3200, 0, catA, images.missingUrl); // picture not found, out of stock
    await make("Backpack", 4200, 8, catB, images.url);
    await make("Wallet", 800, 8, catB, images.url);
    hidden = await make("Hidden Item", 999, 8, catA, images.url, { isActive: false });
  };

  after(async () => {
    try {
      if (S) await S.finish();
    } finally {
      if (images) await images.close();
    }
  });

  // ---- helpers of this suite -------------------------------------------------------
  const cardCount = () => S.js("document.querySelectorAll('.product-card').length");
  const cardNames = () => S.js("[...document.querySelectorAll('.product-card .product-name')].map(e=>e.textContent.trim())");
  const columns = () => S.js("(()=>{const g=document.querySelector('.product-grid');return g?getComputedStyle(g).gridTemplateColumns.split(' ').length:0})()");
  const hasButton = (selector, label) => S.js(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(b=>b.textContent.trim()===${JSON.stringify(label)})`);
  const linkTexts = async () => (await S.navbarLinks()).map((link) => link.text);

  // After an action that makes the page ask the server for the list again: wait for the NEW list request, then for
  // the list to have `n` cards and stop loading, and check once more a moment later that it stayed so.
  // (Looking only at the cards could be fooled by the OLD list, which may have the same number of cards.)
  const listCalls = () => S.apiCalls.filter((call) => /\/api\/products(\?|$)/.test(call)).length;
  let seenListCalls = 0;
  const markListSeen = () => { seenListCalls = listCalls(); };
  const waitCards = async (n, label) => {
    const startedAt = Date.now();
    while (listCalls() <= seenListCalls) {
      if (Date.now() - startedAt > 10000) throw new Error(`the page did not ask the server for the list (${label || `${n} cards`})`);
      await S.sleep(50);
    }
    const condition = `document.querySelectorAll('.product-card').length === ${n} && !document.body.innerText.includes('Loading products')`;
    await S.waitFor(condition, label || `${n} cards`);
    await S.sleep(100);
    await S.waitFor(condition, `${label || `${n} cards`} (and staying)`);
    markListSeen();
  };
  const openList = async (path) => {
    await S.goto(`${S.appUrl}${path}`);
  };

  // ---- A -------------------------------------------------------------------------
  sec("A. empty store, navbar, health page, wrong product addresses", async () => {
    // The run's own database is empty at this point (every suite removes its data), and this suite has not created any yet.
    const activeProducts = await S.models.Product.countDocuments({ isActive: true });
    await S.goto(`${S.appUrl}/`);
    await S.js("localStorage.clear()");
    await S.goto(`${S.appUrl}/`);
    await S.waitFor("!document.body.innerText.includes('Loading products')", "the list");
    const t0 = await S.text();
    S.check("/ loads the product listing (empty store message)", activeProducts === 0 && t0.includes("Products") && t0.includes("No products are available yet"), `${activeProducts} active products: ${t0.slice(0, 200)}`);
    const links = await S.navbarLinks();
    S.check(
      "logged out: navbar links are Products, Login and Sign up, pointing to the right pages",
      JSON.stringify(links) === JSON.stringify([{ text: "Products", href: "/" }, { text: "Login", href: "/login" }, { text: "Sign up", href: "/signup" }]),
      JSON.stringify(links)
    );
    S.check("logged out: no profile link", (await S.userLink()) === null);

    await S.goto(`${S.appUrl}/health`);
    await S.waitFor("document.body.innerText.includes('API is working')", "the health page");
    S.check("/health page still works", (await S.text()).includes("Database: connected"));

    await S.goto(`${S.appUrl}/products/not-an-id`);
    await S.waitFor("document.body.innerText.includes('not found')", "the message for a wrong id");
    let t = await S.text();
    S.check("invalid product id -> friendly message", t.includes("was not found or is no longer available") && !t.includes("Request failed") && !t.includes("AxiosError"), t.slice(0, 200));
    S.check("invalid id page has Back to Products button", await S.has("a.button-link[href=\"/\"]"));
    await S.goto(`${S.appUrl}/products/${"a".repeat(24)}`);
    await S.waitFor("document.body.innerText.includes('not found')", "the message for a missing id");
    S.check("non-existing product id -> friendly message", (await S.text()).includes("was not found or is no longer available"));
    await S.click("a.button-link");
    await S.waitFor("location.pathname === '/'", "back to the list");
    S.check("Back to Products button returns to /", (await S.url()) === "/");
  });

  // ---- B -------------------------------------------------------------------------
  sec("B. product listing", async () => {
    await seed();
    S.resetCalls();
    seenListCalls = 0;
    await openList(`/?category=${catA._id}`); // isolate this suite's data from anything else in the database
    await waitCards(12);
    S.check("listing shows 12 cards on first page (page size)", (await cardCount()) === 12);
    let t = await S.text();
    S.check("shows count '13 products found' for Footwear (hidden excluded)", t.includes("13 products found"), t.match(/\d+ products? found/)?.[0]);
    S.check("pagination text 'Page 1 of 2'", t.includes("Page 1 of 2"));
    S.check("Previous disabled on page 1", await S.js("document.querySelector('.pagination button').disabled"));
    S.check("each card has a View Details link to its own product page", (await S.js("[...document.querySelectorAll('.product-card a.button')].filter(a=>a.textContent.trim()==='View Details' && /^\\/products\\/[0-9a-f]{24}$/.test(a.getAttribute('href'))).length")) === 12);
    await S.shot("desktop-list");

    await openList(`/?category=${catA._id}&search=${encodeURIComponent("alpha shoe")}`);
    await waitCards(1);
    t = await S.text();
    S.check("price shown as 'Rs. 2,500'", t.includes("Rs. 2,500"), t.match(/Rs\.[^\n]*/)?.[0]);
    const categoryLabel = await S.js(`${S.q(".product-category")}.textContent`);
    S.check("category name shown on card", categoryLabel === `${S.tag} Footwear`.toUpperCase() || categoryLabel === `${S.tag} Footwear`, categoryLabel);
    S.check("'In stock' status shown", t.includes("In stock"));
    S.check("card image element is rendered for product with imageUrl", await S.has(".product-card img.product-image"));
    await S.waitFor("(()=>{const i=document.querySelector('.product-card img');return i&&i.complete&&i.naturalWidth>0})()", "the card image to load");
    S.check("image actually loaded", true);

    await openList(`/?category=${catA._id}&search=sandal`);
    await waitCards(1);
    t = await S.text();
    S.check("product without image shows 'No image' placeholder", t.includes("No image") && !(await S.has(".product-card img")));
    S.check("price with decimals 'Rs. 1,499.5'", t.includes("Rs. 1,499.5"));
    S.check("low stock badge 'Only 3 left'", t.includes("Only 3 left"));

    await openList(`/?category=${catA._id}&search=broken`);
    await waitCards(1);
    await S.waitFor("document.body.innerText.includes('No image')", "the broken picture to fall back");
    S.check("broken image URL falls back to placeholder", true);
    S.check("'Out of stock' badge", (await S.text()).includes("Out of stock"));
  });

  // ---- C -------------------------------------------------------------------------
  sec("C. search and filters through the page", async () => {
    await openList("/");
    await waitCards(12);
    await S.setValue("#search", `${S.tag} wallet`);
    await S.clickByText("button", "Search");
    await waitCards(1, "wallet only");
    S.check("search via Search button filters results", (await cardNames())[0] === `${S.tag} Wallet`, JSON.stringify(await cardNames()));
    S.check("URL contains search param", (await S.url()).includes("search="), await S.url());
    S.check("results count says 1 product found", (await S.text()).includes("1 product found"));

    await S.setValue("#search", "description of backpack"); // matches description text
    await S.clickByText("button", "Search");
    await waitCards(1, "backpack by description");
    S.check("search also matches description", (await cardNames())[0] === `${S.tag} Backpack`);

    await S.setValue("#search", "zzzz-no-such-thing");
    await S.clickByText("button", "Search");
    await S.waitFor("document.body.innerText.includes('No products match')", "the no-results message");
    markListSeen();
    S.check("no results -> empty state with message", true);
    S.check("empty state has Clear Filters button", await hasButton(".message-box button", "Clear Filters"));
    await S.clickByText(".message-box button", "Clear Filters");
    await waitCards(12, "list after Clear Filters");
    S.check("Clear Filters from empty state restores list", (await S.url()) === "/");

    // category dropdown
    await S.waitFor(`!!${S.q("#category")} && [...${S.q("#category")}.options].some(o=>o.value==='${catB._id}')`, "the category options");
    const optionTexts = await S.js("[...document.querySelectorAll('#category option')].map(o=>o.textContent)");
    S.check("dropdown has 'All Categories' first and real categories", optionTexts[0] === "All Categories" && optionTexts.includes(`${S.tag} Bags`) && optionTexts.includes(`${S.tag} Footwear`), JSON.stringify(optionTexts));
    await S.setValue("#category", String(catB._id));
    await waitCards(2, "bags category");
    S.check(
      "category change reloads list (2 Bags products)",
      (await S.url()) === `/?category=${catB._id}` && (await cardNames()).every((n) => [`${S.tag} Backpack`, `${S.tag} Wallet`].includes(n)),
      (await S.url()) + JSON.stringify(await cardNames())
    );
    S.check("category select keeps selected value", (await S.js(`${S.q("#category")}.value`)) === String(catB._id));
    S.check("pagination shows Page 1 of 1, both buttons disabled", (await S.js("[...document.querySelectorAll('.pagination button')].every(b=>b.disabled)")) && (await S.text()).includes("Page 1 of 1"));

    // price filters
    await S.setValue("#minPrice", "1000");
    await S.clickByText("button", "Apply Filters");
    await waitCards(1, "min 1000 in bags");
    S.check("min price filter (Bags >= 1000 -> Backpack only)", (await cardNames())[0] === `${S.tag} Backpack`, JSON.stringify(await cardNames()));
    await S.setValue("#minPrice", "");
    await S.setValue("#maxPrice", "1000");
    await S.clickByText("button", "Apply Filters");
    await waitCards(1, "max 1000 in bags");
    S.check("max price filter (Bags <= 1000 -> Wallet only)", (await cardNames())[0] === `${S.tag} Wallet`, JSON.stringify(await cardNames()));
    await S.setValue("#minPrice", "800");
    await S.setValue("#maxPrice", "800");
    await S.clickByText("button", "Apply Filters");
    await waitCards(1, "min=max=800");
    S.check("min and max together, inclusive bounds", (await cardNames())[0] === `${S.tag} Wallet`);

    const urlBefore = await S.url();
    const callsBefore = listCalls();
    await S.setValue("#minPrice", "500");
    await S.setValue("#maxPrice", "100");
    await S.clickByText("button", "Apply Filters");
    await S.waitFor("document.body.innerText.includes('Minimum price cannot be higher')", "the min > max message");
    S.check("min > max -> validation message, no new request/URL", (await S.url()) === urlBefore && listCalls() === callsBefore, `${await S.url()} ${listCalls() - callsBefore} new request(s)`);
    await S.setValue("#minPrice", "-5");
    await S.setValue("#maxPrice", "");
    await S.clickByText("button", "Apply Filters");
    await S.waitFor("document.body.innerText.includes('Prices must be numbers of 0 or more')", "the negative price message");
    S.check("negative price -> validation message", (await S.url()) === urlBefore && listCalls() === callsBefore);
    await S.setValue("#minPrice", "");
    await S.clickByText("button", "Apply Filters");
    await S.waitFor("!document.body.innerText.includes('Prices must be numbers')", "the message to clear");
    S.check("validation message clears after fixing input", true);
    markListSeen();

    await S.clickByText("button", "Clear Filters");
    await S.waitFor("location.search === ''", "the address to be cleared");
    await waitCards(12, "list after Clear Filters");
    S.check("Clear Filters resets URL and inputs", (await S.js(`${S.q("#search")}.value + '|' + ${S.q("#category")}.value + '|' + ${S.q("#minPrice")}.value + '|' + ${S.q("#maxPrice")}.value`)) === "|||");
  });

  // ---- D -------------------------------------------------------------------------
  sec("D. paging", async () => {
    await openList(`/?category=${catA._id}`);
    await waitCards(12);
    await S.clickByText(".pagination button", "Next");
    await waitCards(1, "page 2 has 1 card");
    let t = await S.text();
    S.check("Next -> page 2 ('Page 2 of 2'), URL has page=2", t.includes("Page 2 of 2") && (await S.url()).includes("page=2"), await S.url());
    S.check("Next disabled on last page, Previous enabled", (await S.js("document.querySelectorAll('.pagination button')[1].disabled")) && !(await S.js("document.querySelectorAll('.pagination button')[0].disabled")));
    // changing a filter on page 2 goes back to page 1
    await S.setValue("#minPrice", "0");
    await S.clickByText("button", "Apply Filters");
    await waitCards(12, "back on page 1 after filter");
    S.check("changing filters resets to page 1", !(await S.url()).includes("page="), await S.url());
    await S.clickByText(".pagination button", "Next");
    await waitCards(1, "page 2 again");
    await S.clickByText(".pagination button", "Previous");
    await waitCards(12, "previous works");
    S.check("Previous returns to page 1", (await S.text()).includes("Page 1 of 2"));

    await openList(`/?category=${catA._id}&page=99`);
    await S.waitFor("document.body.innerText.includes('no products on this page')", "the page-beyond-the-end message");
    markListSeen();
    S.check("page beyond the end -> friendly message + 'Go to first page'", await hasButton(".message-box button", "Go to first page"));
    await S.clickByText(".message-box button", "Go to first page");
    await waitCards(12, "first page");
    S.check("'Go to first page' works", (await S.text()).includes("Page 1 of 2"));

    await openList(`/?category=${catA._id}&page=abc`);
    await waitCards(12, "bad page param falls back");
    S.check("garbage ?page=abc falls back to page 1", (await S.text()).includes("Page 1 of 2"));

    await openList("/?category=not-an-id");
    await S.waitFor("!!document.querySelector('.message-box-error')", "the error for a bad category");
    t = await S.text();
    S.check("garbage ?category= shows friendly error, no raw Axios text", t.includes("Invalid category id") && !t.includes("AxiosError") && !t.includes("status code"), t.slice(0, 300));
    markListSeen();
  });

  // ---- E -------------------------------------------------------------------------
  sec("E. product details", async () => {
    await openList(`/?category=${catA._id}&search=alpha`);
    await waitCards(1);
    await S.clickByText(".product-card a.button", "View Details");
    await S.waitFor("location.pathname.startsWith('/products/')", "the details address");
    await S.waitFor("!!document.querySelector('.product-details')", "the details");
    let t = await S.text();
    S.check("View Details goes to /products/:id", (await S.url()) === `/products/${alpha._id}`);
    S.check(
      "details show name, price, category, description, availability, stock",
      t.includes(`${S.tag} Alpha Shoe`) && t.includes("Rs. 2,500") && t.toLowerCase().includes(`${S.tag} footwear`.toLowerCase()) && t.includes("Description of Alpha Shoe") && t.includes("Available") && t.includes("Stock: 20 units"),
      t.slice(0, 400)
    );
    S.check("details image loaded", await S.js("(()=>{const i=document.querySelector('.product-details img');return !!i&&i.complete&&i.naturalWidth>0})()"));
    await S.shot("desktop-details");
    await S.click("a.back-link");
    await S.waitFor("location.pathname === '/'", "the back link");
    S.check("'Back to Products' link returns to listing", true);

    await S.goto(`${S.appUrl}/products/${sandal._id}`);
    await S.waitFor("!!document.querySelector('.product-details')", "the sandal details");
    S.check("no-image product details show placeholder", (await S.text()).includes("No image"));
    await S.goto(`${S.appUrl}/products/${broken._id}`);
    await S.waitFor("!!document.querySelector('.product-details')", "the broken-picture details");
    t = await S.text();
    S.check("out-of-stock details show 'Currently unavailable'", t.includes("Currently unavailable") && t.includes("Stock: 0 units"));
    await S.waitFor("document.body.innerText.includes('No image')", "the placeholder for the broken picture");
    S.check("broken image on details falls back to placeholder", true);
    await S.goto(`${S.appUrl}/products/${hidden._id}`);
    await S.waitFor("document.body.innerText.includes('not found')", "the message for the hidden product");
    S.check("inactive (hidden) product is not viewable by customers", (await S.text()).includes("no longer available"));
  });

  // ---- F -------------------------------------------------------------------------
  sec("F. server failures (browser offline)", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.setOffline(true);
    await S.clickByText(".navbar-links a", "Products");
    await S.waitFor("!!document.querySelector('.message-box-error') && !document.body.innerText.includes('Loading products')", "the error box");
    let t = await S.text();
    S.check("products failure -> friendly error", t.includes("Cannot reach the server") && !t.includes("AxiosError") && !t.includes("Network Error"), t.slice(0, 300));
    S.check("categories failure -> friendly note", t.includes("Could not load categories") || t.includes("Cannot reach the server. Please check your connection and try again. You can still browse"), t.slice(0, 400));
    await S.setOffline(false);

    await S.goto(`${S.appUrl}/login`);
    await S.setOffline(true);
    await S.click("a.navbar-brand"); // moves inside the page to "/" while offline
    await S.waitFor("location.pathname === '/' && !!document.querySelector('.message-box-error')", "the list to fail while offline");
    await S.setOffline(false);
    await S.js(`window.history.pushState({}, '', '/products/${alpha._id}'); window.dispatchEvent(new PopStateEvent('popstate'))`);
    await S.waitFor("!!document.querySelector('.product-details')", "the details after coming back online");
    S.check("details page works again once back online", true);
    await S.setOffline(true);
    await S.js(`window.history.pushState({}, '', '/products/${sandal._id}'); window.dispatchEvent(new PopStateEvent('popstate'))`);
    await S.waitFor("!!document.querySelector('.message-box-error')", "the details error while offline");
    t = await S.text();
    S.check("details failure (offline) -> friendly error + Back button", t.includes("Cannot reach the server") && !t.includes("AxiosError") && (await S.has("a.button-link[href=\"/\"]")));
    await S.setOffline(false);
  });

  // ---- G -------------------------------------------------------------------------
  sec("G. sign up, log in, log out", async () => {
    const email = S.emailOf("signup"); // carries this suite's tag, so the cleanup finds the account
    await S.goto(`${S.appUrl}/signup`);
    await S.js("localStorage.clear()");
    await S.goto(`${S.appUrl}/signup`);
    await S.setValue("#name", "Signup Tester");
    await S.setValue("#email", email);
    await S.setValue("#password", S.password);
    await S.click("button[type=submit]");
    await S.waitFor("location.pathname === '/' && !!document.querySelector('.navbar-user')", "the redirect after signup");
    const userLink = await S.userLink();
    S.check("Signup works, redirects to '/' and navbar shows the user (name and role, linking to the profile)", userLink.text === "Signup Tester (customer)" && userLink.href === "/profile", JSON.stringify(userLink));
    S.check("token saved in localStorage", await S.js("!!localStorage.getItem('token')"));
    const customerLinks = await S.navbarLinks();
    S.check("a new customer has no admin link in the navbar", !customerLinks.some((link) => /^\/admin/.test(link.href || "")), JSON.stringify(customerLinks));
    S.check("a new customer has Products, Cart and My Orders", JSON.stringify(customerLinks.map((link) => link.href)) === JSON.stringify(["/", "/cart", "/orders"]), JSON.stringify(customerLinks));
    S.check("no Admin text on the page", !(await S.text()).includes("Admin"));
    await S.js("location.reload()");
    await S.waitFor("document.readyState==='complete' && !!document.querySelector('.navbar-user')", "the login to survive a reload");
    S.check("still logged in after page reload", true);

    await S.clickByText(".navbar-links button", "Logout");
    await S.waitFor("!document.querySelector('.navbar-user')", "logout");
    S.check(
      "Logout works (Login/Sign up links return, token removed)",
      !(await S.js("localStorage.getItem('token')")) && JSON.stringify(await linkTexts()) === JSON.stringify(["Products", "Login", "Sign up"]) && (await S.userLink()) === null,
      JSON.stringify(await linkTexts())
    );

    await S.goto(`${S.appUrl}/login`);
    await S.setValue("#email", email);
    await S.setValue("#password", `${S.password}-wrong`);
    await S.click("button[type=submit]");
    await S.waitFor("!!document.querySelector('.status-error')", "the login error");
    S.check("Login with wrong password shows friendly error", (await S.text()).includes("Invalid email or password"));
    await S.setValue("#password", S.password);
    await S.click("button[type=submit]");
    await S.waitFor("location.pathname === '/' && !!document.querySelector('.navbar-user')", "the redirect after login");
    S.check("Login works", (await S.userLink()).text === "Signup Tester (customer)");
    await S.clickByText(".navbar-links button", "Logout");
    await S.waitFor("!document.querySelector('.navbar-user')", "second logout");
    S.check("Logout works again", true);
  });

  // ---- H -------------------------------------------------------------------------
  sec("H. screen widths", async () => {
    const sizes = [["mobile", 375, 800, true], ["tablet", 768, 1000, false], ["desktop", 1280, 900, false]];
    for (const [label, w, h, mobile] of sizes) {
      await S.resize(w, h, mobile);
      await openList(`/?category=${catA._id}`);
      await S.waitFor("document.querySelectorAll('.product-card').length === 12 && !document.body.innerText.includes('Loading products')", `12 cards (${label})`);
      const cols = await columns();
      S.check(`${label} (${w}px): list has no horizontal scroll`, await S.noHScroll(), `scrollWidth>${w}`);
      S.check(`${label} (${w}px): grid columns = ${cols}`, label === "mobile" ? cols === 1 : label === "tablet" ? cols >= 2 && cols <= 4 : cols >= 4);
      await S.shot(`${label}-list`);
      await S.goto(`${S.appUrl}/products/${alpha._id}`);
      await S.waitFor("!!document.querySelector('.product-details')", `details (${label})`);
      S.check(`${label} (${w}px): details has no horizontal scroll`, await S.noHScroll());
      const detailCols = await S.js("getComputedStyle(document.querySelector('.product-details')).gridTemplateColumns.split(' ').length");
      S.check(`${label}: details layout ${detailCols === 1 ? "stacked" : "two columns"}`, label === "mobile" ? detailCols === 1 : label === "desktop" ? detailCols === 2 : true);
      await S.shot(`${label}-details`);
      await S.goto(`${S.appUrl}/login`);
      S.check(`${label} (${w}px): login has no horizontal scroll`, await S.noHScroll());
    }
    await S.resize(375, 800, true);
    await S.goto(`${S.appUrl}/`);
    await S.waitFor("document.querySelectorAll('.product-card').length > 0 && !document.body.innerText.includes('Loading products')", "the mobile cards");
    const tooSmall = await S.js("[...document.querySelectorAll('button, .button, input, select')].filter(e=>e.offsetParent && e.getBoundingClientRect().height < 32).length");
    S.check("mobile: buttons/inputs are at least 32px tall (tap-friendly)", tooSmall === 0, `${tooSmall} too small`);
  });

  // ---- whole run -------------------------------------------------------------------
  sec("whole-run checks", async () => {
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
    S.check("the browser console stayed clean (no errors, warnings or exceptions)", S.consoleProblems.length === 0, S.consoleProblems.slice(0, 3).join(" | "));
  });
});
