// Tests for the small display helpers and for the admin note validator.
// Run with:  cd frontend && npm test
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  buildTimeline,
  describeChangedBy,
  getPaymentBadgeClass,
  getStatusActionLabel,
  getStatusBadgeClass,
  ORDER_STATUS_TABS,
  PAYMENT_FILTER_OPTIONS,
  TIMELINE_STAGES,
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

// ---------------------------------------------------------------------------
// Customer order timeline
// ---------------------------------------------------------------------------
const { ORDER_TRANSITIONS } = require("../../backend/src/constants/orderStatus.js");

const at = (hour) => new Date(Date.UTC(2026, 9, 8, hour)).toISOString();
const historyOf = (...statuses) => statuses.map((status, index) => ({ status, changedAt: at(index + 1), note: `secret note ${status}` }));
const orderWith = (status, statuses) => ({ status, statusHistory: historyOf(...statuses) });
const summary = (steps) => steps.map((step) => `${step.status}:${step.state}`).join(" ");

describe("buildTimeline", () => {
  it("the stage list matches the server's status table (same statuses, same order)", () => {
    assert.deepEqual([...TIMELINE_STAGES, "cancelled"].sort(), [...ORDER_STATUSES].sort());
    for (let i = 0; i < TIMELINE_STAGES.length - 1; i++) {
      assert.ok(ORDER_TRANSITIONS[TIMELINE_STAGES[i]].includes(TIMELINE_STAGES[i + 1]), `${TIMELINE_STAGES[i]} -> ${TIMELINE_STAGES[i + 1]}`);
    }
    assert.deepEqual(ORDER_TRANSITIONS[TIMELINE_STAGES[TIMELINE_STAGES.length - 1]], []);
  });

  it("every normal status: earlier ones done, this one current, later ones upcoming", () => {
    const path = ["pending", "confirmed", "processing", "shipped", "delivered"];
    path.forEach((status, index) => {
      const steps = buildTimeline(orderWith(status, path.slice(0, index + 1)));
      assert.equal(steps.length, 5);
      steps.forEach((step, i) => {
        assert.equal(step.state, i < index ? "done" : i === index ? "current" : "upcoming", `${status}: step ${step.status}`);
      });
    });
    assert.equal(summary(buildTimeline(orderWith("pending", ["pending"]))), "pending:current confirmed:upcoming processing:upcoming shipped:upcoming delivered:upcoming");
  });

  it("uses the dates from the history and never invents one", () => {
    const steps = buildTimeline(orderWith("processing", ["pending", "confirmed", "processing"]));
    assert.deepEqual(steps.map((s) => s.changedAt), [at(1), at(2), at(3), null, null]);
  });

  it("cancelled from pending: pending then Cancelled, no future steps", () => {
    const steps = buildTimeline(orderWith("cancelled", ["pending", "cancelled"]));
    assert.equal(summary(steps), "pending:done cancelled:cancelled");
    assert.deepEqual(steps.map((s) => s.changedAt), [at(1), at(2)]);
  });

  it("cancelled from confirmed and from processing: only what was reached", () => {
    assert.equal(summary(buildTimeline(orderWith("cancelled", ["pending", "confirmed", "cancelled"]))), "pending:done confirmed:done cancelled:cancelled");
    assert.equal(summary(buildTimeline(orderWith("cancelled", ["pending", "confirmed", "processing", "cancelled"]))), "pending:done confirmed:done processing:done cancelled:cancelled");
  });

  it("a cancelled order never shows shipped or delivered, and has no current or upcoming step", () => {
    const steps = buildTimeline(orderWith("cancelled", ["pending", "confirmed", "cancelled"]));
    assert.ok(!steps.some((s) => s.status === "shipped" || s.status === "delivered"));
    assert.ok(steps.every((s) => s.state !== "upcoming" && s.state !== "current"));
  });

  it("cancelled without a cancel entry in the history: still ends with Cancelled, with no date", () => {
    const steps = buildTimeline({ status: "cancelled", statusHistory: historyOf("pending") });
    assert.equal(summary(steps), "pending:done cancelled:cancelled");
    assert.equal(steps[1].changedAt, null);
  });

  it("gapped history: only statuses in the history are done; the gap is not shown as completed", () => {
    const steps = buildTimeline(orderWith("shipped", ["pending", "shipped"]));
    assert.equal(summary(steps), "pending:done confirmed:upcoming processing:upcoming shipped:current delivered:upcoming");
    assert.equal(steps[1].changedAt, null);
  });

  it("empty, missing or odd history never crashes", () => {
    assert.equal(summary(buildTimeline({ status: "confirmed", statusHistory: [] })), "pending:upcoming confirmed:current processing:upcoming shipped:upcoming delivered:upcoming");
    assert.equal(buildTimeline({ status: "confirmed" })[1].state, "current");
    assert.equal(buildTimeline({ status: "pending", statusHistory: "nope" })[0].state, "current");
    assert.equal(buildTimeline({ status: "pending", statusHistory: [null, 5, {}, { status: 7 }, { status: "pending", changedAt: at(1) }] })[0].changedAt, at(1));
    assert.equal(buildTimeline(null).length, 5);
    assert.equal(buildTimeline(undefined).length, 5);
    assert.ok(buildTimeline({ status: "mystery", statusHistory: historyOf("pending") }).every((s) => s.state !== "current"));
  });

  it("a bad date becomes null; a repeated status keeps its first time", () => {
    const steps = buildTimeline({ status: "pending", statusHistory: [{ status: "pending", changedAt: "not a date" }] });
    assert.equal(steps[0].changedAt, null);
    const twice = buildTimeline({ status: "confirmed", statusHistory: [{ status: "pending", changedAt: at(1) }, { status: "confirmed", changedAt: at(2) }, { status: "confirmed", changedAt: at(9) }] });
    assert.equal(twice[1].changedAt, at(2));
  });

  it("notes are never part of the result, and the order is not changed", () => {
    const order = orderWith("confirmed", ["pending", "confirmed"]);
    const before = JSON.stringify(order);
    const steps = buildTimeline(order);
    assert.equal(JSON.stringify(order), before);
    assert.ok(!JSON.stringify(steps).includes("secret note"));
    for (const step of steps) assert.deepEqual(Object.keys(step).sort(), ["changedAt", "state", "status"]);
  });
});
