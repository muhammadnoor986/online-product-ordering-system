const net = require("node:net");
const { DEVELOPMENT_PORTS } = require("./guard");

// Asks the operating system for a free local TCP port. The development ports (5000, 5173) are
// never returned, and neither is any port in `avoid`.
const getFreePort = async ({ avoid = [] } = {}) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port: chosen } = probe.address();
        probe.close(() => resolve(chosen));
      });
    });
    if (!DEVELOPMENT_PORTS.includes(port) && !avoid.includes(port)) return port;
  }
  throw new Error("Could not find a free local port.");
};

module.exports = { getFreePort };
