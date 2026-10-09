// The order progress timeline on the customer's order page (/orders/:id): every status,
// cancelled orders from different stages, odd histories, admin notes never shown to the customer,
// live update after cancelling, other pages unchanged, and four screen widths.
// (Moved into the repository from the old scratch folder, where it was "step7bTimeline".)
//
// Run it with:  npm run test:e2e -- step7bTimeline
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");

describe("customer order timeline", () => {
  let S;
  const sec = (title, body) => section(() => S, title, body);

  let alpha;
  let bob;
  let admin;
  const SECRET_NOTE = "SECRET-ADMIN-NOTE-DO-NOT-SHOW";

  before(async () => {
    S = await startSuite("step7bTimeline");

    const category = await S.models.Category.create({ name: `${S.tag} Cat` });
    alpha = await S.models.Product.create({ name: `${S.tag} Alpha`, description: "d", price: 100, stock: 10, category: category._id, imageUrl: "" });
    bob = await S.newUser("bob");
    admin = await S.newUser("admin", "admin");
  });

  after(async () => {
    if (S) await S.finish();
  });

  // ---- helpers of this suite ---------------------------------------------------------
  // The history of an order that went through `statuses`, one hour apart, the last one just now.
  // Every step after the first was made by the admin and carries a secret note.
  const historyOf = (statuses) => {
    const now = Date.now();
    return statuses.map((status, i) => ({
      status,
      changedAt: new Date(now - (statuses.length - i) * 3600e3),
      changedBy: i ? admin._id : bob._id,
      note: i ? `${SECRET_NOTE} ${status}` : "",
    }));
  };
  const makeOrder = (status, path, overrides = {}) =>
    S.insertOrder(bob, [[alpha, 1]], {
      status,
      statusHistory: historyOf(path),
      stockRestored: status === "cancelled",
      paymentStatus: status === "delivered" ? "paid" : "pending",
      ...overrides,
    });
  const open = async (order) => {
    await S.goto(`${S.appUrl}/orders/${order._id}`);
    await S.waitFor("!/Loading your order/.test(document.body.innerText) && !!document.querySelector('.order-timeline')", "the timeline");
  };
  const steps = () =>
    S.js("[...document.querySelectorAll('.timeline-step')].map(li=>({ s: li.querySelector('.timeline-label').textContent.toLowerCase(), cls: li.className.replace('timeline-step timeline-step-',''), date: li.querySelector('.timeline-date')?.textContent||null, sr: li.querySelector('.visually-hidden').textContent.trim() }))");
  const summary = (list) => list.map((step) => `${step.s}:${step.cls}`).join(" ");

  const path = ["pending", "confirmed", "processing", "shipped", "delivered"];
  let gapped; // an order whose history skips steps (used again later)

  // ---- A -------------------------------------------------------------------------
  sec("A. every status", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.js("localStorage.clear()");
    await S.uiLogin("bob");

    for (let i = 0; i < path.length; i++) {
      const order = await makeOrder(path[i], path.slice(0, i + 1));
      await open(order);
      const list = await steps();
      const expected = path.map((name, j) => `${name}:${j < i ? "done" : j === i ? "current" : "upcoming"}`).join(" ");
      S.check(`${path[i]}: ${expected}`, summary(list) === expected, summary(list));
      S.check(`${path[i]}: reached steps show a date, upcoming ones none`, list.every((step, j) => (j <= i) === (step.date !== null)), JSON.stringify(list.map((step) => step.date)));
      S.check(`${path[i]}: screen-reader text on every step`, list.every((step) => /completed|current step|not reached yet/.test(step.sr)) && list[i].sr === "(current step)");
      S.check(
        `${path[i]}: heading 'Order progress' and status badge agree`,
        (await S.text()).includes("Order progress") && (await S.js("document.querySelector('.order-subtitle .badge').textContent")) === path[i][0].toUpperCase() + path[i].slice(1)
      );
    }
  });

  // ---- B -------------------------------------------------------------------------
  sec("B. cancelled from different stages", async () => {
    for (const from of [["pending"], ["pending", "confirmed"], ["pending", "confirmed", "processing"]]) {
      const order = await makeOrder("cancelled", [...from, "cancelled"]);
      await open(order);
      const list = await steps();
      const expected = [...from.map((name) => `${name}:done`), "cancelled:cancelled"].join(" ");
      S.check(`cancelled after ${from[from.length - 1]}: ${expected}`, summary(list) === expected, summary(list));
      S.check("...no future status shown, every step has a real date", !list.some((step) => ["shipped", "delivered"].includes(step.s)) && list.every((step) => step.date), JSON.stringify(list));
      S.check("...Cancelled marker is red", (await S.js("getComputedStyle(document.querySelector('.timeline-step-cancelled .timeline-marker')).backgroundColor")) === "rgb(220, 38, 38)");
    }
  });

  // ---- C -------------------------------------------------------------------------
  sec("C. odd history", async () => {
    gapped = await makeOrder("shipped", ["pending", "shipped"]);
    await open(gapped);
    let list = await steps();
    S.check("gapped history: the gap is not shown as completed", summary(list) === "pending:done confirmed:upcoming processing:upcoming shipped:current delivered:upcoming", summary(list));

    const bare = await makeOrder("confirmed", []);
    await open(bare);
    list = await steps();
    S.check(
      "empty history: current step shown, no dates invented, no crash",
      summary(list) === "pending:upcoming confirmed:current processing:upcoming shipped:upcoming delivered:upcoming" && list.every((step) => step.date === null),
      summary(list)
    );
  });

  // ---- D -------------------------------------------------------------------------
  sec("D. admin notes are never shown to the customer", async () => {
    const noted = await makeOrder("processing", ["pending", "confirmed", "processing"]);
    await open(noted);
    S.check(
      "no admin note text anywhere on the customer page",
      !(await S.text()).includes("SECRET-ADMIN-NOTE") && !(await S.js("document.documentElement.innerHTML")).includes("SECRET-ADMIN-NOTE")
    );
    S.check("no admin name or role in the page", !(await S.text()).includes("admin tester"));
  });

  // ---- E -------------------------------------------------------------------------
  sec("E. updates live after the customer cancels", async () => {
    const live = await makeOrder("pending", ["pending"]);
    await open(live);
    await S.clickByText(".cancel-panel .button", "Cancel order");
    await S.clickByText(".action-confirm .button", "Yes, cancel order");
    await S.waitFor("document.querySelector('.order-subtitle .badge').textContent === 'Cancelled'", "the status to change");
    await S.waitFor("document.querySelectorAll('.timeline-step').length === 2", "the timeline to update");
    const list = await steps();
    S.check("timeline becomes pending:done cancelled:cancelled with a date", summary(list) === "pending:done cancelled:cancelled" && Boolean(list[1].date), summary(list));
  });

  // ---- F -------------------------------------------------------------------------
  sec("F. other pages", async () => {
    await S.goto(`${S.appUrl}/orders`);
    await S.waitFor("!!document.querySelector('.order-card')", "the order list");
    S.check("My Orders list unchanged: no timeline there", !(await S.has(".order-timeline")));

    await open(gapped);
    S.check(
      "items list still the same structure",
      await S.js("(()=>{const s=document.querySelector('section[aria-labelledby=items-heading]');return !!s&&s.children[0].tagName==='H2'&&s.children[1].tagName==='UL'})()")
    );

    await S.uiLogout();
    await S.uiLogin("admin");
    await S.goto(`${S.appUrl}/admin/orders/${gapped._id}`);
    await S.waitFor("!!document.querySelector('.status-history')", "the admin order page");
    S.check("admin order page unchanged: history with notes, no customer timeline", (await S.text()).includes("SECRET-ADMIN-NOTE") && !(await S.has(".order-timeline")));
    await S.uiLogout();
    await S.uiLogin("bob");
  });

  // ---- G -------------------------------------------------------------------------
  sec("G. four screen widths", async () => {
    for (const [width, height] of [[375, 800], [768, 900], [1024, 800], [1440, 900]]) {
      await S.viewport(width, height, width < 500);
      await open(await makeOrder("processing", ["pending", "confirmed", "processing"]));
      S.check(`${width}px: no horizontal scroll`, await S.noHScroll());
      const positions = await S.js("[...document.querySelectorAll('.timeline-step')].map(li=>{const r=li.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top)]})");
      const sideBySide = positions.every((p, i) => i === 0 || (p[0] > positions[i - 1][0] && p[1] === positions[0][1]));
      const stacked = positions.every((p, i) => i === 0 || (p[1] > positions[i - 1][1] && p[0] === positions[0][0]));
      S.check(`${width}px: ${width >= 700 ? "steps side by side" : "steps stacked"}`, width >= 700 ? sideBySide : stacked, JSON.stringify(positions));
      S.check(`${width}px: every label and date fits inside the screen`, await S.js("[...document.querySelectorAll('.timeline-step')].every(li=>li.getBoundingClientRect().right<=window.innerWidth)"));
      await S.shot(`timeline-${width}`);
    }
    await S.viewport(375, 800, true);
    await open(await makeOrder("cancelled", ["pending", "confirmed", "cancelled"]));
    await S.shot("timeline-cancelled-375");
  });

  // ---- H -------------------------------------------------------------------------
  sec("H. whole-run checks", async () => {
    S.check("the browser console stayed clean", S.consoleProblems.length === 0, S.consoleProblems.join(" | "));
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
  });
});
