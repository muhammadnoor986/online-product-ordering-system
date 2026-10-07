const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    // Plain number (for example 1499.5). The frontend adds the "Rs." label.
    price: { type: Number, required: true, min: 0 },
    stock: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "Stock must be a whole number",
      },
    },
    imageUrl: { type: String, trim: true, default: "" },
    // false = hidden from customers (this is how "delete" works)
    isActive: { type: Boolean, default: true },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
      index: true,
    },
  },
  { timestamps: true } // adds createdAt and updatedAt
);

module.exports = mongoose.model("Product", productSchema);
