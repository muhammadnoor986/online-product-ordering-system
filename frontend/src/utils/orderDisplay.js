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

// ---------------------------------------------------------------------------
// Admin orders. These are only LABELS and COLOURS. Which status an order may move to
// (and whether it can be cancelled) always comes from the server.
// ---------------------------------------------------------------------------

// Payment status -> badge colour
const PAYMENT_STATUS_BADGE = {
  pending: "badge-low",
  paid: "badge-in",
  failed: "badge-out",
  refunded: "badge-out",
};

// The text on the button that moves an order to a status: "confirmed" -> "Confirm order"
const STATUS_ACTION_LABELS = {
  confirmed: "Confirm order",
  processing: "Start processing",
  shipped: "Mark as shipped",
  delivered: "Mark as delivered",
};

export const getPaymentBadgeClass = (paymentStatus) => PAYMENT_STATUS_BADGE[paymentStatus] || "badge-low";

export const getStatusActionLabel = (status) => STATUS_ACTION_LABELS[status] || `Mark as ${status}`;

// Tabs of the admin list, in the order of an order's life (the server accepts these names)
export const ORDER_STATUS_TABS = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];

// The payment filter shows only the statuses that exist today (cash on delivery)
export const PAYMENT_FILTER_OPTIONS = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "paid", label: "Paid" },
];

// Who changed a status: "by Admin Name (admin)", or "by the customer" / "by the system" when unknown
export const describeChangedBy = (changedBy) => {
  if (!changedBy) return "by the system";
  if (changedBy.role === "customer") return `by ${changedBy.name} (customer)`;
  return `by ${changedBy.name}${changedBy.role ? ` (${changedBy.role})` : ""}`;
};
