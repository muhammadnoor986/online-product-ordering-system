// The admin orders list (/admin/orders): who may open it, the rows, counts, paging, filters,
// search, sorting, odd addresses, server failures, and four screen widths.
// (Moved into the repository from the old scratch folder, where it was "step3List".)
//
// Run it with:  npm run test:e2e -- step3List
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");

describe("admin orders list", () => {
  let S;
  const sec = (title, body) => section(() => S, title, body);

  let all; // every order of this suite, oldest first
  let newest; // the same orders, newest first (the order the page must show)
  let T; // this suite's tag, as typed into the search box

  before(async () => {
    S = await startSuite("step3List");

    const category = await S.models.Category.create({ name: `${S.tag} Cat` });
    const makeProduct = (name, price) =>
      S.models.Product.create({ name: `${S.tag} ${name}`, description: "d", price, stock: 99, category: category._id, imageUrl: "" });
    const alpha = await makeProduct("Alpha", 250.75);
    const beta = await makeProduct("Beta", 99.99);

    await S.newUser("admin", "admin");
    await S.newUser("bob");
    await S.newUser("alice");

    // 25 orders of bob (the six statuses in turn, known dates) and 3 newer orders of alice
    const statuses = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
    const base = Date.now() - 40 * 24 * 3600 * 1000;
    all = [];
    for (let i = 0; i < 25; i++) {
      const status = statuses[i % 6];
      all.push(
        await S.insertOrder(S.users.bob, i % 2 ? [[alpha, 1 + (i % 3)]] : [[alpha, 1], [beta, 2]], {
          createdAt: new Date(base + i * 3600e3),
          status,
          paymentStatus: status === "delivered" ? "paid" : "pending",
        })
      );
    }
    for (let i = 0; i < 3; i++) {
      all.push(await S.insertOrder(S.users.alice, [[beta, 1]], { createdAt: new Date(base + (100 + i) * 3600e3), status: "confirmed" }));
    }
    newest = [...all].sort((x, y) => y.createdAt - x.createdAt);
    T = encodeURIComponent(S.tag.toLowerCase());
  });

  after(async () => {
    if (S) await S.finish();
  });

  // ---- helpers of this suite -------------------------------------------------------
  const isListRequest = (paused) => paused.request.method === "GET" && /\/api\/admin\/orders(\?|$)/.test(paused.request.url);
  const adminCalls = () => S.apiCalls.filter((call) => /\/api\/admin\/orders(\?|$)/.test(call));
  const rowsNumbers = () => S.js("[...document.querySelectorAll('.admin-table tbody tr td:first-child')].map(e=>e.textContent.trim())");
  const tabs = () => S.js("[...document.querySelectorAll('.status-tab')].map(b=>b.textContent.trim())");
  const submitSearch = () => S.click("form[role=search] button[type=submit]");

  // How many list requests have already been waited for. After an action that makes the page ask the
  // server again, wait for the NEW request, then for the page to stop loading and stay still.
  let waitedFor = 0;
  const forgetCalls = () => { S.resetCalls(); waitedFor = 0; };
  const newRequestDone = async (extraCondition) => {
    const startedAt = Date.now();
    while (adminCalls().length <= waitedFor) {
      if (Date.now() - startedAt > 8000) throw new Error("the page did not ask the server for the list");
      await S.sleep(50);
    }
    waitedFor = adminCalls().length;
    await S.sleep(150);
    await S.waitFor(`!/Loading orders/.test(document.body.innerText) && (${extraCondition})`, "the list to settle");
    await S.sleep(100);
    await S.waitFor(`!/Loading orders/.test(document.body.innerText) && (${extraCondition})`, "the list to stay settled");
  };
  const waitRows = () => newRequestDone("!!document.querySelector('.admin-table tbody tr')");
  const waitSettled = () => newRequestDone("!!document.querySelector('.status-tabs')");

  // After a redirect: wait for the new address, then give a wrong request a moment to show up
  const settleAt = async (pathname) => {
    await S.waitFor(`location.pathname === ${JSON.stringify(pathname)}`, `redirect to ${pathname}`);
    await S.sleep(250);
  };
  const adminLinks = async () => (await S.navbarLinks()).filter((link) => link.href && link.href.startsWith("/admin"));

  // ---- A -------------------------------------------------------------------------
  sec("A. access and navigation", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.js("localStorage.clear()");
    await S.goto(`${S.appUrl}/`);
    await S.waitFor("!!document.querySelector('.navbar-links')", "the navbar");
    S.check("anonymous: no admin links in the navbar", (await adminLinks()).length === 0, JSON.stringify(await S.navbarLinks()));
    S.check("anonymous: no profile link either", (await S.userLink()) === null);

    forgetCalls();
    await S.goto(`${S.appUrl}/admin/orders`);
    await settleAt("/login");
    S.check("anonymous opening /admin/orders -> /login, no API call", (await S.url()) === "/login" && adminCalls().length === 0, await S.url());

    await S.uiLogin("bob");
    S.check("customer: no admin links in the navbar", (await adminLinks()).length === 0, JSON.stringify(await S.navbarLinks()));
    S.check("customer: the name links to the profile, not to anything admin", (await S.userLink()).href === "/profile");
    forgetCalls();
    await S.goto(`${S.appUrl}/admin/orders`);
    await settleAt("/");
    S.check("customer opening /admin/orders -> home, no admin API call", (await S.url()) === "/" && adminCalls().length === 0, `${await S.url()} ${adminCalls()}`);
    await S.uiLogout();

    await S.uiLogin("admin");
    // (The navbar also contains the admin's own name link, so the admin links are checked one by one.)
    const links = await adminLinks();
    S.check(
      "admin: the three admin links are there, in order, pointing to the right pages",
      JSON.stringify(links) === JSON.stringify([
        { text: "Admin Products", href: "/admin/products" },
        { text: "Admin Categories", href: "/admin/categories" },
        { text: "Admin Orders", href: "/admin/orders" },
      ]),
      JSON.stringify(links)
    );
    const userLink = await S.userLink();
    S.check("admin: the name link to the profile is separate from them", userLink.href === "/profile" && userLink.text.endsWith("(admin)"), JSON.stringify(userLink));

    await S.clickByText(".navbar-links a", "Admin Orders");
    await waitSettled();
    S.check("clicking the Admin Orders link opens /admin/orders", (await S.url()) === "/admin/orders", await S.url());
    S.check("heading is Manage Orders", (await S.js("document.querySelector('h1').textContent")) === "Manage Orders");
    S.check("the page is really the orders list (status tabs and search are there)", (await S.has(".status-tabs")) && (await S.has("#order-search")));
  });

  // ---- B -------------------------------------------------------------------------
  sec("B. list, counts, paging (scoped to this suite's data by the search)", async () => {
    forgetCalls();
    await S.goto(`${S.appUrl}/admin/orders?search=${T}`);
    await waitRows();
    const page1 = await rowsNumbers();
    S.check("page 1 shows 10 rows, newest first", page1.length === 10 && JSON.stringify(page1) === JSON.stringify(newest.slice(0, 10).map((o) => o.orderNumber)), JSON.stringify(page1));
    S.check("count line says 28 orders", (await S.js("document.querySelector('.results-count').textContent")) === "28 orders");
    S.check("API got limit=10 and the search", adminCalls().some((call) => /limit=10/.test(call) && /search=/.test(call)), adminCalls().join("\n"));
    S.check(
      "tabs with counts",
      JSON.stringify(await tabs()) === JSON.stringify(["All (28)", "Pending (5)", "Confirmed (7)", "Processing (4)", "Shipped (4)", "Delivered (4)", "Cancelled (4)"]),
      JSON.stringify(await tabs())
    );
    S.check("All tab is pressed", await S.js("document.querySelector('.status-tab').getAttribute('aria-pressed')==='true'"));

    const row0 = await S.js("(()=>{const tr=document.querySelector('.admin-table tbody tr');return [...tr.children].map(td=>td.textContent.trim().replace(/\\s+/g,' '))})()");
    S.check(
      "row shows order, customer name+email, items, total, payment, status",
      row0[0] === newest[0].orderNumber && row0[1].includes("alice tester") && row0[1].includes("@example.com") && row0[3] === "1" && row0[4] === "Rs. 99.99" && row0[5].includes("Cash on Delivery") && row0[5].includes("Pending") && row0[6] === "Confirmed" && row0[7] === "View",
      JSON.stringify(row0)
    );
    S.check("list never shows delivery address or phone", !(await S.text()).includes("PRIVATE-STREET-77") && !(await S.text()).includes("5550199"));
    S.check("View link goes to /admin/orders/<id>", (await S.js("document.querySelector('.admin-table tbody tr a').getAttribute('href')")) === `/admin/orders/${newest[0]._id}`);

    await S.clickByText(".pagination .button", "Next");
    await S.waitFor("location.search.includes('page=2')", "page 2");
    await waitRows();
    const page2 = await rowsNumbers();
    S.check("page 2 = rows 11-20", JSON.stringify(page2) === JSON.stringify(newest.slice(10, 20).map((o) => o.orderNumber)), JSON.stringify(page2));
    S.check("URL keeps search and page", (await S.url()) === `/admin/orders?search=${T}&page=2`, await S.url());
    await S.js("history.back()");
    await S.waitFor("!location.search.includes('page=2')", "back");
    await waitRows();
    S.check("Back button returns to page 1", JSON.stringify(await rowsNumbers()) === JSON.stringify(page1));

    await S.goto(`${S.appUrl}/admin/orders?search=${T}&page=3`);
    await waitRows();
    S.check("page 3 has the last 8 rows", (await rowsNumbers()).length === 8);
    S.check("Next is disabled on the last page", await S.js("[...document.querySelectorAll('.pagination .button')].find(b=>b.textContent==='Next').disabled"));

    await S.goto(`${S.appUrl}/admin/orders?search=${T}&page=9`);
    await waitSettled();
    S.check("page past the end: friendly message + Go to first page", (await S.text()).includes("no orders on this page") && (await S.has(".message-box .button")));
    await S.clickByText(".message-box .button", "Go to first page");
    await waitRows();
    S.check("...which returns to page 1", JSON.stringify(await rowsNumbers()) === JSON.stringify(page1) && !(await S.url()).includes("page="), await S.url());
  });

  // ---- C -------------------------------------------------------------------------
  sec("C. filters", async () => {
    await S.clickByText(".status-tab", "Pending (5)");
    await waitRows();
    const pending = await rowsNumbers();
    S.check("Pending tab: URL has status=pending", (await S.url()) === `/admin/orders?search=${T}&status=pending`, await S.url());
    S.check(
      "...5 rows, all pending, newest first",
      pending.length === 5 &&
        (await S.js("[...document.querySelectorAll('.admin-table tbody tr td[data-label=Status]')].every(e=>e.textContent.trim()==='Pending')")) &&
        JSON.stringify(pending) === JSON.stringify(newest.filter((o) => o.status === "pending").map((o) => o.orderNumber)),
      JSON.stringify(pending)
    );
    S.check("...tab counts stay the same (status filter ignored for counts)", (await tabs())[0] === "All (28)" && (await tabs())[2] === "Confirmed (7)", JSON.stringify(await tabs()));
    S.check("...Pending tab pressed, All not", await S.js("(()=>{const t=[...document.querySelectorAll('.status-tab')];return t[1].getAttribute('aria-pressed')==='true'&&t[0].getAttribute('aria-pressed')==='false'})()"));

    await S.goto(`${S.appUrl}/admin/orders?search=${T}&page=3`);
    await waitRows();
    await S.clickByText(".status-tab", "Delivered (4)");
    await waitRows();
    S.check("changing the status goes back to page 1 (no page= in URL)", !(await S.url()).includes("page=") && (await rowsNumbers()).length === 4, await S.url());

    const options = await S.js("[...document.querySelectorAll('#order-payment option')].map(o=>o.textContent)");
    S.check("payment filter offers All, Pending, Paid only", JSON.stringify(options) === JSON.stringify(["All", "Pending", "Paid"]), JSON.stringify(options));
    await S.setValue("#order-payment", "paid");
    await waitRows();
    S.check("Delivered + Paid: 4 rows with Paid badge", (await rowsNumbers()).length === 4 && (await S.js("[...document.querySelectorAll('.admin-table tbody tr td[data-label=Payment]')].every(e=>e.textContent.includes('Paid'))")));
    S.check("...URL has paymentStatus=paid", (await S.url()).includes("paymentStatus=paid"));
    S.check(
      "...counts follow the payment filter (only delivered orders are paid)",
      JSON.stringify(await tabs()) === JSON.stringify(["All (4)", "Pending (0)", "Confirmed (0)", "Processing (0)", "Shipped (0)", "Delivered (4)", "Cancelled (0)"]),
      JSON.stringify(await tabs())
    );

    await S.clickByText(".status-tab", "Pending (0)");
    await S.waitFor("!!document.querySelector('.message-box')", "the no-match message");
    S.check(
      "no match: friendly message + Clear filters",
      (await S.text()).includes("No orders match") && (await S.js("!![...document.querySelectorAll('.message-box .button')].find(b=>b.textContent==='Clear filters')"))
    );
    await S.clickByText(".message-box .button", "Clear filters");
    await waitRows();
    S.check("Clear filters empties the address and the box", (await S.url()) === "/admin/orders" && (await S.js("document.querySelector('#order-search').value")) === "");
    S.check("Clear filters button is disabled when nothing is filtered", await S.js("[...document.querySelectorAll('.filter-buttons .button')][0].disabled"));
  });

  // ---- D -------------------------------------------------------------------------
  sec("D. search and sort", async () => {
    const first = all[0];
    await S.setValue("#order-search", first.orderNumber.toLowerCase());
    await submitSearch();
    await waitRows();
    S.check("search by order number (case-insensitive) finds exactly that order", JSON.stringify(await rowsNumbers()) === JSON.stringify([first.orderNumber]) && (await S.url()).includes("search="), await S.url());

    await S.setValue("#order-search", `${S.tag.toLowerCase()}.alice@example.com`);
    await submitSearch();
    await waitRows();
    S.check("search by e-mail finds alice's 3 orders", (await rowsNumbers()).length === 3);

    await S.setValue("#order-search", "+92-345 555 0199");
    await submitSearch();
    await waitSettled();
    // Every order of this suite has the phone "+92 345 5550199", so at least its 28 orders must be found
    const found = Number(((await S.js("document.querySelector('.results-count')?.textContent || ''")).match(/^(\d+) orders?$/) || [])[1] || 0);
    S.check("phone search with different punctuation still finds the orders (server rule)", found >= 28, `found ${found}`);

    await S.setValue("#order-search", "(.*)[x");
    await submitSearch();
    await waitSettled();
    S.check("regex-looking text is treated as plain text (no error, no match)", (await S.text()).includes("No orders match") && !(await S.has(".message-box-error")));

    await S.setValue("#order-search", "<img src=x onerror=alert(1)>");
    await submitSearch();
    await waitSettled();
    S.check("HTML typed in search is not rendered as HTML", !(await S.has("img[src=x]")) && S.dialogs.length === 0);
    S.check("search box limits input to 100 characters", (await S.js("document.querySelector('#order-search').maxLength")) === 100);

    await S.goto(`${S.appUrl}/admin/orders?search=${T}&sort=oldest`);
    await waitRows();
    const oldest = await rowsNumbers();
    S.check("sort=oldest shows oldest first", oldest[0] === all[0].orderNumber && (await S.js("document.querySelector('#order-sort').value")) === "oldest", JSON.stringify(oldest));
    await S.setValue("#order-sort", "newest");
    await waitRows();
    S.check("choosing Newest removes sort from the address", !(await S.url()).includes("sort=") && (await rowsNumbers())[0] === newest[0].orderNumber);
  });

  // ---- E -------------------------------------------------------------------------
  sec("E. odd addresses never reach the server as bad values", async () => {
    forgetCalls();
    await S.goto(`${S.appUrl}/admin/orders?search=${T}&status=bogus&paymentStatus=failed&sort=sideways&page=abc`);
    await waitRows();
    S.check("bad status/paymentStatus/sort/page are ignored: normal list, no error", (await rowsNumbers()).length === 10 && !(await S.has(".message-box-error")));
    S.check("...and were not sent to the API", !adminCalls().some((call) => /bogus|failed|sideways|page=abc/.test(call)), adminCalls().join("\n"));

    await S.goto(`${S.appUrl}/admin/orders?search=${"x".repeat(150)}`);
    await waitSettled();
    S.check("search longer than 100 in the address is cut to 100 (no 400)", !(await S.has(".message-box-error")) && (await S.js("document.querySelector('#order-search').value.length")) === 100);
  });

  // ---- F -------------------------------------------------------------------------
  sec("F. server failures", async () => {
    await S.goto(`${S.appUrl}/admin/orders?search=${T}`);
    await waitRows();

    S.interceptor = (paused) => isListRequest(paused) && (S.fulfill(paused, 500, { success: false, message: "boom internal detail" }), true);
    await S.clickByText(".status-tab", "Pending (5)");
    await S.waitFor("!!document.querySelector('.message-box-error')", "the error message");
    const errorText = await S.js("document.querySelector('.message-box-error').textContent");
    S.check("500: friendly message, server detail not shown, filters still usable", errorText.includes("Something went wrong") && !errorText.includes("boom") && (await S.has(".status-tabs")) && (await S.has("#order-search")), errorText);

    S.interceptor = null;
    await S.clickByText(".message-box-error .button", "Try again");
    await waitRows();
    S.check("Try again reloads the list", (await rowsNumbers()).length === 5);

    S.interceptor = (paused) => isListRequest(paused) && (S.fulfill(paused, 401, { success: false, message: "Not authorized" }), true);
    await S.clickByText(".status-tab", "Shipped (4)");
    await S.waitFor("location.pathname === '/login'", "the redirect after a 401");
    S.check("401: logged out and sent to /login", (await S.js("localStorage.getItem('token')")) === null && !(await S.has(".navbar-user")));
    S.interceptor = null;
  });

  // ---- G -------------------------------------------------------------------------
  sec("G. four screen widths", async () => {
    await S.uiLogin("admin");
    for (const [width, height] of [[375, 800], [768, 900], [1024, 800], [1440, 900]]) {
      await S.viewport(width, height, width < 500);
      await S.goto(`${S.appUrl}/admin/orders?search=${T}`);
      await waitRows();
      S.check(`${width}px: no horizontal scroll`, await S.noHScroll());
      if (width === 375) {
        const label = await S.js("getComputedStyle(document.querySelector('.admin-table tbody td'),'::before').content");
        S.check("375px: rows are cards with labels", label === '"Order"' && (await S.js("getComputedStyle(document.querySelector('.admin-table tbody tr')).display")) === "block", label);
        const small = await S.js("[...document.querySelectorAll('.status-tab, .admin-table .button, .filters .button, #order-sort, #order-payment, #order-search')].filter(e=>{const r=e.getBoundingClientRect();return r.height<30}).length");
        S.check("375px: controls are at least 30px tall", small === 0, small);
      }
      if (width === 1440) S.check("1440px: real table header visible", (await S.js("getComputedStyle(document.querySelector('.admin-table thead')).position")) !== "absolute");
      await S.shot(`list-${width}`);
    }
  });

  // ---- H -------------------------------------------------------------------------
  sec("H. whole-run checks", async () => {
    S.check("the browser console stayed clean", S.consoleProblems.length === 0, S.consoleProblems.join(" | "));
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
  });
});
