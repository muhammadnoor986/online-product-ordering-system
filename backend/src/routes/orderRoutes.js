const express = require("express");
const {
  createOrder,
  getMyOrders,
  getMyOrder,
  cancelMyOrder,
} = require("../controllers/orderController");
const { protect } = require("../middleware/authMiddleware");
const { authorizeRoles } = require("../middleware/roleMiddleware");

const router = express.Router();

// Every order route needs a logged-in customer. The owner is always req.user,
// never an id from the URL or the request body.
// There is deliberately NO route that lets a customer change an order's status or payment.
router.use(protect, authorizeRoles("customer"));

router.post("/", createOrder);
router.get("/", getMyOrders);
router.get("/:id", getMyOrder);
router.post("/:id/cancel", cancelMyOrder);

module.exports = router;
