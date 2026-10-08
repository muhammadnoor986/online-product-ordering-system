const mongoose = require("mongoose");
const { ORDER_STATUSES } = require("../constants/orderStatus");
const { PAYMENT_METHODS, PAYMENT_STATUSES, DEFAULT_PAYMENT_STATUS } = require("../constants/paymentMethods");
const roundMoney = require("../utils/roundMoney");

const MAX_ITEMS = 50;
const MAX_QUANTITY_PER_ITEM = 99;

// Two money values are "the same" when they match to the cent
const sameMoney = (a, b) => Math.abs(a - b) < 0.005;

// One purchased product. Everything here is a SNAPSHOT taken when the order was placed,
// so later changes to the product never change an old order.
const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true, trim: true },
    imageUrl: { type: String, trim: true, default: "" },
    price: { type: Number, required: true, min: 0 }, // price of ONE unit at purchase time
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_QUANTITY_PER_ITEM,
      validate: { validator: Number.isInteger, message: "Quantity must be a whole number" },
    },
    lineTotal: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: function (value) {
          return sameMoney(value, roundMoney(this.price * this.quantity));
        },
        message: "Line total must equal price x quantity",
      },
    },
  },
  { _id: false } // no id for each line
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: ORDER_STATUSES, required: true },
    changedAt: { type: Date, default: Date.now },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    note: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    // Made by the server (utils/generateOrderNumber.js). The unique index guarantees uniqueness.
    orderNumber: { type: String, required: true, unique: true, immutable: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },

    // Who ordered, as they were at that moment
    customer: {
      name: { type: String, required: true, trim: true, immutable: true },
      email: { type: String, required: true, trim: true, immutable: true },
    },

    items: {
      type: [orderItemSchema],
      immutable: true,
      validate: [
        { validator: (items) => items.length >= 1, message: "An order needs at least one item" },
        { validator: (items) => items.length <= MAX_ITEMS, message: `An order can hold at most ${MAX_ITEMS} products` },
      ],
    },

    // Delivery details as typed at checkout (a snapshot, not a link to a saved address)
    delivery: {
      fullName: { type: String, required: true, trim: true, immutable: true },
      phone: { type: String, required: true, trim: true, immutable: true },
      addressLine1: { type: String, required: true, trim: true, immutable: true },
      addressLine2: { type: String, trim: true, default: "", immutable: true },
      city: { type: String, required: true, trim: true, immutable: true },
      postalCode: { type: String, trim: true, default: "", immutable: true },
      notes: { type: String, trim: true, default: "", immutable: true },
    },

    paymentMethod: { type: String, enum: PAYMENT_METHODS, required: true, immutable: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: DEFAULT_PAYMENT_STATUS },

    subtotal: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
      validate: {
        validator: function (value) {
          return sameMoney(value, roundMoney(this.items.reduce((sum, item) => sum + item.lineTotal, 0)));
        },
        message: "Subtotal must equal the sum of the line totals",
      },
    },
    shippingFee: { type: Number, default: 0, min: 0, immutable: true }, // Rs. 0 for now
    total: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
      validate: {
        validator: function (value) {
          return sameMoney(value, roundMoney(this.subtotal + this.shippingFee));
        },
        message: "Total must equal subtotal + shipping fee",
      },
    },

    status: { type: String, enum: ORDER_STATUSES, default: "pending" },
    statusHistory: { type: [statusHistorySchema], default: [] },

    // true once the stock of a cancelled order has been given back (so it is never done twice)
    stockRestored: { type: Boolean, default: false },
  },
  { timestamps: true } // adds createdAt and updatedAt
);

// "My orders", newest first. (Also serves lookups by user.)
orderSchema.index({ user: 1, createdAt: -1 });

// The admin order list: newest first, and filtered by status (statuses first, then date)
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Order", orderSchema);
module.exports.MAX_ITEMS = MAX_ITEMS;
