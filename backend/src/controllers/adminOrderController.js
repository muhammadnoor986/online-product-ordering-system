const Order = require("../models/Order");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const isValidObjectId = require("../utils/isValidObjectId");
const { parsePagination, escapeRegex } = require("../utils/queryHelpers");
const orderService = require("../services/orderService");
const { ORDER_STATUSES, canTransition, allowedNextStatuses } = require("../constants/orderStatus");
const { PAYMENT_STATUSES } = require("../constants/paymentMethods");

const MAX_SEARCH_LENGTH = 100;
const SORT_OPTIONS = ["newest", "oldest"];

// An admin may cancel from every status that the ONE status table lets move to "cancelled"
// (pending, confirmed, processing). It is worked out from that table, not written down twice.
const ADMIN_CANCELLABLE_STATUSES = ORDER_STATUSES.filter((status) => canTransition(status, "cancelled"));

// Returns the id in lowercase (how ids are stored), or throws 400 if it is not a valid id
const checkOrderId = (id) => {
  if (!isValidObjectId(id)) {
    throw new AppError("Invalid order id", 400);
  }
  return id.toLowerCase();
};

// The request body as a plain object (anything else counts as an empty body)
const plainBody = (body) => (body && typeof body === "object" && !Array.isArray(body) ? body : {});

// ---------------------------------------------------------------------------
// How an order is shown to an admin
// ---------------------------------------------------------------------------

const toItemView = (item) => ({
  productId: item.product,
  name: item.name,
  imageUrl: item.imageUrl,
  price: item.price,
  quantity: item.quantity,
  lineTotal: item.lineTotal,
});

// A short row for the list: no delivery address, no item list
const toAdminOrderSummary = (order) => ({
  _id: order._id,
  orderNumber: order.orderNumber,
  status: order.status,
  paymentMethod: order.paymentMethod,
  paymentStatus: order.paymentStatus,
  customer: { name: order.customer.name, email: order.customer.email },
  itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
  total: order.total,
  allowedNextStatuses: [...allowedNextStatuses(order.status)],
  createdAt: order.createdAt,
});

// The full order, with the names of the people who changed its status
const toAdminOrder = async (order) => {
  const changerIds = [
    ...new Set(order.statusHistory.map((entry) => (entry.changedBy ? String(entry.changedBy) : null)).filter(Boolean)),
  ];
  const changers = changerIds.length > 0 ? await User.find({ _id: { $in: changerIds } }).select("name role") : [];
  const changersById = new Map(changers.map((user) => [String(user._id), user]));

  return {
    _id: order._id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    customer: { name: order.customer.name, email: order.customer.email },
    userId: order.user,
    delivery: {
      fullName: order.delivery.fullName,
      phone: order.delivery.phone,
      addressLine1: order.delivery.addressLine1,
      addressLine2: order.delivery.addressLine2,
      city: order.delivery.city,
      postalCode: order.delivery.postalCode,
      notes: order.delivery.notes,
    },
    items: order.items.map(toItemView),
    subtotal: order.subtotal,
    shippingFee: order.shippingFee,
    total: order.total,
    statusHistory: order.statusHistory.map((entry) => {
      const person = entry.changedBy ? changersById.get(String(entry.changedBy)) : null;
      return {
        status: entry.status,
        changedAt: entry.changedAt,
        note: entry.note,
        changedBy: entry.changedBy
          ? { id: entry.changedBy, name: person ? person.name : "Unknown user", role: person ? person.role : null }
          : null,
      };
    }),
    stockRestored: order.stockRestored,
    allowedNextStatuses: [...allowedNextStatuses(order.status)],
    canCancel: ADMIN_CANCELLABLE_STATUSES.includes(order.status),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
};

// ---------------------------------------------------------------------------
// GET /api/admin/orders
//   ?page=1&limit=10&status=pending&paymentStatus=pending&search=ali&sort=newest
// ---------------------------------------------------------------------------

// The text to look for becomes a "contains, ignoring upper/lower case" test on several fields.
// The text is escaped first, so it can never act as a pattern.
const buildSearchClauses = (term) => {
  const pattern = new RegExp(escapeRegex(term), "i");
  const clauses = [
    { orderNumber: pattern },
    { "customer.name": pattern },
    { "customer.email": pattern },
    { "delivery.fullName": pattern },
    { "delivery.phone": pattern },
  ];

  // A phone number is stored as it was typed ("+92 300 1234567"). If the admin searches with
  // digits, let spaces, dashes and brackets between the digits match too.
  const digits = term.replace(/\D/g, "");
  if (digits.length >= 3 && /^[+\d\s\-()]+$/.test(term)) {
    clauses.push({ "delivery.phone": new RegExp(digits.split("").join("[\\s\\-()]*")) });
  }
  return clauses;
};

const listOrders = async (req, res, next) => {
  try {
    const { status, paymentStatus, search, sort } = req.query;

    if (status !== undefined && (typeof status !== "string" || !ORDER_STATUSES.includes(status))) {
      throw new AppError(`status must be one of: ${ORDER_STATUSES.join(", ")}`, 400);
    }
    if (paymentStatus !== undefined && (typeof paymentStatus !== "string" || !PAYMENT_STATUSES.includes(paymentStatus))) {
      throw new AppError(`paymentStatus must be one of: ${PAYMENT_STATUSES.join(", ")}`, 400);
    }
    if (sort !== undefined && (typeof sort !== "string" || !SORT_OPTIONS.includes(sort))) {
      throw new AppError(`sort must be one of: ${SORT_OPTIONS.join(", ")}`, 400);
    }

    let searchTerm = "";
    if (search !== undefined) {
      if (typeof search !== "string") throw new AppError("search must be text", 400);
      searchTerm = search.trim();
      if (searchTerm.length > MAX_SEARCH_LENGTH) {
        throw new AppError(`search must be at most ${MAX_SEARCH_LENGTH} characters`, 400);
      }
    }

    const { page, limit } = parsePagination(req.query);

    // Everything except the status: used for the list AND for the per-status counts
    const baseFilter = {};
    if (paymentStatus) baseFilter.paymentStatus = paymentStatus;
    if (searchTerm) baseFilter.$or = buildSearchClauses(searchTerm);

    const listFilter = status ? { ...baseFilter, status } : baseFilter;
    const sortOrder = sort === "oldest" ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 };

    const [total, orders, countRows] = await Promise.all([
      Order.countDocuments(listFilter),
      Order.find(listFilter)
        .select("orderNumber status paymentMethod paymentStatus customer items total createdAt")
        .sort(sortOrder)
        .skip((page - 1) * limit)
        .limit(limit),
      // How many orders there are in each status, for the same search (the status filter itself is ignored)
      Order.aggregate([{ $match: baseFilter }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    const statusCounts = Object.fromEntries(ORDER_STATUSES.map((name) => [name, 0]));
    for (const row of countRows) {
      if (Object.hasOwn(statusCounts, row._id)) statusCounts[row._id] = row.count;
    }

    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      orders: orders.map(toAdminOrderSummary),
      pagination: { page, limit, total, totalPages, hasNextPage: page < totalPages },
      statusCounts,
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/admin/orders/:id
// ---------------------------------------------------------------------------
const getOrder = async (req, res, next) => {
  try {
    const orderId = checkOrderId(req.params.id);

    const order = await Order.findById(orderId);
    if (!order) {
      throw new AppError("Order not found", 404);
    }

    res.status(200).json({ success: true, order: await toAdminOrder(order) });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/admin/orders/:id/status     body: { status, note? }
// Only these two fields are ever read. Everything else in the body is ignored.
// ---------------------------------------------------------------------------
const updateOrderStatus = async (req, res, next) => {
  try {
    const orderId = checkOrderId(req.params.id);
    const body = plainBody(req.body);

    if (typeof body.status !== "string" || !ORDER_STATUSES.includes(body.status)) {
      throw new AppError(`status is required and must be one of: ${ORDER_STATUSES.join(", ")}`, 400);
    }
    const note = orderService.validateNote(body.note);

    const order = await orderService.changeOrderStatus({
      orderId,
      toStatus: body.status,
      actorId: req.user._id,
      note,
    });

    res.status(200).json({
      success: true,
      message: `Order is now ${order.status}`,
      order: await toAdminOrder(order),
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// POST /api/admin/orders/:id/cancel     body: { note? }
// Gives the stock back exactly once (the same function the customer's cancel uses).
// ---------------------------------------------------------------------------
const cancelOrderAsAdmin = async (req, res, next) => {
  try {
    const orderId = checkOrderId(req.params.id);
    const note = orderService.validateNote(plainBody(req.body).note);

    const { order, stockRestoreFailed } = await orderService.cancelOrderWithReport({
      orderId,
      actorId: req.user._id,
      allowedStatuses: ADMIN_CANCELLABLE_STATUSES, // no ownerId: an admin may cancel any customer's order
      note,
    });

    // The order IS cancelled either way. If some stock could not be given back, say so clearly.
    const warnings = stockRestoreFailed.map((item) => ({
      type: "stock_not_restored",
      productId: item.productId,
      quantity: item.quantity,
    }));

    res.status(200).json({
      success: true,
      message:
        warnings.length === 0
          ? "Order cancelled"
          : `Order cancelled, but the stock of ${warnings.length} product(s) could not be restored. Please check the stock manually.`,
      order: await toAdminOrder(order),
      warnings,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { listOrders, getOrder, updateOrderStatus, cancelOrderAsAdmin };
