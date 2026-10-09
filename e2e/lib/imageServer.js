const http = require("node:http");

// A tiny local web server that answers with a 1x1 picture, so tests can give products a real image
// address without using the internet. It listens on a free random port (never a fixed one).
// Any address under /missing answers "404 Not Found", for tests of broken pictures.
//
//   const images = await startImageServer();
//   images.url          e.g. "http://localhost:51234/p.png"   (a picture that loads)
//   images.missingUrl   e.g. "http://localhost:51234/missing.png"   (a picture that is not found)
//   await images.close();
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const startImageServer = () =>
  new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      if (request.url.startsWith("/missing")) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("not found");
        return;
      }
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(PIXEL);
    });
    server.once("error", reject);
    server.listen(0, () => { // all addresses, so "localhost" works whichever way the browser resolves it
      const { port } = server.address();
      resolve({
        url: `http://localhost:${port}/p.png`,
        missingUrl: `http://localhost:${port}/missing.png`,
        port,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });

module.exports = { startImageServer };
