const fs = require("node:fs");
const path = require("node:path");
const { DEVELOPMENT_PORTS } = require("./guard");
const { scaled } = require("./timeouts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Everyday helpers for driving one browser tab. `cdp` is the DevTools connection (see cdp.js).
//   appUrl  the E2E frontend, apiUrl  the E2E backend (ending in /api)
const createPage = async (cdp, { appUrl, apiUrl, artifactsDir = "", suiteName = "suite" }) => {
  const state = {
    apiCalls: [], // "METHOD url" for every request the page sent to the E2E backend
    consoleProblems: [], // console errors/warnings and uncaught exceptions
    dialogs: [], // text of any browser dialog (alert/confirm); they are dismissed
    forbiddenCalls: [], // any request the page sent to a development server port (must stay empty)
    interceptor: null, // (pausedRequest) => true when the test answered the request itself
  };

  // Requests to the E2E backend are paused so a test can answer them itself (to simulate an
  // error, for example). Everything else, and every request the test does not handle, goes on.
  cdp.on("Fetch.requestPaused", (paused) => {
    let handled = false;
    try {
      handled = Boolean(state.interceptor && state.interceptor(paused));
    } catch (error) { /* a broken interceptor must not freeze the page */ }
    if (!handled) {
      // (a request can also be paused after the server has answered; that needs continueResponse)
      const answered = paused.responseStatusCode !== undefined || paused.responseErrorReason !== undefined;
      cdp.send(answered ? "Fetch.continueResponse" : "Fetch.continueRequest", { requestId: paused.requestId }).catch(() => {});
    }
  });
  cdp.on("Page.javascriptDialogOpening", (dialog) => {
    state.dialogs.push(dialog.message);
    cdp.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
  });
  cdp.on("Network.requestWillBeSent", (event) => {
    if (event.request.url.startsWith(`${apiUrl}/`)) state.apiCalls.push(`${event.request.method} ${event.request.url}`);
    try {
      const port = Number(new URL(event.request.url).port);
      if (DEVELOPMENT_PORTS.includes(port)) state.forbiddenCalls.push(`${event.request.method} ${event.request.url}`);
    } catch (error) { /* not a normal address (data: or about:) */ }
  });
  cdp.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error" || event.type === "warning") {
      state.consoleProblems.push(event.args.map((arg) => arg.value || arg.description || "").join(" ").slice(0, 200));
    }
  });
  cdp.on("Runtime.exceptionThrown", (event) => {
    const details = event.exceptionDetails;
    state.consoleProblems.push(`EXCEPTION ${(details.exception && details.exception.description) || details.text}`.slice(0, 200));
  });

  // The browser tells us when a page has been quiet on the network for a while ("networkIdle")
  const idleLoaders = new Set();
  cdp.on("Page.lifecycleEvent", (event) => {
    if (event.name === "networkIdle") idleLoaders.add(event.loaderId);
  });

  await cdp.send("Page.enable");
  await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `${apiUrl}/*`, requestStage: "Request" }] });

  const page = {
    appUrl,
    apiUrl,
    sleep,
    cdp,
    get interceptor() { return state.interceptor; },
    set interceptor(fn) { state.interceptor = fn; },
    get apiCalls() { return state.apiCalls; },
    get dialogs() { return state.dialogs; },
    get forbiddenCalls() { return state.forbiddenCalls; },
    get consoleProblems() { return state.consoleProblems; },
    resetCalls: () => { state.apiCalls.length = 0; },

    // Runs JavaScript inside the page and returns its value (awaiting promises)
    js: async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        throw new Error("JS error: " + ((details.exception && details.exception.description) || details.text));
      }
      return result.result.value;
    },

    // Waits until `expression` (JavaScript run in the page) is true. Errors while the page is
    // changing are ignored. Fails with `label` after `timeoutMs`.
    waitFor: async (expression, label, timeoutMs = scaled(10000)) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        try {
          if (await page.js(expression)) return true;
        } catch (error) { /* the page is navigating */ }
        await sleep(100);
      }
      // Say what the page looked like and what it had asked the server, so a failure can be understood without guessing
      const where = await page.js("location.pathname + ' | ' + document.body.innerText.replace(/\s+/g,' ').slice(0,220)").catch(() => "(page not readable)");
      const lastCalls = state.apiCalls.slice(-8).map((call) => call.replace(apiUrl, "")).join(" , ");
      throw new Error(`Timed out waiting for: ${label}. Page: ${where}. Last API calls: ${lastCalls || "none"}`);
    },

    // Opens an address and waits for the page to finish loading (the browser's load event)
    goto: async (url) => {
      const loaded = cdp.waitForEvent("Page.loadEventFired", scaled(20000));
      const result = await cdp.send("Page.navigate", { url });
      if (result.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`);
      await loaded;
      await page.waitFor("document.readyState === 'complete'", "load " + url);
      // The page file has loaded, but the React app draws the screen a moment later
      await page.waitFor("!!document.querySelector('#root') && document.querySelector('#root').children.length > 0", "the app to start on " + url);
    },

    // Like goto(), and also waits until the browser reports the page's network as quiet ("networkIdle": nothing in flight for a
    // moment). Use it when the test is about to change data behind the page's back: until then the page may still be
    // loading its own data, and would pick the change up early.
    gotoSettled: async (url) => {
      const loaded = cdp.waitForEvent("Page.loadEventFired", scaled(20000));
      const result = await cdp.send("Page.navigate", { url });
      if (result.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`);
      await loaded;
      await page.waitFor("document.readyState === 'complete'", "load " + url);
      await page.waitFor("!!document.querySelector('#root') && document.querySelector('#root').children.length > 0", "the app to start on " + url);
      const startedAt = Date.now();
      while (!idleLoaders.has(result.loaderId)) {
        if (Date.now() - startedAt > scaled(20000)) throw new Error(`The network did not become quiet on ${url}. Last API calls: ${state.apiCalls.slice(-6).join(" , ")}`);
        await sleep(50);
      }
    },

    q: (selector) => `document.querySelector(${JSON.stringify(selector)})`,
    text: () => page.js("document.body.innerText"),
    url: () => page.js("location.pathname + location.search"),
    has: (selector) => page.js(`!!document.querySelector(${JSON.stringify(selector)})`),

    // After a redirect: waits for the new path, then gives any wrong request a moment to show up
    // (so a check like "no API call was made" cannot pass just because it looked too early)
    settleAt: async (pathname, extraMs = 250) => {
      await page.waitFor(`location.pathname === ${JSON.stringify(pathname)}`, `a redirect to ${pathname}`);
      await sleep(extraMs);
    },

    // Types into a field the way a person would (React sees an input/change event)
    setValue: (selector, value) =>
      page.js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('no element '+${JSON.stringify(selector)});const proto=Object.getPrototypeOf(el);Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));return true;})()`),

    click: (selector) =>
      page.js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('no element '+${JSON.stringify(selector)});el.click();return true;})()`),

    // Clicks the first element of `selector` whose text is exactly `label`
    clickByText: (selector, label) =>
      page.js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!el)throw new Error('no ${selector} with text ${label}');el.click();return true;})()`),

    viewport: (width, height, mobile = false) =>
      cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile }),
    noHScroll: () => page.js("document.documentElement.scrollWidth <= window.innerWidth"),
    navLinks: () => page.js("[...document.querySelectorAll('.navbar-links a')].map(a=>a.textContent.trim()).join('|')"),

    // The navigation links as { text, href }, WITHOUT the logged-in person's own profile link.
    // (Use these instead of comparing the whole navbar text: the navbar also shows the user's name.)
    navbarLinks: () => page.js("[...document.querySelectorAll('.navbar-links a:not(.navbar-user)')].map(a=>({text:a.textContent.trim(),href:a.getAttribute('href')}))"),

    // The logged-in person's own link in the navbar ({ text, href }), or null when nobody is logged in
    userLink: () => page.js("(()=>{const a=document.querySelector('.navbar-links a.navbar-user');return a?{text:a.textContent.trim(),href:a.getAttribute('href')}:null})()"),

    // Saves a screenshot, but only when the runner was asked to keep them (E2E_SCREENSHOTS=1)
    shot: async (name) => {
      if (!artifactsDir) return;
      fs.mkdirSync(artifactsDir, { recursive: true });
      const picture = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(artifactsDir, `${suiteName}-${name}.png`), Buffer.from(picture.data, "base64"));
    },

    // True when a paused request is at the RESPONSE stage (the server has already handled it).
    // Only happens after watchResponses().
    isResponseStage: (paused) => paused.responseStatusCode !== undefined || paused.responseErrorReason !== undefined,

    // Also pause the server's ANSWERS for addresses under `${apiUrl}/<pathPrefix>` (for example "orders"), so a test
    // can make an answer get lost after the server has already done the work. Off by default.
    watchResponses: (pathPrefix) =>
      cdp.send("Fetch.enable", {
        patterns: [
          { urlPattern: `${apiUrl}/*`, requestStage: "Request" },
          { urlPattern: `${apiUrl}/${pathPrefix}*`, requestStage: "Response" },
        ],
      }),

    // Like viewport(), but returns only when the page has really been resized (so layout checks cannot run too early)
    resize: async (width, height, mobile = false) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await page.waitFor(`window.innerWidth === ${width}`, `the page to become ${width}px wide`);
    },

    // Makes a paused request fail like a lost connection (used with `interceptor`)
    failRequest: (paused, reason = "ConnectionFailed") =>
      cdp.send("Fetch.failRequest", { requestId: paused.requestId, errorReason: reason }).catch(() => {}),

    // Switches the whole browser tab offline (true) or back online (false)
    setOffline: (offline) =>
      cdp.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }),

    // Answers a paused request with a made-up response (used with `interceptor`)
    fulfill: (paused, status, body) =>
      cdp
        .send("Fetch.fulfillRequest", {
          requestId: paused.requestId,
          responseCode: status,
          responseHeaders: [
            { name: "Content-Type", value: "application/json" },
            { name: "Access-Control-Allow-Origin", value: appUrl },
          ],
          body: Buffer.from(JSON.stringify(body)).toString("base64"),
        })
        .catch(() => {}),

  };
  return page;
};

module.exports = { createPage, sleep };
