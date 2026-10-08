const jwt = require("jsonwebtoken");

// Creates a signed JWT. Only the user id, role and token version go inside (nothing sensitive).
const generateToken = (user) => {
  return jwt.sign(
    { userId: user._id, role: user.role, tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
  );
};

module.exports = generateToken;
