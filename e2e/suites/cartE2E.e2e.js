// The customer cart: anonymous visitors, the empty cart, adding products (and the count in the
// navbar), the cart page (quantities, totals, removing, clearing), no leaking between customers,
// stock and availability problems, network and session failures, admins, the existing pages, and
// three screen widths.
// (Moved into the repository from the old scratch folder, where it was "cartE2E".)
//
// Run it with:  npm run test:e2e -- cartE2E
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");
const { startImageServer } = require("../lib/imageServer");

describe("customer cart", () => {
  let S;
  const sec = (title, body) => section(() => S, title, body);

  let images; // a local image server (random port), so products have real pictures without the internet
  let P; // the products of this suite
  let category;

  before(async () => {
    S = await startSuite("cartE2E");
    images = await startImageServer();

    await S.newUser("admin", "admin");
    await S.newUser("alice");
    await S.newUser("bob");
    category = await S.models.Category.create({ name: `${S.tag} Category` });
    P = {
      alpha: await makeProduct("Alpha", 250.75, 10),
      beta: await makeProduct("Beta", 99.99, 3),
      soldOut: await makeProduct("SoldOut", 10, 0),
      p4: await makeProduct("Four", 40, 5),
      p5: await makeProduct("Five", 50, 5),
      p6: await makeProduct("Six", 60, 5),
      p7: await makeProduct("Seven", 70, 5),
      p8: await makeProduct("Eight", 80, 5),
      stale: await makeProduct("Stale", 15, 5),
    };
  });

  after(async () => {
    try {
      if (S) await S.finish();
    } finally {
      if (images) await images.close();
    }
  });

  const makeProduct = (name, price, stock) =>
    S.models.Product.create({ name: `${S.tag} ${name}`, description: `desc ${name}`, price, stock, category: category._id, imageUrl: images.url });

  // ---- helpers of this suite -------------------------------------------------------
  const pid = (product) => String(product._id);
  const cartApiCalls = () => S.apiCalls.filter((call) => call.includes("/api/cart"));
  const isCartRequest = (paused) => /\/api\/cart(\/|\?|$)/.test(paused.request.url);
  const linkTexts = async () => (await S.navbarLinks()).map((link) => link.text);
  const cartLinkText = () => S.js("(()=>{const a=[...document.querySelectorAll('.navbar-links a')].find(x=>x.getAttribute('href')==='/cart');return a?a.textContent.trim():null})()");
  const waitForCartCount = (text) => S.waitFor(`document.querySelector('.navbar-links a[href="/cart"]')?.textContent.trim() === ${JSON.stringify(text)}`, `the navbar to say ${text}`);

  // A product card on the product list, by name
  const card = (name) => `[...document.querySelectorAll('.product-card')].find(c=>c.querySelector('.product-name').textContent.trim()===${JSON.stringify(name)})`;
  const cardText = (name) => S.js(`(()=>{const c=${card(name)};return c?c.innerText:null})()`);
  const cardButton = (name, label) => S.js(`(()=>{const c=${card(name)};const b=[...c.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!b)throw new Error('no button ${label}');b.click();return true})()`);
  const cardButtonState = (name) => S.js(`(()=>{const c=${card(name)};const b=c&&c.querySelector('.add-to-cart button');return b?{label:b.textContent.trim(),disabled:b.disabled}:null})()`);

  // A line of the cart page, by product name
  const row = (name) => `[...document.querySelectorAll('.cart-item')].find(r=>r.querySelector('.cart-item-name').textContent.trim()===${JSON.stringify(name)})`;
  const rowText = (name) => S.js(`(()=>{const r=${row(name)};return r?r.innerText:null})()`);
  const rowButton = (name, labelStart) =>
    S.js(`(()=>{const r=${row(name)};const b=[...r.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||x.textContent.trim()).startsWith(${JSON.stringify(labelStart)}));if(!b)throw new Error('no button ${labelStart}');b.click();return true})()`);
  const rowButtonState = (name, labelStart) =>
    S.js(`(()=>{const r=${row(name)};const b=r&&[...r.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||x.textContent.trim()).startsWith(${JSON.stringify(labelStart)}));return b?{disabled:b.disabled}:null})()`);
  const rowQuantity = (name) => S.js(`(()=>{const r=${row(name)};return r?Number(r.querySelector('.quantity-value').textContent):null})()`);
  const rowCount = () => S.js("document.querySelectorAll('.cart-item').length");
  const waitForQuantity = (name, quantity) => S.waitFor(`(()=>{const r=${row(name)};return !!r&&r.querySelector('.quantity-value').textContent===${JSON.stringify(String(quantity))}})()`, `${name} to have quantity ${quantity}`);

  const waitForCart = () => S.waitFor("!/Loading your cart/.test(document.body.innerText) && !!document.querySelector('h1')", "the cart to load");
  const waitForCards = () => S.waitFor("document.querySelectorAll('.product-card').length > 0 && !/Loading products/.test(document.body.innerText)", "the product cards");
  const openList = async () => {
    await S.goto(`${S.appUrl}/?search=${encodeURIComponent(S.tag)}`);
    await waitForCards();
  };
  const cartInDatabase = async (user) => {
    const cart = await S.models.Cart.findOne({ user: user._id });
    return cart ? cart.items.map((item) => ({ product: String(item.product), quantity: item.quantity })) : [];
  };

  // ---- A -------------------------------------------------------------------------
  sec("A. anonymous visitor", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.js("localStorage.clear()");
    S.resetCalls();
    await openList();
    S.check(
      "A. no Cart link for an anonymous visitor (only Products, Login, Sign up)",
      JSON.stringify(await linkTexts()) === JSON.stringify(["Products", "Login", "Sign up"]) && (await S.userLink()) === null,
      (await linkTexts()).join("|")
    );
    S.check("A. product cards still show an Add to Cart button", (await cardButtonState(P.alpha.name)).label === "Add to Cart");
    await cardButton(P.alpha.name, "Add to Cart");
    await S.waitFor("location.pathname === '/login'", "the redirect to login");
    S.check("A. clicking Add to Cart as anonymous goes to /login", (await S.url()) === "/login");
    await S.goto(`${S.appUrl}/cart`);
    await S.settleAt("/login");
    S.check("A. visiting /cart as anonymous redirects to /login", (await S.url()) === "/login");
    S.check("A. anonymous visitors never call the cart API", cartApiCalls().length === 0, cartApiCalls().join(", "));
  });

  // ---- B, C, D ---------------------------------------------------------------------
  sec("B/C/D. customer and empty cart", async () => {
    await S.uiLogin("alice");
    const links = await S.navbarLinks();
    S.check(
      "B. customer sees the Cart link (no count while the cart is empty), with Products and My Orders",
      (await cartLinkText()) === "Cart" && JSON.stringify(links) === JSON.stringify([{ text: "Products", href: "/" }, { text: "Cart", href: "/cart" }, { text: "My Orders", href: "/orders" }]),
      JSON.stringify(links)
    );
    await S.clickByText(".navbar-links a", "Cart");
    await S.waitFor("location.pathname === '/cart'", "the cart route");
    await waitForCart();
    S.check("C. /cart opens with the heading 'Shopping Cart'", (await S.js("document.querySelector('h1').textContent")) === "Shopping Cart");
    S.check(
      "D. an empty cart shows a friendly message and a way to continue shopping",
      (await S.text()).includes("Your cart is empty.") && (await S.js("!!([...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Continue Shopping'))"))
    );
    S.check("D. no checkout button is shown for an empty cart", !(await S.text()).includes("Proceed to Checkout"));
    await S.clickByText("a", "Continue Shopping");
    await S.waitFor("location.pathname === '/'", "the products page");
    S.check("D. Continue Shopping returns to the products", (await S.url()) === "/");
  });

  // ---- E, F ------------------------------------------------------------------------
  sec("E/F. adding products", async () => {
    await openList();
    await cardButton(P.alpha.name, "Add to Cart");
    await S.waitFor(`(${card(P.alpha.name)}).innerText.includes('Added to cart.')`, "the 'added' message");
    S.check("E. a friendly 'Added to cart.' message with a View cart link appears", (await cardText(P.alpha.name)).includes("View cart"));
    S.check("E. the item is really in the customer's cart (database)", JSON.stringify(await cartInDatabase(S.users.alice)) === JSON.stringify([{ product: pid(P.alpha), quantity: 1 }]));
    S.check("F. the navbar shows Cart (1)", (await cartLinkText()) === "Cart (1)", await cartLinkText());

    await cardButton(P.alpha.name, "Add to Cart");
    await waitForCartCount("Cart (2)");
    S.check("F. adding the same product again makes it Cart (2)", (await cartLinkText()) === "Cart (2)");
    await cardButton(P.beta.name, "Add to Cart");
    await waitForCartCount("Cart (3)");
    S.check("F. adding another product makes it Cart (3)", (await cartLinkText()) === "Cart (3)");
    S.check("E. out-of-stock product: the button is disabled and says 'Out of stock'", JSON.stringify(await cardButtonState(P.soldOut.name)) === JSON.stringify({ label: "Out of stock", disabled: true }));

    await S.goto(`${S.appUrl}/products/${pid(P.soldOut)}`);
    await S.waitFor("!!document.querySelector('.product-details')", "the sold-out product page");
    S.check("E. product page of an out-of-stock product: Add to Cart is disabled", await S.js("(()=>{const b=document.querySelector('.add-to-cart button');return !!b && b.disabled && b.textContent.trim()==='Out of stock'})()"));

    await S.goto(`${S.appUrl}/products/${pid(P.beta)}`);
    await S.waitFor("!!document.querySelector('.product-details .add-to-cart button')", "the Beta product page");
    await S.click(".add-to-cart button");
    await S.waitFor("!!document.querySelector('.add-to-cart-success')", "the 'added' message on the product page");
    await waitForCartCount("Cart (4)");
    S.check("F. adding from the product page works (Cart (4))", (await cartLinkText()) === "Cart (4)", await cartLinkText());
    await S.click(".add-to-cart button");
    await waitForCartCount("Cart (5)");
    await S.waitFor("!!document.querySelector('.add-to-cart button') && document.querySelector('.add-to-cart button').disabled", "the button to be disabled at the limit");
    S.check("F. when every unit of a product is in the cart the button says 'Maximum in cart'", (await S.js("document.querySelector('.add-to-cart button').textContent.trim()")) === "Maximum in cart");
  });

  // ---- G, H, I, J -------------------------------------------------------------------
  sec("G/H/I/J. the cart page", async () => {
    await S.clickByText(".navbar-links a", "Cart (5)");
    await S.waitFor("location.pathname === '/cart'", "the cart");
    await waitForCart();
    await S.waitFor("document.querySelectorAll('.cart-item').length === 2", "two rows");
    const text = await S.text();
    S.check(
      "cart rows show name, unit price, quantity, line total (from the server)",
      (await rowText(P.alpha.name)).includes("Rs. 250.75 each") && (await rowText(P.alpha.name)).includes("Rs. 501.5") && (await rowQuantity(P.alpha.name)) === 2
    );
    S.check("subtotal is the server's value: Rs. 801.47", text.includes("Rs. 801.47"), text.slice(0, 300));
    S.check("summary shows the item count", text.includes("5 items in your cart"));
    S.check("a product image is shown on each line", await S.js("document.querySelectorAll('.cart-item img').length === 2"));
    S.check(
      "'Proceed to Checkout' is now a working link to /checkout (the cart has no problems)",
      await S.js("(()=>{const a=[...document.querySelectorAll('a')].find(x=>x.textContent.trim()==='Proceed to Checkout');return !!a && a.getAttribute('href')==='/checkout'})()")
    );
    await S.shot("cart-desktop");

    await rowButton(P.alpha.name, "Increase quantity");
    await waitForQuantity(P.alpha.name, 3);
    await S.waitFor("document.body.innerText.includes('Rs. 1,052.22')", "the new subtotal");
    S.check("G. + increases the quantity (3), line total Rs. 752.25 and subtotal Rs. 1,052.22 come from the server", (await rowText(P.alpha.name)).includes("Rs. 752.25") && (await S.text()).includes("Rs. 1,052.22"));
    await waitForCartCount("Cart (6)");
    S.check("G. the navbar count follows (Cart (6))", (await cartLinkText()) === "Cart (6)", await cartLinkText());
    S.check("G. database agrees (alpha 3)", (await cartInDatabase(S.users.alice)).find((item) => item.product === pid(P.alpha)).quantity === 3);
    S.check("G. + is disabled at the stock limit (beta: 3 of 3)", (await rowButtonState(P.beta.name, "Increase quantity")).disabled === true);

    await rowButton(P.alpha.name, "Decrease quantity");
    await waitForQuantity(P.alpha.name, 2);
    S.check("H. − decreases the quantity (2)", (await rowQuantity(P.alpha.name)) === 2);
    await rowButton(P.alpha.name, "Decrease quantity");
    await waitForQuantity(P.alpha.name, 1);
    S.check("H. − is disabled at quantity 1 (it can never go below 1)", (await rowButtonState(P.alpha.name, "Decrease quantity")).disabled === true);

    // two clicks in the same instant must not add 2 (the request sets an absolute number)
    await S.js(`(()=>{const r=${row(P.alpha.name)};const b=[...r.querySelectorAll('button')].find(x=>x.getAttribute('aria-label').startsWith('Increase'));b.click();b.click();return true})()`);
    await waitForQuantity(P.alpha.name, 2);
    await S.sleep(500); // a wrong second increase would arrive within this time; nothing may change
    await waitForCart();
    S.check(
      "H. a double click still ends at exactly 2 (not 3)",
      (await rowQuantity(P.alpha.name)) === 2 && (await cartInDatabase(S.users.alice)).find((item) => item.product === pid(P.alpha)).quantity === 2,
      `${await rowQuantity(P.alpha.name)}`
    );

    await rowButton(P.beta.name, "Remove");
    await S.waitFor("document.querySelectorAll('.cart-item').length === 1", "the row to be removed");
    S.check("I. Remove takes the line out, with a confirmation message", (await rowText(P.beta.name)) === null && (await S.text()).includes("was removed from your cart"));
    await waitForCartCount("Cart (2)");
    S.check(
      "I. database agrees and the navbar says Cart (2)",
      JSON.stringify(await cartInDatabase(S.users.alice)) === JSON.stringify([{ product: pid(P.alpha), quantity: 2 }]) && (await cartLinkText()) === "Cart (2)"
    );

    // Clear Cart asks first. Answering No must send nothing at all.
    const clearsBefore = S.apiCalls.filter((call) => call.startsWith("DELETE") && /\/api\/cart$/.test(call)).length;
    await S.js("window.confirm = () => false; true");
    await S.clickByText("button", "Clear Cart");
    await S.sleep(300); // nothing is supposed to happen; give a wrong request time to show up
    S.check(
      "J. Clear Cart asks first; answering No keeps the cart (and sends nothing)",
      (await rowCount()) === 1 && (await cartInDatabase(S.users.alice)).length === 1 && S.apiCalls.filter((call) => call.startsWith("DELETE") && /\/api\/cart$/.test(call)).length === clearsBefore
    );
    await S.js("window.confirm = () => true; true");
    await S.clickByText("button", "Clear Cart");
    await S.waitFor("document.body.innerText.includes('Your cart is empty.')", "the cart to be cleared");
    await waitForCartCount("Cart");
    S.check("J. answering Yes empties the cart (empty state, no count in the navbar, database empty)", (await cartLinkText()) === "Cart" && (await cartInDatabase(S.users.alice)).length === 0);
  });

  // ---- K -------------------------------------------------------------------------
  sec("K. logout / login", async () => {
    await openList();
    await cardButton(P.alpha.name, "Add to Cart");
    await waitForCartCount("Cart (1)");
    const keys = await S.js("Object.keys(localStorage).sort().join(',')");
    S.check("K. only the login (token, user) is kept in localStorage, never cart data or prices", keys === "token,user", keys);

    await S.uiLogout();
    S.check("K. after logout the Cart link is gone", JSON.stringify(await linkTexts()) === JSON.stringify(["Products", "Login", "Sign up"]) && (await S.userLink()) === null);
    S.check("K. localStorage is empty after logout", (await S.js("Object.keys(localStorage).length")) === 0);
    await S.goto(`${S.appUrl}/cart`);
    await S.settleAt("/login");
    S.check("K. /cart after logout goes to /login", (await S.url()) === "/login");

    await S.uiLogin("bob");
    S.check("K. a different customer starts with an empty cart (no count)", (await cartLinkText()) === "Cart");
    await S.clickByText(".navbar-links a", "Cart");
    await waitForCart();
    S.check("K. and /cart shows no products of the previous customer", (await S.text()).includes("Your cart is empty.") && !(await S.text()).includes(P.alpha.name));
    await openList();
    await cardButton(P.beta.name, "Add to Cart");
    await waitForCartCount("Cart (1)");
    await S.uiLogout();

    await S.uiLogin("alice");
    await waitForCartCount("Cart (1)");
    await S.clickByText(".navbar-links a", "Cart (1)");
    await waitForCart();
    await S.waitFor("document.querySelectorAll('.cart-item').length === 1", "Alice's row");
    S.check("K. coming back, Alice sees her own cart (Alpha) and not Bob's (Beta)", (await rowText(P.alpha.name)) !== null && (await rowText(P.beta.name)) === null);
  });

  // ---- L -------------------------------------------------------------------------
  sec("L. problems and stock messages", async () => {
    const alice = S.users.alice;
    await S.models.Cart.deleteMany({ user: alice._id });
    await S.models.Cart.create({
      user: alice._id,
      items: [{ product: P.p4._id, quantity: 3 }, { product: P.p5._id, quantity: 2 }, { product: P.p6._id, quantity: 2 }, { product: P.p7._id, quantity: 1 }, { product: P.p8._id, quantity: 1 }],
    });
    await S.models.Product.updateOne({ _id: P.p5._id }, { stock: 0 });
    await S.models.Product.updateOne({ _id: P.p6._id }, { stock: 1 });
    await S.models.Product.updateOne({ _id: P.p7._id }, { isActive: false });
    await S.models.Product.deleteOne({ _id: P.p8._id });
    await S.goto(`${S.appUrl}/cart`);
    await waitForCart();
    await S.waitFor("document.querySelectorAll('.cart-item').length === 5", "5 rows");

    S.check(
      "L. out of stock: clear message, +/− disabled, Remove still works",
      (await rowText(P.p5.name)).includes("out of stock") && (await rowButtonState(P.p5.name, "Increase quantity")).disabled && (await rowButtonState(P.p5.name, "Decrease quantity")).disabled && !(await rowButtonState(P.p5.name, "Remove")).disabled
    );
    S.check(
      "L. insufficient stock: says how many are available and offers 'Change to 1'",
      (await rowText(P.p6.name)).includes("Only 1 in stock, but you have 2 in your cart.") && (await rowText(P.p6.name)).includes("Change to 1")
    );
    S.check(
      "L. inactive: 'no longer available' and the name is not a link",
      (await rowText(P.p7.name)).includes("no longer available") && (await S.js(`(()=>{const r=${row(P.p7.name)};return !r.querySelector('.cart-item-name a')})()`))
    );
    S.check("L. product that no longer exists: says so and offers removal", (await rowText("This product no longer exists")).includes("no longer exists. Please remove it"));
    const text = await S.text();
    S.check("L. the summary warns that some items are excluded, and the subtotal is only the buyable line (3 x 40 = Rs. 120)", text.includes("not included in the subtotal") && text.includes("Rs. 120"), text.slice(-400));
    S.check("L. checkout button stays disabled while there are problems", await S.js("[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Proceed to Checkout').disabled"));
    await S.shot("cart-problems-desktop");

    await S.clickByText("button", "Change to 1");
    await S.waitFor(`(()=>{const r=${row(P.p6.name)};return !!r&&!r.innerText.includes('Only 1 in stock')})()`, "the problem to go away");
    S.check("L. 'Change to 1' fixes the line (quantity 1, problem gone)", (await rowQuantity(P.p6.name)) === 1 && (await cartInDatabase(alice)).find((item) => item.product === pid(P.p6)).quantity === 1);
    await rowButton(P.p7.name, "Remove");
    await S.waitFor("document.querySelectorAll('.cart-item').length === 4", "the unavailable line to be removed");
    S.check("L. an unavailable line can be removed", (await rowText(P.p7.name)) === null);

    // stale page: the page says stock 5, the real stock dropped to 2, the customer clicks +
    await S.models.Product.updateOne({ _id: P.p4._id }, { stock: 2 });
    await rowButton(P.p4.name, "Increase quantity");
    await S.waitFor("!!document.querySelector('.status-error')", "the friendly refusal");
    const refusal = await S.js("document.querySelector('.status-error').textContent");
    S.check("L. a refused change shows the server's friendly message (not a raw error)", /Only 2 of .* in stock/.test(refusal) && !/AxiosError|status code|Request failed/i.test(refusal), refusal);
    await S.waitFor(`(()=>{const r=${row(P.p4.name)};return !!r&&r.innerText.includes('Only 2 in stock')})()`, "the cart to refresh");
    S.check("L. ...and the cart was refreshed, so the page now shows the real stock problem", (await rowText(P.p4.name)).includes("Only 2 in stock"));

    // stale product card
    await openList();
    await S.models.Product.updateOne({ _id: P.stale._id }, { stock: 0 });
    await cardButton(P.stale.name, "Add to Cart");
    await S.waitFor(`(${card(P.stale.name)}).innerText.includes('out of stock')`, "the card message");
    S.check("L. adding a product that just sold out shows a friendly message on the card", !/AxiosError|status code|Request failed/i.test(await cardText(P.stale.name)));
  });

  // ---- network and session problems --------------------------------------------------
  sec("network and session problems", async () => {
    // 1. the cart cannot be LOADED: only the cart request fails (the rest of the site keeps working)
    S.interceptor = (paused) => isCartRequest(paused) && (S.failRequest(paused), true);
    await S.goto(`${S.appUrl}/cart`);
    await S.waitFor("!!document.querySelector('.message-box-error')", "the load error box");
    let text = await S.text();
    S.check("a cart that cannot be loaded shows a friendly error with 'Try again' (no raw error)", /Cannot reach the server/.test(text) && text.includes("Try again") && !/Network Error|AxiosError/.test(text), text.slice(0, 200));
    S.check("...and does not claim the cart is empty", !text.includes("Your cart is empty"));
    S.interceptor = null;
    await S.clickByText("button", "Try again");
    await S.waitFor("document.querySelectorAll('.cart-item').length > 0", "the cart to recover");
    S.check("'Try again' loads the cart once the connection is back", (await rowCount()) > 0);

    // 2. a CHANGE fails because the connection drops
    await S.setOffline(true);
    await rowButton(P.p6.name, "Remove");
    await S.waitFor("!!document.querySelector('.status-error')", "the offline error");
    text = await S.js("document.querySelector('.status-error').textContent");
    S.check("offline: a failed change shows a friendly message, not a raw error", /Cannot reach the server/.test(text) && !/Network Error|AxiosError/.test(text), text);
    await S.setOffline(false);
    S.check("offline: the line is still on screen (nothing was removed)", (await rowText(P.p6.name)) !== null);

    // expired session: the saved token stops working, the next cart action logs the customer out
    await S.goto(`${S.appUrl}/cart`);
    await waitForCart();
    await S.waitFor("document.querySelectorAll('.cart-item').length > 0", "the rows again");
    await S.js("localStorage.setItem('token','expired.or.invalid')");
    await rowButton(P.p4.name, "Remove");
    await S.waitFor("location.pathname === '/login'", "the redirect after a 401");
    S.check(
      "expired session: the customer is logged out and sent to /login",
      (await S.js("localStorage.getItem('token')")) === null && JSON.stringify(await linkTexts()) === JSON.stringify(["Products", "Login", "Sign up"])
    );
  });

  // ---- M -------------------------------------------------------------------------
  sec("M. admin", async () => {
    await S.uiLogin("admin");
    S.resetCalls();
    const texts = await linkTexts();
    S.check("M. admin sees no Cart link", !texts.some((text) => text.startsWith("Cart")), texts.join("|"));
    await S.goto(`${S.appUrl}/cart`);
    await S.settleAt("/");
    S.check("M. admin visiting /cart is sent to the home page", (await S.url()) === "/");
    await openList();
    S.check("M. admin sees no Add to Cart buttons on the product cards", (await S.js("document.querySelectorAll('.add-to-cart').length")) === 0);
    await S.goto(`${S.appUrl}/products/${pid(P.alpha)}`);
    await S.waitFor("!!document.querySelector('.product-details')", "the product page as admin");
    S.check("M. ...nor on the product page", (await S.js("document.querySelectorAll('.add-to-cart').length")) === 0);
    S.check("M. the admin session made no cart API calls at all", cartApiCalls().length === 0, cartApiCalls().join(", "));
    const adminTexts = await linkTexts();
    S.check("M. admin navigation is unchanged", adminTexts.includes("Admin Products") && adminTexts.includes("Admin Categories"));
    await S.uiLogout();
  });

  // ---- N -------------------------------------------------------------------------
  sec("N. existing pages", async () => {
    await openList();
    S.check("N. product listing still works (cards shown)", (await S.js("document.querySelectorAll('.product-card').length")) >= 5);
    await S.click(".product-card .product-name a");
    await S.waitFor("!!document.querySelector('.product-details')", "the product details");
    S.check("N. product details still work", (await S.js("document.querySelector('.product-details h1').textContent")).includes(S.tag));
    await S.goto(`${S.appUrl}/health`);
    await S.waitFor("document.body.innerText.includes('API is working')", "the health page");
    S.check("N. /health still works", (await S.text()).includes("API is working"));
  });

  // ---- O -------------------------------------------------------------------------
  sec("O. three screen widths", async () => {
    await S.uiLogin("alice");
    await S.models.Cart.deleteMany({ user: S.users.alice._id });
    const long = await makeProduct("Resp Long Name Product With Many Words To Test Wrapping Behaviour On Small Screens", 1234.5, 8);
    const two = await makeProduct("Resp Two", 20, 1);
    await S.models.Cart.create({ user: S.users.alice._id, items: [{ product: long._id, quantity: 3 }, { product: two._id, quantity: 1 }, { product: P.p5._id, quantity: 1 }] });
    for (const [label, width, height, mobile] of [["mobile", 375, 800, true], ["tablet", 768, 1000, false], ["desktop", 1280, 900, false]]) {
      await S.viewport(width, height, mobile);
      await S.goto(`${S.appUrl}/cart`);
      await waitForCart();
      await S.waitFor("document.querySelectorAll('.cart-item').length === 3", `3 rows (${label})`);
      const columns = await S.js("getComputedStyle(document.querySelector('.cart-layout')).gridTemplateColumns.split(' ').length");
      S.check(`${label} (${width}px): cart has no horizontal scroll`, await S.noHScroll());
      S.check(`${label}: layout is ${label === "desktop" ? "items + summary (2 columns)" : "1 column"}`, label === "desktop" ? columns === 2 : columns === 1, `${columns}`);
      const small = await S.js("[...document.querySelectorAll('.cart-item button, .cart-summary button, .cart-summary a.button')].filter(e=>e.offsetParent && e.getBoundingClientRect().height < 32).length");
      S.check(`${label}: buttons are tap-friendly (>= 32px tall)`, small === 0, `${small} too small`);
      const overflowing = await S.js("[...document.querySelectorAll('.cart-item, .cart-summary')].filter(e=>e.scrollWidth > e.clientWidth + 1).length");
      S.check(`${label}: nothing overflows its box (long names wrap)`, overflowing === 0, `${overflowing}`);
      await S.shot(`cart-${label}`);

      await openList();
      S.check(`${label} (${width}px): product list with Add to Cart buttons has no horizontal scroll`, await S.noHScroll());
      S.check(`${label}: navbar with the Cart count has no horizontal scroll`, await S.noHScroll());
      await S.shot(`list-${label}`);
    }
    await S.viewport(1280, 900, false);
    await S.uiLogout();
  });

  // ---- whole run -------------------------------------------------------------------
  sec("whole-run checks", async () => {
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
    S.check("the browser console stayed clean (no errors, warnings or exceptions)", S.consoleProblems.length === 0, S.consoleProblems.slice(0, 3).join(" | "));
  });
});
