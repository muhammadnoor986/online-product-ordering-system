import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import axiosClient from "../api/axiosClient.js";
import { useAuth } from "../context/AuthContext.jsx";
import CancelOrderPanel from "../components/CancelOrderPanel.jsx";
import OrderItemsList from "../components/OrderItemsList.jsx";
import OrderTimeline from "../components/OrderTimeline.jsx";
import formatPrice from "../utils/formatPrice.js";
import getErrorMessage from "../utils/getErrorMessage.js";
import { capitalize, formatOrderDate, getPaymentMethodName, getStatusBadgeClass } from "../utils/orderDisplay.js";

// A read-only page for ONE of the customer's orders. Checkout sends the customer here
// right after the order is placed. Everything shown comes from the server.
function OrderDetails() {
  const { id } = useParams();
  const { logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Checkout passes { justPlaced, orderNumber } in the navigation state. Remember it once,
  // then remove it from the browser history, so a later reload does not repeat the welcome banner.
  const [justPlaced] = useState(Boolean(location.state && location.state.justPlaced));
  const [placedNumber] = useState(location.state ? location.state.orderNumber : "");
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  // What happened after the customer tried to cancel: { type: "ok" | "error", message }
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let ignore = false; // stops an old request from overwriting a newer one

    const loadOrder = async () => {
      setLoading(true);
      setErrorMessage("");
      setNotice(null);
      setOrder(null);

      try {
        const response = await axiosClient.get(`/orders/${id}`);
        if (!ignore) setOrder(response.data.order);
      } catch (error) {
        if (ignore) return;
        const status = error.response ? error.response.status : undefined;

        // The saved login no longer works: log out, and the route sends the customer to /login
        if (status === 401) {
          logout();
          return;
        }

        if (status === 400 || status === 404) {
          setErrorMessage("Sorry, we could not find this order.");
        } else {
          setErrorMessage(getErrorMessage(error, "Could not load this order."));
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    };

    loadOrder();
    return () => {
      ignore = true;
    };
  }, [id]);

  // The server cancelled the order: show the order it sent back (it is the truth)
  const handleCancelled = (updatedOrder, message) => {
    setOrder(updatedOrder);
    setNotice({ type: "ok", message: message || "Order cancelled" });
  };

  // The order can no longer be cancelled (for example the shop confirmed it a moment ago):
  // load it again quietly, without a "Loading" screen, and explain what happened
  const handleConflict = async (message) => {
    setNotice({ type: "error", message: `${message} The order below has been refreshed.` });
    try {
      const response = await axiosClient.get(`/orders/${id}`);
      setOrder(response.data.order);
    } catch (error) {
      if (error.response && error.response.status === 401) {
        logout();
        return;
      }
      setNotice({ type: "error", message: `${message} Please reload this page to see the current order.` });
    }
  };

  const banner = justPlaced && (
    <div className="status status-ok order-banner" role="status">
      <p>
        <strong>Thank you! Your order has been placed.</strong>
      </p>
      <p>
        Order number: <strong>{order ? order.orderNumber : placedNumber}</strong>. You will pay in cash when it arrives.
      </p>
    </div>
  );

  if (loading) {
    return (
      <main className="container container-wide">
        <p className="loading-text" role="status">
          Loading your order...
        </p>
      </main>
    );
  }

  if (errorMessage) {
    return (
      <main className="container container-wide">
        {/* The order exists even if its page failed to load: do not leave the customer in doubt */}
        {banner}
        <div className="message-box message-box-error" role="alert">
          <p>{errorMessage}</p>
          <div className="order-footer">
            <Link to="/orders" className="button button-link">
              My Orders
            </Link>
            <Link to="/" className="button button-link button-secondary">
              Continue Shopping
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const placedAt = formatOrderDate(order.createdAt);

  return (
    <main className="container container-wide">
      {banner}

      <Link to="/orders" className="back-link">
        &larr; Back to My Orders
      </Link>

      <h1>Order {order.orderNumber}</h1>
      <p className="order-subtitle">
        Placed on {placedAt} &middot;{" "}
        <span className={`badge ${getStatusBadgeClass(order.status)}`}>{capitalize(order.status)}</span>
      </p>

      {notice && (
        <div className={`status ${notice.type === "ok" ? "status-ok" : "status-error"}`} role={notice.type === "ok" ? "status" : "alert"}>
          <p>
            <strong>{notice.message}</strong>
          </p>
        </div>
      )}

      {/* The server decides whether this order can still be cancelled */}
      {order.canCancel && (
        <div className="order-actions">
          <CancelOrderPanel order={order} onCancelled={handleCancelled} onConflict={handleConflict} />
        </div>
      )}

      <div className="order-progress">
        <OrderTimeline order={order} />
      </div>

      <div className="cart-layout">
        <section className="checkout-section" aria-labelledby="items-heading">
          <h2 id="items-heading">Items</h2>
          <OrderItemsList items={order.items} />
        </section>

        <aside className="order-side">
          <section className="cart-summary" aria-label="Payment summary">
            <h2>Summary</h2>
            <div className="summary-row">
              <span>Subtotal</span>
              <span>{formatPrice(order.subtotal)}</span>
            </div>
            <div className="summary-row">
              <span>Shipping</span>
              <span>{formatPrice(order.shippingFee)}</span>
            </div>
            <div className="summary-total">
              <span>Total</span>
              <strong>{formatPrice(order.total)}</strong>
            </div>
            <dl className="order-meta">
              <dt>Payment</dt>
              <dd>{getPaymentMethodName(order.paymentMethod)}</dd>
              <dt>Payment status</dt>
              <dd>{capitalize(order.paymentStatus)}</dd>
            </dl>
          </section>

          <section className="cart-summary" aria-label="Delivery details">
            <h2>Delivery</h2>
            <p className="order-address">
              {order.delivery.fullName}
              {"\n"}
              {order.delivery.addressLine1}
              {order.delivery.addressLine2 ? `\n${order.delivery.addressLine2}` : ""}
              {"\n"}
              {order.delivery.city}
              {order.delivery.postalCode ? ` ${order.delivery.postalCode}` : ""}
              {"\n"}
              {order.delivery.phone}
            </p>
            {order.delivery.notes && (
              <p className="order-notes">
                <strong>Notes:</strong> {order.delivery.notes}
              </p>
            )}
          </section>
        </aside>
      </div>

      <div className="order-footer">
        <Link to="/orders" className="button button-link">
          My Orders
        </Link>
        <Link to="/" className="button button-link button-secondary">
          Continue Shopping
        </Link>
      </div>
    </main>
  );
}

export default OrderDetails;
