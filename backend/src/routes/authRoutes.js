const express = require("express");
const { signup, login, getMe, updateMe, changePassword } = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/signup", signup);
router.post("/login", login);
router.get("/me", protect, getMe);
router.post("/change-password", protect, changePassword); // new password + every older token retired
router.patch("/me", protect, updateMe); // customers and admins may change their OWN name

module.exports = router;
