// Proves that the change-password form's check (frontend) and the server's check never disagree.
// Both are given exactly the same inputs; they must give the same message.
// Run with:  cd frontend && npm test
//
// (Special characters are built from code points on purpose, so that no invisible character
//  is ever typed into this file.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH, validatePasswordChange } from "../src/utils/validatePassword.js";

const require = createRequire(import.meta.url);
// The real server rules (a pure function: no database is touched)
const server = require("../../backend/src/utils/passwordRules.js");

const char = (codePoint) => String.fromCodePoint(codePoint);
const OK_CURRENT = "Old-password-1";

const newPasswords = [
  undefined, null, "", " ", "a", "1234567", "12345678", "123456789", "abcdefg", "abcdefgh", "abcdefghi",
  "        ", "       x", "a".repeat(8), "a".repeat(71), "a".repeat(72), "a".repeat(73), "a".repeat(100),
  char(0xe9).repeat(35), char(0xe9).repeat(36), char(0xe9).repeat(37), // 70, 72 and 74 bytes
  char(0x1f600).repeat(4), char(0x1f600).repeat(18), char(0x1f600).repeat(19), // 8 UTF-16 units / 72 and 76 bytes
  "علی" + "x".repeat(10), "pass word 123", "tab\tinside1", "new\nline-pass",
  0, 12345678, true, false, {}, [], ["Brand-new-pass"], { $gt: "" },
];
const currentPasswords = [undefined, null, "", " ", OK_CURRENT, "x", "a".repeat(100), 0, true, {}, [], ["x"]];

describe("validatePasswordChange agrees with the server", () => {
  it("the limits are the same numbers", () => {
    assert.equal(PASSWORD_MIN_LENGTH, server.PASSWORD_MIN_LENGTH);
    assert.equal(PASSWORD_MAX_BYTES, server.PASSWORD_MAX_BYTES);
    assert.equal(PASSWORD_MIN_LENGTH, 8);
  });

  it("gives the same answer for every combination of current and new password", () => {
    for (const currentPassword of currentPasswords) {
      for (const newPassword of newPasswords) {
        const body = { currentPassword, newPassword };
        assert.equal(validatePasswordChange(body), server.validatePasswordChange(body), `differs for ${JSON.stringify(body)}`);
      }
    }
  });

  it("when the new password equals the current one (including long and unusual ones)", () => {
    for (const same of ["abcdefgh", "a".repeat(72), "a".repeat(73), "short", " ", "pass word 123", char(0xe9).repeat(30)]) {
      const body = { currentPassword: same, newPassword: same };
      assert.equal(validatePasswordChange(body), server.validatePasswordChange(body), JSON.stringify(same));
    }
    assert.match(validatePasswordChange({ currentPassword: "abcdefgh", newPassword: "abcdefgh" }), /must be different/);
  });

  it("odd inputs never crash and agree", () => {
    for (const odd of [undefined, null, 0, "text", [], () => 1]) {
      assert.equal(validatePasswordChange(odd), server.validatePasswordChange(odd));
    }
  });

  it("exact boundaries: 7 characters fail, 8 pass, 72 bytes pass, 73 bytes fail", () => {
    const run = (newPassword) => validatePasswordChange({ currentPassword: OK_CURRENT, newPassword });
    assert.match(run("1234567"), /at least 8/);
    assert.equal(run("12345678"), "");
    assert.equal(run("a".repeat(72)), "");
    assert.match(run("a".repeat(73)), /at most 72 bytes/);
    assert.equal(run("pass word 123"), "", "spaces and other characters are allowed");
    assert.equal(run("        "), "", "the password is used exactly as typed (never trimmed)");
    assert.match(run(""), /New password is required/);
    assert.match(run(12345678), /New password is required/);
    assert.match(validatePasswordChange({ currentPassword: "", newPassword: "12345678" }), /Current password is required/);
  });
});
