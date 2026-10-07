const mongoose = require("mongoose");

const MAX_DISTINCT_PRODUCTS = 50;
const MAX_QUANTITY_PER_PRODUCT = 99;

// One line in the cart. It only points to a product and says how many;
// name, price and stock are always read from the Product when the cart is shown.
const cartItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    quantity: {
      type: Number,
      required: true,
      min: [1, "Quantity must be at least 1"],
      max: [MAX_QUANTITY_PER_PRODUCT, `Quantity cannot be more than ${MAX_QUANTITY_PER_PRODUCT}`],
      validate: { validator: Number.isInteger, message: "Quantity must be a whole number" },
    },
  },
  { _id: false } // no id for each line; a product appears at most once per cart
);

const cartSchema = new mongoose.Schema(
  {
    // One cart per user (enforced by the unique index)
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    items: {
      type: [cartItemSchema],
      validate: {
        validator: (items) => items.length <= MAX_DISTINCT_PRODUCTS,
        message: `A cart can hold at most ${MAX_DISTINCT_PRODUCTS} different products`,
      },
    },
  },
  {
    timestamps: true, // adds createdAt and updatedAt
    // If two requests change the same cart at the same moment, the second save fails
    // with a VersionError instead of silently overwriting the first one.
    optimisticConcurrency: true,
  }
);

const Cart = mongoose.model("Cart", cartSchema);

Cart.MAX_DISTINCT_PRODUCTS = MAX_DISTINCT_PRODUCTS;
Cart.MAX_QUANTITY_PER_PRODUCT = MAX_QUANTITY_PER_PRODUCT;

module.exports = Cart;
