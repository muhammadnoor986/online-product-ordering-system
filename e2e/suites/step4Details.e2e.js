// The admin order details page (/admin/orders/:id): what an admin sees, who may open it,
// how it fails, and how it looks at four screen widths.
// (First suite moved into the repository. It was "step4Details" in the old scratch folder.)
//
// Run it with:  npm run test:e2e -- step4Details
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");

describe("admin order details page", () => {
  let S;
  const sec = (title, body) => section(() => S, title, body);

  // The data of this suite (created once, in before())
  let rich;
  let cancelled;
  let plain;
  let bob;
  let admin;
  let T; // the suite's tag, as used in the list's search box

  before(async () => {
    S = await startSuite("step4Details");

    const category = await S.models.Category.create({ name: `${S.tag} Cat` });
    const makeProduct = (name, price) =>
      S.models.Product.create({ name: `${S.tag} ${name}`, description: "d", price, stock: 99, category: category._id, imageUrl: "" });
    const alpha = await makeProduct("Alpha", 250.75);
    const beta = await makeProduct("Beta With A Really Long Name That Needs To Wrap Nicely On Small Screens Without Overflow", 99.99);

    admin = await S.newUser("admin", "admin");
    bob = await S.newUser("bob");
    const eve = await S.newUser("eve");
    const unknownUserId = new S.mongoose.Types.ObjectId(); // someone who is no longer in the database
    const now = Date.now();

    rich = await S.insertOrder(bob, [[alpha, 2], [beta, 1]], {
      status: "shipped",
      paymentStatus: "pending",
      delivery: { fullName: "Bob Receiver", phone: "+92 345 5550199", addressLine1: "PRIVATE-STREET-77", addressLine2: "Flat 4", city: "Lahore", postalCode: "54000", notes: "Ring the bell\nTwice <b>bold</b>" },
      statusHistory: [
        { status: "pending", changedAt: new Date(now - 4 * 3600e3), changedBy: bob._id },
        { status: "confirmed", changedAt: new Date(now - 3 * 3600e3), changedBy: admin._id, note: "Called the customer\nAll fine <img src=x onerror=alert(1)>" },
        { status: "processing", changedAt: new Date(now - 2 * 3600e3), changedBy: unknownUserId },
        { status: "shipped", changedAt: new Date(now - 1 * 3600e3), changedBy: admin._id },
      ],
    });
    cancelled = await S.insertOrder(eve, [[alpha, 1]], {
      status: "cancelled",
      stockRestored: false,
      statusHistory: [
        { status: "pending", changedAt: new Date(now - 5000), changedBy: eve._id },
        { status: "cancelled", changedAt: new Date(now), changedBy: admin._id },
      ],
    });
    plain = await S.insertOrder(eve, [[beta, 1]], {});
    T = encodeURIComponent(S.tag.toLowerCase());
  });

  after(async () => {
    if (S) await S.finish();
  });

  // ---- helpers of this suite ---------------------------------------------------
  const isDetailRequest = (paused) => paused.request.method === "GET" && /\/api\/admin\/orders\/[0-9a-f]{24}$/.test(paused.request.url);
  const detailCalls = () => S.apiCalls.filter((call) => /\/api\/admin\/orders\/[0-9a-f]{24}/.test(call));
  const writeCalls = () => S.apiCalls.filter((call) => /^(PATCH|POST|PUT|DELETE)/.test(call));
  const waitForPage = () => S.waitFor("!/Loading the order/.test(document.body.innerText) && !!document.querySelector('main h1, .message-box')", "the order page");
  // After a redirect: wait for the new address, then give a wrong request a moment to show up
  const settleAt = async (pathname) => {
    await S.waitFor(`location.pathname === ${JSON.stringify(pathname)}`, `redirect to ${pathname}`);
    await S.sleep(250);
  };

  // ---- A -------------------------------------------------------------------------
  sec("A. who may open the page", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.js("localStorage.clear()");

    S.resetCalls();
    await S.goto(`${S.appUrl}/admin/orders/${rich._id}`);
    await settleAt("/login");
    S.check("anonymous -> /login, no API call", (await S.url()) === "/login" && detailCalls().length === 0);

    await S.uiLogin("bob");
    S.resetCalls();
    await S.goto(`${S.appUrl}/admin/orders/${rich._id}`);
    await settleAt("/");
    S.check("customer -> home, no admin API call", (await S.url()) === "/" && detailCalls().length === 0, await S.url());
    await S.uiLogout();
  });

  // ---- B -------------------------------------------------------------------------
  sec("B. what the admin sees", async () => {
    await S.uiLogin("admin");
    S.resetCalls();
    await S.goto(`${S.appUrl}/admin/orders?search=${T}&status=shipped`);
    await S.waitFor("!!document.querySelector('.admin-table tbody tr')", "the list");
    await S.click(".admin-table tbody tr a");
    await S.waitFor(`location.pathname === '/admin/orders/${rich._id}'`, "the details address");
    await waitForPage();

    const text = await S.text();
    S.check("heading shows the order number", (await S.js("document.querySelector('h1').textContent")) === `Order ${rich.orderNumber}`);
    S.check("status badge Shipped in subtitle", await S.js("document.querySelector('.order-subtitle .badge').textContent === 'Shipped'"));

    const items = await S.js("[...document.querySelectorAll('ul.order-items > li')].map(li=>li.innerText.replace(/\\s+/g,' ').trim())");
    S.check("items listed with quantity x price and line total", items.length === 2 && items[0].includes("2 × Rs. 250.75") && items[0].includes("Rs. 501.5") && items[1].includes("1 × Rs. 99.99"), JSON.stringify(items));
    S.check("summary: subtotal, shipping, total", text.includes("Subtotal") && text.includes("Rs. 601.49") && text.includes("Shipping") && text.includes("Total"), text.slice(0, 300));
    S.check("payment method and status badge", text.includes("Cash on Delivery") && (await S.js("[...document.querySelectorAll('.order-meta .badge')].map(b=>b.textContent).join()")) === "Pending");
    S.check("customer name and e-mail", text.includes("bob tester") && text.includes(S.emailOf("bob")));
    S.check("delivery details shown", text.includes("Bob Receiver") && text.includes("PRIVATE-STREET-77") && text.includes("Flat 4") && text.includes("Lahore 54000") && text.includes("+92 345 5550199"));
    S.check("delivery notes keep their line break and show HTML as text", await S.js("(()=>{const n=document.querySelector('.order-notes');return n.textContent.includes('Twice <b>bold</b>') && !n.querySelector('b')})()"));

    const history = await S.js("[...document.querySelectorAll('.status-history-item')].map(li=>({badge:li.querySelector('.badge').textContent, by:li.querySelector('.status-history-by').textContent, note:li.querySelector('.status-history-note')?.textContent||null}))");
    S.check("history: 4 entries, oldest first", JSON.stringify(history.map((entry) => entry.badge)) === JSON.stringify(["Pending", "Confirmed", "Processing", "Shipped"]), JSON.stringify(history));
    S.check(
      "history: who changed it (customer / admin / unknown user)",
      history[0].by === "by bob tester (customer)" && history[1].by === "by admin tester (admin)" && history[2].by === "by Unknown user" && history[3].by === "by admin tester (admin)",
      JSON.stringify(history.map((entry) => entry.by))
    );
    S.check("history: note shown, HTML not executed", history[1].note.includes("Called the customer") && history[1].note.includes("<img src=x onerror=alert(1)>") && !(await S.has(".status-history-note img")) && S.dialogs.length === 0);
    S.check("history: entries without a note show none", history[0].note === null && history[3].note === null);
    S.check("the page asked the E2E backend for this order (request tracking works)", detailCalls().some((call) => call.endsWith(`/api/admin/orders/${rich._id}`)), detailCalls().join());
    S.check("viewing sends only GET requests", writeCalls().length === 0, writeCalls().join());
    S.check("no user id or other internal ids shown", !text.includes(String(bob._id)) && !text.includes(String(admin._id)));

    const backHref = await S.js("document.querySelector('.back-link').getAttribute('href')");
    S.check("Back link returns to the same filtered list", backHref === `/admin/orders?search=${T}&status=shipped`, backHref);
    await S.click(".back-link");
    await S.waitFor("location.pathname === '/admin/orders'", "the list again");
    S.check("...and clicking it keeps the filters", (await S.url()) === `/admin/orders?search=${T}&status=shipped`, await S.url());
    await S.waitFor("[...document.querySelectorAll('.status-tab')].some(b=>b.getAttribute('aria-pressed')==='true' && b.textContent.startsWith('Shipped'))", "the Shipped tab to be selected");
    S.check("...and the list shows that filter (Shipped pressed)", true);

    await S.goto(`${S.appUrl}/admin/orders/${rich._id}`);
    await waitForPage();
    S.check("opened directly (no list): Back goes to plain /admin/orders", (await S.js("document.querySelector('.back-link').getAttribute('href')")) === "/admin/orders");
  });

  // ---- C -------------------------------------------------------------------------
  sec("C. a cancelled order", async () => {
    await S.goto(`${S.appUrl}/admin/orders/${cancelled._id}`);
    await waitForPage();
    S.check("no Stock returned row (the stockRestored flag cannot show failed restores)", !(await S.text()).includes("Stock returned"));
    S.check("status badge Cancelled", await S.js("document.querySelector('.order-subtitle .badge').textContent === 'Cancelled'"));
  });

  // ---- D -------------------------------------------------------------------------
  sec("D. when something goes wrong", async () => {
    await S.goto(`${S.appUrl}/admin/orders/not-a-real-id`);
    await waitForPage();
    S.check("malformed id: not-found message, no Try again", (await S.text()).includes("could not find this order") && !(await S.has(".message-box .button")));

    await S.goto(`${S.appUrl}/admin/orders/${new S.mongoose.Types.ObjectId()}`);
    await waitForPage();
    S.check("unknown id: not-found message", (await S.text()).includes("could not find this order") && (await S.has(".back-link")));

    S.interceptor = (paused) => isDetailRequest(paused) && (S.fulfill(paused, 500, { success: false, message: "boom internal detail" }), true);
    await S.goto(`${S.appUrl}/admin/orders/${plain._id}`);
    await S.waitFor("!!document.querySelector('.message-box-error')", "the error message");
    const errorText = await S.js("document.querySelector('.message-box-error').textContent");
    S.check("500: friendly message, no internal detail, Try again offered", errorText.includes("Something went wrong") && !errorText.includes("boom") && errorText.includes("Try again"), errorText);

    S.interceptor = null;
    await S.clickByText(".message-box-error .button", "Try again");
    await waitForPage();
    S.check("Try again loads the order", (await S.js("document.querySelector('h1').textContent")) === `Order ${plain.orderNumber}`);

    S.interceptor = (paused) => isDetailRequest(paused) && (S.fulfill(paused, 401, { success: false, message: "Not authorized" }), true);
    await S.goto(`${S.appUrl}/admin/orders/${plain._id}`);
    await S.waitFor("location.pathname === '/login'", "the redirect after a 401");
    S.check("401: logged out and sent to /login", (await S.js("localStorage.getItem('token')")) === null);
    S.interceptor = null;
  });

  // ---- E -------------------------------------------------------------------------
  sec("E. four screen widths", async () => {
    await S.uiLogin("admin");
    for (const [width, height] of [[375, 800], [768, 900], [1024, 800], [1440, 900]]) {
      await S.viewport(width, height, width < 500);
      await S.goto(`${S.appUrl}/admin/orders/${rich._id}`);
      await waitForPage();
      S.check(`${width}px: no horizontal scroll`, await S.noHScroll());
      const sideBySide = "(()=>{const a=document.querySelector('.order-main').getBoundingClientRect(),b=document.querySelector('.order-side').getBoundingClientRect();return b.left>a.right-1})()";
      const stacked = "(()=>{const a=document.querySelector('.order-main').getBoundingClientRect(),b=document.querySelector('.order-side').getBoundingClientRect();return b.top>=a.bottom-1})()";
      if (width >= 900) S.check(`${width}px: two columns (items left, summary right)`, await S.js(sideBySide));
      if (width < 900) S.check(`${width}px: one column`, await S.js(stacked));
      await S.shot(`details-${width}`);
    }
  });

  // ---- F -------------------------------------------------------------------------
  sec("F. whole-run checks", async () => {
    S.check("the browser console stayed clean", S.consoleProblems.length === 0, S.consoleProblems.join(" | "));
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
  });
});
