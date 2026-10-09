// The admin "Update order" panel on /admin/orders/:id: the whole status chain (driven only by the
// buttons the server offers), note checks, cancelling with stock, conflicts, double clicks,
// server failures, what the customer sees, and four screen widths.
// (Moved into the repository from the old scratch folder, where it was "step5Actions".)
//
// Run it with:  npm run test:e2e -- step5Actions
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");

describe("admin order actions", () => {
  let S;
  const sec = (title, body) => section(() => S, title, body);

  // Data of this suite
  let alpha;
  let beta;
  let gamma;
  let admin;
  let bob;
  let firstOrder; // the order that goes through the whole chain; the customer looks at it later

  // Every write request the page sends to the admin orders API: { method, url, body }
  const sent = [];
  const isWrite = (paused) => paused.request.method !== "GET" && paused.request.method !== "OPTIONS" && /\/api\/admin\/orders\//.test(paused.request.url);
  const record = (paused) => {
    if (isWrite(paused)) {
      sent.push({
        method: paused.request.method,
        url: paused.request.url.replace(/^.*\/api/, ""),
        body: paused.request.postData ? JSON.parse(paused.request.postData) : null,
      });
    }
    return false; // only recorded: the request goes on to the real backend
  };

  before(async () => {
    S = await startSuite("step5Actions");
    S.interceptor = record;

    const category = await S.models.Category.create({ name: `${S.tag} Cat` });
    const makeProduct = (name, price, stock = 10) =>
      S.models.Product.create({ name: `${S.tag} ${name}`, description: "d", price, stock, category: category._id, imageUrl: "" });
    alpha = await makeProduct("Alpha", 250.75);
    beta = await makeProduct("Beta", 99.99);
    gamma = await makeProduct("Gamma", 10);
    admin = await S.newUser("admin", "admin");
    bob = await S.newUser("bob");
  });

  after(async () => {
    if (S) await S.finish();
  });

  // ---- helpers of this suite ---------------------------------------------------------
  const stockOf = async (product) => (await S.models.Product.findById(product._id)).stock;
  const dbOrder = (order) => S.models.Order.findById(order._id);
  const buttonLabels = () => S.js("[...document.querySelectorAll('#actions-heading ~ .form-actions .button')].map(b=>b.textContent.trim())");
  const waitForPage = () => S.waitFor("!/Loading the order/.test(document.body.innerText) && !!document.querySelector('#actions-heading')", "the order page");
  const open = async (order) => {
    await S.goto(`${S.appUrl}/admin/orders/${order._id}`);
    await waitForPage();
  };
  const clickAction = (label) => S.clickByText("#actions-heading ~ .form-actions .button", label);
  const confirmAction = () => S.click(".action-confirm button[type=submit]");
  // The notice above the panel (after a change) shows what the server answered
  const waitForNotice = (text) =>
    S.waitFor(`!!document.querySelector('.order-actions')?.previousElementSibling && /${text}/.test(document.querySelector('.order-actions').previousElementSibling.innerText)`, `the notice "${text}"`);
  const badge = () => S.js("document.querySelector('.order-subtitle .badge').textContent");
  const settleAt = async (pathname) => {
    await S.waitFor(`location.pathname === ${JSON.stringify(pathname)}`, `redirect to ${pathname}`);
    await S.sleep(250);
  };

  // ---- A -------------------------------------------------------------------------
  sec("A. the whole forward chain, driven only by the server's buttons", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.js("localStorage.clear()");
    await S.uiLogin("admin");

    firstOrder = await S.insertOrder(bob, [[alpha, 2], [beta, 1]], {});
    await open(firstOrder);
    S.check("pending: buttons are Confirm order + Cancel order", JSON.stringify(await buttonLabels()) === JSON.stringify(["Confirm order", "Cancel order"]), JSON.stringify(await buttonLabels()));
    S.check("heading 'Update order'", (await S.text()).includes("Update order"));
    S.check("no confirmation box until a button is clicked", !(await S.has(".action-confirm")));

    await clickAction("Confirm order");
    S.check("click opens an inline confirmation (no browser dialog)", (await S.has(".action-confirm")) && S.dialogs.length === 0);
    S.check("...asks 'Change the status to Confirmed?'", (await S.text()).includes("Change the status to Confirmed?"));
    S.check("...the note box is focused", await S.js("document.activeElement && document.activeElement.id === 'order-note'"));
    S.check("...nothing was sent yet", sent.length === 0, JSON.stringify(sent));
    await S.clickByText(".action-confirm .button", "Back");
    S.check("Back closes it and sends nothing", !(await S.has(".action-confirm")) && sent.length === 0);
    S.check("...and the order is unchanged", (await dbOrder(firstOrder)).status === "pending");

    await clickAction("Confirm order");
    await S.setValue("#order-note", "  Called the customer\r\nAll good <b>x</b>  ");
    S.check("counter follows the typing", (await S.js("document.querySelector('.notes-counter').textContent")).endsWith("/300"));
    await confirmAction();
    await waitForNotice("Order is now confirmed");
    S.check(
      "PATCH sent with status + trimmed note, nothing else",
      sent.length === 1 && sent[0].method === "PATCH" && sent[0].url === `/admin/orders/${firstOrder._id}/status` && JSON.stringify(sent[0].body) === JSON.stringify({ note: "Called the customer\nAll good <b>x</b>", status: "confirmed" }),
      JSON.stringify(sent)
    );
    S.check("success notice, status badge and history updated", (await badge()) === "Confirmed" && (await S.js("document.querySelector('.status-ok')?.innerText.includes('Order is now confirmed')")));
    const history = await S.js("[...document.querySelectorAll('.status-history-item')].map(li=>li.innerText.replace(/\\s+/g,' '))");
    S.check(
      "history has the new entry with admin name and note (HTML as text)",
      history.length === 2 && history[1].includes("Confirmed") && history[1].includes("by admin tester (admin)") && history[1].includes("All good <b>x</b>") && !(await S.has(".status-history-note b")),
      JSON.stringify(history)
    );
    S.check("confirmation closed, buttons now Start processing + Cancel", !(await S.has(".action-confirm")) && JSON.stringify(await buttonLabels()) === JSON.stringify(["Start processing", "Cancel order"]), JSON.stringify(await buttonLabels()));

    await clickAction("Start processing");
    await confirmAction();
    await waitForNotice("Order is now processing");
    S.check("processing: buttons Mark as shipped + Cancel order", JSON.stringify(await buttonLabels()) === JSON.stringify(["Mark as shipped", "Cancel order"]), JSON.stringify(await buttonLabels()));
    S.check("...request had no note field when the note was empty", JSON.stringify(sent[1].body) === JSON.stringify({ status: "processing" }), JSON.stringify(sent[1]));

    await clickAction("Mark as shipped");
    await confirmAction();
    await waitForNotice("Order is now shipped");
    S.check("shipped: only Mark as delivered (the server removed Cancel)", JSON.stringify(await buttonLabels()) === JSON.stringify(["Mark as delivered"]), JSON.stringify(await buttonLabels()));

    await clickAction("Mark as delivered");
    S.check("delivered confirmation mentions COD becoming paid", (await S.text()).includes("Cash on Delivery payment will be marked as paid"));
    await confirmAction();
    await waitForNotice("Order is now delivered");
    S.check("delivered: payment badge turns Paid", (await S.js("[...document.querySelectorAll('.order-meta .badge')].map(b=>b.textContent).join()")) === "Paid");
    S.check("delivered: no buttons, message that it is final", (await buttonLabels()).length === 0 && (await S.text()).includes("This order is delivered. It is final"), JSON.stringify(await buttonLabels()));

    const stored = await dbOrder(firstOrder);
    S.check("database agrees: delivered + paid, 5 history entries", stored.status === "delivered" && stored.paymentStatus === "paid" && stored.statusHistory.length === 5, `${stored.status} ${stored.paymentStatus} ${stored.statusHistory.length}`);
    S.check("every request went to the right endpoint", sent.every((r) => r.method === "PATCH" && r.url === `/admin/orders/${firstOrder._id}/status`) && sent.length === 4);

    await S.goto(`${S.appUrl}/admin/orders`);
    await S.waitFor("!!document.querySelector('.admin-table')", "the list");
    S.check("the list page has no admin action panel", !(await S.text()).includes("Update order"));
  });

  // ---- B -------------------------------------------------------------------------
  sec("B. note validation (client side; the server is not called)", async () => {
    const order = await S.insertOrder(bob, [[alpha, 1]], {});
    await open(order);
    sent.length = 0;

    await clickAction("Confirm order");
    await S.setValue("#order-note", "x".repeat(301));
    await confirmAction();
    S.check(
      "301 characters: error shown, nothing sent, box stays open",
      (await S.js("document.querySelector('#order-note-error')?.textContent")) === "Note must be at most 300 characters" && sent.length === 0 && (await S.has(".action-confirm"))
    );
    S.check("...field marked invalid", (await S.js("document.querySelector('#order-note').getAttribute('aria-invalid')")) === "true");

    await S.setValue("#order-note", "bad" + String.fromCharCode(7) + "char");
    await confirmAction();
    S.check("control character: error shown, nothing sent", (await S.js("document.querySelector('#order-note-error')?.textContent")) === "Note contains invalid characters" && sent.length === 0);

    await S.setValue("#order-note", "fine now");
    S.check("typing clears the error", !(await S.has("#order-note-error")));
    await S.clickByText(".action-confirm .button", "Back");
    await clickAction("Confirm order");
    S.check("reopening starts with an empty note and no error", (await S.js("document.querySelector('#order-note').value")) === "" && !(await S.has("#order-note-error")));

    await S.setValue("#order-note", "x".repeat(300));
    await confirmAction();
    await waitForNotice("Order is now confirmed");
    S.check("exactly 300 characters is accepted", sent.length === 1 && sent[0].body.note.length === 300);
  });

  // ---- C -------------------------------------------------------------------------
  sec("C. cancel: stock comes back, with a warning first", async () => {
    const order = await S.insertOrder(bob, [[alpha, 2], [beta, 3]], {});
    const stockAlpha = await stockOf(alpha);
    const stockBeta = await stockOf(beta);
    await open(order);
    sent.length = 0;

    await clickAction("Cancel order");
    S.check(
      "cancel confirmation: title + stock warning, danger button",
      (await S.text()).includes("Cancel this order?") && (await S.text()).includes("This cannot be undone. The stock of every item in this order is returned to the shop.") && (await S.has(".action-confirm .button-danger"))
    );
    S.check("...buttons say 'Yes, cancel order' / 'Keep order'", (await S.js("[...document.querySelectorAll('.action-confirm .button')].map(b=>b.textContent).join('|')")) === "Yes, cancel order|Keep order");
    await S.clickByText(".action-confirm .button", "Keep order");
    S.check("Keep order sends nothing", sent.length === 0 && (await dbOrder(order)).status === "pending");

    await clickAction("Cancel order");
    await S.setValue("#order-note", "Customer asked to cancel");
    await confirmAction();
    await waitForNotice("Order cancelled");
    S.check(
      "POST to the cancel endpoint with only the note",
      sent.length === 1 && sent[0].method === "POST" && sent[0].url === `/admin/orders/${order._id}/cancel` && JSON.stringify(sent[0].body) === JSON.stringify({ note: "Customer asked to cancel" }),
      JSON.stringify(sent)
    );
    S.check("status Cancelled, no buttons, final message", (await badge()) === "Cancelled" && (await buttonLabels()).length === 0 && (await S.text()).includes("This order is cancelled. It is final"));
    S.check("page does not claim anything about stock after reload (flag is not reliable)", !(await S.text()).includes("Stock returned"));
    S.check("stock really went back in the database (+2 Alpha, +3 Beta)", (await stockOf(alpha)) === stockAlpha + 2 && (await stockOf(beta)) === stockBeta + 3, `${await stockOf(alpha)} ${await stockOf(beta)}`);
    S.check("no warning notice (plain success)", (await S.has(".status-ok")) && !(await S.has(".status-warning")));
    S.check("payment stays Pending for a cancelled order", (await S.js("[...document.querySelectorAll('.order-meta .badge')].map(b=>b.textContent).join()")) === "Pending");
  });

  // ---- D -------------------------------------------------------------------------
  sec("D. cancel when a product no longer exists: warning with the product name", async () => {
    const order = await S.insertOrder(bob, [[gamma, 4], [alpha, 1]], {});
    await S.models.Product.deleteOne({ _id: gamma._id });
    await open(order);
    await clickAction("Cancel order");
    await confirmAction();
    await waitForNotice("Order cancelled");
    S.check("amber warning notice (not the green success one)", (await S.has(".status-warning")) && !(await S.has(".status-ok")));
    const warning = await S.js("document.querySelector('.status-warning').innerText");
    S.check("...names the product and how many to add back", warning.includes(`${S.tag} Gamma: 4 to add back`), warning);
    S.check("...order is Cancelled and the warning stays until the page is left", (await badge()) === "Cancelled" && (await S.has(".status-warning")));
  });

  // ---- E -------------------------------------------------------------------------
  sec("E. someone else changed the order first (409)", async () => {
    const order = await S.insertOrder(bob, [[alpha, 1]], {});
    await open(order);
    sent.length = 0;
    await clickAction("Confirm order");
    // while the confirmation is open, "someone else" confirms the order
    await S.models.Order.updateOne({ _id: order._id }, { $set: { status: "confirmed" }, $push: { statusHistory: { status: "confirmed", changedAt: new Date(), changedBy: admin._id } } });
    await confirmAction();
    await S.waitFor("!!document.querySelector('.status-error')", "the conflict notice");
    const message = await S.js("document.querySelector('.status-error').innerText");
    S.check("red notice explains the order changed and was reloaded", /reloaded/.test(message) && message.length > 30, message);
    await S.waitFor("document.querySelector('.order-subtitle .badge').textContent === 'Confirmed'", "the reloaded status");
    S.check("the page now shows the current order and buttons", (await badge()) === "Confirmed" && JSON.stringify(await buttonLabels()) === JSON.stringify(["Start processing", "Cancel order"]), JSON.stringify(await buttonLabels()));
    S.check("confirmation box closed after the conflict", !(await S.has(".action-confirm")));
    S.check("the stale click changed nothing (history still 2)", (await dbOrder(order)).statusHistory.length === 2, (await dbOrder(order)).statusHistory.length);
  });

  // ---- F -------------------------------------------------------------------------
  sec("F. double click and slow server", async () => {
    const quick = await S.insertOrder(bob, [[alpha, 1]], {});
    await open(quick);
    sent.length = 0;
    await clickAction("Confirm order");
    await S.js("(()=>{const b=document.querySelector('.action-confirm button[type=submit]');b.click();b.click();b.click();return true})()");
    await waitForNotice("Order is now confirmed");
    S.check("three rapid clicks send ONE request", sent.length === 1, JSON.stringify(sent));
    S.check("...and the order has exactly one new history entry", (await dbOrder(quick)).statusHistory.length === 2);

    const slow = await S.insertOrder(bob, [[alpha, 1]], {});
    await open(slow);
    sent.length = 0;
    let held = null;
    S.interceptor = (paused) => {
      if (isWrite(paused)) {
        held = paused;
        return true; // keep this request waiting until the test lets it go
      }
      return false;
    };
    await clickAction("Confirm order");
    await confirmAction();
    await S.waitFor("!!document.querySelector('.action-confirm button[type=submit]')?.disabled", "the button to be disabled while saving");
    S.check(
      "while saving: Confirm says Saving... and is disabled, Back and the note are disabled too",
      (await S.js("document.querySelector('.action-confirm button[type=submit]').textContent")) === "Saving..." &&
        (await S.js("[...document.querySelectorAll('.action-confirm .button-secondary')].every(b=>b.disabled) && document.querySelector('#order-note').disabled"))
    );
    for (let i = 0; i < 100 && !held; i++) await S.sleep(50);
    await S.cdp.send("Fetch.continueRequest", { requestId: held.requestId });
    S.interceptor = record;
    await waitForNotice("Order is now confirmed");
    S.check("after the answer everything is normal again", (await badge()) === "Confirmed" && !(await S.has(".action-confirm")));
  });

  // ---- G -------------------------------------------------------------------------
  sec("G. server failures keep the box open and change nothing", async () => {
    const order = await S.insertOrder(bob, [[alpha, 1]], {});
    await open(order);

    S.interceptor = (paused) => isWrite(paused) && (S.fulfill(paused, 500, { success: false, message: "boom internal detail" }), true);
    await clickAction("Confirm order");
    await S.setValue("#order-note", "keep me");
    await confirmAction();
    await S.waitFor("!!document.querySelector('.action-confirm .status-error')", "the inline error");
    const errorText = await S.js("document.querySelector('.action-confirm .status-error').textContent");
    S.check("500: friendly inline error, no server detail", errorText.includes("Something went wrong") && errorText.includes("not changed") && !errorText.includes("boom"), errorText);
    S.check(
      "...box stays open with the note kept, and the order is unchanged",
      (await S.js("document.querySelector('#order-note').value")) === "keep me" && (await badge()) === "Pending" && (await dbOrder(order)).status === "pending"
    );

    S.interceptor = (paused) => isWrite(paused) && (S.fulfill(paused, 400, { success: false, message: "Note contains invalid characters" }), true);
    await confirmAction();
    await S.waitFor("/invalid characters/.test(document.querySelector('.action-confirm .status-error')?.textContent||'')", "the 400 message");
    S.check("400: the server's own message is shown", /invalid characters/.test(await S.js("document.querySelector('.action-confirm .status-error').textContent")));

    S.interceptor = record;
    sent.length = 0;
    await confirmAction();
    await waitForNotice("Order is now confirmed");
    S.check("retry works after the failures", (await dbOrder(order)).status === "confirmed" && sent.length === 1);

    const other = await S.insertOrder(bob, [[alpha, 1]], {});
    await open(other);
    S.interceptor = (paused) => isWrite(paused) && (S.fulfill(paused, 404, { success: false, message: "Order not found" }), true);
    await clickAction("Confirm order");
    await confirmAction();
    await S.waitFor("!!document.querySelector('.action-confirm .status-error')", "the 404 message");
    S.check("404: 'This order no longer exists.'", (await S.js("document.querySelector('.action-confirm .status-error').textContent")) === "This order no longer exists.");

    S.interceptor = (paused) => isWrite(paused) && (S.fulfill(paused, 401, { success: false, message: "Not authorized" }), true);
    await confirmAction();
    await S.waitFor("location.pathname === '/login'", "the redirect after a 401");
    S.check("401: logged out and sent to /login", (await S.js("localStorage.getItem('token')")) === null);
    S.interceptor = record;
  });

  // ---- H -------------------------------------------------------------------------
  sec("H. the customer sees the result, and never sees admin controls", async () => {
    await S.uiLogin("bob");
    await S.goto(`${S.appUrl}/orders/${firstOrder._id}`);
    await S.waitFor("!!document.querySelector('.order-subtitle')", "the customer's order page");
    S.check("customer page shows Delivered, no admin panel, no note/history", (await badge()) === "Delivered" && !(await S.text()).includes("Update order") && !(await S.text()).includes("Called the customer"));

    sent.length = 0;
    await S.goto(`${S.appUrl}/admin/orders/${firstOrder._id}`);
    await settleAt("/");
    S.check("customer typing the admin URL is sent home, nothing sent", (await S.url()) === "/" && sent.length === 0);
    await S.uiLogout();
  });

  // ---- I -------------------------------------------------------------------------
  sec("I. four screen widths", async () => {
    await S.uiLogin("admin");
    const order = await S.insertOrder(bob, [[alpha, 1], [beta, 1]], {});
    for (const [width, height] of [[375, 800], [768, 900], [1024, 800], [1440, 900]]) {
      await S.viewport(width, height, width < 500);
      await open(order);
      await clickAction("Confirm order");
      await S.setValue("#order-note", "A fairly long note to see how the box looks on this screen width.");
      S.check(`${width}px: confirmation box fits, no horizontal scroll`, await S.noHScroll());
      S.check(`${width}px: buttons are tall enough to tap`, await S.js("[...document.querySelectorAll('.action-confirm .button')].every(b=>b.getBoundingClientRect().height>=36)"));
      await S.shot(`actions-${width}`);
      await S.clickByText(".action-confirm .button", "Back");
    }
  });

  // ---- J -------------------------------------------------------------------------
  sec("J. whole-run checks", async () => {
    S.check("the browser console stayed clean", S.consoleProblems.length === 0, S.consoleProblems.join(" | "));
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
  });
});
