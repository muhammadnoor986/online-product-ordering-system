// A minimal request log. One line per finished request:
//
//   GET /api/products 200 18ms
//
// It logs ONLY the method, the path, the status and how long it took. It never looks at the
// request body, the headers (so no Authorization token and no cookies), or the query string
// (so nothing typed into a search or a link ends up in the log). It cannot leak a password,
// a token or the database address, because it never reads them.
//
// `log` is where the line goes (console.log by default), so tests can capture it.
// Turn the log off with LOG_REQUESTS=false (the tests do).

// Keeps the path readable and harmless: no query string, no control characters, not too long
const cleanPath = (url) => {
  const path = String(url).split("?")[0].split("#")[0];
  const printable = path.replace(/[^\x20-\x7e]/g, "?");
  return printable.length > 200 ? `${printable.slice(0, 200)}...` : printable;
};

const createRequestLogger = ({ log = (line) => console.log(line), now = () => Date.now() } = {}) => {
  return (req, res, next) => {
    const startedAt = now();

    res.on("finish", () => {
      const milliseconds = Math.max(0, Math.round(now() - startedAt));
      log(`${req.method} ${cleanPath(req.originalUrl)} ${res.statusCode} ${milliseconds}ms`);
    });

    next();
  };
};

module.exports = { createRequestLogger, cleanPath };
