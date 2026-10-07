// Takes stock for an order and gives it back.
//
// The database is a standalone MongoDB (no transactions), so the safety comes from two things:
//   1. Every change is ONE atomic update that also checks the condition
//      (the product is active AND has enough stock). Stock can never go below zero.
//   2. If a later step fails we undo the earlier steps ("compensation").
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const { getProblem } = require("./cartService");

// `items` are lines like { product: <id>, quantity: <whole number 1 or more> }.
// A zero or negative quantity would turn "take stock" into "add stock", so refuse it loudly.
const assertValidItems = (items) => {
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new Error("stockService: quantity must be a whole number of 1 or more");
    }
  }
};

// For every line that cannot be bought, describes why (the same shape the cart API uses)
const buildProblemDetails = (lines, productsById) =>
  lines.flatMap((line) => {
    const product = productsById.get(String(line.product));
    const reason = getProblem(product, line.quantity);
    if (!reason) return [];
    return [
      {
        productId: String(line.product),
        name: product ? product.name : "This product no longer exists",
        reason,
        requested: line.quantity,
        available: product && product.isActive ? product.stock : 0,
      },
    ];
  });

const STOCK_CONFLICT_MESSAGE =
  "Some items in your cart are no longer available in the requested quantity. Please review your cart.";

const loadProductsById = async (lines) => {
  const products = await Product.find({ _id: { $in: lines.map((line) => line.product) } }).select(
    "name stock isActive"
  );
  return new Map(products.map((product) => [String(product._id), product]));
};

// Gives stock back. NEVER throws: it is used while recovering from another failure.
// A failed update is retried once; if it still fails it is logged (product id and amount
// only, no personal data) and reported in the returned `failed` list.
const releaseStock = async (items) => {
  assertValidItems(items);
  const failed = [];

  for (const item of items) {
    let done = false;
    for (let attempt = 1; attempt <= 2 && !done; attempt++) {
      try {
        // No isActive condition: stock must come back even if the product was hidden meanwhile
        const result = await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } });
        done = result.matchedCount === 1;
      } catch (error) {
        done = false;
      }
    }
    if (!done) {
      failed.push(item);
      console.error(
        `[stock] could not give stock back: product ${String(item.product)}, quantity ${item.quantity}`
      );
    }
  }

  return { failed };
};

// Takes stock for every line, or for none of them.
// On success returns the lines that were reserved. If any line cannot be reserved, the lines
// reserved before it are given back and a 409 with details is thrown.
const reserveStock = async (items) => {
  assertValidItems(items);

  // A fixed order makes competing checkouts behave the same way every time
  const lines = [...items].sort((a, b) => String(a.product).localeCompare(String(b.product)));
  const reserved = [];

  for (const line of lines) {
    const result = await Product.updateOne(
      { _id: line.product, isActive: true, stock: { $gte: line.quantity } },
      { $inc: { stock: -line.quantity } }
    );

    if (result.modifiedCount === 1) {
      reserved.push(line);
      continue;
    }

    // Not enough stock (or hidden/removed) at this exact moment: undo what we already took
    await releaseStock(reserved);

    // Explain every line that has a problem right now, not only the first one
    let details = buildProblemDetails(lines, await loadProductsById(lines));
    if (details.length === 0) {
      // The situation changed again while we looked; still report the line that failed
      details = [
        {
          productId: String(line.product),
          name: "A product in your cart",
          reason: "insufficient_stock",
          requested: line.quantity,
          available: 0,
        },
      ];
    }
    throw new AppError(STOCK_CONFLICT_MESSAGE, 409, details);
  }

  return reserved;
};

module.exports = {
  reserveStock,
  releaseStock,
  buildProblemDetails,
  STOCK_CONFLICT_MESSAGE,
};
