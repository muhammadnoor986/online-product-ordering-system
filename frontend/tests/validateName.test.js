// Proves that the profile page's name check (frontend) and the server's check never disagree.
// Both get the same inputs and must give the same message and the same cleaned name.
// Run with:  cd frontend && npm test
//
// (Special characters are built from code points on purpose, so that no invisible character
//  is ever typed into this file.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NAME_MAX_LENGTH, validateName } from "../src/utils/validateDelivery.js";

const require = createRequire(import.meta.url);
// The real server code. It is only imported to call its pure validation function:
// no database connection is made.
const { validateProfileUpdate } = require("../../backend/src/controllers/authController.js");

const char = (codePoint) => String.fromCodePoint(codePoint);

// What the server says about a name: { error, name }
const askServer = (raw) => {
  try {
    return { error: "", name: validateProfileUpdate({ name: raw }) };
  } catch (error) {
    return { error: error.message, name: "" };
  }
};

const candidates = [
  "", " ", "   ", "\t", "\n", "a", "Ali", "  Ali  ", "Ali Khan", "Ali  Khan", "x".repeat(99), "x".repeat(100), "x".repeat(101),
  " " + "x".repeat(100) + " ", " " + "x".repeat(101) + " ", "علی خان", char(0x1f600), char(0x1f600).repeat(60), char(0x1f600).repeat(51),
  "<b>bold</b>", "O'Brien", "Zoë", `Ali${char(0x200c)}Khan`, `Ali${char(0x200f)}Khan`, `Ali${char(0x200b)}Khan`, `Ali${char(0xfeff)}Khan`, `Ali${char(0x00a0)}Khan`,
  undefined, null, 0, 1, true, false, {}, [], ["Ali"], { $gt: "" },
];
for (const codePoint of [0x0000, 0x0001, 0x0007, 0x0008, 0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x001b, 0x001f, 0x007f, 0x0080, 0x0085, 0x009f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
  const c = char(codePoint);
  candidates.push(`Ali${c}Khan`, `${c}Ali`, `Ali${c}`);
}

describe("validateName agrees with the server", () => {
  it("gives the same message and the same cleaned name for every candidate", () => {
    assert.ok(candidates.length > 100);
    for (const candidate of candidates) {
      assert.deepEqual(validateName(candidate), askServer(candidate), `differs for ${JSON.stringify(candidate)}`);
    }
  });

  it("trims, counts after trimming, and uses the same limit as the server", () => {
    assert.equal(NAME_MAX_LENGTH, 100);
    assert.deepEqual(validateName("  Ali  "), { error: "", name: "Ali" });
    assert.equal(validateName(" " + "x".repeat(100) + " ").error, "");
    assert.match(validateName("x".repeat(101)).error, /at most 100/);
    assert.match(validateName("   ").error, /required/);
    assert.match(validateName(`a${char(0x202e)}b`).error, /invalid characters/);
  });
});
