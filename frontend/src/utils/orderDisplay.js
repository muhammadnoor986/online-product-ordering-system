// How an order is shown to the customer. Used by the "My Orders" list and by the
// single order page, so both always look the same.

// Order status -> the colour of its badge (the .badge-* classes in global.css)
const STATUS_BADGE = {
  pending: "badge-low",
  confirmed: "badge-in",
  processing: "badge-in",
  shipped: "badge-in",
  delivered: "badge-in",
  cancelled: "badge-out",
};

const PAYMENT_METHOD_NAMES = { cod: "Cash on Delivery" };

// "pending" -> "Pending"
export const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : "");

export const getStatusBadgeClass = (status) => STATUS_BADGE[status] || "badge-low";

export const getPaymentMethodName = (method) => PAYMENT_METHOD_NAMES[method] || method;

// "2026-10-07T13:42:36.000Z" -> the customer's local date and time
export const formatOrderDate = (isoDate) => new Date(isoDate).toLocaleString();

// One short line about what was ordered: "Alpha × 2, Beta × 1 +3 more"
export const summarizeItems = (items, maxShown = 2) => {
  const shown = items.slice(0, maxShown).map((item) => `${item.name} × ${item.quantity}`);
  const hidden = items.length - maxShown;
  return hidden > 0 ? `${shown.join(", ")} +${hidden} more` : shown.join(", ");
};
