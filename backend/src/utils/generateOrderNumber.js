const crypto = require("node:crypto");

// 32 easy-to-read characters (no I, L, O or U, so numbers are hard to misread over the phone)
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SUFFIX_LENGTH = 6;

// Matches numbers made by generateOrderNumber, e.g. ORD-20261007-K7QX2M
const ORDER_NUMBER_PATTERN = /^ORD-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/;

// Creates ORD-YYYYMMDD-XXXXXX. The date is UTC, the suffix comes from a secure random source.
// This only makes a candidate. The unique index on Order.orderNumber is what guarantees
// uniqueness, and placeOrder retries with a new number if a collision happens.
const generateOrderNumber = (now = new Date()) => {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  let suffix = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    suffix += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return `ORD-${date}-${suffix}`;
};

// Exported as an object so that tests can replace generateOrderNumber to simulate collisions
module.exports = { generateOrderNumber, ORDER_NUMBER_PATTERN };
