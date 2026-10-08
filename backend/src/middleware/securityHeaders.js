// Adds a few safe response headers to every answer of the API (normal answers, 404s and errors,
// because it runs before the routes). No extra package is needed for this.
//
//   X-Content-Type-Options: nosniff   the browser must trust the declared type (JSON stays JSON)
//   X-Frame-Options: DENY             the API can never be shown inside a frame on another site
//   Referrer-Policy: no-referrer      no address is passed on when a link from an answer is followed
//
// "x-powered-by" (which tells everyone the server is Express) is switched off in app.js.
//
// Answers under /api/auth (login, signup, the profile, passwords, tokens) also get
// "Cache-Control: no-store", so a browser or proxy never keeps them. The other answers are NOT
// marked that way, so ordinary caching of the product list still works as before.

// "/api/auth" or anything below it. Letter case does not matter, because Express routes
// "/API/Auth/me" to the same place. (req.path has no query string.)
const AUTH_PATH = /^\/api\/auth(\/|$)/i;

const securityHeaders = (req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");

  if (AUTH_PATH.test(req.path)) {
    res.set("Cache-Control", "no-store");
  }

  next();
};

module.exports = securityHeaders;
