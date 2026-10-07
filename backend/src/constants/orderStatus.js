// The life of an order. It only ever moves forward one step, or to "cancelled".
const ORDER_STATUSES = Object.freeze([
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
]);

// status -> the statuses it may change to. "delivered" and "cancelled" are final.
const ORDER_TRANSITIONS = Object.freeze({
  pending: Object.freeze(["confirmed", "cancelled"]),
  confirmed: Object.freeze(["processing", "cancelled"]),
  processing: Object.freeze(["shipped", "cancelled"]),
  shipped: Object.freeze(["delivered"]),
  delivered: Object.freeze([]),
  cancelled: Object.freeze([]),
});

// A customer may cancel their own order only while it is still pending
const CUSTOMER_CANCELLABLE_STATUSES = Object.freeze(["pending"]);

// Object.hasOwn keeps odd inputs such as "constructor" or "__proto__ " from matching
const allowedNextStatuses = (status) =>
  typeof status === "string" && Object.hasOwn(ORDER_TRANSITIONS, status)
    ? ORDER_TRANSITIONS[status]
    : [];

const canTransition = (from, to) => allowedNextStatuses(from).includes(to);

module.exports = {
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  CUSTOMER_CANCELLABLE_STATUSES,
  canTransition,
  allowedNextStatuses,
};
