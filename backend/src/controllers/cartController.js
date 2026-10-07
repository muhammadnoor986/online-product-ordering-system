const Cart = require("../models/Cart");
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const isValidObjectId = require("../utils/isValidObjectId");
const {
  getProblem,
  findItem,
  buildCartResponse,
  updateCart,
} = require("../services/cartService");

const { MAX_DISTINCT_PRODUCTS, MAX_QUANTITY_PER_PRODUCT } = Cart;

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
