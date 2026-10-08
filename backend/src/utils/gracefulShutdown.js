// Closes the server in an orderly way when the process is asked to stop (Ctrl+C or a
// "stop" from the hosting platform): stop taking new requests, let the running ones end,
// close the database connection, then exit. Everything it touches is passed in, so the
// tests can use fake servers, a fake database and a fake clock.
//
//   server         the http.Server from app.listen
//   closeDatabase  async function that closes the MongoDB connection
//   exit           what ends the process (process.exit)
//   timeoutMs      if the shutdown takes longer than this, the process is stopped anyway

const createShutdown = ({
  server,
  closeDatabase,
  exit = (code) => process.exit(code),
  log = (line) => console.log(line),
  errorLog = (line) => console.error(line),
  timeoutMs = 10000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  let started = false;

  return async (signal) => {
    // A second Ctrl+C means "I do not want to wait": stop right now
    if (started) {
      errorLog(`${signal} received again: forcing exit.`);
      exit(1);
      return;
    }
    started = true;
    log(`${signal} received: shutting down...`);

    // Never hang forever (for example because a client keeps a connection open)
    const timer = setTimer(() => {
      errorLog(`Shutdown took longer than ${Math.round(timeoutMs / 1000)} seconds: forcing exit.`);
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      exit(1);
    }, timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();

    try {
      // 1. Stop accepting new connections. The callback runs when the last request is done.
      const closed = new Promise((resolve, reject) => {
        server.close((error) => (error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
      });
      // Connections that are only waiting for a next request can go now
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      await closed;

      // 2. Close the database connection
      await closeDatabase();

      clearTimer(timer);
      log("Shutdown complete.");
      exit(0);
    } catch (error) {
      clearTimer(timer);
      errorLog(`Shutdown failed: ${error.message}`);
      exit(1);
    }
  };
};

// Starts the shutdown on SIGINT (Ctrl+C) and SIGTERM (stop request).
// `proc` is process (or any event emitter in a test).
const registerShutdownHandlers = (proc, shutdown) => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    proc.on(signal, () => {
      shutdown(signal);
    });
  }
};

module.exports = { createShutdown, registerShutdownHandlers };
