const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { connectCdp } = require("./cdp");
const { isAlive, killTree } = require("./processes");
const { scaled } = require("./timeouts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Removes a folder, trying again for up to `budgetMs` (Windows keeps files locked for a moment after a program closes).
// Returns true when the folder is gone.
const removeWithRetries = async (folder, budgetMs) => {
  const startedAt = Date.now();
  for (;;) {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (Date.now() - startedAt > budgetMs) return false;
      await sleep(300);
    }
  }
};

// ---------------------------------------------------------------------------
// Finding a browser (Edge or Chrome: anything that speaks the DevTools protocol)
// ---------------------------------------------------------------------------
const browserCandidates = (env = process.env) => {
  const found = [];
  if (process.platform === "win32") {
    const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      found.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
      found.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    found.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    found.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    found.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
      for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"]) {
        found.push(path.join(directory, name));
      }
    }
  }
  return found;
};

// E2E_BROWSER (a full path) wins. Otherwise the usual Edge and Chrome places are searched.
const findBrowser = (env = process.env) => {
  if (env.E2E_BROWSER) {
    if (!fs.existsSync(env.E2E_BROWSER)) {
      throw new Error("E2E_BROWSER is set, but that file does not exist.");
    }
    return env.E2E_BROWSER;
  }
  const found = browserCandidates(env).find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      "No browser was found. Install Microsoft Edge or Google Chrome, or set E2E_BROWSER to the full path of its program."
    );
  }
  return found;
};

// ---------------------------------------------------------------------------
// Starting and stopping a browser
// ---------------------------------------------------------------------------
// The browser registers its process id in the run folder, so that the runner can still end it
// if a test crashes before it could close the browser itself.
const pidFile = (runDir, pid) => path.join(runDir, `browser-${pid}.pid`);

// Starts a headless browser with a fresh, temporary profile inside `runDir`.
// The browser chooses its own debugging port (--remote-debugging-port=0) and writes it into
// the profile's DevToolsActivePort file, which is read here.
const launchBrowser = async ({ browserPath, runDir }) => {
  const profileDir = fs.mkdtempSync(path.join(runDir, "profile-"));
  const child = spawn(
    browserPath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true }
  );
  let exited = false;
  const exitPromise = new Promise((resolve) => child.once("exit", () => { exited = true; resolve(); }));
  fs.writeFileSync(pidFile(runDir, child.pid), String(child.pid));

  const activePortFile = path.join(profileDir, "DevToolsActivePort");
  let debuggingPort = 0;
  for (let attempt = 0; attempt < scaled(150) && !debuggingPort; attempt++) {
    if (exited) throw new Error("The browser stopped while starting.");
    try {
      // The browser writes two lines (the port, then a path). A missing, locked (EBUSY) or half-written file just means
      // "not ready yet": look again.
      const lines = fs.readFileSync(activePortFile, "utf8").split(/\r?\n/);
      if (lines.length >= 2 && lines[1].trim() !== "") debuggingPort = Number(lines[0]) || 0;
    } catch (error) {
      /* not there yet, or being written right now */
    }
    if (!debuggingPort) await sleep(100);
  }
  if (!debuggingPort) {
    killTree(child.pid);
    throw new Error("The browser did not report its debugging port in time.");
  }

  // The browser's single tab
  let pageTarget;
  for (let attempt = 0; attempt < scaled(50) && !pageTarget; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json();
      pageTarget = targets.find((target) => target.type === "page");
    } catch (error) { /* not ready yet */ }
    if (!pageTarget) await sleep(100);
  }
  if (!pageTarget) {
    killTree(child.pid);
    throw new Error("The browser has no page to control.");
  }

  const cdp = await connectCdp(pageTarget.webSocketDebuggerUrl);

  // Closes the browser politely, then makes sure it (and its helper processes) are gone
  const close = async () => {
    cdp.close();
    if (!exited) {
      try {
        const version = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/version`)).json();
        const browserSocket = await connectCdp(version.webSocketDebuggerUrl);
        browserSocket.send("Browser.close").catch(() => {});
        await Promise.race([exitPromise, sleep(3000)]);
        browserSocket.close();
      } catch (error) { /* it may already be closing */ }
    }
    if (!exited || isAlive(child.pid)) killTree(child.pid);
    // On a busy machine the browser needs longer to let go of its files, so wait for it to be really gone
    await Promise.race([exitPromise, sleep(15000)]);
    fs.rmSync(pidFile(runDir, child.pid), { force: true });
    // Removing the profile folder is retried for up to 20 seconds. If Windows still holds it, the run is NOT
    // failed here: the runner removes the whole run folder at the very end (and reports it if that fails too).
    await removeWithRetries(profileDir, 20000);
  };

  return { cdp, close, pid: child.pid, profileDir };
};

// Used by the runner at the very end: ends any browser that a crashed test left behind.
// Only the process ids that the tests of THIS run registered are touched.
const stopLeftoverBrowsers = (runDir) => {
  let stopped = 0;
  if (!fs.existsSync(runDir)) return stopped;
  for (const name of fs.readdirSync(runDir)) {
    const match = /^browser-(\d+)\.pid$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (isAlive(pid)) {
      killTree(pid);
      stopped += 1;
    }
    fs.rmSync(path.join(runDir, name), { force: true });
  }
  return stopped;
};

// A new empty working folder for one run (inside the system's temporary folder)
const RUN_DIR_PREFIX = "online-e2e-";
const createRunDir = () => fs.mkdtempSync(path.join(os.tmpdir(), RUN_DIR_PREFIX));

// Removes the run folder. It refuses to remove anything that is not an E2E run folder
// inside the temporary folder, so a wrong path can never delete something else.
const removeRunDir = async (runDir) => {
  const resolved = path.resolve(runDir);
  const inside = path.dirname(resolved) === path.resolve(os.tmpdir());
  if (!inside || !path.basename(resolved).startsWith(RUN_DIR_PREFIX)) {
    throw new Error("Refusing to remove a folder that is not an E2E run folder.");
  }
  if (!(await removeWithRetries(resolved, 30000))) {
    throw new Error("The run folder could not be removed (a program may still be using it).");
  }
};

module.exports = { findBrowser, browserCandidates, launchBrowser, stopLeftoverBrowsers, createRunDir, removeRunDir };
