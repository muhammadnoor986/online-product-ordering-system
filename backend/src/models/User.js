const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    // Always stores a bcrypt hash, never the plain password
    password: { type: String, required: true },
    role: { type: String, enum: ["customer", "admin"], default: "customer" },
    // Goes up by one whenever the password changes. Login tokens carry the number they were made
    // with, so every older token stops working. Accounts that have no number yet count as 0.
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true } // adds createdAt and updatedAt
);

// Removes the password hash whenever a user is converted to JSON
userSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.password;
    delete ret.tokenVersion;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
