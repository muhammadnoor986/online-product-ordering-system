// Checkout (placing an order from the cart) and cancelling an order.
//
// The database has no transactions, so every step is either read-only, one atomic update,
// or undone if a later step fails. The order of the steps matters:
//
//   validate (read only) -> CLAIM the cart -> RESERVE stock -> CREATE the order
//
// The claim comes first on purpose. It is the one step two identical checkouts cannot both win,
// so a double click never deducts stock twice or creates two orders.
const Order = require("../models/Order");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const roundMoney = require("../utils/roundMoney");
const orderNumbers = require("../utils/generateOrderNumber");
const cartService = require("./cartService");
const stockService = require("./stockService");
const { PAYMENT_METHODS } = require("../constants/paymentMethods");
const { canTransition, CUSTOMER_CANCELLABLE_STATUSES } = require("../constants/orderStatus");

const SHIPPING_FEE = 0; // Rs. 0 for now (the Order model already has the field for later)
const MAX_ORDER_NUMBER_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

// Not allowed in any delivery field:
//   \u0000-\u001F and \u007F-\u009F   all control characters (ASCII, and the "C1" ones such as U+0085)
//   \u2028 \u2029                     Unicode line / paragraph separators (they act like newlines)
//   \u202A-\u202E \u2066-\u2069         text-direction overrides (can make an address LOOK different to the admin)
// Deliberately still allowed: the zero-width joiners U+200C / U+200D and the marks U+200E / U+200F,
// because Urdu and Persian names and addresses need them.
const ANY_CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
// The delivery notes may also contain ordinary line breaks (LF and CR)
const CONTROL_CHARACTER_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
const PHONE_PATTERN = /^\+?[0-9\s\-()]{7,20}$/;
const POSTAL_CODE_PATTERN = /^[A-Za-z0-9\s-]+$/;

const DELIVERY_FIELDS = [
  { key: "fullName", label: "Full name", required: true, min: 2, max: 100 },
  { key: "phone", label: "Phone number", required: true, min: 7, max: 20, pattern: PHONE_PATTERN, digits: [7, 15] },
  { key: "addressLine1", label: "Address", required: true, min: 5, max: 200 },
  { key: "addressLine2", label: "Address line 2", required: false, max: 200 },
  { key: "city", label: "City", required: true, min: 2, max: 60 },
  { key: "postalCode", label: "Postal code", required: false, max: 12, pattern: POSTAL_CODE_PATTERN },
  { key: "notes", label: "Delivery notes", required: false, max: 300, multiline: true },
];

// Checks the checkout request. Returns ONLY the fields we accept, cleaned up.
// Everything else the client sends (prices, totals, status, user, ...) is never even read.
const validateCheckoutInput = (body) => {
  const errors = []; // { field, message }
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};

  // delivery: must be a plain object; only the whitelisted fields are copied
  const rawDelivery = Object.hasOwn(input, "delivery") ? input.delivery : undefined;
  const delivery = {};
  if (!rawDelivery || typeof rawDelivery !== "object" || Array.isArray(rawDelivery)) {
    errors.push({ field: "delivery", message: "Delivery information is required" });
  } else {
    for (const spec of DELIVERY_FIELDS) {
      const raw = Object.hasOwn(rawDelivery, spec.key) ? rawDelivery[spec.key] : undefined;
      const field = `delivery.${spec.key}`;

      if (raw === undefined && !spec.required) {
        delivery[spec.key] = "";
        continue;
      }
      if (typeof raw !== "string") {
        errors.push({
          field,
          message: raw === undefined ? `${spec.label} is required` : `${spec.label} must be text`,
        });
        continue;
      }

      let value = raw.trim();
      if (spec.multiline) value = value.replace(/\r\n/g, "\n");

      const badCharacters = spec.multiline ? CONTROL_CHARACTER_EXCEPT_NEWLINE : ANY_CONTROL_CHARACTER;
      if (badCharacters.test(value)) {
        errors.push({ field, message: `${spec.label} contains invalid characters` });
        continue;
      }
      if (spec.required && value === "") {
        errors.push({ field, message: `${spec.label} is required` });
        continue;
      }
      if (value !== "" && spec.min && value.length < spec.min) {
        errors.push({ field, message: `${spec.label} must be at least ${spec.min} characters` });
        continue;
      }
      if (value.length > spec.max) {
        errors.push({ field, message: `${spec.label} must be at most ${spec.max} characters` });
        continue;
      }
      if (value !== "" && spec.pattern && !spec.pattern.test(value)) {
        errors.push({ field, message: `${spec.label} is not valid` });
        continue;
      }
      if (value !== "" && spec.digits) {
        const digitCount = value.replace(/\D/g, "").length;
        if (digitCount < spec.digits[0] || digitCount > spec.digits[1]) {
          errors.push({ field, message: `${spec.label} is not valid` });
          continue;
        }
      }
      delivery[spec.key] = value;
    }
  }

  const paymentMethod = Object.hasOwn(input, "paymentMethod") ? input.paymentMethod : undefined;
  if (typeof paymentMethod !== "string" || !PAYMENT_METHODS.includes(paymentMethod)) {
    errors.push({
      field: "paymentMethod",
      message: `Payment method must be one of: ${PAYMENT_METHODS.join(", ")}`,
    });
  }

  // expectedTotal is optional: the total the customer saw. Only used to detect price changes.
  const expectedTotal = Object.hasOwn(input, "expectedTotal") ? input.expectedTotal : undefined;
  if (
    expectedTotal !== undefined &&
    (typeof expectedTotal !== "number" || !Number.isFinite(expectedTotal) || expectedTotal < 0)
  ) {
    errors.push({ field: "expectedTotal", message: "expectedTotal must be a number of 0 or more" });
  }

  if (errors.length > 0) {
    throw new AppError(errors.map((error) => error.message).join(". "), 400, errors);
  }
  return { delivery, paymentMethod, expectedTotal };
};

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

// Order creation can fail on a duplicate order number (very rare). Only that case is retried.
const isOrderNumberCollision = (error) =>
  error && error.code === 11000 && Boolean(error.keyPattern && error.keyPattern.orderNumber);

// Creates the order with a fresh number, retrying ONLY the insert if the number is taken.
// Stock is never touched here, so a retry cannot deduct stock twice.
const createOrderWithRetry = async (orderData) => {
  for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
    try {
      return await Order.create({ ...orderData, orderNumber: orderNumbers.generateOrderNumber() });
    } catch (error) {
      if (!isOrderNumberCollision(error)) throw error;
      if (attempt === MAX_ORDER_NUMBER_ATTEMPTS) {
        throw new AppError("Could not create the order right now. Please try again.", 503);
      }
    }
  }
};

// After a failed checkout: put the claimed lines back into the cart.
// If even that fails we log a safe diagnostic (ids and quantities only) and report an error.
const restoreCartOrFail = async (userId, lines, originalError) => {
  try {
    const { skipped } = await cartService.restoreCartItems(userId, lines);
    if (skipped > 0) {
      console.error(`[checkout] ${skipped} cart line(s) could not be put back: the cart is full`);
    }
  } catch (restoreError) {
    console.error(
      `[checkout] could not restore the cart after a failed checkout: user ${String(userId)}, ` +
        `lines ${JSON.stringify(lines.map((line) => ({ product: String(line.product), quantity: line.quantity })))}, ` +
        `restore error ${restoreError.name}, original error ${originalError ? originalError.name : "none"}`
    );
    throw new AppError(
      "Your order could not be completed and your cart could not be fully restored.",
      500
    );
  }
};

// Runs a function only the first time it is called (protects against giving stock back twice)
const once = (fn) => {
  let called = false;
  return (...args) => {
    if (called) return Promise.resolve();
    called = true;
    return fn(...args);
  };
};

// Turns the logged-in customer's cart into an order.
// `user` is req.user (never an id from the request). `body` is the raw request body.
const placeOrder = async (user, body) => {
  // 1. Validate the input before anything is changed
  const { delivery, paymentMethod, expectedTotal } = validateCheckoutInput(body);

  // 2. Load the customer's cart
  const cart = await Cart.findOne({ user: user._id });
  if (!cart || cart.items.length === 0) {
    throw new AppError("Your cart is empty", 400);
  }
  const lines = cart.items.map((item) => ({ product: item.product, quantity: item.quantity }));

  // 3. Load the products and check that every line can still be bought (read only)
  const products = await Product.find({ _id: { $in: lines.map((line) => line.product) } }).select(
    "name price imageUrl stock isActive"
  );
  const productsById = new Map(products.map((product) => [String(product._id), product]));

  const problems = stockService.buildProblemDetails(lines, productsById);
  if (problems.length > 0) {
    throw new AppError(stockService.STOCK_CONFLICT_MESSAGE, 409, problems);
  }

  // 4. Build the order lines and totals from DATABASE values only
  const items = lines.map((line) => {
    const product = productsById.get(String(line.product));
    return {
      product: product._id,
      name: product.name,
      imageUrl: product.imageUrl || "",
      price: product.price,
      quantity: line.quantity,
      lineTotal: roundMoney(product.price * line.quantity),
    };
  });
  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
  const shippingFee = SHIPPING_FEE;
  const total = roundMoney(subtotal + shippingFee);

  // 5. The customer saw a different total? Tell them the new one instead of charging it
  if (expectedTotal !== undefined && roundMoney(expectedTotal) !== total) {
    throw new AppError(
      "The prices in your cart have changed since you last looked. Please review the new total.",
      409,
      [{ reason: "price_changed", expectedTotal, currentTotal: total }]
    );
  }

  // 6. CLAIM the cart. From here on this request owns these items.
  //    A concurrent checkout or cart edit makes this fail with 409 before anything else happens.
  await cartService.claimCart(cart);

  // 7. RESERVE stock (all lines or none). On failure the cart goes back to the customer.
  let reserved;
  try {
    reserved = await stockService.reserveStock(lines);
  } catch (error) {
    await restoreCartOrFail(user._id, lines, error);
    throw error;
  }
  const releaseReservedStock = once(() => stockService.releaseStock(reserved));

  // 8. CREATE the order. On failure stock and cart both go back.
  try {
    const order = await createOrderWithRetry({
      user: user._id,
      customer: { name: user.name, email: user.email },
      items,
      delivery,
      paymentMethod,
      paymentStatus: "pending",
      subtotal,
      shippingFee,
      total,
      status: "pending",
      statusHistory: [{ status: "pending", changedAt: new Date(), changedBy: user._id }],
      stockRestored: false,
    });

    return { order, cart: await cartService.buildEmptyCartResponse() };
  } catch (error) {
    await releaseReservedStock();
    await restoreCartOrFail(user._id, lines, error);

    // The order data is built by this function, never by the client. If the model still
    // rejects it, that is a bug on our side, so do not show model details to the customer.
    if (error.name === "ValidationError") {
      console.error(`[checkout] the order failed model validation: ${error.message}`);
      throw new AppError("Could not create the order", 500);
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

// Cancels an order and gives its stock back EXACTLY ONCE.
//   orderId        the order to cancel
//   actorId        who is cancelling (stored in the status history)
//   ownerId        when set, only an order belonging to this user can be cancelled (customers)
//   allowedStatuses  statuses it may be cancelled from (customers: pending only)
//
// One atomic update does three things together: "still in an allowed status", "stock not yet
// restored" -> "cancelled" + "stock restored" + history entry. Only the request that gets the
// updated order back gives the stock back, so two simultaneous cancels cannot restore it twice.
// (If the server crashed right after that update, the stock would stay taken. We accept that:
// it leaves the shop slightly under-stocked, never over-stocked.)
const cancelOrder = async ({
  orderId,
  actorId,
  ownerId,
  allowedStatuses = CUSTOMER_CANCELLABLE_STATUSES,
  note = "",
}) => {
  // Only statuses that the status rules really allow to move to "cancelled"
  const cancellableFrom = allowedStatuses.filter((status) => canTransition(status, "cancelled"));

  const filter = { _id: orderId, status: { $in: cancellableFrom }, stockRestored: false };
  if (ownerId) filter.user = ownerId;

  const order = await Order.findOneAndUpdate(
    filter,
    {
      $set: { status: "cancelled", stockRestored: true },
      $push: { statusHistory: { status: "cancelled", changedAt: new Date(), changedBy: actorId, note } },
    },
    { returnDocument: "after" }
  );

  if (!order) {
    // Say why: not found / not yours (404), or not in a cancellable status (409)
    const lookup = { _id: orderId };
    if (ownerId) lookup.user = ownerId;
    const existing = await Order.findOne(lookup).select("status");
    if (!existing) {
      throw new AppError("Order not found", 404);
    }
    throw new AppError(
      existing.status === "cancelled"
        ? "This order has already been cancelled"
        : `This order can no longer be cancelled because it is ${existing.status}`,
      409
    );
  }

  await stockService.releaseStock(order.items.map((item) => ({ product: item.product, quantity: item.quantity })));
  return order;
};

module.exports = { placeOrder, cancelOrder, validateCheckoutInput };
