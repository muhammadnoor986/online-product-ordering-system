const bcrypt = require("bcrypt");
const User = require("../models/User");
const generateToken = require("../utils/generateToken");
const AppError = require("../utils/AppError");

const SALT_ROUNDS = 10;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns an array of problems (empty array = input is valid)
const validateSignup = ({ name, email, password } = {}) => {
  const errors = [];
  if (typeof name !== "string" || !name.trim()) errors.push("Name is required");
  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    errors.push("A valid email is required");
  }
  if (typeof password !== "string" || password.length < 6) {
    errors.push("Password must be at least 6 characters");
  }
  return errors;
};

const validateLogin = ({ email, password } = {}) => {
  const errors = [];
  if (typeof email !== "string" || !email.trim()) errors.push("Email is required");
  if (typeof password !== "string" || !password) errors.push("Password is required");
  return errors;
};

// POST /api/auth/signup
const signup = async (req, res, next) => {
  try {
    const errors = validateSignup(req.body);
    if (errors.length > 0) {
      throw new AppError(errors.join(". "), 400);
    }

    const { name, email, password } = req.body;
    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      throw new AppError("An account with this email already exists", 409);
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Role is always "customer" here; users cannot choose admin themselves
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: "customer",
    });

    res.status(201).json({
      success: true,
      message: "Account created successfully",
      token: generateToken(user),
      user,
    });
  } catch (error) {
    // Two signups at the same moment can still hit the unique index
    if (error.code === 11000) {
      return next(new AppError("An account with this email already exists", 409));
    }
    next(error);
  }
};

// POST /api/auth/login
const login = async (req, res, next) => {
  try {
    const errors = validateLogin(req.body);
    if (errors.length > 0) {
      throw new AppError(errors.join(". "), 400);
    }

    const { email, password } = req.body;
    const user = await User.findOne({ email: email.trim().toLowerCase() });

    // Same message for "no such email" and "wrong password"
    const passwordMatches = user && (await bcrypt.compare(password, user.password));
    if (!passwordMatches) {
      throw new AppError("Invalid email or password", 401);
    }

    res.status(200).json({
      success: true,
      message: "Logged in successfully",
      token: generateToken(user),
      user,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/auth/me (protected)
const getMe = (req, res) => {
  res.status(200).json({ success: true, user: req.user });
};

module.exports = { signup, login, getMe };
