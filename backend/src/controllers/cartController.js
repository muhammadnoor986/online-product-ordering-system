const Cart = require("../models/Cart");
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const isValidObjectId = require("../utils/isValidObjectId");

const { MAX_DISTINCT_PRODUCTS, MAX_QUANTITY_PER_PRODUCT } = Cart;

// How many times we reload and retry when two requests change the same cart at once
const MAX_SAVE_ATTEMPTS = 3;

// Rounds to 2 decimals so sums like 0.1 + 0.2 become exactly 0.3
const roundMoney = (amount) => Math.round((amount + Number.EPSILON) * 100) / 100;

const checkProductId = (id) => {
  if (!isValidObjectId(id)) {
    throw new AppError("Invalid product id", 400);
  }
};

// Returns an error message, or null when the quantity is fine
const quantityProblem = (quantity) => {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_PRODUCT) {
    return `Quantity must be a whole number from 1 to ${MAX_QUANTITY_PER_PRODUCT}`;
  }
  return null;
};

// Why a cart line cannot be bought right now (null = it can)
const getProblem = (product, quantity) => {
  if (!product) return "not_found";
  if (!product.isActive) return "inactive";
  if (product.stock <= 0) return "out_of_stock";
  if (quantity > product.stock) return "insufficient_stock";
  return null;
};

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

// Loads the user's cart (or starts an empty one), lets `change` modify it, and saves it.
// If another request saved the same cart in the meantime, we reload and try again.
// If that keeps failing we answer 409 instead of overwriting someone else's change.
const updateCart = async (userId, change) => {
  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
    const cart = (await Cart.findOne({ user: userId })) || new Cart({ user: userId, items: [] });

    const result = await change(cart); // may throw an AppError, then nothing is saved

    try {
      await cart.save();
      return { cart, result };
    } catch (error) {
      // VersionError: cart changed since we loaded it. 11000: two first-time saves collided.
      const isConflict = error.name === "VersionError" || error.code === 11000;
      if (!isConflict) throw error;
      if (attempt === MAX_SAVE_ATTEMPTS) {
        throw new AppError(
          "Your cart was changed at the same time by another request. Please reload your cart and try again.",
          409
        );
      }
    }
  }
};

// Throws a 409 (with details) if `wanted` units of this product cannot be bought
const assertProductAvailable = (product, wanted, alreadyInCart = 0) => {
  const reason = getProblem(product, wanted);
  if (!reason) return;

  const details = [
    {
      productId: product._id,
      name: product.name,
      reason,
      requested: wanted,
      available: product.isActive ? product.stock : 0,
    },
  ];

  if (reason === "inactive") {
    throw new AppError(`"${product.name}" is no longer available`, 409, details);
  }
  if (reason === "out_of_stock") {
    throw new AppError(`"${product.name}" is out of stock`, 409, details);
  }
  const already = alreadyInCart > 0 ? ` (you already have ${alreadyInCart} in your cart)` : "";
  throw new AppError(`Only ${product.stock} of "${product.name}" in stock${already}`, 409, details);
};

const findItem = (cart, productId) =>
  cart.items.find((item) => String(item.product) === String(productId));

// GET /api/cart
const getCart = async (req, res, next) => {
  try {
    // A user without a cart simply gets an empty one. Nothing is created here.
    const cart = (await Cart.findOne({ user: req.user._id })) || { items: [] };

    res.status(200).json({ success: true, cart: await buildCartResponse(cart) });
  } catch (error) {
    next(error);
  }
};

// POST /api/cart/items   body: { productId, quantity }   (quantity defaults to 1)
const addItem = async (req, res, next) => {
  try {
    const { productId, quantity = 1 } = req.body || {};

    checkProductId(productId);
    const problem = quantityProblem(quantity);
    if (problem) throw new AppError(problem, 400);

    const product = await Product.findById(productId).select("name price imageUrl stock isActive");
    if (!product) {
      throw new AppError("Product not found", 404);
    }

    const { cart, result } = await updateCart(req.user._id, async (cart) => {
      const existingItem = findItem(cart, product._id);
      const alreadyInCart = existingItem ? existingItem.quantity : 0;
      const wanted = alreadyInCart + quantity;

      if (!existingItem && cart.items.length >= MAX_DISTINCT_PRODUCTS) {
        throw new AppError(
          `Your cart can hold at most ${MAX_DISTINCT_PRODUCTS} different products`,
          400
        );
      }
      if (wanted > MAX_QUANTITY_PER_PRODUCT) {
        throw new AppError(
          `You can have at most ${MAX_QUANTITY_PER_PRODUCT} of one product in your cart`,
          400
        );
      }
      assertProductAvailable(product, wanted, alreadyInCart);

      if (existingItem) {
        existingItem.quantity = wanted;
      } else {
        cart.items.push({ product: product._id, quantity });
      }
      return { isNewLine: !existingItem };
    });

    res.status(result.isNewLine ? 201 : 200).json({
      success: true,
      message: result.isNewLine ? "Added to cart" : "Cart updated",
      cart: await buildCartResponse(cart),
    });
  } catch (error) {
    next(error);
  }
};

// PUT /api/cart/items/:productId   body: { quantity }
const updateItemQuantity = async (req, res, next) => {
  try {
    const { quantity } = req.body || {};

    checkProductId(req.params.productId);
    const productId = req.params.productId.toLowerCase(); // ids are stored in lowercase
    const problem = quantityProblem(quantity);
    if (problem) throw new AppError(problem, 400);

    const { cart } = await updateCart(req.user._id, async (cart) => {
      const item = findItem(cart, productId);
      if (!item) {
        throw new AppError("This product is not in your cart", 404);
      }

      const product = await Product.findById(productId).select("name price imageUrl stock isActive");
      if (!product) {
        throw new AppError("Product not found", 404);
      }
      assertProductAvailable(product, quantity);

      item.quantity = quantity;
    });

    res.status(200).json({
      success: true,
      message: "Cart updated",
      cart: await buildCartResponse(cart),
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/cart/items/:productId
const removeItem = async (req, res, next) => {
  try {
    checkProductId(req.params.productId);
    const productId = req.params.productId.toLowerCase(); // ids are stored in lowercase

    const { cart } = await updateCart(req.user._id, async (cart) => {
      if (!findItem(cart, productId)) {
        throw new AppError("This product is not in your cart", 404);
      }
      cart.items = cart.items.filter((item) => String(item.product) !== productId);
    });

    res.status(200).json({
      success: true,
      message: "Item removed from cart",
      cart: await buildCartResponse(cart),
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/cart
const clearCart = async (req, res, next) => {
  try {
    const existingCart = await Cart.findOne({ user: req.user._id });

    // Nothing to clear? Still a success (the cart is empty, which is what was asked for).
    if (!existingCart || existingCart.items.length === 0) {
      return res.status(200).json({
        success: true,
        message: "Cart cleared",
        cart: await buildCartResponse({ items: [] }),
      });
    }

    const { cart } = await updateCart(req.user._id, async (cart) => {
      cart.items = [];
    });

    res.status(200).json({
      success: true,
      message: "Cart cleared",
      cart: await buildCartResponse(cart),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getCart, addItem, updateItemQuantity, removeItem, clearCart };
