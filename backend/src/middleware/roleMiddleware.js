const AppError = require("../utils/AppError");

// Use after protect. Example: router.get("/x", protect, authorizeRoles("admin"), handler)
const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return next(new AppError("You do not have permission to do this.", 403));
    }
    next();
  };
};

module.exports = { authorizeRoles };
