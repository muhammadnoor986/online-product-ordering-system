// A customer cancels their own order (/orders/:id): the button follows the server's `canCancel`,
// the inline confirmation, stock coming back exactly once, conflicts (409), double clicks,
// server failures, other people's orders, and four screen widths.
// (Moved into the repository from the old scratch folder, where it was "step7aCancel".)
//
// Run it with:  npm run test:e2e -- step7aCancel
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");

describe("customer order cancellation", () => {
  let S;
  const sec = (title, body) => section(() => S, title, body);

  let alpha;
  let beta;
  let bob;

  // Every cancel request the page sends: { url, body }
  const sent = [];
  const isCancel = (paused) => paused.request.method === "POST" && /\/api\/orders\/[0-9a-f]{24}\/cancel$/.test(paused.request.url);
  const record = (paused) => {
    if (isCancel(paused)) sent.push({ url: paused.request.url.replace(/^.*\/api/, ""), body: paused.request.postData || null });
    return false; // only recorded: the request goes on to the real backend
  };

  before(async () => {
    S = await startSuite("step7aCancel");
    S.interceptor = record;

    const category = await S.models.Category.create({ name: `${S.tag} Cat` });
    alpha = await S.models.Product.create({ name: `${S.tag} Alpha`, description: "d", price: 100, stock: 10, category: category._id, imageUrl: "" });
    beta = await S.models.Product.create({ name: `${S.tag} Beta`, description: "d", price: 50, stock: 10, category: category._id, imageUrl: "" });
    bob = await S.newUser("bob");
    await S.newUser("eve");
    await S.newUser("admin", "admin");
  });

  after(async () => {
    if (S) await S.finish();
  });

  // ---- helpers of this suite ---------------------------------------------------------
  const stockOf = async (product) => (await S.models.Product.findById(product._id)).stock;
  const dbOrder = (order) => S.models.Order.findById(order._id);
  const open = async (order) => {
    await S.goto(`${S.appUrl}/orders/${order._id}`);
    await S.waitFor("!/Loading your order/.test(document.body.innerText) && !!document.querySelector('h1')", "the order page");
  };
  const badge = () => S.js("document.querySelector('.order-subtitle .badge').textContent");
  const hasPanel = () => S.has(".cancel-panel");
  const startCancel = () => S.clickByText(".cancel-panel .button", "Cancel order");
  const confirmCancel = () => S.clickByText(".action-confirm .button", "Yes, cancel order");
  // The notice under the order's subtitle (it shows what the server answered)
  const waitForNotice = (text) => S.waitFor(`/${text}/.test(document.querySelector('.order-subtitle').nextElementSibling?.innerText||'')`, `the notice "${text}"`);

  // ---- A -------------------------------------------------------------------------
  sec("A. the button follows the server's canCancel", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.js("localStorage.clear()");
    await S.uiLogin("bob");

    const byStatus = {};
    for (const status of ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"]) {
      byStatus[status] = await S.insertOrder(bob, [[alpha, 1]], { status, stockRestored: status === "cancelled" });
    }
    for (const status of Object.keys(byStatus)) {
      await open(byStatus[status]);
      S.check(`${status}: cancel panel ${status === "pending" ? "shown" : "not shown"}`, (await hasPanel()) === (status === "pending"));
    }

    await S.goto(`${S.appUrl}/orders`);
    await S.waitFor("!!document.querySelector('.order-card')", "the order cards");
    S.check("no cancel button on My Orders cards", !(await S.text()).includes("Cancel order"));
  });

  // ---- B -------------------------------------------------------------------------
  sec("B. confirmation, Keep order", async () => {
    const order = await S.insertOrder(bob, [[alpha, 2], [beta, 1]], {});
    await open(order);
    S.check("panel heading + Cancel order button, no confirmation yet", (await S.text()).includes("Cancel this order") && !(await S.has(".action-confirm")));

    await startCancel();
    const text = await S.text();
    S.check("inline confirmation, no browser dialog", (await S.has(".action-confirm")) && S.dialogs.length === 0);
    S.check(
      "wording: cancelled, items returned to stock, cannot be undone",
      text.includes("Are you sure you want to cancel this order?") && text.includes("returned to available stock") && text.includes("This cannot be undone")
    );
    S.check("no note field", !(await S.has(".cancel-panel textarea, .cancel-panel input")));
    S.check("buttons: Yes, cancel order / Keep order", (await S.js("[...document.querySelectorAll('.action-confirm .button')].map(b=>b.textContent).join('|')")) === "Yes, cancel order|Keep order");

    await S.clickByText(".action-confirm .button", "Keep order");
    S.check("Keep order closes it, sends nothing, order unchanged", !(await S.has(".action-confirm")) && sent.length === 0 && (await dbOrder(order)).status === "pending" && (await badge()) === "Pending");
  });

  // ---- C -------------------------------------------------------------------------
  sec("C. cancelling", async () => {
    const order = await S.insertOrder(bob, [[alpha, 2], [beta, 1]], {});
    const stockAlpha = await stockOf(alpha);
    const stockBeta = await stockOf(beta);
    await open(order);
    sent.length = 0;

    await startCancel();
    await confirmCancel();
    await waitForNotice("Order cancelled");
    S.check("one POST to /orders/:id/cancel with no body", sent.length === 1 && sent[0].url === `/orders/${order._id}/cancel` && !sent[0].body, JSON.stringify(sent));
    S.check("green notice, badge Cancelled, panel gone", (await badge()) === "Cancelled" && !(await hasPanel()) && (await S.has(".status-ok")));
    const stored = await dbOrder(order);
    S.check("database: cancelled, payment still pending, history has the cancel entry", stored.status === "cancelled" && stored.paymentStatus === "pending" && stored.statusHistory.length === 2);
    S.check("stock returned exactly once (+2 Alpha, +1 Beta)", (await stockOf(alpha)) === stockAlpha + 2 && (await stockOf(beta)) === stockBeta + 1, `${await stockOf(alpha)} ${await stockOf(beta)}`);

    await open(order);
    S.check("after reload still Cancelled, no panel, no notice", (await badge()) === "Cancelled" && !(await hasPanel()) && !(await S.has(".status-ok")));
  });

  // ---- D -------------------------------------------------------------------------
  sec("D. 409: the shop changed the order first", async () => {
    const order = await S.insertOrder(bob, [[alpha, 1]], {});
    const stockBefore = await stockOf(alpha);
    await open(order);
    sent.length = 0;
    await startCancel();
    // while the confirmation is open, the shop confirms the order
    await S.models.Order.updateOne({ _id: order._id }, { $set: { status: "confirmed" }, $push: { statusHistory: { status: "confirmed", changedAt: new Date(), changedBy: S.users.admin._id } } });
    await confirmCancel();
    await S.waitFor("!!document.querySelector('.status-error')", "the conflict notice");
    const message = await S.js("document.querySelector('.status-error').innerText");
    S.check("red notice: can no longer be cancelled + refreshed", /can no longer be cancelled because it is confirmed/.test(message) && /refreshed/.test(message), message);
    await S.waitFor("document.querySelector('.order-subtitle .badge').textContent === 'Confirmed'", "the refreshed status");
    S.check("page shows the current order (Confirmed), panel gone", (await badge()) === "Confirmed" && !(await hasPanel()));
    S.check("nothing was cancelled, stock untouched", (await dbOrder(order)).status === "confirmed" && (await stockOf(alpha)) === stockBefore);

    const other = await S.insertOrder(bob, [[alpha, 1]], {});
    await open(other);
    await startCancel();
    await S.models.Order.updateOne({ _id: other._id }, { $set: { status: "cancelled", stockRestored: true } });
    await confirmCancel();
    await S.waitFor("!!document.querySelector('.status-error')", "the 'already cancelled' notice");
    S.check("already cancelled elsewhere: server message shown", /already been cancelled/.test(await S.js("document.querySelector('.status-error').innerText")));
  });

  // ---- E -------------------------------------------------------------------------
  sec("E. double click and slow server", async () => {
    const quick = await S.insertOrder(bob, [[alpha, 3]], {});
    const stockBefore = await stockOf(alpha);
    await open(quick);
    sent.length = 0;
    await startCancel();
    await S.js("(()=>{const b=[...document.querySelectorAll('.action-confirm .button')].find(x=>x.textContent==='Yes, cancel order');b.click();b.click();b.click();return true})()");
    await waitForNotice("Order cancelled");
    S.check("three rapid clicks send ONE request", sent.length === 1, JSON.stringify(sent));
    S.check("stock returned once (+3)", (await stockOf(alpha)) === stockBefore + 3);

    const slow = await S.insertOrder(bob, [[alpha, 1]], {});
    await open(slow);
    let held = null;
    S.interceptor = (paused) => {
      if (isCancel(paused)) {
        held = paused;
        return true; // keep this request waiting until the test lets it go
      }
      return false;
    };
    await startCancel();
    await confirmCancel();
    await S.waitFor("[...document.querySelectorAll('.action-confirm .button')].some(b=>b.textContent==='Cancelling...' && b.disabled)", "the saving state");
    S.check("while saving: 'Cancelling...' disabled, Keep order disabled", await S.js("[...document.querySelectorAll('.action-confirm .button-secondary')].every(b=>b.disabled)"));
    for (let i = 0; i < 100 && !held; i++) await S.sleep(50);
    await S.cdp.send("Fetch.continueRequest", { requestId: held.requestId });
    S.interceptor = record;
    await waitForNotice("Order cancelled");
    S.check("then normal again", (await badge()) === "Cancelled");
  });

  // ---- F -------------------------------------------------------------------------
  sec("F. failures", async () => {
    const order = await S.insertOrder(bob, [[alpha, 1]], {});
    await open(order);

    S.interceptor = (paused) => isCancel(paused) && (S.fulfill(paused, 500, { success: false, message: "boom internal detail" }), true);
    await startCancel();
    await confirmCancel();
    await S.waitFor("!!document.querySelector('.action-confirm .status-error')", "the 500 message");
    const errorText = await S.js("document.querySelector('.action-confirm .status-error').textContent");
    S.check(
      "500: friendly, no server detail, box stays open, order unchanged",
      errorText.includes("Something went wrong") && errorText.includes("not cancelled") && !errorText.includes("boom") && (await dbOrder(order)).status === "pending" && (await badge()) === "Pending"
    );

    S.interceptor = (paused) => isCancel(paused) && (S.fulfill(paused, 404, { success: false, message: "Order not found" }), true);
    await confirmCancel();
    await S.waitFor("/could not find this order any more/.test(document.querySelector('.action-confirm .status-error')?.textContent||'')", "the 404 message");
    S.check("404: friendly message", (await S.js("document.querySelector('.action-confirm .status-error').textContent")).includes("could not find this order any more"));

    S.interceptor = record;
    sent.length = 0;
    await confirmCancel();
    await waitForNotice("Order cancelled");
    S.check("retry after failures works", (await dbOrder(order)).status === "cancelled" && sent.length === 1);

    const last = await S.insertOrder(bob, [[alpha, 1]], {});
    await open(last);
    S.interceptor = (paused) => isCancel(paused) && (S.fulfill(paused, 401, { success: false, message: "Not authorized" }), true);
    await startCancel();
    await confirmCancel();
    await S.waitFor("location.pathname === '/login'", "the redirect after a 401");
    S.check("401: logged out and sent to /login", (await S.js("localStorage.getItem('token')")) === null);
    S.interceptor = record;
  });

  // ---- G -------------------------------------------------------------------------
  sec("G. other people", async () => {
    const evesOrder = await S.insertOrder(S.users.eve, [[alpha, 1]], {});
    const bobsOrder = await S.insertOrder(bob, [[alpha, 1]], {});
    await S.uiLogin("bob");
    sent.length = 0;
    await S.goto(`${S.appUrl}/orders/${evesOrder._id}`);
    await S.waitFor("/could not find this order/.test(document.body.innerText)", "the 'not found' message");
    S.check("someone else's order: not found, no panel", (await S.text()).includes("could not find this order") && !(await hasPanel()));

    await S.uiLogout();
    await S.uiLogin("admin");
    await S.goto(`${S.appUrl}/orders/${bobsOrder._id}`);
    await S.settleAt("/");
    S.check("admin opening /orders/:id is sent home (no cancel panel)", (await S.url()) === "/" && !(await hasPanel()));
    S.check("no cancel request was ever sent by those", sent.length === 0);
    await S.uiLogout();
    await S.uiLogin("bob");
  });

  // ---- H -------------------------------------------------------------------------
  sec("H. four screen widths", async () => {
    const order = await S.insertOrder(bob, [[alpha, 1], [beta, 1]], {});
    for (const [width, height] of [[375, 800], [768, 900], [1024, 800], [1440, 900]]) {
      await S.viewport(width, height, width < 500);
      await open(order);
      await startCancel();
      S.check(`${width}px: no horizontal scroll`, await S.noHScroll());
      S.check(`${width}px: buttons tall enough`, await S.js("[...document.querySelectorAll('.cancel-panel .button')].every(b=>b.getBoundingClientRect().height>=36)"));
      await S.shot(`cancel-${width}`);
      await S.clickByText(".action-confirm .button", "Keep order");
    }
  });

  // ---- I -------------------------------------------------------------------------
  sec("I. whole-run checks", async () => {
    S.check("the browser console stayed clean", S.consoleProblems.length === 0, S.consoleProblems.join(" | "));
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
  });
});
