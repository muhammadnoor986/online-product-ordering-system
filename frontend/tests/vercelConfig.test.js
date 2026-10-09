// frontend/vercel.json: the one rule the site needs on Vercel. No network, no Vercel account needed.
// Run with:  cd frontend && npm test
//
// Why the rule exists: the site has its own routes (/cart, /orders/123, /admin/products ...). Vercel looks for a file with
// that name and would answer "404 Not Found" on a reload or a pasted link, unless every other path gets index.html.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const config = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

describe("frontend/vercel.json", () => {
  it("is valid JSON with exactly one rewrite: every path goes to /index.html", () => {
    assert.deepEqual(config.rewrites, [{ source: "/(.*)", destination: "/index.html" }]);
  });

  it("adds nothing else that could change the build (no build or install commands, no output directory, no env values)", () => {
    const allowed = new Set(["$schema", "rewrites"]);
    for (const key of Object.keys(config)) assert.ok(allowed.has(key), `unexpected key: ${key}`);
  });

  it("the app's client-side routes all start with a path the rewrite covers", () => {
    const routes = ["/", "/cart", "/checkout", "/orders", "/orders/123", "/profile", "/admin/products", "/admin/categories", "/admin/orders", "/admin/orders/123", "/login", "/signup"];
    const pattern = new RegExp(`^${config.rewrites[0].source}$`);
    for (const route of routes) assert.ok(pattern.test(route), route);
  });
});
