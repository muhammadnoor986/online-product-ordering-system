const express = require("express");
const {
  listOrders,
  getOrder,
  updateOrderStatus,
  cancelOrderAsAdmin,
} = require("../controllers/adminOrderController");
const { protect } = require("../middleware/authMiddleware");
const { authorizeRoles } = require("../middleware/roleMiddleware");

const router = express.Router();

// Every route here needs a logged-in ADMIN (customers get 403, visitors 401).
// This is the same protect + authorizeRoles pair the rest of the API uses.
router.use(protect, authorizeRoles("admin"));

router.get("/", listOrders);
router.get("/:id", getOrder);
router.patch("/:id/status", updateOrderStatus); // one step forward
router.post("/:id/cancel", cancelOrderAsAdmin); // cancel + give the stock back

module.exports = router;
