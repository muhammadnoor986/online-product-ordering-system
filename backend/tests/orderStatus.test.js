// Pure rule tests. No database or server is needed here.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  CUSTOMER_CANCELLABLE_STATUSES,
  canTransition,
  allowedNextStatuses,
} = require("../src/constants/orderStatus");
const { PAYMENT_METHODS, PAYMENT_STATUSES, DEFAULT_PAYMENT_STATUS } = require("../src/constants/paymentMethods");
const { generateOrderNumber, ORDER_NUMBER_PATTERN } = require("../src/utils/generateOrderNumber");
const roundMoney = require("../src/utils/roundMoney");

// The approved flow, written out by hand so the code is checked against it
const EXPECTED = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

describe("Order status rules", () => {
  it("has exactly the six approved statuses", () => {
    assert.deepEqual([...ORDER_STATUSES], ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"]);
  });

  it("allows exactly the approved transitions and no others (all 36 pairs)", () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const expected = EXPECTED[from].includes(to);
        assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
      }
    }
  });

  it("never allows skipping a step or going backwards", () => {
    assert.equal(canTransition("pending", "processing"), false);
    assert.equal(canTransition("pending", "shipped"), false);
    assert.equal(canTransition("pending", "delivered"), false);
    assert.equal(canTransition("confirmed", "pending"), false);
    assert.equal(canTransition("shipped", "processing"), false);
    assert.equal(canTransition("shipped", "cancelled"), false, "no cancelling once shipped");
    assert.equal(canTransition("delivered", "shipped"), false);
  });

  it("treats delivered and cancelled as final", () => {
    assert.deepEqual([...allowedNextStatuses("delivered")], []);
    assert.deepEqual([...allowedNextStatuses("cancelled")], []);
    for (const to of ORDER_STATUSES) {
      assert.equal(canTransition("delivered", to), false);
      assert.equal(canTransition("cancelled", to), false);
    }
  });

  it("a status cannot change to itself", () => {
    for (const status of ORDER_STATUSES) assert.equal(canTransition(status, status), false);
  });

  it("returns no next statuses for unknown or odd input (never throws)", () => {
    for (const odd of ["constructor", "__proto__", "toString", "hasOwnProperty", "PENDING", " pending", "", undefined, null, 5, {}, []]) {
      assert.deepEqual([...allowedNextStatuses(odd)], [], `allowedNextStatuses(${String(odd)})`);
      assert.equal(canTransition(odd, "cancelled"), false);
    }
    assert.equal(canTransition("pending", "constructor"), false);
    assert.equal(canTransition("pending", undefined), false);
  });

  it("only lets customers cancel pending orders", () => {
    assert.deepEqual([...CUSTOMER_CANCELLABLE_STATUSES], ["pending"]);
  });

  it("cannot be changed by other code (the tables are frozen)", () => {
    assert.throws(() => ORDER_TRANSITIONS.pending.push("delivered"), TypeError);
    assert.throws(() => ORDER_STATUSES.push("refunded"), TypeError);
    assert.equal(Object.isFrozen(ORDER_TRANSITIONS), true);
  });
});

describe("Payment constants", () => {
  it("supports cash on delivery only", () => {
    assert.deepEqual([...PAYMENT_METHODS], ["cod"]);
  });

  it("has the four payment statuses and starts as pending", () => {
    assert.deepEqual([...PAYMENT_STATUSES], ["pending", "paid", "failed", "refunded"]);
    assert.equal(DEFAULT_PAYMENT_STATUS, "pending");
  });
});

describe("Order numbers", () => {
  it("look like ORD-YYYYMMDD-XXXXXX", () => {
    for (let i = 0; i < 200; i++) {
      assert.match(generateOrderNumber(), ORDER_NUMBER_PATTERN);
    }
  });

  it("use the UTC date", () => {
    assert.match(generateOrderNumber(new Date("2026-10-07T23:59:59Z")), /^ORD-20261007-/);
    assert.match(generateOrderNumber(new Date("2026-10-08T00:00:00Z")), /^ORD-20261008-/);
    // 00:30 on 1 Jan in Pakistan (UTC+5) is still 31 Dec in UTC
    assert.match(generateOrderNumber(new Date("2026-01-01T00:30:00+05:00")), /^ORD-20251231-/);
  });

  it("use only easy-to-read characters (no I, L, O, U)", () => {
    for (let i = 0; i < 300; i++) {
      assert.doesNotMatch(generateOrderNumber().slice(13), /[ILOU]/);
    }
  });

  it("differ from each other (random suffix)", () => {
    const numbers = new Set(Array.from({ length: 200 }, () => generateOrderNumber()));
    assert.equal(numbers.size, 200);
  });

  // (That a client cannot choose or influence the number is tested in orders.test.js,
  //  with a checkout request that tries to send its own orderNumber.)
});

describe("Money rounding", () => {
  it("removes floating point noise", () => {
    assert.equal(roundMoney(0.1 + 0.2), 0.3);
    assert.equal(roundMoney(250.75 * 2), 501.5);
    assert.equal(roundMoney(99.99 * 3), 299.97);
    assert.equal(roundMoney(1.005), 1.01);
    assert.equal(roundMoney(0), 0);
  });
});
