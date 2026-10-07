const express = require("express");
const {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
} = require("../controllers/productController");
const { protect } = require("../middleware/authMiddleware");
const { authorizeRoles } = require("../middleware/roleMiddleware");

const router = express.Router();

// GET /api/products stays public. Only when ?includeInactive=true is asked for do we
// require a logged-in admin, by reusing the existing protect + authorizeRoles middleware.
const adminOnlyWhenIncludingInactive = (req, res, next) => {
  if (req.query.includeInactive !== "true") {
    return next();
  }
  protect(req, res, (error) => {
    if (error) return next(error);
    authorizeRoles("admin")(req, res, next);
  });
};

router.get("/", adminOnlyWhenIncludingInactive, getProducts);
router.get("/:id", getProductById);
router.post("/", protect, authorizeRoles("admin"), createProduct);
router.put("/:id", protect, authorizeRoles("admin"), updateProduct);
router.delete("/:id", protect, authorizeRoles("admin"), deleteProduct);

module.exports = router;
