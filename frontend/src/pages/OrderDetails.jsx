import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import axiosClient from "../api/axiosClient.js";
import { useAuth } from "../context/AuthContext.jsx";
import ProductImage from "../components/ProductImage.jsx";
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

  useEffect(() => {
    let ignore = false; // stops an old request from overwriting a newer one

    const loadOrder = async () => {
      setLoading(true);
      setErrorMessage("");
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

      <div className="cart-layout">
        <section className="checkout-section" aria-labelledby="items-heading">
          <h2 id="items-heading">Items</h2>
          <ul className="order-items">
            {order.items.map((item) => (
              <li key={item.productId} className="order-item">
                <ProductImage imageUrl={item.imageUrl} name={item.name} className="order-item-image" />
                <div className="order-item-info">
                  <p className="order-item-name">{item.name}</p>
                  <p className="order-item-detail">
                    {item.quantity} &times; {formatPrice(item.price)}
                  </p>
                </div>
                <p className="order-item-total">{formatPrice(item.lineTotal)}</p>
              </li>
            ))}
          </ul>
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
