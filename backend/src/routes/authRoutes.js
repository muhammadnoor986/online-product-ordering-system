const express = require("express");
const { signup, login, getMe, updateMe } = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/signup", signup);
router.post("/login", login);
router.get("/me", protect, getMe);
router.patch("/me", protect, updateMe); // customers and admins may change their OWN name

module.exports = router;
