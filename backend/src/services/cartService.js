// Cart logic shared by the cart API (cartController) and checkout (orderService).
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const roundMoney = require("../utils/roundMoney");

const { MAX_DISTINCT_PRODUCTS, MAX_QUANTITY_PER_PRODUCT } = Cart;

// How many times we reload and retry when two requests change the same cart at once
const MAX_SAVE_ATTEMPTS = 3;

// Why a cart line cannot be bought right now (null = it can)
const getProblem = (product, quantity) => {
  if (!product) return "not_found";
  if (!product.isActive) return "inactive";
  if (product.stock <= 0) return "out_of_stock";
  if (quantity > product.stock) return "insufficient_stock";
  return null;
};

const findItem = (cart, productId) =>
  cart.items.find((item) => String(item.product) === String(productId));

// Builds the cart that is sent to the client. Name, price and stock always come from the
// Product collection (the cart itself only stores ids and quantities).
// This only reads. It never changes the cart.
const buildCartResponse = async (cart) => {
  const productIds = cart.items.map((item) => item.product);
  const products =
    productIds.length > 0
      ? await Product.find({ _id: { $in: productIds } }).select("name price imageUrl stock isActive")
      : [];
  const productsById = new Map(products.map((product) => [String(product._id), product]));

  let itemCount = 0; // total quantity of everything in the cart
  let subtotal = 0; // only lines that can be bought right now
  let hasProblems = false;

  const items = cart.items.map((item) => {
    const product = productsById.get(String(item.product));
    const problem = getProblem(product, item.quantity);
    const price = product ? product.price : 0;
    const lineTotal = roundMoney(price * item.quantity);

    itemCount += item.quantity;
    if (problem) {
      hasProblems = true;
    } else {
      subtotal += lineTotal;
    }

    return {
      productId: item.product,
      name: product ? product.name : "This product no longer exists",
      price,
      imageUrl: product ? product.imageUrl : "",
      stock: product ? product.stock : 0,
      isActive: product ? product.isActive : false,
      quantity: item.quantity,
      lineTotal,
      isAvailable: problem === null,
      problem,
    };
  });

  return { items, itemCount, subtotal: roundMoney(subtotal), hasProblems };
};

// An empty cart, in the same shape as buildCartResponse
const buildEmptyCartResponse = () => buildCartResponse({ items: [] });

// Loads the user's cart (or starts an empty one), lets `change` modify it, and saves it.
// If another request saved the same cart in the meantime, we reload and try again.
// If that keeps failing we answer 409 instead of overwriting someone else's change.
const updateCart = async (userId, change, { maxAttempts = MAX_SAVE_ATTEMPTS } = {}) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const cart = (await Cart.findOne({ user: userId })) || new Cart({ user: userId, items: [] });

    const result = await change(cart); // may throw an AppError, then nothing is saved

    try {
      await cart.save();
      return { cart, result };
    } catch (error) {
      // VersionError: cart changed since we loaded it. 11000: two first-time saves collided.
      const isConflict = error.name === "VersionError" || error.code === 11000;
      if (!isConflict) throw error;
      if (attempt === maxAttempts) {
        throw new AppError(
          "Your cart was changed at the same time by another request. Please reload your cart and try again.",
          409
        );
      }
    }
  }
};

// CHECKOUT STEP 1: take ownership of the cart's contents by emptying the cart.
// `cart` must be the document that was loaded (and checked) at the start of checkout.
// The save only succeeds if the cart has not changed since it was loaded (optimistic
// concurrency). So when two checkouts, or a checkout and a cart edit, collide,
// exactly one of them wins and the other gets a 409 before anything else was touched.
const claimCart = async (cart) => {
  cart.items = [];
  try {
    await cart.save();
  } catch (error) {
    if (error.name === "VersionError" || error.name === "DocumentNotFoundError") {
      throw new AppError(
        "Your cart changed while you were checking out, or this checkout is already in progress. Please review your cart and try again.",
        409
      );
    }
    throw error;
  }
};

// Puts the lines of a failed checkout back into the cart.
// It MERGES with whatever the cart holds now, never creating duplicate lines and never
// going over the 99-per-product or 50-products limits. Returns how many lines did not fit.
const restoreCartItems = async (userId, lines) => {
  let skipped = 0;

  await updateCart(
    userId,
    async (cart) => {
      skipped = 0; // this function may run again after a conflict, so count from zero each time
      for (const line of lines) {
        const existing = findItem(cart, line.product);
        if (existing) {
          existing.quantity = Math.min(MAX_QUANTITY_PER_PRODUCT, existing.quantity + line.quantity);
        } else if (cart.items.length < MAX_DISTINCT_PRODUCTS) {
          cart.items.push({ product: line.product, quantity: Math.min(MAX_QUANTITY_PER_PRODUCT, line.quantity) });
        } else {
          skipped += 1;
        }
      }
    },
    { maxAttempts: 5 } // be more persistent than normal: this is a recovery path
  );

  return { skipped };
};

module.exports = {
  getProblem,
  findItem,
  buildCartResponse,
  buildEmptyCartResponse,
  updateCart,
  claimCart,
  restoreCartItems,
};
