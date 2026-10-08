// Tests for the small display helpers and for the admin note validator.
// Run with:  cd frontend && npm test
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  describeChangedBy,
  getPaymentBadgeClass,
  getStatusActionLabel,
  getStatusBadgeClass,
  ORDER_STATUS_TABS,
  PAYMENT_FILTER_OPTIONS,
} from "../src/utils/orderDisplay.js";
import { validateNote } from "../src/utils/validateDelivery.js";

const require = createRequire(import.meta.url);
// The real server code (pure functions only: no database connection is made)
const { validateNote: serverValidateNote } = require("../../backend/src/services/orderService.js");
const { ORDER_STATUSES } = require("../../backend/src/constants/orderStatus.js");
const { PAYMENT_STATUSES } = require("../../backend/src/constants/paymentMethods.js");

const char = (codePoint) => String.fromCodePoint(codePoint);

describe("admin display helpers", () => {
  it("every order status has a badge and the tabs list exactly the server's statuses", () => {
    assert.deepEqual([...ORDER_STATUS_TABS].sort(), [...ORDER_STATUSES].sort());
    for (const status of ORDER_STATUSES) assert.match(getStatusBadgeClass(status), /^badge-/);
  });

  it("every payment status has a badge, and the filter only offers real statuses", () => {
    for (const status of PAYMENT_STATUSES) assert.match(getPaymentBadgeClass(status), /^badge-/);
    assert.equal(getPaymentBadgeClass("paid"), "badge-in");
    assert.equal(getPaymentBadgeClass("something-new"), "badge-low");
    for (const option of PAYMENT_FILTER_OPTIONS) {
      assert.ok(option.value === "" || PAYMENT_STATUSES.includes(option.value));
    }
  });

  it("action labels exist for every forward status and fall back for unknown ones", () => {
    for (const status of ["confirmed", "processing", "shipped", "delivered"]) {
      assert.ok(getStatusActionLabel(status).length > 3);
    }
    assert.equal(getStatusActionLabel("confirmed"), "Confirm order");
    assert.equal(getStatusActionLabel("weird"), "Mark as weird");
  });

  it("describes who changed a status", () => {
    assert.equal(describeChangedBy(null), "by the system");
    assert.equal(describeChangedBy({ id: "1", name: "Sana", role: "admin" }), "by Sana (admin)");
    assert.equal(describeChangedBy({ id: "1", name: "Noor", role: "customer" }), "by Noor (customer)");
    assert.equal(describeChangedBy({ id: "1", name: "Unknown user", role: null }), "by Unknown user");
  });
});

// What the server says about a note: { error, note }
const askServer = (raw) => {
  try {
    return { error: "", note: serverValidateNote(raw) };
  } catch (error) {
    return { error: error.message, note: "" };
  }
};

describe("validateNote agrees with the server", () => {
  const candidates = [
    undefined, "", " ", "ok", "  padded  ", "line1\nline2", "a\r\nb", "\r", "\n", "x".repeat(299), "x".repeat(300), "x".repeat(301),
    " " + "x".repeat(300) + " ", "x\r\n".repeat(100), "x\n".repeat(150), "علی خان", char(0x1f600).repeat(5),
    0, 1, null, true, false, {}, [], ["x"],
  ];
  for (const codePoint of [0x0000, 0x0009, 0x000b, 0x001b, 0x007f, 0x0085, 0x00a0, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff]) {
    const c = char(codePoint);
    candidates.push(`a${c}b`, `${c}a`, `a${c}`);
  }

  it("gives the same error message and the same cleaned text for every candidate", () => {
    for (const candidate of candidates) {
      assert.deepEqual(validateNote(candidate), askServer(candidate), `differs for ${JSON.stringify(candidate)}`);
    }
  });

  it("trims, tidies line breaks and rejects bad characters", () => {
    assert.deepEqual(validateNote("  one\r\ntwo  "), { error: "", note: "one\ntwo" });
    assert.match(validateNote(`a${char(0x202e)}b`).error, /invalid characters/);
    assert.match(validateNote("x".repeat(301)).error, /at most 300/);
  });
});
