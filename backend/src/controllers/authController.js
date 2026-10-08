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

const NAME_MAX_LENGTH = 100;
// Control characters, Unicode line separators and text-direction overrides (the same set the
// checkout delivery fields refuse)
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

// Returns the cleaned name, or throws 400. Only "name" may be in the body.
const validateProfileUpdate = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("Name is required", 400);
  }
  const otherFields = Object.keys(body).filter((key) => key !== "name");
  if (otherFields.length > 0) {
    throw new AppError("Only the name can be changed here", 400);
  }
  if (typeof body.name !== "string") {
    throw new AppError("Name is required", 400);
  }

  const name = body.name.trim();
  if (!name) throw new AppError("Name is required", 400);
  if (CONTROL_CHARACTER.test(name)) throw new AppError("Name contains invalid characters", 400);
  if (name.length > NAME_MAX_LENGTH) {
    throw new AppError(`Name must be at most ${NAME_MAX_LENGTH} characters`, 400);
  }
  return name;
};

// PATCH /api/auth/me (protected)  body: { name }
// Changes the name of the logged-in user, and nothing else. The user is always req.user
// (from the token), never an id from the request. Old orders keep the name they were placed with.
const updateMe = async (req, res, next) => {
  try {
    const name = validateProfileUpdate(req.body);

    const user = await User.findByIdAndUpdate(req.user._id, { $set: { name } }, { returnDocument: "after", runValidators: true });
    if (!user) {
      throw new AppError("User no longer exists.", 401);
    }

    res.status(200).json({ success: true, message: "Profile updated", user });
  } catch (error) {
    next(error);
  }
};

module.exports = { signup, login, getMe, updateMe, validateProfileUpdate };
