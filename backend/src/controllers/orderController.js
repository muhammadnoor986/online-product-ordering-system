const Order = require("../models/Order");
const AppError = require("../utils/AppError");
const isValidObjectId = require("../utils/isValidObjectId");
const orderService = require("../services/orderService");
const { ORDER_STATUSES, CUSTOMER_CANCELLABLE_STATUSES, canTransition } = require("../constants/orderStatus");

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

// Returns the id in lowercase (how ids are stored), or throws 400 if it is not a valid id
const checkOrderId = (id) => {
  if (!isValidObjectId(id)) {
    throw new AppError("Invalid order id", 400);
  }
  return id.toLowerCase();
};

// "12" -> 12. Returns null when the value is not a whole number of at least `min`.
const parseWholeNumber = (value, min) => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= min ? number : null;
};

const canCustomerCancel = (status) =>
  CUSTOMER_CANCELLABLE_STATUSES.includes(status) && canTransition(status, "cancelled");

const toItemView = (item) => ({
  productId: item.product,
  name: item.name,
  imageUrl: item.imageUrl,
  price: item.price,
  quantity: item.quantity,
  lineTotal: item.lineTotal,
});

// What a customer sees of ONE order. Built field by field, so nothing internal
// (admin ids in the history, the stockRestored flag, __v, ...) can leak by accident.
const toCustomerOrder = (order) => ({
  _id: order._id,
  orderNumber: order.orderNumber,
  status: order.status,
  paymentMethod: order.paymentMethod,
  paymentStatus: order.paymentStatus,
  customer: { name: order.customer.name, email: order.customer.email },
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
  statusHistory: order.statusHistory.map((entry) => ({
    status: entry.status,
    changedAt: entry.changedAt,
    note: entry.note,
  })),
  canCancel: canCustomerCancel(order.status),
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

// A shorter view for the "my orders" list: no phone number, no address.
const toCustomerOrderSummary = (order) => ({
  _id: order._id,
  orderNumber: order.orderNumber,
  status: order.status,
  paymentMethod: order.paymentMethod,
  paymentStatus: order.paymentStatus,
  items: order.items.map(toItemView),
  itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
  subtotal: order.subtotal,
  shippingFee: order.shippingFee,
  total: order.total,
  canCancel: canCustomerCancel(order.status),
  createdAt: order.createdAt,
});

// POST /api/orders   (checkout: turns the cart into an order)
const createOrder = async (req, res, next) => {
  try {
    const { order, cart } = await orderService.placeOrder(req.user, req.body);

    res.status(201).json({
      success: true,
      message: "Order placed successfully",
      order: toCustomerOrder(order),
      cart,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/orders   (?page=1&limit=10&status=pending)
const getMyOrders = async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = { user: req.user._id };

    if (status !== undefined) {
      if (typeof status !== "string" || !ORDER_STATUSES.includes(status)) {
        throw new AppError(`status must be one of: ${ORDER_STATUSES.join(", ")}`, 400);
      }
      filter.status = status;
    }

    let page = 1;
    if (req.query.page !== undefined) {
      page = parseWholeNumber(req.query.page, 1);
      if (page === null) throw new AppError("page must be a whole number of 1 or more", 400);
    }

    let limit = DEFAULT_PAGE_SIZE;
    if (req.query.limit !== undefined) {
      limit = parseWholeNumber(req.query.limit, 1);
      if (limit === null) throw new AppError("limit must be a whole number of 1 or more", 400);
      limit = Math.min(limit, MAX_PAGE_SIZE);
    }

    const [total, orders] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter)
        .select("-delivery -customer -statusHistory") // keep phone and address out of the list
        .sort({ createdAt: -1, _id: -1 }) // newest first
        .skip((page - 1) * limit)
        .limit(limit),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      orders: orders.map(toCustomerOrderSummary),
      pagination: { page, limit, total, totalPages, hasNextPage: page < totalPages },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/orders/:id
const getMyOrder = async (req, res, next) => {
  try {
    const orderId = checkOrderId(req.params.id);

    // The owner is part of the query: someone else's order is simply "not found"
    const order = await Order.findOne({ _id: orderId, user: req.user._id });
    if (!order) {
      throw new AppError("Order not found", 404);
    }

    res.status(200).json({ success: true, order: toCustomerOrder(order) });
  } catch (error) {
    next(error);
  }
};

// POST /api/orders/:id/cancel   (a customer can cancel their own PENDING order)
const cancelMyOrder = async (req, res, next) => {
  try {
    const orderId = checkOrderId(req.params.id);

    const order = await orderService.cancelOrder({
      orderId,
      actorId: req.user._id,
      ownerId: req.user._id,
      allowedStatuses: CUSTOMER_CANCELLABLE_STATUSES,
    });

    res.status(200).json({
      success: true,
      message: "Order cancelled",
      order: toCustomerOrder(order),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { createOrder, getMyOrders, getMyOrder, cancelMyOrder };
