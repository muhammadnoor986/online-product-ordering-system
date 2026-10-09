// Checkout and the order page: opening checkout from the cart, who may use it, an empty cart,
// unavailable items, delivery validation, a successful order, duplicate clicks, refusals by the
// server (409), an expired session, network and server failures (including "the answer got lost"),
// the order page, and the layouts on three screen widths.
// (Moved into the repository from the old scratch folder, where it was "checkoutE2E".)
//
// How this suite waits: it never sleeps to "give the page time". Every wait names the thing it waits
// for: the cart count in the navbar, the Place Order button becoming usable, the address changing,
// the order page showing its heading or banner, a field message appearing. A short fixed pause is used
// in ONE kind of place only: to prove that something did NOT happen (see settleBriefly).
//
// Run it with:  npm run test:e2e -- checkoutE2E
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");
const { startImageServer } = require("../lib/imageServer");

describe("checkout and the order page", () => {
  let S;
  const sec = (title, body) => section(() => S, title, body);

  let images;
  let category;
  let productA; // Alpha
  let productB; // Beta
  let firstOrderPath; // the order page of customer c1 (used again in later sections)
  let firstOrderId;

  const HEX_ID = /^\/orders\/[0-9a-f]{24}$/;
  const URDU_NAME = String.fromCharCode(0x0639, 0x0644, 0x06cc, 0x200c, 0x062e, 0x0627, 0x0646);
  const orderPosts = []; // the bodies of every POST /api/orders the page sent

  before(async () => {
    S = await startSuite("checkoutE2E");
    images = await startImageServer();
    // Also see the ANSWERS to order requests, so a test can make an answer get lost
    await S.watchResponses("orders");
    S.cdp.on("Network.requestWillBeSent", (event) => {
      if (event.request.method === "POST" && /\/api\/orders$/.test(event.request.url)) orderPosts.push(event.request.postData);
    });

    category = await S.models.Category.create({ name: `${S.tag} Category` });
    await S.newUser("admin", "admin");
    productA = await makeProduct("Alpha", 250.75, 10);
    productB = await makeProduct("Beta", 99.99, 5);
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
  const putCart = async (user, lines) => {
    await S.models.Cart.deleteMany({ user: user._id });
    await S.models.Cart.create({ user: user._id, items: lines.map(([product, quantity]) => ({ product: product._id, quantity })) });
  };
  const dbOrders = (user) => S.models.Order.find({ user: user._id }).sort({ createdAt: 1 });
  const dbCart = async (user) => {
    const cart = await S.models.Cart.findOne({ user: user._id });
    return cart ? cart.items.map((item) => ({ product: String(item.product), quantity: item.quantity })) : [];
  };
  const stockOf = async (product) => (await S.models.Product.findById(product._id)).stock;
  const callsTo = (method, fragment) => S.apiCalls.filter((call) => call.startsWith(`${method} `) && call.includes(fragment));
  const forgetCalls = () => { S.resetCalls(); orderPosts.length = 0; };
  const linkTexts = async () => (await S.navbarLinks()).map((link) => link.text);

  // ---- request interceptors (what the test does to the order requests) -------------------
  const isOrderPost = (paused) => paused.request.method === "POST" && /\/api\/orders$/.test(paused.request.url);
  const isOrderList = (paused) => paused.request.method === "GET" && /\/api\/orders(\?|$)/.test(paused.request.url);
  const isOneOrder = (paused) => paused.request.method === "GET" && /\/api\/orders\/[0-9a-f]{24}/.test(paused.request.url);
  const interceptors = {
    // the request never reaches the server
    failRequest: (paused) => !S.isResponseStage(paused) && isOrderPost(paused) && (S.failRequest(paused), true),
    // the server creates the order, but the ANSWER is lost on its way back
    failResponse: (paused) => S.isResponseStage(paused) && isOrderPost(paused) && (S.failRequest(paused, "ConnectionReset"), true),
    // the answer is lost AND the page's check of "did my order get created?" fails too
    failResponseAndCheck: (paused) =>
      (S.isResponseStage(paused) && isOrderPost(paused) && (S.failRequest(paused, "ConnectionReset"), true)) ||
      (!S.isResponseStage(paused) && isOrderList(paused) && (S.failRequest(paused), true)),
    // the order page cannot be loaded
    failGetOrders: (paused) => !S.isResponseStage(paused) && (isOrderList(paused) || isOneOrder(paused)) && (S.failRequest(paused), true),
    // the server "answers" with a made-up response
    fulfill: (status, body) => (paused) => !S.isResponseStage(paused) && isOrderPost(paused) && (S.fulfill(paused, status, body), true),
  };

  // ---- named waits ----------------------------------------------------------------------
  // The cart count in the navbar arrives after the cart request finishes, so wait for the value itself
  const waitForCartLink = (text) => S.waitFor(`document.querySelector('.navbar-links a[href="/cart"]')?.textContent.trim() === ${JSON.stringify(text)}`, `the navbar to say "${text}"`);
  const cartLinkText = () => S.js("(()=>{const a=[...document.querySelectorAll('.navbar-links a')].find(x=>x.getAttribute('href')==='/cart');return a?a.textContent.trim():null})()");
  const placeButton = () => S.js("(()=>{const b=document.querySelector('button[form=\"checkout-form\"]');return b?{text:b.textContent.trim(),disabled:b.disabled}:null})()");
  // Place Order is usable: it exists, says "Place Order" (not "Placing...") and is not disabled
  const waitForPlaceOrderReady = async () => {
    try {
      await S.waitFor("(()=>{const b=document.querySelector('button[form=\"checkout-form\"]');return !!b && b.textContent.trim()==='Place Order' && !b.disabled})()", "Place Order to be usable");
    } catch (error) {
      // Say what the page looked like, so a failure can be understood without guessing
      const seen = await S.js("JSON.stringify({ path: location.pathname, button: (()=>{const b=document.querySelector('button[form=\\\"checkout-form\\\"]');return b?{text:b.textContent.trim(),disabled:b.disabled}:null})(), notices: [...document.querySelectorAll('.status, .checkout-problems, .message-box')].map(e=>e.innerText.replace(/\s+/g,' ').slice(0,120)) })").catch(() => "(page not readable)");
      const lastCalls = S.apiCalls.slice(-8).map((call) => call.replace(S.apiUrl, "")).join(" , ");
      throw new Error(`Place Order did not become usable. The page showed: ${seen}. Last API calls: ${lastCalls}`);
    }
  };
  const waitForPlaceOrderDisabled = () =>
    S.waitFor("(()=>{const b=document.querySelector('button[form=\"checkout-form\"]');return !!b && b.disabled})()", "Place Order to be disabled");
  const waitForCheckoutForm = () => S.waitFor("!!document.querySelector('#checkout-form') && !/Loading your checkout/.test(document.body.innerText)", "the checkout form");
  // Opens checkout and waits until the page has finished loading its own data (the browser reports the network as quiet).
  // Without this, the page may still be refreshing the cart when a test changes the data behind its back.
  const goCheckout = async () => {
    await S.gotoSettled(`${S.appUrl}/checkout`);
    await waitForCheckoutForm();
  };
  // Clicks Place Order, but only once the button can really be used (a click on a disabled button does nothing)
  const submit = async () => {
    await waitForPlaceOrderReady();
    await S.click('button[form="checkout-form"]');
  };
  const waitForOrderPage = () =>
    S.waitFor("!/Loading your order/.test(document.body.innerText) && !!document.querySelector('h1') && document.querySelector('h1').textContent.startsWith('Order ORD-')", "the order page");
  // After Place Order: wait for the new order's own page. If it never comes, say why (what the page shows, how many requests were sent)
  const waitForOrderPlaced = async (label = "the order to be placed") => {
    try {
      await S.waitFor(`${HEX_ID}.test(location.pathname)`, `the address of the new order (${label})`);
      await waitForOrderPage();
    } catch (error) {
      const shown = (await S.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`The order was not placed (${label}). Order requests sent: ${orderPosts.length}. The page says: "${shown}"`);
    }
  };
  const fieldError = (name) => S.js(`(()=>{const e=document.getElementById('checkout-${name}-error');return e?e.textContent.trim():null})()`);
  const fillValid = async (overrides = {}) => {
    const values = { fullName: "Test Customer", phone: "+92 300 1234567", addressLine1: "House 12, Street 5, Model Town", addressLine2: "", city: "Lahore", postalCode: "54000", notes: "", ...overrides };
    for (const [key, value] of Object.entries(values)) await S.setValue(`#checkout-${key}`, value);
    return values;
  };
  // Only for proving that something did NOT happen (for example "no request was sent"): there is no
  // event to wait for, so a wrong request is given a moment to show up before the test looks.
  const settleBriefly = () => S.sleep(300);

  // ---- 1 -------------------------------------------------------------------------
  sec("1. opening checkout from the cart", async () => {
    const c1 = await S.newUser("c1");
    await putCart(c1, [[productA, 2], [productB, 1]]);
    await S.uiLogin("c1");
    await waitForCartLink("Cart (3)"); // the count appears only after the cart request has finished
    await S.clickByText(".navbar-links a", "Cart (3)");
    await S.waitFor("location.pathname === '/cart' && document.querySelectorAll('.cart-item').length === 2", "the cart page");
    S.check(
      "cart: 'Proceed to Checkout' is a link to /checkout when there are no problems",
      await S.js("(()=>{const a=[...document.querySelectorAll('a')].find(x=>x.textContent.trim()==='Proceed to Checkout');return !!a && a.getAttribute('href')==='/checkout'})()")
    );
    await S.clickByText("a", "Proceed to Checkout");
    await waitForCheckoutForm();
    S.check("customer reaches /checkout from the cart", (await S.url()) === "/checkout");
    const text = await S.text();
    S.check(
      "summary lists both products with quantities and the server's line totals",
      text.includes(`${S.tag} Alpha × 2`) && text.includes("Rs. 501.5") && text.includes(`${S.tag} Beta × 1`) && text.includes("Rs. 99.99"),
      text.slice(0, 500)
    );
    const summary = await S.js("document.querySelector('.cart-summary').innerText");
    S.check("summary shows subtotal, shipping Rs. 0 and total Rs. 601.49", summary.includes("Rs. 601.49") && summary.includes("Shipping"), summary);
    S.check(
      "Cash on Delivery is the only payment option and is selected",
      (await S.js("document.querySelectorAll('input[name=paymentMethod]').length")) === 1 && (await S.js("document.querySelector('input[name=paymentMethod]').checked")) && (await S.text()).includes("Cash on Delivery")
    );
    S.check("the name is pre-filled from the account and can be edited", (await S.js("document.querySelector('#checkout-fullName').value")) === "c1 tester");
    await waitForPlaceOrderReady();
    S.check("Place Order is available", JSON.stringify(await placeButton()) === JSON.stringify({ text: "Place Order", disabled: false }));
    await S.shot("checkout-desktop");
  });

  // ---- 2 -------------------------------------------------------------------------
  sec("2. anonymous visitor and admin", async () => {
    await S.uiLogout();
    forgetCalls();
    await S.goto(`${S.appUrl}/checkout`);
    await S.settleAt("/login");
    S.check("anonymous visitor is sent to /login", (await S.url()) === "/login");
    await S.goto(`${S.appUrl}/orders/${"a".repeat(24)}`);
    await S.settleAt("/login");
    S.check("anonymous visitor cannot open an order page either", (await S.url()) === "/login");
    S.check("anonymous visitors make no cart or order API calls", S.apiCalls.filter((call) => /\/api\/(cart|orders)/.test(call)).length === 0, S.apiCalls.join(", "));

    await S.uiLogin("admin");
    forgetCalls();
    await S.goto(`${S.appUrl}/checkout`);
    await S.settleAt("/");
    S.check("admin is sent to the home page from /checkout", (await S.url()) === "/");
    await S.goto(`${S.appUrl}/orders/${"a".repeat(24)}`);
    await S.settleAt("/");
    S.check("admin is sent to the home page from an order page", (await S.url()) === "/");
    S.check("admin makes no cart or order API calls", S.apiCalls.filter((call) => /\/api\/(cart|orders)/.test(call)).length === 0, S.apiCalls.join(", "));
    await S.uiLogout();
  });

  // ---- 3 -------------------------------------------------------------------------
  sec("3. empty cart", async () => {
    await S.newUser("c3");
    await S.uiLogin("c3");
    await S.goto(`${S.appUrl}/checkout`);
    await S.waitFor("document.body.innerText.includes('nothing to check out')", "the empty-cart message");
    S.check("an empty cart shows a friendly message and no form", !(await S.has("#checkout-form")) && !(await S.has('button[form="checkout-form"]')));
    S.check("...with a way to keep shopping", await S.js("!![...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Continue Shopping')"));
    S.check("nothing was ordered", (await dbOrders(S.users.c3)).length === 0);
    await S.uiLogout();
  });

  // ---- 4 -------------------------------------------------------------------------
  sec("4. unavailable items", async () => {
    await S.newUser("c4");
    const fine = await makeProduct("Fine4", 10, 5);
    const hidden = await makeProduct("Hidden4", 20, 5);
    await putCart(S.users.c4, [[fine, 1], [hidden, 1]]);
    await S.models.Product.updateOne({ _id: hidden._id }, { isActive: false });
    await S.uiLogin("c4");
    await S.goto(`${S.appUrl}/cart`);
    await S.waitFor("document.querySelectorAll('.cart-item').length === 2", "the cart rows");
    S.check(
      "cart: with a problem item 'Proceed to Checkout' is disabled with an explanation",
      (await S.js("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Proceed to Checkout');return !!b&&b.disabled})()")) && (await S.text()).includes("fix the items that need attention")
    );

    await goCheckout();
    const text = await S.text();
    S.check(
      "checkout names the unavailable product and links back to the cart",
      text.includes("cannot be ordered right now") && text.includes(`${S.tag} Hidden4`) && (await S.js("!![...document.querySelectorAll('.status a')].find(a=>a.getAttribute('href')==='/cart')"))
    );
    await waitForPlaceOrderDisabled();
    S.check("Place Order is disabled while an item is unavailable", (await placeButton()).disabled === true);

    await fillValid();
    forgetCalls();
    await S.js("document.querySelector('#checkout-form').requestSubmit(); true");
    await settleBriefly(); // nothing is supposed to happen: give a wrong request time to show up
    S.check("even submitting the form directly (Enter key) sends nothing", callsTo("POST", "/api/orders").length === 0 && (await dbOrders(S.users.c4)).length === 0);

    await S.clickByText("a", "go back to your cart");
    await S.waitFor("location.pathname === '/cart'", "the cart");
    await S.js("(()=>{const r=[...document.querySelectorAll('.cart-item')].find(x=>x.querySelector('.cart-item-name').textContent.includes('Hidden4'));[...r.querySelectorAll('button')].find(b=>b.textContent.trim()==='Remove').click();return true})()");
    await S.waitFor("document.querySelectorAll('.cart-item').length === 1", "the line to be removed");
    await S.waitFor("!!([...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Proceed to Checkout'))", "the checkout link to come back");
    S.check("after removing it, checkout is available again", await S.js("(()=>{const a=[...document.querySelectorAll('a')].find(x=>x.textContent.trim()==='Proceed to Checkout');return !!a && a.getAttribute('href')==='/checkout'})()"));
    await S.uiLogout();
  });

  // ---- 5 -------------------------------------------------------------------------
  sec("5. delivery validation", async () => {
    await S.newUser("c5");
    const product = await makeProduct("Val5", 30, 20);
    await putCart(S.users.c5, [[product, 1]]);
    await S.uiLogin("c5");
    await goCheckout();
    forgetCalls();
    await submit();
    await S.waitFor("!!document.getElementById('checkout-phone-error')", "the validation messages");
    S.check(
      "empty form: messages for phone, address and city (the pre-filled name is fine)",
      (await fieldError("phone")) === "Phone number is required" && (await fieldError("addressLine1")) === "Address is required" && (await fieldError("city")) === "City is required" && (await fieldError("fullName")) === null
    );
    S.check("the first invalid field gets the focus", (await S.js("document.activeElement && document.activeElement.id")) === "checkout-phone");
    S.check("invalid fields are marked for screen readers (aria-invalid)", (await S.js("document.querySelector('#checkout-phone').getAttribute('aria-invalid')")) === "true");
    S.check("nothing was sent to the server", callsTo("POST", "/api/orders").length === 0);

    const cases = [
      ["fullName", "A", "at least 2"], ["fullName", "   ", "required"], ["fullName", "A".repeat(101), "at most 100"],
      ["phone", "abc", "at least 7"], ["phone", "abcdefgh", "not valid"], ["phone", "12345678901234567", "not valid"], ["phone", "+++1234567", "not valid"],
      ["addressLine1", "abcd", "at least 5"], ["addressLine2", "x".repeat(201), "at most 200"], ["city", "L", "at least 2"],
      ["postalCode", "54_000", "not valid"], ["postalCode", "1".repeat(13), "at most 12"], ["notes", "n".repeat(301), "at most 300"],
      ["addressLine1", "House" + String.fromCharCode(0x85) + "12 street", "invalid characters"],
      ["addressLine2", "Near" + String.fromCharCode(0x2028) + "park", "invalid characters"],
      ["city", "Lah" + String.fromCharCode(0x202e) + "ore", "invalid characters"],
      ["notes", "bell" + String.fromCharCode(7) + "ring", "invalid characters"],
    ];
    let allMessages = true;
    let problems = "";
    await fillValid();
    for (const [field, value, expected] of cases) {
      await S.setValue(`#checkout-${field}`, value);
      // wait for THIS message to appear (not for time to pass); a case that never shows it is reported, not skipped
      const shown = await S.waitFor(`(()=>{const e=document.getElementById('checkout-${field}-error');return !!e && e.textContent.includes(${JSON.stringify(expected)})})()`, `${field} message "${expected}"`, 3000).then(() => true, () => false);
      if (!shown) {
        allMessages = false;
        problems += `${field}=${JSON.stringify(value).slice(0, 20)} got ${await fieldError(field)}; `;
      }
      await fillValid(); // put it right again
      const cleared = await S.waitFor(`!document.getElementById('checkout-${field}-error')`, `${field} message to clear`, 3000).then(() => true, () => false);
      if (!cleared) {
        allMessages = false;
        problems += `${field} error did not clear; `;
      }
    }
    S.check("17 invalid values each show the right message (and clear when fixed)", allMessages, problems);

    await fillValid({ notes: "Call first\nGate 3 " + URDU_NAME, fullName: URDU_NAME, city: URDU_NAME });
    S.check(
      "Urdu text (with the zero-width joiner) is accepted, notes may contain line breaks",
      (await fieldError("fullName")) === null && (await fieldError("city")) === null && (await fieldError("notes")) === null
    );
    S.check("the notes counter shows the length", (await S.text()).includes("/300"));
    S.check("still nothing sent while the form was invalid or being edited", callsTo("POST", "/api/orders").length === 0);
    await S.uiLogout();
  });

  // ---- 6 -------------------------------------------------------------------------
  sec("6. successful order (customer c1)", async () => {
    await S.uiLogin("c1");
    await goCheckout();
    await S.setValue("#checkout-fullName", "Ayesha Khan");
    const notes = "Call first\nGate 3 " + URDU_NAME;
    await fillValid({ fullName: "Ayesha Khan", addressLine2: "Near the park", notes });
    forgetCalls();
    await submit();
    await waitForOrderPlaced("customer c1");
    firstOrderPath = await S.url();
    S.check("after placing the order the customer lands on /orders/<the new order's id>", HEX_ID.test(firstOrderPath), firstOrderPath);

    const orders = await dbOrders(S.users.c1);
    S.check("exactly one order was created", orders.length === 1);
    const order = orders[0];
    firstOrderId = String(order._id);
    S.check("the redirect used the real order id", firstOrderPath === `/orders/${order._id}`);

    const posted = JSON.parse(orderPosts[0]);
    S.check(
      "the request carried only delivery, paymentMethod 'cod' and expectedTotal",
      JSON.stringify(Object.keys(posted).sort()) === JSON.stringify(["delivery", "expectedTotal", "paymentMethod"]) && posted.paymentMethod === "cod",
      JSON.stringify(Object.keys(posted))
    );
    S.check("expectedTotal was the total on screen (601.49) and the delivery has the 7 fields", posted.expectedTotal === 601.49 && Object.keys(posted.delivery).length === 7);
    S.check("nothing price-related or status-related was sent", !/price|lineTotal|subtotal|shipping|status|user|stock|orderNumber/i.test(orderPosts[0].replace(/addressLine/g, "")), orderPosts[0].slice(0, 200));
    S.check(
      "stored order: pending, COD, payment pending, shipping 0, total 601.49",
      order.status === "pending" && order.paymentMethod === "cod" && order.paymentStatus === "pending" && order.shippingFee === 0 && order.total === 601.49 && order.subtotal === 601.49
    );
    S.check(
      "stored delivery matches what was typed (edited name, notes with line break and Urdu)",
      order.delivery.fullName === "Ayesha Khan" && order.delivery.addressLine2 === "Near the park" && order.delivery.notes === notes && order.delivery.city === "Lahore"
    );
    S.check("stock was deducted exactly (Alpha 10 -> 8, Beta 5 -> 4) and the cart is empty", (await stockOf(productA)) === 8 && (await stockOf(productB)) === 4 && (await dbCart(S.users.c1)).length === 0);
    await waitForCartLink("Cart"); // the count disappears once the page has learned the cart is empty
    S.check("the navbar cart count is gone", (await cartLinkText()) === "Cart", await cartLinkText());

    const text = await S.text();
    S.check("order page: success banner with the order number", text.includes("Thank you! Your order has been placed.") && text.includes(order.orderNumber));
    S.check("order page: items with price x quantity and line totals", text.includes(`${S.tag} Alpha`) && text.includes("2 × Rs. 250.75") && text.includes("Rs. 501.5") && text.includes("1 × Rs. 99.99"), text.slice(0, 500));
    S.check("order page: subtotal, shipping and total from the server", text.includes("Rs. 601.49") && text.includes("Shipping"));
    S.check("order page: Cash on Delivery, payment status Pending, order status Pending", text.includes("Cash on Delivery") && text.includes("Pending"));
    S.check(
      "order page: the delivery details (name, address lines, city, phone, notes)",
      text.includes("Ayesha Khan") && text.includes("House 12, Street 5, Model Town") && text.includes("Near the park") && text.includes("Lahore 54000") && text.includes("+92 300 1234567") && text.includes("Gate 3")
    );
    // (The old suite asserted that a fresh order page had NO cancel button. That was written before customers could
    //  cancel and is now wrong: a pending order offers "Cancel order". This is the current behavior; the whole
    //  cancelling flow has its own suite, step7aCancel.)
    S.check(
      "order page: a just-placed (pending) order offers 'Cancel order'",
      await S.js("!![...document.querySelectorAll('.cancel-panel button')].find(b=>b.textContent.trim()==='Cancel order')")
    );

    const keys = await S.js("Object.keys(localStorage).sort().join(',')");
    S.check("only the login is kept in localStorage; nothing in sessionStorage", keys === "token,user" && (await S.js("sessionStorage.length")) === 0, keys);
    const stored = await S.js("JSON.stringify(localStorage)");
    S.check("no delivery details or order data in browser storage", !stored.includes("Gate 3") && !stored.includes("ORD-"));
    await S.shot("order-desktop");

    await S.js("history.back(); true");
    await S.waitFor(`location.pathname !== ${JSON.stringify(firstOrderPath)}`, "the Back button to leave the order page");
    S.check("the Back button does NOT return to the checkout page", (await S.url()) !== "/checkout", await S.url());

    await S.goto(`${S.appUrl}${firstOrderPath}`);
    await waitForOrderPage();
    S.check("reloading the order page still shows the order, without repeating the banner", !(await S.text()).includes("Thank you!") && (await S.text()).includes(order.orderNumber));
  });

  // ---- 7 -------------------------------------------------------------------------
  sec("7. duplicate clicks", async () => {
    await S.newUser("c7");
    const product = await makeProduct("Dup7", 40, 20);
    await putCart(S.users.c7, [[product, 3]]);
    await S.uiLogout();
    await S.uiLogin("c7");
    await goCheckout();
    await fillValid();
    await waitForPlaceOrderReady();
    forgetCalls();
    await S.js(`(()=>{const b=document.querySelector('button[form="checkout-form"]');b.click();b.click();document.querySelector('#checkout-form').requestSubmit();b.click();return true})()`);
    await waitForOrderPlaced("rapid clicks");
    // All four clicks happened in the same instant, so a second request would already have been sent by now
    S.check("4 rapid clicks / Enter presses send exactly ONE order request", callsTo("POST", "/api/orders").length === 1, String(callsTo("POST", "/api/orders").length));
    S.check("one order, stock deducted once (20 -> 17)", (await dbOrders(S.users.c7)).length === 1 && (await stockOf(product)) === 17);
  });

  // ---- 8 -------------------------------------------------------------------------
  sec("8. server refusals (409)", async () => {
    // (a) the stock dropped after the page was opened
    await S.newUser("c8");
    const short = await makeProduct("Short8", 15, 2);
    await putCart(S.users.c8, [[short, 2]]);
    await S.uiLogout();
    await S.uiLogin("c8");
    await goCheckout();
    await fillValid({ phone: "0311 7654321" });
    await waitForPlaceOrderReady(); // the page is completely loaded and usable...
    await S.models.Product.updateOne({ _id: short._id }, { stock: 1 }); // ...and only now does someone else buy one
    await submit();
    await S.waitFor("!!document.querySelector('.checkout-problems') && document.body.innerText.includes('only 1 available')", "the stock refusal");
    let text = await S.text();
    S.check(
      "stock changed after the page opened: friendly message listing the product and what is available",
      text.includes("no longer available in the requested quantity") && text.includes(`${S.tag} Short8: only 1 available`),
      text.slice(0, 400)
    );
    S.check(
      "nothing was ordered, stock untouched, cart intact",
      (await dbOrders(S.users.c8)).length === 0 && (await stockOf(short)) === 1 && JSON.stringify(await dbCart(S.users.c8)) === JSON.stringify([{ product: String(short._id), quantity: 2 }])
    );
    await S.waitFor("!!document.querySelector('.status a[href=\"/cart\"]')", "the blocking notice after the refresh");
    await waitForPlaceOrderDisabled();
    S.check("the cart refreshed, so the page now blocks ordering until it is fixed", (await placeButton()).disabled === true);
    S.check("what the customer typed is still there", (await S.js("document.querySelector('#checkout-phone').value")) === "0311 7654321");
    await S.clickByText(".status a", "go back to your cart");
    await S.waitFor("location.pathname === '/cart'", "the cart");
    await S.clickByText("button", "Change to 1");
    await S.waitFor("!!document.querySelector('a.button[href=\"/checkout\"]')", "the checkout link to become active");
    await S.clickByText("a", "Proceed to Checkout");
    await waitForCheckoutForm();
    await fillValid();
    await submit();
    await waitForOrderPlaced("after fixing the cart");
    S.check("after fixing the cart the order goes through with the corrected quantity", (await dbOrders(S.users.c8))[0].items[0].quantity === 1 && (await stockOf(short)) === 0);

    // (b) the price changed after the page was opened
    await S.newUser("c8b");
    const priced = await makeProduct("Price8b", 40, 10);
    await putCart(S.users.c8b, [[priced, 1]]);
    await S.uiLogout();
    await S.uiLogin("c8b");
    await goCheckout();
    await fillValid({ city: "Karachi" });
    await waitForPlaceOrderReady(); // the page is completely loaded and usable...
    await S.models.Product.updateOne({ _id: priced._id }, { price: 45 }); // ...and only now does the price change
    forgetCalls();
    await submit();
    await S.waitFor("document.body.innerText.includes('The prices in your cart have changed')", "the price refusal");
    text = await S.text();
    S.check("price changed after the page opened: the new total (Rs. 45) is announced", text.includes("The new total is Rs. 45"), text.slice(0, 300));
    await S.waitFor("document.querySelector('.cart-summary .summary-total').innerText.includes('Rs. 45')", "the summary to refresh");
    await waitForPlaceOrderReady();
    S.check(
      "the summary now shows the new total, nothing was ordered, the form keeps its values",
      (await dbOrders(S.users.c8b)).length === 0 && (await S.js("document.querySelector('#checkout-city').value")) === "Karachi" && (await placeButton()).disabled === false
    );
    await submit();
    await waitForOrderPlaced("second attempt at the new price");
    const retry = JSON.parse(orderPosts[1]);
    S.check("the second attempt sent the NEW total (45) as expectedTotal and succeeded at that price", retry.expectedTotal === 45 && (await dbOrders(S.users.c8b))[0].total === 45);

    // (c) a 409 without details
    await S.newUser("c8c");
    const generic = await makeProduct("Generic8c", 10, 10);
    await putCart(S.users.c8c, [[generic, 1]]);
    await S.uiLogout();
    await S.uiLogin("c8c");
    await goCheckout();
    await fillValid();
    S.interceptor = interceptors.fulfill(409, { message: "Your cart changed while you were checking out, or this checkout is already in progress. Please review your cart and try again." });
    await submit();
    await S.waitFor("document.body.innerText.includes('Your cart changed while you were checking out')", "the conflict message");
    S.interceptor = null;
    await waitForPlaceOrderReady();
    S.check(
      "a 409 without details (cart changed / checkout already running) shows the server's message and keeps the form",
      (await placeButton()).disabled === false && (await S.js("document.querySelector('#checkout-phone').value")) !== ""
    );
  });

  // ---- 9 -------------------------------------------------------------------------
  sec("9. expired session", async () => {
    await S.newUser("c9");
    const product = await makeProduct("Exp9", 10, 10);
    await putCart(S.users.c9, [[product, 1]]);
    await S.uiLogout();
    await S.uiLogin("c9");
    await goCheckout();
    await fillValid();
    await S.js("localStorage.setItem('token','expired.or.invalid'); true");
    await submit();
    await S.waitFor("location.pathname === '/login'", "the redirect after a 401");
    S.check(
      "an expired session logs the customer out and sends them to /login",
      (await S.js("localStorage.getItem('token')")) === null && JSON.stringify(await linkTexts()) === JSON.stringify(["Products", "Login", "Sign up"]) && (await S.userLink()) === null
    );
    S.check("no order was created, the cart is untouched", (await dbOrders(S.users.c9)).length === 0 && (await dbCart(S.users.c9)).length === 1);
  });

  // ---- 10 ------------------------------------------------------------------------
  sec("10. network and server failures", async () => {
    // (a) the request never reaches the server
    await S.newUser("c10");
    const net = await makeProduct("Net10", 20, 10);
    await putCart(S.users.c10, [[net, 2]]);
    await S.uiLogin("c10");
    await goCheckout();
    await fillValid({ fullName: "Network Tester", notes: "keep me" });
    S.interceptor = interceptors.failRequest;
    await submit();
    await S.waitFor("document.body.innerText.includes('Your order was not placed')", "the 'not placed' message");
    await waitForPlaceOrderReady();
    S.check(
      "request never reached the server: 'not placed' message, form kept, Place Order usable again",
      (await S.js("document.querySelector('#checkout-notes').value")) === "keep me" && (await placeButton()).disabled === false && (await dbOrders(S.users.c10)).length === 0 && (await stockOf(net)) === 10
    );
    S.interceptor = null;
    await submit();
    await waitForOrderPlaced("retry after the failure");
    S.check("trying again after the failure works (exactly one order)", (await dbOrders(S.users.c10)).length === 1 && (await stockOf(net)) === 8);

    // (b) the server creates the order but the answer is lost: the page must FIND the order and open it
    await S.newUser("c10b");
    const lost = await makeProduct("Lost10b", 20, 10);
    await putCart(S.users.c10b, [[lost, 2]]);
    await S.uiLogout();
    await S.uiLogin("c10b");
    await goCheckout();
    await fillValid();
    S.interceptor = interceptors.failResponse;
    forgetCalls();
    await submit();
    await waitForOrderPlaced("the answer was lost");
    S.interceptor = null;
    const lostOrders = await dbOrders(S.users.c10b);
    S.check("the server created the order but the answer was lost: the page checks, FINDS the order and opens it", lostOrders.length === 1 && (await S.url()) === `/orders/${lostOrders[0]._id}`);
    await S.waitFor("document.body.innerText.includes('Thank you!')", "the thank-you banner");
    S.check("...with the success banner, one order, stock deducted once, and no second POST", (await stockOf(lost)) === 8 && callsTo("POST", "/api/orders").length === 1);

    // (c) the answer is lost AND the page's check fails too: be honest, and never order twice
    await S.newUser("c10c");
    const unsure = await makeProduct("Lost10c", 20, 10);
    await putCart(S.users.c10c, [[unsure, 1]]);
    await S.uiLogout();
    await S.uiLogin("c10c");
    await goCheckout();
    await fillValid();
    S.interceptor = interceptors.failResponseAndCheck;
    forgetCalls();
    await submit();
    await S.waitFor("document.body.innerText.includes('could not confirm whether your order was placed')", "the 'could not confirm' message");
    S.interceptor = null;
    const unsureText = await S.text();
    S.check("answer lost AND the check also fails: an honest 'could not confirm' message that warns not to order twice", unsureText.includes("do not order again") && unsureText.includes("reload this page"), unsureText.slice(0, 400));
    S.check("no second order request was made, and exactly one order exists", callsTo("POST", "/api/orders").length === 1 && (await dbOrders(S.users.c10c)).length === 1);

    // (d) the server answers with errors
    await S.newUser("c10d");
    const failing = await makeProduct("Fail10d", 20, 10);
    await putCart(S.users.c10d, [[failing, 1]]);
    await S.uiLogout();
    await S.uiLogin("c10d");
    await goCheckout();
    await fillValid({ phone: "0300 1112223" });

    S.interceptor = interceptors.fulfill(500, { message: "Internal server error" });
    await submit();
    await S.waitFor("document.body.innerText.includes('Something went wrong on our side')", "the 500 message");
    await waitForPlaceOrderReady();
    S.check(
      "a server error (500) shows a friendly message, never the raw text; the form stays usable",
      !(await S.text()).includes("Internal server error") && (await placeButton()).disabled === false && (await S.js("document.querySelector('#checkout-phone').value")) === "0300 1112223"
    );

    S.interceptor = interceptors.fulfill(400, {
      message: "Phone number is not valid. City is required",
      details: [{ field: "delivery.phone", message: "Phone number is not valid" }, { field: "delivery.city", message: "City is required" }],
    });
    await submit();
    await S.waitFor("!!document.getElementById('checkout-phone-error')", "the 400 field messages");
    S.check(
      "a 400 with field details puts each message under its field and focuses the first",
      (await fieldError("phone")) === "Phone number is not valid" && (await fieldError("city")) === "City is required" && (await S.js("document.activeElement.id")) === "checkout-phone"
    );

    S.interceptor = interceptors.fulfill(403, { message: "You do not have permission to do this." });
    await fillValid();
    await submit();
    await S.waitFor("document.body.innerText.includes('Only customer accounts can shop')", "the 403 message");
    S.interceptor = null;
    S.check("a 403 shows the customer-only message", (await S.text()).includes("Only customer accounts can shop"));
  });

  // ---- 11 ------------------------------------------------------------------------
  sec("11. the order page", async () => {
    await S.uiLogout();
    await S.uiLogin("c3");
    await S.goto(`${S.appUrl}/orders/${firstOrderId}`);
    await S.waitFor("document.body.innerText.includes('could not find this order')", "'not found' for someone else's order");
    S.check("another customer's order shows a friendly 'not found' (nothing about the order leaks)", !(await S.text()).includes(S.tag) && !(await S.text()).includes("Ayesha"));
    await S.goto(`${S.appUrl}/orders/${"f".repeat(24)}`);
    await S.waitFor("document.body.innerText.includes('could not find this order')", "'not found' for an unknown order");
    const unknownShown = (await S.text()).includes("could not find this order");
    await S.goto(`${S.appUrl}/orders/not-an-id`);
    await S.waitFor("document.body.innerText.includes('could not find this order')", "'not found' for a malformed id");
    S.check("an unknown id and a malformed id both show the same friendly message", unknownShown && (await S.text()).includes("could not find this order"));
    await S.uiLogout();

    // the order IS created, but its page cannot be loaded afterwards: the customer is still told it was placed
    await S.newUser("c11");
    const fallback = await makeProduct("Fallback11", 20, 10);
    await putCart(S.users.c11, [[fallback, 1]]);
    await S.uiLogin("c11");
    await goCheckout();
    await fillValid();
    S.interceptor = interceptors.failGetOrders;
    await submit();
    await S.waitFor("document.body.innerText.includes('Thank you! Your order has been placed.') && !!document.querySelector('.message-box-error')", "the fallback banner");
    S.interceptor = null;
    const placed = (await dbOrders(S.users.c11))[0];
    const fallbackText = await S.text();
    S.check(
      "the order page cannot load, but the customer is still told the order was placed, with its number",
      fallbackText.includes(placed.orderNumber) && (fallbackText.includes("Could not") || fallbackText.includes("Cannot reach the server"))
    );
  });

  // ---- 12 ------------------------------------------------------------------------
  sec("12. layouts on three screen widths", async () => {
    await S.newUser("c12");
    const long = await makeProduct("Responsive Long Name Product With Many Words To Test Wrapping On Small Screens", 1234.5, 20);
    const other = await makeProduct("Resp12", 20, 20);
    await putCart(S.users.c12, [[long, 3], [other, 1]]);
    await S.uiLogout();
    await S.uiLogin("c12");

    for (const [label, width, height, mobile] of [["mobile", 375, 800, true], ["tablet", 768, 1000, false], ["desktop", 1280, 900, false]]) {
      await S.resize(width, height, mobile); // returns only when the page really has this width
      await goCheckout();
      await submit(); // show the validation messages too (the widest content)
      await S.waitFor("!!document.getElementById('checkout-phone-error')", `the validation messages (${label})`);
      const columns = await S.js("getComputedStyle(document.querySelector('.cart-layout')).gridTemplateColumns.split(' ').length");
      S.check(`${label} (${width}px): checkout has no horizontal scroll`, await S.noHScroll());
      S.check(`${label}: layout is ${label === "desktop" ? "form + summary (2 columns)" : "1 column"}`, label === "desktop" ? columns === 2 : columns === 1, `${columns}`);
      const small = await S.js("[...document.querySelectorAll('#checkout-form input:not([type=radio]), #checkout-form textarea, button[form=\"checkout-form\"], .cart-summary a.button')].filter(e=>e.offsetParent && e.getBoundingClientRect().height < 32).length");
      S.check(`${label}: inputs and buttons are at least 32px tall`, small === 0, `${small} too small`);
      const overflow = await S.js("[...document.querySelectorAll('.checkout-section, .cart-summary, .summary-item')].filter(e=>e.scrollWidth > e.clientWidth + 1).length");
      S.check(`${label}: nothing overflows its box (long names wrap)`, overflow === 0, `${overflow}`);
      if (label === "mobile") {
        const formFirst = await S.js("(()=>{const f=document.querySelector('#checkout-form').getBoundingClientRect().top, s=document.querySelector('.cart-summary').getBoundingClientRect().top; return f < s})()");
        S.check("mobile: the form comes first and the summary (with Place Order) below it", formFirst);
      }
      await S.shot(`checkout-${label}`);
    }

    await S.uiLogout();
    await S.uiLogin("c1");
    for (const [label, width, height, mobile] of [["mobile", 375, 800, true], ["tablet", 768, 1000, false], ["desktop", 1280, 900, false]]) {
      await S.resize(width, height, mobile);
      await S.goto(`${S.appUrl}/orders/${firstOrderId}`);
      await waitForOrderPage();
      const columns = await S.js("getComputedStyle(document.querySelector('.cart-layout')).gridTemplateColumns.split(' ').length");
      S.check(`${label} (${width}px): order page has no horizontal scroll`, await S.noHScroll());
      S.check(`${label}: order page layout is ${label === "desktop" ? "items + side (2 columns)" : "1 column"}`, label === "desktop" ? columns === 2 : columns === 1, `${columns}`);
      const overflow = await S.js("[...document.querySelectorAll('.checkout-section, .cart-summary, .order-item')].filter(e=>e.scrollWidth > e.clientWidth + 1).length");
      S.check(`${label}: nothing overflows on the order page`, overflow === 0, `${overflow}`);
      await S.shot(`order-${label}`);
    }
    await S.resize(1280, 900, false);
  });

  // ---- 13 ------------------------------------------------------------------------
  sec("13. whole-run checks", async () => {
    S.check("the browser console showed no errors or React warnings during the whole run", S.consoleProblems.length === 0, S.consoleProblems.slice(0, 3).join(" | "));
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
  });
});
