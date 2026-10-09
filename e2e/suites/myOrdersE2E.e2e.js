// "My Orders" for a customer (/orders): navigation, the empty state, a customer with 25 orders and
// the paging, View Details, bad page numbers, one customer never seeing another's orders, an expired
// session, error states, a real checkout showing up first, and four screen widths.
// (Moved into the repository from the old scratch folder, where it was "myOrdersE2E".)
//
// Run it with:  npm run test:e2e -- myOrdersE2E
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");

describe("my orders", () => {
  let S;
  const sec = (title, body) => section(() => S, title, body);

  let bobOrders; // bob's 25 orders, oldest first
  let newestFirst; // the same orders, in the order the page must show them
  let carolOrder;
  let daveOrder;
  let evePrice; // helper data for the real checkout
  let cheapProduct;

  const HEX_ID = /^\/orders\/[0-9a-f]{24}$/;
  const money = (amount) => `Rs. ${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  const preview = (items) => {
    const shown = items.slice(0, 2).map((item) => `${item.name} × ${item.quantity}`);
    const more = items.length - 2;
    return more > 0 ? `${shown.join(", ")} +${more} more` : shown.join(", ");
  };

  before(async () => {
    S = await startSuite("myOrdersE2E");

    const category = await S.models.Category.create({ name: `${S.tag} Category` });
    const makeProduct = (name, price, stock) =>
      S.models.Product.create({ name: `${S.tag} ${name}`, description: `desc ${name}`, price, stock, category: category._id, imageUrl: "" });
    await S.newUser("admin", "admin");
    for (const who of ["alice", "bob", "carol", "dave", "eve"]) await S.newUser(who);
    const p1 = await makeProduct("Alpha", 250.75, 50);
    const p2 = await makeProduct("Beta", 99.99, 50);
    const p3 = await makeProduct("Gamma", 1000, 50);
    const long = await makeProduct("Long Name Product With Many Many Words To Check That The Preview Wraps Nicely On Small Screens", 1234.5, 50);
    cheapProduct = await makeProduct("EveItem", 40, 10);
    evePrice = 40;

    // Bob: 25 orders with known dates, statuses and sizes (order i is older than order i+1)
    const statuses = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
    const base = Date.now() - 40 * 24 * 3600 * 1000;
    bobOrders = [];
    for (let i = 0; i < 25; i++) {
      const lines = [[p1, 1 + (i % 3)]];
      if (i % 2 === 0) lines.push([p2, 1]);
      if (i % 4 === 0) lines.push([p3, 2]);
      if (i % 5 === 0) lines.push([long, 1]);
      const status = statuses[i % statuses.length];
      bobOrders.push(await S.insertOrder(S.users.bob, lines, { createdAt: new Date(base + i * 3600 * 1000), status, paymentStatus: status === "delivered" ? "paid" : "pending" }));
    }
    newestFirst = [...bobOrders].reverse();
    carolOrder = await S.insertOrder(S.users.carol, [[p2, 2]], { createdAt: new Date(base) });
    daveOrder = await S.insertOrder(S.users.dave, [[p1, 1]], { createdAt: new Date(base) });
    await S.insertOrder(S.users.eve, [[p1, 1]], { createdAt: new Date(base) }); // an OLD order for eve
  });

  after(async () => {
    if (S) await S.finish();
  });

  // ---- helpers of this suite -------------------------------------------------------
  const ordersCalls = () => S.apiCalls.filter((call) => /\/api\/orders/.test(call));
  const isOrderList = (paused) => paused.request.method === "GET" && /\/api\/orders(\?|$)/.test(paused.request.url);
  const waitForOrders = () => S.waitFor("!!document.querySelector('.order-card') && !/Loading your orders/.test(document.body.innerText)", "the order cards");
  const cardNumbers = () => S.js("[...document.querySelectorAll('.order-card .order-card-number')].map(e=>e.textContent.trim())");
  const linkTexts = async () => (await S.navbarLinks()).map((link) => link.text);
  const waitForDetails = () => S.waitFor("!!document.querySelector('h1') && document.querySelector('h1').textContent.startsWith('Order ORD-')", "the order details");

  // ---- A -------------------------------------------------------------------------
  sec("A. navigation", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.js("localStorage.clear()");
    S.resetCalls();
    await S.goto(`${S.appUrl}/`);
    await S.waitFor("!!document.querySelector('.navbar-links')", "the navbar");
    S.check(
      "A. anonymous visitors see Products, Login, Sign up and no My Orders link",
      JSON.stringify(await linkTexts()) === JSON.stringify(["Products", "Login", "Sign up"]) && (await S.userLink()) === null,
      (await linkTexts()).join("|")
    );

    await S.uiLogin("alice");
    const links = await S.navbarLinks();
    S.check(
      "A. customers see Products, Cart and My Orders (each pointing to the right page)",
      JSON.stringify(links) === JSON.stringify([{ text: "Products", href: "/" }, { text: "Cart", href: "/cart" }, { text: "My Orders", href: "/orders" }]),
      JSON.stringify(links)
    );
    S.check("A. the customer's own name link is separate and points to /profile", (await S.userLink()).href === "/profile");
    await S.uiLogout();

    await S.uiLogin("admin");
    const adminTexts = await linkTexts();
    S.check("A. admins do not see My Orders, and still see the admin links", !adminTexts.includes("My Orders") && adminTexts.includes("Admin Products"), adminTexts.join("|"));
    S.resetCalls();
    await S.goto(`${S.appUrl}/orders`);
    await S.settleAt("/");
    S.check("F. admin opening /orders is sent to the home page", (await S.url()) === "/");
    S.check("F. ...and makes no orders API call", ordersCalls().length === 0, ordersCalls().join(","));
    await S.uiLogout();

    S.resetCalls();
    await S.goto(`${S.appUrl}/orders`);
    await S.settleAt("/login");
    S.check("F. a logged-out visitor opening /orders is sent to /login", (await S.url()) === "/login");
    S.check("F. ...and makes no orders API call", ordersCalls().length === 0);
  });

  // ---- B -------------------------------------------------------------------------
  sec("B. customer with no orders", async () => {
    await S.uiLogin("alice");
    S.resetCalls();
    await S.clickByText(".navbar-links a", "My Orders");
    await S.waitFor("location.pathname === '/orders' && !/Loading your orders/.test(document.body.innerText)", "the orders page");
    S.check("B. the My Orders link opens /orders with the heading 'My Orders'", (await S.js("document.querySelector('h1').textContent")) === "My Orders");
    await S.waitFor("document.body.innerText.includes('placed any orders yet')", "the empty state");
    S.check("B. a customer with no orders sees a friendly empty state", (await S.text()).includes("placed any orders yet"));
    S.check(
      "B. ...with a Start Shopping button, and no list or pagination",
      (await S.js("!![...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Start Shopping')")) && !(await S.has(".order-card")) && !(await S.has(".pagination"))
    );
    S.check("B. the request asked for page 1 with 10 per page", ordersCalls().some((call) => call.includes("page=1") && call.includes("limit=10")), ordersCalls().join(","));
    await S.clickByText("a", "Start Shopping");
    await S.waitFor("location.pathname === '/'", "the products page");
    S.check("B. Start Shopping goes to the products", (await S.url()) === "/");
    await S.uiLogout();
  });

  // ---- C -------------------------------------------------------------------------
  sec("C. a customer with 25 orders", async () => {
    await S.uiLogin("bob");
    await S.clickByText(".navbar-links a", "My Orders");
    await waitForOrders();
    S.check("C. the page shows 10 order cards and '25 orders'", (await S.js("document.querySelectorAll('.order-card').length")) === 10 && (await S.text()).includes("25 orders"));
    S.check("C. newest orders come first (the 10 newest, in order)", JSON.stringify(await cardNumbers()) === JSON.stringify(newestFirst.slice(0, 10).map((o) => o.orderNumber)), JSON.stringify(await cardNumbers()));

    let everyField = true;
    let why = "";
    for (let i = 0; i < 10; i++) {
      const order = newestFirst[i];
      const cardText = await S.js(`document.querySelectorAll('.order-card')[${i}].innerText`);
      const href = await S.js(`document.querySelectorAll('.order-card')[${i}].querySelector('a.button').getAttribute('href')`);
      const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
      const checks = [
        cardText.includes(order.orderNumber),
        cardText.includes("Placed on"),
        cardText.includes(capitalize(order.status)),
        cardText.includes(`Payment: ${capitalize(order.paymentStatus)}`),
        cardText.includes(`${units} ${units === 1 ? "item" : "items"}`),
        cardText.includes(money(order.total)),
        cardText.includes(preview(order.items)),
        href === `/orders/${order._id}`,
      ];
      if (checks.includes(false)) {
        everyField = false;
        why += `card ${i} ${JSON.stringify(checks)} `;
      }
    }
    S.check("C. every card shows number, date, status, payment status, item count, total, product preview and a View Details link to its own order", everyField, why);

    const badges = await S.js("[...document.querySelectorAll('.order-card .badge')].map(b=>b.textContent.trim()+':'+b.className.replace('badge ',''))");
    S.check(
      "C. cancelled orders get the red badge, pending the amber one, delivered the green one",
      badges.some((b) => b.startsWith("Cancelled:badge-out")) && badges.some((b) => b.startsWith("Pending:badge-low")) && badges.some((b) => b.startsWith("Delivered:badge-in")),
      badges.join(",")
    );
    const text = await S.text();
    S.check("C. the list shows no phone number, street address or e-mail", !text.includes("PRIVATE-STREET-77") && !text.includes("5550199") && !text.includes(S.users.bob.email) && !text.includes("Private Person"));
    S.check("C. only the previews of the first two products are shown (+N more for the rest)", text.includes("more"));
    S.check(
      "C. Page 1 of 3, Previous disabled, Next enabled",
      text.includes("Page 1 of 3") && (await S.js("document.querySelector('.pagination button').disabled")) && !(await S.js("document.querySelectorAll('.pagination button')[1].disabled"))
    );
    await S.shot("list-desktop-page1");

    S.resetCalls();
    await S.clickByText(".pagination button", "Next");
    await S.waitFor("document.body.innerText.includes('Page 2 of 3') && !/Loading your orders/.test(document.body.innerText)", "page 2");
    S.check("C. Next opens page 2 and puts it in the address (/orders?page=2)", (await S.url()) === "/orders?page=2", await S.url());
    S.check("C. page 2 shows orders 11-20 of the newest-first list", JSON.stringify(await cardNumbers()) === JSON.stringify(newestFirst.slice(10, 20).map((o) => o.orderNumber)));
    S.check("C. the request for page 2 used page=2&limit=10", ordersCalls().some((call) => call.includes("page=2") && call.includes("limit=10")));

    await S.clickByText(".pagination button", "Next");
    await S.waitFor("document.body.innerText.includes('Page 3 of 3') && !/Loading your orders/.test(document.body.innerText)", "page 3");
    S.check(
      "C. page 3 shows the remaining 5 oldest orders, Next is disabled",
      JSON.stringify(await cardNumbers()) === JSON.stringify(newestFirst.slice(20).map((o) => o.orderNumber)) && (await S.js("document.querySelectorAll('.pagination button')[1].disabled"))
    );
    await S.clickByText(".pagination button", "Previous");
    await S.waitFor("document.body.innerText.includes('Page 2 of 3') && !/Loading your orders/.test(document.body.innerText)", "back to page 2");
    S.check("C. Previous goes back to page 2", (await S.url()) === "/orders?page=2");
  });

  // ---- D -------------------------------------------------------------------------
  sec("D. View Details", async () => {
    const second = newestFirst[11]; // the 2nd card on page 2
    await S.js("document.querySelectorAll('.order-card')[1].querySelector('a.button').click(); true");
    await S.waitFor(`${HEX_ID}.test(location.pathname)`, "the details address");
    await waitForDetails();
    S.check("D. View Details opens /orders/<that order's id>", (await S.url()) === `/orders/${second._id}`, await S.url());
    const text = await S.text();
    S.check(
      "D. the details page shows that order (number, items, total, status, payment)",
      text.includes(second.orderNumber) && text.includes(money(second.total)) && text.includes(capitalize(second.status)) && text.includes("Cash on Delivery") && text.includes(second.items[0].name)
    );
    S.check("D. no 'order placed' banner when opened from the list", !text.includes("Thank you!"));
    S.check(
      "D. the page has a 'Back to My Orders' link and a My Orders button",
      (await S.js("!![...document.querySelectorAll('a')].find(a=>a.textContent.includes('Back to My Orders') && a.getAttribute('href')==='/orders')")) &&
        (await S.js("!![...document.querySelectorAll('.order-footer a')].find(a=>a.textContent.trim()==='My Orders')"))
    );
    await S.shot("details-desktop");

    await S.js("history.back(); true");
    await S.waitFor("location.pathname === '/orders' && !!document.querySelector('.order-card')", "the Back button");
    S.check(
      "D. the browser Back button returns to the same page of the list (/orders?page=2)",
      (await S.url()) === "/orders?page=2" && JSON.stringify(await cardNumbers()) === JSON.stringify(newestFirst.slice(10, 20).map((o) => o.orderNumber)),
      await S.url()
    );

    await S.js("document.querySelectorAll('.order-card')[0].querySelector('a.button').click(); true");
    await S.waitFor(`${HEX_ID}.test(location.pathname)`, "the second details address");
    await waitForDetails();
    await S.clickByText("a", "← Back to My Orders");
    await S.waitFor("location.pathname === '/orders' && !!document.querySelector('.order-card')", "the Back link");
    S.check("D. 'Back to My Orders' opens the list (first page)", (await S.url()) === "/orders");
  });

  // ---- page parameter problems -----------------------------------------------------
  sec("page parameter problems", async () => {
    for (const bad of ["abc", "0", "-3", "1.5", ""]) {
      await S.goto(`${S.appUrl}/orders?page=${bad}`);
      await waitForOrders();
      S.check(`page=${JSON.stringify(bad)} falls back to page 1`, JSON.stringify(await cardNumbers()) === JSON.stringify(newestFirst.slice(0, 10).map((o) => o.orderNumber)), JSON.stringify(await cardNumbers()));
      S.check(`page=${JSON.stringify(bad)} shows no error`, !(await S.text()).includes("Could not"));
    }
    await S.goto(`${S.appUrl}/orders?page=99`);
    await S.waitFor("document.body.innerText.includes('no orders on this page')", "the empty page message");
    S.check("a page past the end says so and offers 'Go to first page'", await S.js("!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Go to first page')"));
    await S.clickByText("button", "Go to first page");
    await waitForOrders();
    S.check("'Go to first page' returns to the newest orders", (await S.url()) === "/orders" && (await cardNumbers())[0] === newestFirst[0].orderNumber);
  });

  // ---- E -------------------------------------------------------------------------
  sec("E. one customer cannot see another's orders", async () => {
    await S.uiLogout();
    await S.uiLogin("carol");
    await S.goto(`${S.appUrl}/orders?user=${S.users.bob._id}&userId=${S.users.bob._id}`);
    await waitForOrders();
    const carolNumbers = await cardNumbers();
    S.check(
      "E. the list shows only the customer's own order, even with ?user=<someone else's id> in the address",
      JSON.stringify(carolNumbers) === JSON.stringify([carolOrder.orderNumber]) && (await S.text()).includes("1 order"),
      JSON.stringify(carolNumbers)
    );
    S.check("E. none of Bob's order numbers or products appear", !bobOrders.some((order) => carolNumbers.includes(order.orderNumber)));

    await S.goto(`${S.appUrl}/orders/${bobOrders[24]._id}`);
    await S.waitFor("document.body.innerText.includes('could not find this order')", "'not found' for another customer");
    const text = await S.text();
    S.check(
      "E. typing another customer's order id shows only 'not found' (no order data leaks)",
      !text.includes(bobOrders[24].orderNumber) && !text.includes("PRIVATE-STREET-77") && !text.includes("5550199") && !text.includes("Private Person")
    );

    await S.goto(`${S.appUrl}/orders/${"e".repeat(24)}`);
    await S.waitFor("document.body.innerText.includes('could not find this order')", "'not found' for an unknown id");
    const unknownText = await S.text();
    await S.goto(`${S.appUrl}/orders/abc`);
    await S.waitFor("document.body.innerText.includes('could not find this order')", "'not found' for a malformed id");
    const malformedText = await S.text();
    S.check("E. an unknown id and a malformed id show the same friendly message", unknownText.includes("could not find this order") && malformedText.includes("could not find this order"));
    await S.uiLogout();
  });

  // ---- G -------------------------------------------------------------------------
  sec("G. expired session", async () => {
    await S.uiLogin("bob");
    await S.goto(`${S.appUrl}/orders`);
    await waitForOrders();
    await S.js("localStorage.setItem('token','expired.or.invalid'); true");
    await S.clickByText(".pagination button", "Next");
    await S.waitFor("location.pathname === '/login'", "the redirect after a 401 on a page change");
    S.check(
      "G. a 401 while changing page logs the customer out and goes to /login",
      (await S.js("localStorage.getItem('token')")) === null && JSON.stringify(await linkTexts()) === JSON.stringify(["Products", "Login", "Sign up"]) && (await S.userLink()) === null
    );

    await S.uiLogin("dave");
    await S.goto(`${S.appUrl}/`);
    await S.js("localStorage.setItem('token','expired.or.invalid'); true");
    await S.clickByText(".navbar-links a", "My Orders");
    await S.waitFor("location.pathname === '/login'", "the redirect after a 401 on load");
    S.check("G. a 401 when opening My Orders logs out and goes to /login (no raw error shown)", (await S.js("localStorage.getItem('token')")) === null && !(await S.text()).includes("Invalid or expired token"));

    await S.uiLogin("dave");
    await S.goto(`${S.appUrl}/orders`);
    await waitForOrders();
    await S.js("localStorage.setItem('token','expired.or.invalid'); true");
    await S.js("document.querySelectorAll('.order-card')[0].querySelector('a.button').click(); true");
    await S.waitFor("location.pathname === '/login'", "the redirect after a 401 on the details page");
    S.check("G. a 401 on the order details page also logs out and goes to /login", (await S.js("localStorage.getItem('token')")) === null && !(await S.text()).includes("Invalid or expired token"));
  });

  // ---- H -------------------------------------------------------------------------
  sec("H. error states", async () => {
    await S.uiLogin("dave");
    await S.goto(`${S.appUrl}/`);

    S.interceptor = (paused) => isOrderList(paused) && (S.failRequest(paused), true);
    await S.clickByText(".navbar-links a", "My Orders");
    await S.waitFor("!!document.querySelector('.message-box-error')", "the network error");
    let text = await S.text();
    S.check("H. connection failure: a friendly message and Try again (no raw error)", text.includes("Cannot reach the server") && text.includes("Try again") && !/Network Error|AxiosError/.test(text));

    S.interceptor = null;
    await S.clickByText("button", "Try again");
    await waitForOrders();
    S.check("H. Try again loads the orders once the connection is back", (await cardNumbers())[0] === daveOrder.orderNumber);

    await S.goto(`${S.appUrl}/`);
    S.interceptor = (paused) => isOrderList(paused) && (S.fulfill(paused, 500, { message: "Internal server error" }), true);
    await S.clickByText(".navbar-links a", "My Orders");
    await S.waitFor("!!document.querySelector('.message-box-error')", "the 500 error");
    text = await S.text();
    S.check("H. a server error (500) shows a generic friendly message, not the server's text", text.includes("Something went wrong on our side") && !text.includes("Internal server error"));
    S.interceptor = null;
    await S.uiLogout();
  });

  // ---- I -------------------------------------------------------------------------
  sec("I. a new order appears at the top", async () => {
    // Eve has one old order and a cart with 2 units of a Rs. 40 product
    await S.models.Cart.deleteMany({ user: S.users.eve._id });
    await S.models.Cart.create({ user: S.users.eve._id, items: [{ product: cheapProduct._id, quantity: 2 }] });
    await S.uiLogin("eve");
    await S.clickByText(".navbar-links a", "My Orders");
    await waitForOrders();
    S.check("I. before ordering, Eve's list has her one old order", (await cardNumbers()).length === 1);

    await S.goto(`${S.appUrl}/checkout`);
    await S.waitFor("!!document.querySelector('#checkout-form')", "the checkout form");
    for (const [key, value] of Object.entries({ phone: "+92 300 1234567", addressLine1: "House 12, Street 5", city: "Lahore" })) await S.setValue(`#checkout-${key}`, value);
    await S.click('button[form="checkout-form"]');
    await S.waitFor(`${HEX_ID}.test(location.pathname)`, "the order to be placed");
    await S.waitFor("document.body.innerText.includes('Thank you!')", "the thank-you banner");
    const newNumber = (await S.js("document.querySelector('h1').textContent")).replace("Order ", "").trim();
    await S.clickByText("a", "← Back to My Orders");
    await S.waitFor("location.pathname === '/orders' && document.querySelectorAll('.order-card').length === 2", "two orders");
    const numbers = await cardNumbers();
    S.check("I. after a real checkout, the new order is at the TOP of My Orders, above the old one", numbers[0] === newNumber && numbers.length === 2, JSON.stringify(numbers));
    S.check(
      `I. the new order shows Pending, payment Pending, 2 items and ${money(evePrice * 2)}`,
      await S.js(`(()=>{const c=document.querySelectorAll('.order-card')[0].innerText;return c.includes('Pending')&&c.includes('Payment: Pending')&&c.includes('2 items')&&c.includes(${JSON.stringify(money(evePrice * 2))})})()`)
    );
    await S.uiLogout();
  });

  // ---- J -------------------------------------------------------------------------
  sec("J. four screen widths", async () => {
    await S.uiLogin("bob");
    for (const [label, width, height, mobile] of [["mobile", 375, 800, true], ["tablet", 768, 1000, false], ["laptop", 1024, 800, false], ["wide", 1440, 900, false]]) {
      await S.viewport(width, height, mobile);
      await S.goto(`${S.appUrl}/orders`);
      await waitForOrders();
      const columns = await S.js("getComputedStyle(document.querySelector('.order-card')).gridTemplateColumns.split(' ').length");
      S.check(`${label} (${width}px): the list has no horizontal scroll`, await S.noHScroll());
      S.check(`${label}: each order is ${width >= 700 ? "two columns (details | total and button)" : "one stacked column"}`, width >= 700 ? columns === 2 : columns === 1, `${columns}`);
      const small = await S.js("[...document.querySelectorAll('.order-card a.button, .pagination button')].filter(e=>e.offsetParent && e.getBoundingClientRect().height < 32).length");
      S.check(`${label}: buttons are at least 32px tall`, small === 0, `${small} too small`);
      const overflow = await S.js("[...document.querySelectorAll('.order-card')].filter(e=>e.scrollWidth > e.clientWidth + 1).length");
      S.check(`${label}: nothing overflows a card (the long product name wraps)`, overflow === 0, `${overflow}`);
      S.check(`${label}: the navbar with My Orders has no horizontal scroll`, await S.noHScroll());
      await S.shot(`list-${label}`);

      await S.goto(`${S.appUrl}/orders/${newestFirst[0]._id}`);
      await waitForDetails();
      S.check(`${label}: the order page has no horizontal scroll`, await S.noHScroll());
      await S.shot(`details-${label}`);
    }
    await S.viewport(1280, 900, false);
  });

  // ---- K -------------------------------------------------------------------------
  sec("K. whole-run checks", async () => {
    S.check("K. the browser console showed no errors or warnings during the whole run", S.consoleProblems.length === 0, S.consoleProblems.slice(0, 3).join(" | "));
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
  });
});
