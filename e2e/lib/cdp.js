// A very small client for the Chrome DevTools Protocol (the way Edge and Chrome can be remote
// controlled). It only uses Node's built-in WebSocket and needs no package.
// Docs: https://chromedevtools.github.io/devtools-protocol/

const { scaled } = require("./timeouts");

// Opens the connection. Returns { send, on, waitForEvent, close }.
const connectCdp = (webSocketUrl) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let nextId = 0;
    const pending = new Map(); // command id -> { resolve, reject }
    const listeners = new Map(); // event name -> [functions]

    const client = {
      // Sends a command and waits for its answer
      // A command that gets no answer within `timeoutMs` fails (a busy browser can leave one unanswered forever).
      send: (method, params = {}, timeoutMs = scaled(30000)) =>
        new Promise((resolveCommand, rejectCommand) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectCommand(new Error(`The browser did not answer "${method}" within ${Math.round(timeoutMs / 1000)} seconds.`));
          }, timeoutMs);
          pending.set(id, {
            resolve: (value) => { clearTimeout(timer); resolveCommand(value); },
            reject: (error) => { clearTimeout(timer); rejectCommand(error); },
          });
          socket.send(JSON.stringify({ id, method, params }));
        }),

      // Calls `listener(params)` every time the browser reports this event
      on: (method, listener) => {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(listener);
      },

      // Starts listening NOW and resolves on the next such event. Create it BEFORE the action that
      // causes the event, so a fast event cannot be missed.
      waitForEvent: (method, timeoutMs = 20000) =>
        new Promise((resolveEvent, rejectEvent) => {
          const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeoutMs);
          client.on(method, (params) => {
            clearTimeout(timer);
            resolveEvent(params);
          });
        }),

      close: () => {
        try { socket.close(); } catch (error) { /* already closed */ }
      },
    };

    socket.onopen = () => resolve(client);
    socket.onerror = () => reject(new Error("Could not connect to the browser's DevTools port."));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve: done, reject: fail } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) fail(new Error(`${message.error.message || "DevTools error"}`));
        else done(message.result);
      } else if (message.method && listeners.has(message.method)) {
        for (const listener of listeners.get(message.method)) {
          try { listener(message.params); } catch (error) { /* a listener must never break the connection */ }
        }
      }
    };
    socket.onclose = () => {
      for (const { reject: fail } of pending.values()) fail(new Error("The browser connection was closed."));
      pending.clear();
    };
  });

module.exports = { connectCdp };
