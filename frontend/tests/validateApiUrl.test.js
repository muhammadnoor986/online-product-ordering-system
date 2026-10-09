// The build-time check of VITE_API_URL (config/validateApiUrl.js). No Vite, no server, no network.
// Run with:  cd frontend && npm test
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkApiUrl, assertProductionApiUrl } from "../config/validateApiUrl.js";

describe("checkApiUrl", () => {
  it("accepts a normal https API address (with or without a trailing slash, with a port or a path)", () => {
    for (const value of [
      "https://api.example.com/api",
      "https://api.example.com/api/",
      "https://my-service.onrender.com/api",
      "https://api.example.com:8443/api",
      "  https://api.example.com/api  ",
    ]) {
      assert.equal(checkApiUrl(value), "", value);
    }
  });

  it("refuses a missing, blank or non-text value", () => {
    for (const value of [undefined, null, "", "   ", 5, {}, []]) {
      assert.match(checkApiUrl(value), /VITE_API_URL is not set/, String(value));
    }
  });

  it("refuses text that is not a web address", () => {
    for (const value of ["api.example.com/api", "/api", "not a url", "https://", "://x"]) {
      assert.match(checkApiUrl(value), /not a valid web address/, value);
    }
  });

  it("refuses http:// and other protocols in a production build", () => {
    for (const value of ["http://api.example.com/api", "ftp://api.example.com/api", "ws://api.example.com/api"]) {
      assert.match(checkApiUrl(value), /must start with https/, value);
    }
  });

  it("refuses an address that points to this computer, which is the silent localhost fallback in disguise", () => {
    for (const value of ["https://localhost/api", "https://LOCALHOST:5000/api", "https://127.0.0.1/api", "https://[::1]/api", "https://0.0.0.0/api"]) {
      assert.match(checkApiUrl(value), /localhost/, value);
    }
    // the exact default of the app is refused too (twice over: http and localhost)
    assert.notEqual(checkApiUrl("http://localhost:5000/api"), "");
  });

  it("refuses a user name or password in the address (it would be written into the public files)", () => {
    assert.match(checkApiUrl("https://user:secret@api.example.com/api"), /user name or password/);
    assert.match(checkApiUrl("https://user@api.example.com/api"), /user name or password/);
  });

  it("refuses ? and # parts", () => {
    assert.match(checkApiUrl("https://api.example.com/api?x=1"), /without \? or #/);
    assert.match(checkApiUrl("https://api.example.com/api#top"), /without \? or #/);
  });

  it("never puts the value into the message (it could contain a secret by mistake)", () => {
    for (const value of ["https://user:LEAKYPASSWORD@api.example.com/api", "http://LEAKYHOST.example.com/api", "LEAKY not a url"]) {
      assert.equal(checkApiUrl(value).includes("LEAKY"), false, value);
    }
  });
});

describe("assertProductionApiUrl", () => {
  const good = { VITE_API_URL: "https://api.example.com/api" };

  it("does nothing for the dev server, whatever the value is (local development keeps working without VITE_API_URL)", () => {
    assert.doesNotThrow(() => assertProductionApiUrl({ command: "serve", mode: "development", env: {} }));
    assert.doesNotThrow(() => assertProductionApiUrl({ command: "serve", mode: "production", env: {} }));
    assert.doesNotThrow(() => assertProductionApiUrl({ command: "serve", mode: "development", env: { VITE_API_URL: "http://localhost:5000/api" } }));
  });

  it("does nothing for a build in another mode (a local test build)", () => {
    assert.doesNotThrow(() => assertProductionApiUrl({ command: "build", mode: "development", env: {} }));
    assert.doesNotThrow(() => assertProductionApiUrl({ command: "build", mode: "staging", env: { VITE_API_URL: "http://localhost:5000/api" } }));
  });

  it("a production build with a good address passes", () => {
    assert.doesNotThrow(() => assertProductionApiUrl({ command: "build", mode: "production", env: good }));
  });

  it("a production build with no address, an empty one or no env at all stops with a clear message", () => {
    for (const env of [{}, { VITE_API_URL: "" }, { VITE_API_URL: "   " }, undefined]) {
      assert.throws(
        () => assertProductionApiUrl({ command: "build", mode: "production", env }),
        (error) => /production build was stopped/.test(error.message) && /VITE_API_URL is not set/.test(error.message) && /--mode development/.test(error.message)
      );
    }
  });

  it("a production build with the localhost default or an http address stops", () => {
    for (const value of ["http://localhost:5000/api", "http://api.example.com/api", "https://localhost/api"]) {
      assert.throws(() => assertProductionApiUrl({ command: "build", mode: "production", env: { VITE_API_URL: value } }), /production build was stopped/, value);
    }
  });
});
