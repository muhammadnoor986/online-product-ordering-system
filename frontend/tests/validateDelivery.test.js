// Proves that the checkout form's validator (frontend) and the server's validator never disagree.
// Both are given exactly the same inputs; they must give the same errors (field AND message)
// and the same cleaned-up values. Run with:  cd frontend && npm test
//
// (Special characters are built from code points on purpose, so that no invisible character
//  is ever typed into this file.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { validateDelivery, DELIVERY_FIELDS } from "../src/utils/validateDelivery.js";

const require = createRequire(import.meta.url);
// The real server code. It is only imported to call its pure validation function:
// no database connection is made.
const { validateCheckoutInput } = require("../../backend/src/services/orderService.js");

const char = (codePoint) => String.fromCodePoint(codePoint);

// What the server says about these delivery values: { errors: {field: message}, delivery }
const askServer = (delivery) => {
  try {
    const result = validateCheckoutInput({ delivery, paymentMethod: "cod" });
    return { errors: {}, delivery: result.delivery };
  } catch (error) {
    const errors = {};
    for (const detail of error.details) {
      errors[detail.field.replace("delivery.", "")] = detail.message;
    }
    return { errors, delivery: undefined };
  }
};

const valid = {
  fullName: "Ayesha Khan",
  phone: "+92 300 1234567",
  addressLine1: "House 12, Street 5, Model Town",
  addressLine2: "Near the park",
  city: "Lahore",
  postalCode: "54000",
  notes: "Please call first",
};

const compare = (values, label) => {
  const client = validateDelivery(values);
  const server = askServer(values);
  assert.deepEqual(client.errors, server.errors, `errors differ for ${label}: ${JSON.stringify(values)}`);
  if (Object.keys(server.errors).length === 0) {
    assert.deepEqual(client.delivery, server.delivery, `cleaned values differ for ${label}`);
  }
};

// Special characters, each tried at the start, in the middle and at the end of a value
const SPECIAL_CODE_POINTS = [
  0x0000, 0x0001, 0x0007, 0x0008, 0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x000e, 0x001b, 0x001f, 0x007f,
  0x0080, 0x0085, 0x009b, 0x009f, 0x00a0, 0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
];

const URDU = "علی خان"; // "Ali Khan" in Urdu (no hidden characters: plain letters)
const EMOJI = char(0x1f600);

// Candidate texts for ONE field
const candidatesFor = (spec) => {
  const out = new Set(["", " ", "   ", "a", "ab", "abc", "abcd", "abcde", "x y", " padded ", " inner  spaces ", URDU, EMOJI, EMOJI.repeat(3)]);

  // lengths around the limits, plain and padded with spaces
  const edges = [0, 1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 19, 20, 21, 59, 60, 61, 99, 100, 101, 199, 200, 201, 299, 300, 301];
  for (const length of edges) {
    out.add("a".repeat(length));
    out.add(` ${"a".repeat(length)} `);
    out.add("1".repeat(length));
  }
  for (const length of [spec.min, spec.max, spec.min - 1, spec.max + 1]) {
    if (length >= 0) {
      out.add("a".repeat(length));
      out.add(`  ${"a".repeat(length)}  `);
      out.add(EMOJI.repeat(Math.floor(length / 2)));
    }
  }

  for (const codePoint of SPECIAL_CODE_POINTS) {
    const c = char(codePoint);
    out.add(`Some${c}value here`);
    out.add(`${c}Some value`);
    out.add(`Some value${c}`);
    out.add(`+92 300${c}1234567`);
    out.add(`54${c}000`);
  }

  if (spec.key === "phone") {
    for (const phone of [
      "+92 300 1234567", "0300-1234567", "(042) 111 222 333", "1234567", "123456", "123456789012345", "1234567890123456",
      "+", "++92300123456", "+9230012345", "92 300 12345 67 abc", "1".repeat(20), "1".repeat(21), " - - - - - - - ", "()()()()()()()",
      "٠٣٠٠١٢٣٤٥٦٧", // Arabic-Indic digits
      "+1 (555) 123-4567", "555.123.4567", "tel:1234567", "12 34 56 78 90",
    ]) out.add(phone);
  }
  if (spec.key === "postalCode") {
    for (const code of ["54000", "54-000", "AB1 2CD", "54_000", "5400!", "1".repeat(12), "1".repeat(13), "  54000  ", "-", "---"]) out.add(code);
  }
  if (spec.key === "notes" || spec.multiline) {
    for (const note of ["line1\nline2", "a\r\nb", "\r", "\n", "\n\n\n", "  \n  ", "a\r\n\r\nb", "tab\there", "x".repeat(300), "x\n".repeat(150), "x\r\n".repeat(100)]) out.add(note);
  }
  return [...out];
};

describe("validateDelivery agrees with the server", () => {
  for (const spec of DELIVERY_FIELDS) {
    it(`field ${spec.key}: same errors, same messages and same cleaned values for every candidate`, () => {
      const candidates = candidatesFor(spec);
      assert.ok(candidates.length > 150, `corpus for ${spec.key} is too small (${candidates.length})`);
      for (const candidate of candidates) {
        compare({ ...valid, [spec.key]: candidate }, `${spec.key} = ${JSON.stringify(candidate).slice(0, 60)}`);
      }
    });
  }

  it("a field that is missing completely", () => {
    for (const spec of DELIVERY_FIELDS) {
      const values = { ...valid };
      delete values[spec.key];
      compare(values, `missing ${spec.key}`);
    }
  });

  it("values that are not text (numbers, null, booleans, objects, arrays)", () => {
    for (const spec of DELIVERY_FIELDS) {
      for (const notText of [0, 1, 12.5, null, true, false, {}, [], ["x"], { $gt: "" }]) {
        compare({ ...valid, [spec.key]: notText }, `${spec.key} = ${JSON.stringify(notText)}`);
      }
    }
  });

  it("3000 random combinations of all fields at once", () => {
    // a small fixed-seed generator, so a failure can always be reproduced
    let seed = 20261007;
    const random = (n) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    const pools = Object.fromEntries(DELIVERY_FIELDS.map((spec) => [spec.key, [valid[spec.key], valid[spec.key], ...candidatesFor(spec)]]));

    for (let i = 0; i < 3000; i++) {
      const values = {};
      for (const spec of DELIVERY_FIELDS) {
        const pool = pools[spec.key];
        values[spec.key] = pool[random(pool.length)];
      }
      compare(values, `random combination #${i}`);
    }
  });

  it("returns trimmed values and tidied line breaks", () => {
    const result = validateDelivery({ ...valid, fullName: "  Ali  ", notes: "  one\r\ntwo  " });
    assert.deepEqual(result.errors, {});
    assert.equal(result.delivery.fullName, "Ali");
    assert.equal(result.delivery.notes, "one\ntwo");
    assert.deepEqual(result.delivery, askServer({ ...valid, fullName: "  Ali  ", notes: "  one\r\ntwo  " }).delivery);
  });

  it("accepts the sample values and Urdu text with its joiner characters", () => {
    assert.deepEqual(validateDelivery(valid).errors, {});
    const zwnj = char(0x200c);
    const rlm = char(0x200f);
    const urdu = { ...valid, fullName: `علی${zwnj}خان`, notes: `گھنٹی\n${rlm}دروازہ` };
    assert.deepEqual(validateDelivery(urdu).errors, {});
    assert.deepEqual(askServer(urdu).errors, {});
  });

  it("rejects the dangerous characters (and the server agrees)", () => {
    for (const codePoint of [0x0000, 0x0085, 0x2028, 0x2029, 0x202e, 0x2066]) {
      const values = { ...valid, fullName: `Ali${char(codePoint)}Khan`, notes: `a${char(codePoint)}b` };
      const client = validateDelivery(values);
      assert.match(client.errors.fullName, /invalid characters/);
      assert.match(client.errors.notes, /invalid characters/);
      assert.deepEqual(client.errors, askServer(values).errors);
    }
  });
});
