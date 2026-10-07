const express = require("express");
const {
  getCart,
  addItem,
  updateItemQuantity,
  removeItem,
  clearCart,
} = require("../controllers/cartController");
const { protect } = require("../middleware/authMiddleware");
const { authorizeRoles } = require("../middleware/roleMiddleware");

const router = express.Router();

// Every cart route needs a logged-in customer. The cart owner is always req.user,
// never an id from the URL or the request body.
router.use(protect, authorizeRoles("customer"));

router.get("/", getCart);
router.post("/items", addItem);
router.put("/items/:productId", updateItemQuantity);
router.delete("/items/:productId", removeItem);
router.delete("/", clearCart);

module.exports = router;
