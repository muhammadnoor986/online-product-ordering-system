import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axiosClient from "../api/axiosClient.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useCart } from "../context/CartContext.jsx";
import formatPrice from "../utils/formatPrice.js";
import { validateDelivery, NOTES_MAX_LENGTH } from "../utils/validateDelivery.js";

// Cash on Delivery is the only payment method for now. This is a fixed value, not something
// the customer can edit.
const PAYMENT_METHOD_COD = "cod";

// Shown for information only. The server decides the real shipping fee and the real total.
const SHIPPING_FEE_SHOWN = 0;

// An order found while checking after a lost connection must be this recent to count as ours
const RECENT_ORDER_WINDOW_MS = 10 * 60 * 1000;

const FIELD_ORDER = ["fullName", "phone", "addressLine1", "addressLine2", "city", "postalCode", "notes"];

const STOCK_REASON_TEXT = {
  inactive: "is no longer available",
  out_of_stock: "is out of stock",
  not_found: "no longer exists",
};

const describeStockProblem = (problem) => {
  if (problem.reason === "insufficient_stock") {
    return `${problem.name}: only ${problem.available} available (you have ${problem.requested} in your cart)`;
  }
  return `${problem.name} ${STOCK_REASON_TEXT[problem.reason] || "cannot be ordered"}`;
};

// Does an order from the server look like the one we just tried to place?
// (same products, same quantities, same total, created a moment ago)
const matchesSubmission = (order, submitted) => {
  if (!order || order.total !== submitted.total) return false;
  if (order.items.length !== submitted.lines.length) return false;
  const quantities = new Map(order.items.map((item) => [String(item.productId), item.quantity]));
  const sameItems = submitted.lines.every((line) => quantities.get(String(line.productId)) === line.quantity);
  const age = Math.abs(Date.now() - Date.parse(order.createdAt));
  return sameItems && age < RECENT_ORDER_WINDOW_MS;
};

// One label + input (or textarea) + error message
function TextField({ name, label, required = false, multiline = false, hint = null, value, error, onChange, ...attributes }) {
  const id = `checkout-${name}`;
  const errorId = `${id}-error`;
  const Control = multiline ? "textarea" : "input";

  return (
    <div className="form-field">
      <label htmlFor={id}>
        {label}
        {required ? <span className="required-mark" aria-hidden="true"> *</span> : <span className="optional-mark"> (optional)</span>}
      </label>
      <Control
        id={id}
        name={name}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? errorId : undefined}
        {...attributes}
      />
      {hint}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Checkout() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { cart, loading, updating, error: cartError, placeOrder, refreshCart } = useCart();

  // What the customer typed. The name starts as the account name (and can be changed).
  const [values, setValues] = useState(() => ({
    fullName: user ? user.name : "",
    phone: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    postalCode: "",
    notes: "",
  }));
  const [errors, setErrors] = useState({}); // { fieldName: "message" }
  const [submitted, setSubmitted] = useState(false); // after the first try, fields are re-checked as the customer types
  const [notice, setNotice] = useState(null); // { type: "error" | "info", text, problems?: [...] }
  const [phase, setPhase] = useState("idle"); // idle | submitting | checking | placed

  // A lock that works instantly (state does not update fast enough to stop two clicks in the same moment)
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const noticeRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Make sure prices and stock are fresh before the customer commits
  useEffect(() => {
    refreshCart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (notice && noticeRef.current) noticeRef.current.scrollIntoView({ block: "nearest" });
  }, [notice]);

  const hasItems = cart.items.length > 0;
  const problemItems = cart.items.filter((item) => item.problem);
  const canSubmit = phase === "idle" && hasItems && !cart.hasProblems && !loading && !updating;

  const focusFirstError = (found) => {
    const first = FIELD_ORDER.find((key) => found[key]);
    if (first) document.getElementById(`checkout-${first}`)?.focus();
  };

  const handleChange = (name, value) => {
    setValues((current) => ({ ...current, [name]: value }));
    if (submitted) {
      // re-check just this field, so its message appears or disappears as the customer types
      const message = validateDelivery({ ...values, [name]: value }).errors[name];
      setErrors((current) => {
        const next = { ...current };
        if (message) next[name] = message;
        else delete next[name];
        return next;
      });
    }
  };

  // ----- success -----
  // The order exists now. Go to its page. `replace` means the Back button will NOT bring the
  // customer back to this (now empty) checkout page. The lock stays on so nothing can be sent twice.
  const finishSuccess = (order) => {
    setPhase("placed");
    if (mountedRef.current) {
      navigate(`/orders/${order._id}`, {
        replace: true,
        state: { justPlaced: true, orderNumber: order.orderNumber },
      });
    }
  };

  const unlock = () => {
    submittingRef.current = false;
    if (mountedRef.current) setPhase("idle");
  };

  // ----- the server answered with a problem -----
  const showServerProblem = (result) => {
    const details = Array.isArray(result.details) ? result.details : [];

    // 400: some delivery fields are not valid. Show each message under its field.
    if (result.status === 400) {
      const fieldErrors = {};
      const other = [];
      for (const detail of details) {
        if (detail && typeof detail.field === "string" && detail.field.startsWith("delivery.")) {
          fieldErrors[detail.field.slice("delivery.".length)] = detail.message;
        } else if (detail && detail.message) {
          other.push(detail.message);
        }
      }
      if (Object.keys(fieldErrors).length > 0) {
        setErrors(fieldErrors);
        setSubmitted(true);
        setNotice({ type: "error", text: ["Please correct the highlighted fields.", ...other].join(" ") });
        focusFirstError(fieldErrors);
        return;
      }
    }

    // 409: the prices changed, or something in the cart cannot be ordered any more
    if (result.status === 409) {
      const priceChange = details.find((detail) => detail && detail.reason === "price_changed");
      if (priceChange) {
        setNotice({
          type: "error",
          text: `The prices in your cart have changed. The new total is ${formatPrice(priceChange.currentTotal)}. Please check it and place your order again.`,
        });
        return;
      }
      const problems = details.filter((detail) => detail && detail.productId);
      if (problems.length > 0) {
        setNotice({ type: "error", text: result.message, problems: problems.map(describeStockProblem) });
        return;
      }
    }

    setNotice({ type: "error", text: result.message });
  };

  // ----- the server did not answer at all (connection lost, timeout) -----
  // The order MAY have been created before the connection dropped, so do not guess:
  // reload the cart and look at the newest order.
  const recoverFromLostConnection = async (submittedCart) => {
    setPhase("checking");
    setNotice({ type: "info", text: "We could not confirm your order. Checking whether it was placed..." });

    await refreshCart();

    try {
      const response = await axiosClient.get("/orders", { params: { limit: 1 } });
      const newest = response.data.orders[0];

      if (matchesSubmission(newest, submittedCart)) {
        finishSuccess(newest); // it WAS placed
        return;
      }
      setNotice({
        type: "error",
        text: "Your order was not placed. Please check your details and try again.",
      });
      unlock();
    } catch (checkError) {
      // Still no connection (or the session ended): we really cannot tell
      if (checkError.response && checkError.response.status === 401) return; // the login screen takes over
      setNotice({
        type: "error",
        text: "We could not confirm whether your order was placed. Please check your connection and reload this page. If your cart is then empty, your order may already have been placed, so do not order again.",
      });
      unlock();
    }
  };

  // ----- the Place Order button -----
  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submittingRef.current || !canSubmit) return;

    const { errors: found, delivery } = validateDelivery(values);
    setSubmitted(true);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setNotice({ type: "error", text: "Please correct the highlighted fields." });
      focusFirstError(found);
      return;
    }

    submittingRef.current = true;
    setPhase("submitting");
    setNotice(null);

    // Remember exactly what we are sending (used only to recognise our own order afterwards)
    const submittedCart = {
      total: cart.subtotal,
      lines: cart.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
    };

    // We send the delivery details, "cod", and the total the customer SEES (expectedTotal).
    // Prices, totals, status and payment status are decided by the server.
    const result = await placeOrder({
      delivery,
      paymentMethod: PAYMENT_METHOD_COD,
      expectedTotal: submittedCart.total,
    });

    if (result.ok) {
      finishSuccess(result.data.order);
      return;
    }
    if (result.status === 401) return; // session expired: CartContext logged the customer out, the route sends them to /login
    if (result.status === undefined) {
      await recoverFromLostConnection(submittedCart);
      return;
    }

    showServerProblem(result);
    unlock();
  };

  const noticeBox = notice && (
    <div ref={noticeRef} className={`status ${notice.type === "info" ? "status-info" : "status-error"}`} role={notice.type === "info" ? "status" : "alert"}>
      <p>{notice.text}</p>
      {notice.problems && (
        <ul className="checkout-problems">
          {notice.problems.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
    </div>
  );

  // ===== what to show =====

  // The order is being sent, or was placed and we are moving to its page
  if (phase === "placed" || (phase === "submitting" && !hasItems)) {
    return (
      <main className="container container-wide">
        <h1>Checkout</h1>
        <p className="loading-text" role="status">
          {phase === "placed" ? "Order placed! Taking you to your order..." : "Placing your order..."}
        </p>
      </main>
    );
  }

  if (loading && !hasItems) {
    return (
      <main className="container container-wide">
        <h1>Checkout</h1>
        <p className="loading-text" role="status">
          Loading your checkout...
        </p>
      </main>
    );
  }

  if (cartError && !hasItems) {
    return (
      <main className="container container-wide">
        <h1>Checkout</h1>
        <div className="message-box message-box-error" role="alert">
          <p>{cartError}</p>
          <button type="button" className="button" onClick={refreshCart}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  if (!hasItems) {
    return (
      <main className="container container-wide">
        <h1>Checkout</h1>
        {noticeBox}
        <div className="message-box">
          <p>Your cart is empty, so there is nothing to check out.</p>
          <Link to="/" className="button button-link">
            Continue Shopping
          </Link>
        </div>
      </main>
    );
  }

  const busy = phase !== "idle";

  return (
    <main className="container container-wide">
      <Link to="/cart" className="back-link">
        &larr; Back to Cart
      </Link>
      <h1>Checkout</h1>

      {cartError && (
        <p className="status status-error" role="alert">
          {cartError}
        </p>
      )}
      {cart.hasProblems && (
        <div className="status status-error" role="alert">
          <p>Some items in your cart cannot be ordered right now:</p>
          <ul className="checkout-problems">
            {problemItems.map((item) => (
              <li key={item.productId}>{item.name}</li>
            ))}
          </ul>
          <p>
            Please <Link to="/cart">go back to your cart</Link> to remove or change them.
          </p>
        </div>
      )}
      {noticeBox}

      <div className="cart-layout">
        <form id="checkout-form" className="checkout-form" onSubmit={handleSubmit} noValidate>
          <section className="checkout-section" aria-labelledby="delivery-heading">
            <h2 id="delivery-heading">Delivery details</h2>

            <TextField name="fullName" label="Full name" required value={values.fullName} error={errors.fullName} onChange={handleChange} type="text" autoComplete="name" />
            <TextField name="phone" label="Phone number" required value={values.phone} error={errors.phone} onChange={handleChange} type="tel" inputMode="tel" autoComplete="tel" placeholder="+92 300 1234567" />
            <TextField name="addressLine1" label="Address" required value={values.addressLine1} error={errors.addressLine1} onChange={handleChange} type="text" autoComplete="address-line1" placeholder="House number and street" />
            <TextField name="addressLine2" label="Address line 2" value={values.addressLine2} error={errors.addressLine2} onChange={handleChange} type="text" autoComplete="address-line2" placeholder="Apartment, area, landmark" />
            <div className="form-row">
              <TextField name="city" label="City" required value={values.city} error={errors.city} onChange={handleChange} type="text" autoComplete="address-level2" />
              <TextField name="postalCode" label="Postal code" value={values.postalCode} error={errors.postalCode} onChange={handleChange} type="text" autoComplete="postal-code" />
            </div>
            <TextField
              name="notes"
              label="Delivery notes"
              multiline
              rows="3"
              value={values.notes}
              error={errors.notes}
              onChange={handleChange}
              hint={
                <p className="field-hint notes-counter">
                  {values.notes.length}/{NOTES_MAX_LENGTH}
                </p>
              }
            />
          </section>

          <section className="checkout-section" aria-labelledby="payment-heading">
            <h2 id="payment-heading">Payment method</h2>
            <label className="payment-option" htmlFor="payment-cod">
              <input id="payment-cod" type="radio" name="paymentMethod" value={PAYMENT_METHOD_COD} checked readOnly />
              <span>
                <span className="payment-option-title">Cash on Delivery</span>
                <span className="payment-option-text">Pay in cash when your order arrives.</span>
              </span>
            </label>
          </section>
        </form>

        <aside className="cart-summary" aria-label="Order summary">
          <h2>Order summary</h2>
          <ul className="summary-items">
            {cart.items.map((item) => (
              <li key={item.productId} className="summary-item">
                <span className="summary-item-name">
                  {item.name} &times; {item.quantity}
                  {item.problem && <em className="summary-item-unavailable"> (unavailable)</em>}
                </span>
                <span className={item.problem ? "cart-item-total-excluded" : ""}>
                  {item.problem === "not_found" ? "-" : formatPrice(item.lineTotal)}
                </span>
              </li>
            ))}
          </ul>

          <div className="summary-row">
            <span>Subtotal</span>
            <span>{formatPrice(cart.subtotal)}</span>
          </div>
          <div className="summary-row">
            <span>Shipping</span>
            <span>{formatPrice(SHIPPING_FEE_SHOWN)}</span>
          </div>
          <div className="summary-total">
            <span>Total</span>
            <strong>{formatPrice(cart.subtotal)}</strong>
          </div>
          <p className="summary-label">Pay {formatPrice(cart.subtotal)} in cash on delivery.</p>

          <button type="submit" form="checkout-form" className="button" disabled={!canSubmit}>
            {phase === "submitting" ? "Placing order..." : phase === "checking" ? "Checking your order..." : "Place Order"}
          </button>
          {busy && <p className="cart-summary-note">Please wait, do not close this page.</p>}
        </aside>
      </div>
    </main>
  );
}

export default Checkout;
