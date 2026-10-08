const jwt = require("jsonwebtoken");
const User = require("../models/User");
const AppError = require("../utils/AppError");

// Requires "Authorization: Bearer <token>". On success sets req.user.
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError("Not authenticated. Please log in.", 401);
    }

    const token = authHeader.split(" ")[1];

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      throw new AppError("Invalid or expired token. Please log in again.", 401);
    }

    // Load the user so deleted users cannot keep using an old token
    const user = await User.findById(decoded.userId);
    if (!user) {
      throw new AppError("User no longer exists.", 401);
    }

    // A password change raises the user's tokenVersion, which retires every older token.
    // Tokens made before this check existed have no "tv" and count as version 0.
    const tokenVersion = decoded.tv === undefined ? 0 : decoded.tv;
    if (tokenVersion !== (user.tokenVersion || 0)) {
      throw new AppError("Invalid or expired token. Please log in again.", 401);
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { protect };
