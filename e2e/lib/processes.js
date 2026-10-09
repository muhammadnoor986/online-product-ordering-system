const { spawn, spawnSync } = require("node:child_process");
const { redact } = require("./guard");

const TAIL_LINES = 40;

// Starts a Node program (always `node file.js`, never through a shell, so it works the same on
// Windows, macOS and Linux). Keeps the last lines of its output, so a failure can be explained.
const startNodeProcess = (name, args, { cwd, env, secrets = [] }) => {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const tail = [];
  const keep = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() === "") continue;
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
    }
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);

  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const handle = {
    name,
    child,
    exited,
    hasExited: false,
    // The last output lines, with secrets and connection strings hidden
    safeOutput: () => redact(tail.join("\n"), secrets),
  };
  exited.then(() => { handle.hasExited = true; });
  return handle;
};

// Ends a process AND the programs it started (a browser or Vite starts helper processes).
// `pid` is a number; this works on Windows (taskkill) and elsewhere (signals).
const killTree = (pid) => {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(pid, "SIGKILL"); } catch (error) { /* already gone */ }
  }
};

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// Stops a process started with startNodeProcess and waits until it is really gone
const stopProcess = async (handle, { timeoutMs = 5000 } = {}) => {
  if (!handle || handle.hasExited) return;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  if (process.platform === "win32") {
    // Windows cannot deliver a polite stop signal, so end the process and its helpers
    killTree(handle.child.pid);
  } else {
    handle.child.kill("SIGTERM");
    const stopped = await Promise.race([handle.exited.then(() => true), wait(timeoutMs).then(() => false)]);
    if (!stopped) killTree(handle.child.pid);
  }
  await Promise.race([handle.exited, wait(timeoutMs)]);
};

module.exports = { startNodeProcess, stopProcess, killTree, isAlive };
