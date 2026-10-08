const AppError = require("./AppError");

// "12" -> 12. Returns null when the value is not a whole number of at least `min`.
const parseWholeNumber = (value, min) => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= min ? number : null;
};

// Reads ?page= and ?limit= (same rules as the product and order lists):
//   page   whole number of 1 or more, default 1
//   limit  whole number of 1 or more, default 10, silently capped at maxLimit
// Anything else is a 400.
const parsePagination = (query, { defaultLimit = 10, maxLimit = 50 } = {}) => {
  let page = 1;
  if (query.page !== undefined) {
    page = parseWholeNumber(query.page, 1);
    if (page === null) throw new AppError("page must be a whole number of 1 or more", 400);
  }

  let limit = defaultLimit;
  if (query.limit !== undefined) {
    limit = parseWholeNumber(query.limit, 1);
    if (limit === null) throw new AppError("limit must be a whole number of 1 or more", 400);
    limit = Math.min(limit, maxLimit);
  }

  return { page, limit };
};

// Escapes characters like ( or * so that search text is treated as plain text, never as a pattern
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = { parsePagination, escapeRegex };
