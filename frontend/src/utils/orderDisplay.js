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

// ---------------------------------------------------------------------------
// Customer order timeline
// ---------------------------------------------------------------------------

// The stages of an order's life in the order they are shown ("cancelled" is not a stage:
// it ends the line). This is only the display order. The server decides what really happened,
// and a test checks that this list matches the server's status table.
export const TIMELINE_STAGES = ORDER_STATUS_TABS.filter((status) => status !== "cancelled");

// Turns an order (as the customer API returns it) into the steps of its timeline:
//   [{ status, state, changedAt }]
//   state      "done" (reached before), "current" (the order is here now),
//              "upcoming" (not reached) or "cancelled" (the final step of a cancelled order)
//   changedAt  when the status was reached according to statusHistory, or null if it says nothing
// Only the statusHistory and status the server sent are used. Notes are never read, and no
// time is ever made up.
export const buildTimeline = (order) => {
  const history = order && Array.isArray(order.statusHistory) ? order.statusHistory : [];
  const currentStatus = order ? order.status : undefined;

  // The first time each status was reached
  const reachedAt = new Map();
  for (const entry of history) {
    if (!entry || typeof entry.status !== "string" || reachedAt.has(entry.status)) continue;
    const time = new Date(entry.changedAt);
    reachedAt.set(entry.status, Number.isNaN(time.getTime()) ? null : entry.changedAt);
  }
  const timeOf = (status) => (reachedAt.has(status) ? reachedAt.get(status) : null);

  if (currentStatus === "cancelled") {
    // Only the stages that were really reached, then the cancellation as the end
    const steps = TIMELINE_STAGES.filter((status) => reachedAt.has(status)).map((status) => ({
      status,
      state: "done",
      changedAt: timeOf(status),
    }));
    steps.push({ status: "cancelled", state: "cancelled", changedAt: timeOf("cancelled") });
    return steps;
  }

  return TIMELINE_STAGES.map((status) => {
    if (status === currentStatus) return { status, state: "current", changedAt: timeOf(status) };
    if (reachedAt.has(status)) return { status, state: "done", changedAt: timeOf(status) };
    return { status, state: "upcoming", changedAt: null };
  });
};
