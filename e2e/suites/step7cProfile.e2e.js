// The profile page (/profile): protection, what a customer sees, name validation, changing the
// name, refresh and navigation, refusal of sensitive fields, failures, the admin's own profile,
// and four screen widths with a very long name.
// (Moved into the repository from the old scratch folder, where it was "step7cProfile".)
//
// Run it with:  npm run test:e2e -- step7cProfile
const { describe, before, after } = require("node:test");
const { startSuite, section } = require("../lib/suite");

describe("profile page", () => {
  let S;
  const sec = (title, body) => section(() => S, title, body);

  let bob;
  let admin;
  let eve;
  let oldOrder; // an order bob placed under his old name

  // Every name-change request the page sends (the request bodies)
  const sent = [];
  const isNameChange = (paused) => paused.request.method === "PATCH" && /\/api\/auth\/me$/.test(paused.request.url);
  const record = (paused) => {
    if (isNameChange(paused)) sent.push(paused.request.postData ? JSON.parse(paused.request.postData) : null);
    return false; // only recorded: the request goes on to the real backend
  };

  before(async () => {
    S = await startSuite("step7cProfile");
    S.interceptor = record;

    bob = await S.newUser("bob");
    admin = await S.newUser("admin", "admin");
    eve = await S.newUser("eve");
    const category = await S.models.Category.create({ name: `${S.tag} Cat` });
    const alpha = await S.models.Product.create({ name: `${S.tag} Alpha`, description: "d", price: 100, stock: 10, category: category._id, imageUrl: "" });
    oldOrder = await S.insertOrder(bob, [[alpha, 1]], {});
  });

  after(async () => {
    if (S) await S.finish();
  });

  // ---- helpers of this suite ---------------------------------------------------------
  const nameInDatabase = async (user) => (await S.models.User.findById(user._id)).name;
  const navbarName = async () => ((await S.userLink()) || {}).text;
  const nameField = () => S.js("document.querySelector('#profile-name').value");
  const openProfile = async () => {
    await S.goto(`${S.appUrl}/profile`);
    await S.waitFor("!!document.querySelector('#profile-name')", "the profile page");
  };
  const save = () => S.click("form.profile-card button[type=submit]");
  const saveDisabled = () => S.js("document.querySelector('form.profile-card button[type=submit]').disabled");
  const fieldError = () => S.js("document.querySelector('#profile-name-error')?.textContent || null");
  const linkTexts = async () => (await S.navbarLinks()).map((link) => link.text);

  // ---- A -------------------------------------------------------------------------
  sec("A. protection", async () => {
    await S.goto(`${S.appUrl}/login`);
    await S.js("localStorage.clear()");
    S.resetCalls();
    await S.goto(`${S.appUrl}/profile`);
    await S.settleAt("/login");
    S.check("logged out: /profile -> /login, no profile API call", (await S.url()) === "/login" && !S.apiCalls.some((call) => /\/auth\/me/.test(call) && /PATCH/.test(call)), await S.url());
    S.check("logged out: no profile link in the navbar", (await S.userLink()) === null);
  });

  // ---- B -------------------------------------------------------------------------
  sec("B. a customer sees the right data", async () => {
    await S.uiLogin("bob");
    const link = await S.userLink();
    S.check("navbar name is a link to /profile", link.href === "/profile" && link.text === "bob tester (customer)", JSON.stringify(link));
    // The navigation links are checked on their own (the name link is not one of them)
    const links = await S.navbarLinks();
    S.check(
      "the navigation links are Products, Cart, My Orders, and there is no separate Profile item",
      JSON.stringify(links.map((item) => item.text)) === JSON.stringify(["Products", "Cart", "My Orders"]) && !links.some((item) => item.href === "/profile"),
      JSON.stringify(links)
    );

    await S.click("a.navbar-user");
    await S.waitFor("!!document.querySelector('#profile-name')", "the profile page via the link");
    S.check("clicking the name opens /profile", (await S.url()) === "/profile");
    S.check("heading and form shown", (await S.js("document.querySelector('h1').textContent")) === "My Profile" && (await nameField()) === "bob tester");

    const info = await S.js("[...document.querySelectorAll('.profile-info dt, .profile-info dd')].map(e=>e.textContent)");
    const created = (await S.models.User.findById(bob._id)).createdAt.toISOString();
    const expectedDate = await S.js(`new Date(${JSON.stringify(created)}).toLocaleDateString(undefined,{dateStyle:'long'})`);
    S.check("email, role and member-since are correct", JSON.stringify(info) === JSON.stringify(["Email", S.emailOf("bob"), "Role", "Customer", "Member since", expectedDate]), JSON.stringify(info));
    S.check(
      "only ONE editable field (the name): email and role are plain text",
      (await S.js("document.querySelectorAll('main form.profile-card:not([aria-labelledby=password-heading]) input, main select, main textarea').length")) === 1 &&
        !(await S.js("[...document.querySelectorAll('main input')].some(i=>i.value.includes('@'))"))
    );
    S.check("hint says email and role cannot be changed", (await S.text()).includes("cannot be changed here"));
    S.check("Save is disabled while the name is unchanged", await saveDisabled());
    S.check("My Orders button (customer)", (await S.js("[...document.querySelectorAll('.order-footer a')].map(a=>a.textContent+'>'+a.getAttribute('href')).join()")) === "My Orders>/orders");
  });

  // ---- C -------------------------------------------------------------------------
  sec("C. client-side validation (nothing is sent)", async () => {
    sent.length = 0;
    await S.setValue("#profile-name", "   ");
    S.check("blank: Save is enabled (the trimmed name differs), and clicking it shows an error", !(await saveDisabled()));
    await save();
    S.check("blank name: 'Name is required', nothing sent", (await fieldError()) === "Name is required" && sent.length === 0);
    S.check("...field marked invalid", (await S.js("document.querySelector('#profile-name').getAttribute('aria-invalid')")) === "true");

    await S.setValue("#profile-name", "x".repeat(101));
    await save();
    S.check("101 characters: refused, nothing sent", (await fieldError()) === "Name must be at most 100 characters" && sent.length === 0);

    await S.setValue("#profile-name", "bad" + String.fromCharCode(7) + "name");
    await save();
    S.check("control character: refused, nothing sent", (await fieldError()) === "Name contains invalid characters" && sent.length === 0);

    await S.setValue("#profile-name", "Fine");
    S.check("typing clears the error", !(await S.has("#profile-name-error")));
    S.check("counter follows", (await S.js("document.querySelector('.notes-counter').textContent")) === "4/100");
    S.check("database unchanged so far", (await nameInDatabase(bob)) === "bob tester");
  });

  // ---- D -------------------------------------------------------------------------
  sec("D. the customer changes the name", async () => {
    await S.setValue("#profile-name", "  Bob Renamed  ");
    S.check("Save enabled after a real change", !(await saveDisabled()));
    await save();
    await S.waitFor("!!document.querySelector('.status-ok')", "the success message");
    S.check("PATCH sent with ONLY the trimmed name", sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify({ name: "Bob Renamed" }), JSON.stringify(sent));
    S.check("success message shown", (await S.js("document.querySelector('.status-ok').textContent")) === "Your name has been updated.");
    S.check("navbar shows the new name IMMEDIATELY (no reload)", (await navbarName()) === "Bob Renamed (customer)", await navbarName());
    S.check("form shows the trimmed name and Save is disabled again", (await nameField()) === "Bob Renamed" && (await saveDisabled()));
    const stored = await S.js("JSON.parse(localStorage.getItem('user'))");
    S.check(
      "localStorage user updated; role and email untouched",
      stored.name === "Bob Renamed" && stored.role === "customer" && stored.email === S.emailOf("bob") && !("password" in stored),
      JSON.stringify(stored)
    );
    S.check("database has the new name", (await nameInDatabase(bob)) === "Bob Renamed");
    await S.setValue("#profile-name", "Bob Renamed2");
    S.check("editing again hides the old success message", !(await S.has(".status-ok")));
    await S.setValue("#profile-name", "Bob Renamed");
  });

  // ---- E -------------------------------------------------------------------------
  sec("E. refresh and navigation", async () => {
    await openProfile();
    S.check("after a full reload the new name is still shown (navbar and form)", (await navbarName()) === "Bob Renamed (customer)" && (await nameField()) === "Bob Renamed");
    await S.clickByText(".order-footer a", "My Orders");
    await S.waitFor("location.pathname === '/orders'", "My Orders");
    S.check("My Orders button works", (await S.url()) === "/orders");
    await S.waitFor("!!document.querySelector('.order-card')", "the order cards");
    S.check("My Orders page works and navbar keeps the name", (await navbarName()) === "Bob Renamed (customer)");

    await S.goto(`${S.appUrl}/orders/${oldOrder._id}`);
    await S.waitFor("!!document.querySelector('.order-timeline')", "the order page");
    S.check("the old order page still opens normally", (await S.js("document.querySelector('h1').textContent")).startsWith("Order "));
    S.check("customer still has Cart and My Orders in the navbar", (await linkTexts()).slice(0, 3).join("|") === "Products|Cart|My Orders", (await linkTexts()).join("|"));
  });

  // ---- F -------------------------------------------------------------------------
  sec("F. sensitive fields through the endpoint (as the logged-in customer)", async () => {
    // The request is sent from the page itself, with the customer's own login token, to THIS run's backend
    const attempt = (body) =>
      S.js(`(async()=>{const r=await fetch(${JSON.stringify(`${S.apiUrl}/auth/me`)},{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('token')},body:JSON.stringify(${JSON.stringify(body)})});return r.status})()`);
    const before = await S.models.User.findById(bob._id).lean();
    const results = [];
    for (const body of [{ name: "Hack", role: "admin" }, { name: "Hack", email: "evil@example.com" }, { name: "Hack", password: "NewPass123" }, { name: "Hack", _id: String(eve._id) }, { role: "admin" }]) {
      results.push(await attempt(body));
    }
    S.check("every attempt is refused with 400", results.every((status) => status === 400), JSON.stringify(results));
    S.check(
      "role, email, password hash and name unchanged; eve untouched",
      JSON.stringify(await S.models.User.findById(bob._id).lean()) === JSON.stringify(before) && (await nameInDatabase(eve)) === "eve tester"
    );
    await S.goto(`${S.appUrl}/admin/orders`);
    await S.settleAt("/");
    S.check("customer still cannot open admin pages", (await S.url()) === "/");
  });

  // ---- G -------------------------------------------------------------------------
  sec("G. failures", async () => {
    await openProfile();
    sent.length = 0;

    S.interceptor = (paused) => isNameChange(paused) && (S.fulfill(paused, 500, { message: "Internal server error boom" }), true);
    await S.setValue("#profile-name", "Will Fail");
    await save();
    await S.waitFor("!!document.querySelector('.status-error')", "the 500 message");
    const errorText = await S.js("document.querySelector('.status-error').textContent");
    S.check(
      "500: friendly message, no server text, navbar and database keep the old name",
      errorText.includes("Something went wrong") && !errorText.includes("boom") && (await navbarName()) === "Bob Renamed (customer)" && (await nameInDatabase(bob)) === "Bob Renamed",
      errorText
    );
    S.check("...the typed name stays in the box so it can be retried", (await nameField()) === "Will Fail");

    S.interceptor = (paused) => isNameChange(paused) && (S.fulfill(paused, 400, { message: "Name contains invalid characters" }), true);
    await save();
    await S.waitFor("/invalid characters/.test(document.querySelector('.status-error')?.textContent||'')", "the 400 message");
    S.check("400: the server message is shown", /invalid characters/.test(await S.js("document.querySelector('.status-error').textContent")));

    S.interceptor = record;
    sent.length = 0;
    await save();
    await S.waitFor("!!document.querySelector('.status-ok')", "the retry to succeed");
    S.check("retry succeeds", (await nameInDatabase(bob)) === "Will Fail" && sent.length === 1);

    await S.setValue("#profile-name", "Bob Renamed");
    await save();
    await S.waitFor("!!document.querySelector('.status-ok')", "the name to be restored");

    // three rapid clicks while the server is slow
    await S.setValue("#profile-name", "Slow Name");
    sent.length = 0;
    let held = null;
    S.interceptor = (paused) => {
      if (isNameChange(paused)) {
        held = paused;
        sent.push(JSON.parse(paused.request.postData));
        return true; // keep this request waiting until the test lets it go
      }
      return false;
    };
    await S.js("(()=>{const b=document.querySelector('form.profile-card button[type=submit]');b.click();b.click();b.click();return true})()");
    await S.waitFor("document.querySelector('form.profile-card button[type=submit]').textContent==='Saving...'", "the saving state");
    S.check("while saving: button says Saving... and is disabled, field disabled", (await saveDisabled()) && (await S.js("document.querySelector('#profile-name').disabled")));
    for (let i = 0; i < 100 && !held; i++) await S.sleep(50);
    await S.cdp.send("Fetch.continueRequest", { requestId: held.requestId });
    S.interceptor = record;
    await S.waitFor("!!document.querySelector('.status-ok')", "the slow save to finish");
    S.check("three rapid clicks sent ONE request", sent.length === 1, JSON.stringify(sent));

    S.interceptor = (paused) => isNameChange(paused) && (S.fulfill(paused, 401, { message: "Not authorized" }), true);
    await S.setValue("#profile-name", "Unauthorized Try");
    await save();
    await S.waitFor("location.pathname === '/login'", "the redirect after a 401");
    S.check("401: logged out and sent to /login", (await S.js("localStorage.getItem('token')")) === null);
    S.interceptor = record;
  });

  // ---- H -------------------------------------------------------------------------
  sec("H. an admin", async () => {
    await S.uiLogin("admin");
    const link = await S.userLink();
    S.check("admin navbar: the name is the same kind of link to /profile", link.href === "/profile" && link.text === "admin tester (admin)", JSON.stringify(link));
    S.check("admin navbar has no extra Profile item", !(await linkTexts()).includes("Profile") && !(await S.navbarLinks()).some((item) => item.href === "/profile"), (await linkTexts()).join("|"));

    await S.click("a.navbar-user");
    await S.waitFor("!!document.querySelector('#profile-name')", "the admin's profile");
    S.check(
      "admin sees their data; role Admin; Admin Orders button instead of My Orders",
      (await S.js("[...document.querySelectorAll('.profile-info dd')].map(e=>e.textContent).slice(0,2).join()")) === `${S.emailOf("admin")},Admin` &&
        (await S.js("[...document.querySelectorAll('.order-footer a')].map(a=>a.getAttribute('href')).join()")) === "/admin/orders"
    );

    sent.length = 0;
    await S.setValue("#profile-name", "Chief Admin");
    await save();
    await S.waitFor("!!document.querySelector('.status-ok')", "the admin's name to be saved");
    S.check(
      "admin: navbar shows the new name at once; database updated; role unchanged",
      (await navbarName()) === "Chief Admin (admin)" && (await nameInDatabase(admin)) === "Chief Admin" && (await S.models.User.findById(admin._id)).role === "admin"
    );
    S.check("only the admin's own record changed (bob and eve untouched)", (await nameInDatabase(bob)) === "Slow Name" && (await nameInDatabase(eve)) === "eve tester");

    await S.click(".order-footer a");
    await S.waitFor("location.pathname === '/admin/orders'", "the admin orders page");
    S.check("Admin Orders button works", (await S.url()) === "/admin/orders");

    await S.goto(`${S.appUrl}/admin/orders/${oldOrder._id}`);
    await S.waitFor("!!document.querySelector('.status-history')", "the admin's order page");
    S.check("the old order still shows the name it was placed with", (await S.text()).includes("bob tester") && !(await S.text()).includes("Bob Renamed"));
  });

  // ---- I -------------------------------------------------------------------------
  sec("I. four screen widths, with a 100-character name", async () => {
    await openProfile();
    await S.setValue("#profile-name", "N".repeat(100));
    await save();
    await S.waitFor("!!document.querySelector('.status-ok')", "the long name to be saved");
    for (const [width, height] of [[375, 800], [768, 900], [1024, 800], [1440, 900]]) {
      await S.viewport(width, height, width < 500);
      await openProfile();
      S.check(`${width}px: profile - no horizontal scroll (100-character name)`, await S.noHScroll());
      S.check(
        `${width}px: Save and name field are big enough to use`,
        await S.js("(()=>{const b=document.querySelector('form.profile-card button[type=submit]').getBoundingClientRect(),i=document.querySelector('#profile-name').getBoundingClientRect();return b.height>=36&&i.height>=36&&i.right<=window.innerWidth})()")
      );
      await S.shot(`profile-${width}`);
      await S.goto(`${S.appUrl}/admin/orders`);
      await S.waitFor("!!document.querySelector('.status-tabs')", "the admin orders page");
      S.check(`${width}px: other page with the long navbar name - no horizontal scroll`, await S.noHScroll());
    }
  });

  // ---- J -------------------------------------------------------------------------
  sec("J. whole-run checks", async () => {
    S.check("the browser console stayed clean", S.consoleProblems.length === 0, S.consoleProblems.join(" | "));
    S.check("the browser never contacted a development server (ports 5000 / 5173)", S.forbiddenCalls.length === 0, S.forbiddenCalls.join(" | "));
  });
});
