const mongoose = require("mongoose");

// Connects to MongoDB Atlas using the connection string from .env
const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing. Add it to backend/.env");
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("MongoDB connected");
};

module.exports = connectDB;
