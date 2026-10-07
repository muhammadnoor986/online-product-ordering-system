// Run with: npm run seed:admin
// Creates the first admin user from the ADMIN_* values in backend/.env
require("dotenv").config();

const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const User = require("../models/User");

const seedAdmin = async () => {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set in backend/.env");
  }
  if (ADMIN_PASSWORD.length < 6) {
    throw new Error("ADMIN_PASSWORD must be at least 6 characters");
  }

  await connectDB();

  const email = ADMIN_EMAIL.trim().toLowerCase();
  const existingUser = await User.findOne({ email });

  if (existingUser) {
    if (existingUser.role === "admin") {
      console.log(`Admin already exists (${email}). Nothing to do.`);
    } else {
      // Not promoting automatically: that would silently change a customer's access
      console.log(`A customer with ${email} already exists. Use a different ADMIN_EMAIL.`);
    }
    return;
  }

  const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await User.create({
    name: ADMIN_NAME || "Admin",
    email,
    password: hashedPassword,
    role: "admin",
  });
  console.log(`Admin created (${email}).`);
};

seedAdmin()
  .catch((error) => {
    console.error("Admin seed failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
