// A MongoDB id is exactly 24 hexadecimal characters.
// (Mongoose's own check also accepts any 12-character string, which is too loose.)
const isValidObjectId = (value) =>
  typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value);

module.exports = isValidObjectId;
