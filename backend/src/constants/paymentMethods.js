// Cash on Delivery is the only payment method for now.
// To add online payment later, add its name here and implement it in a payment service;
// the rest of the order code only ever checks this list.
const PAYMENT_METHODS = Object.freeze(["cod"]);

// "pending" -> "paid" happens automatically when a COD order is delivered (admin phase).
// Customers can never set the payment status.
const PAYMENT_STATUSES = Object.freeze(["pending", "paid", "failed", "refunded"]);
const DEFAULT_PAYMENT_STATUS = "pending";

module.exports = { PAYMENT_METHODS, PAYMENT_STATUSES, DEFAULT_PAYMENT_STATUS };
