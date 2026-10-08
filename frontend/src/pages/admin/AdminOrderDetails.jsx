import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import axiosClient from "../../api/axiosClient.js";
import { useAuth } from "../../context/AuthContext.jsx";
import OrderActionPanel from "../../components/OrderActionPanel.jsx";
import OrderItemsList from "../../components/OrderItemsList.jsx";
import formatPrice from "../../utils/formatPrice.js";
import getErrorMessage from "../../utils/getErrorMessage.js";
import {
  capitalize,
  describeChangedBy,
  formatOrderDate,
  getPaymentBadgeClass,
  getPaymentMethodName,
  getStatusBadgeClass,
} from "../../utils/orderDisplay.js";

// ONE order, with everything an admin needs: customer, delivery details, items, payment and
// the status history. Everything shown comes from the server.
function AdminOrderDetails() {
  const { id } = useParams();
  const { logout } = useAuth();
  const location = useLocation();

  // The list passes its filters (for example "?status=pending&page=2") so "Back" returns to the same view
  const listSearch = location.state && typeof location.state.listSearch === "string" ? location.state.listSearch : "";
  const backLink = (
    <Link to={`/admin/orders${listSearch}`} className="back-link">
      &larr; Back to Orders
    </Link>
  );

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [canRetry, setCanRetry] = useState(false); // "Try again" makes no sense when the order does not exist
  const [reloadCount, setReloadCount] = useState(0); // change it to load the order again
  // The result of the last change: { type: "ok" | "warning" | "error", message, warnings }
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let ignore = false; // stops an old request from overwriting a newer one

    const loadOrder = async () => {
      setLoading(true);
      setErrorMessage("");
      setCanRetry(false);
      setNotice(null);
      setOrder(null);

      try {
        const response = await axiosClient.get(`/admin/orders/${id}`);
        if (!ignore) setOrder(response.data.order);
      } catch (error) {
        if (ignore) return;
        const code = error.response ? error.response.status : undefined;

        // The saved login no longer works: log out, and the route sends the admin to /login
        if (code === 401) {
          logout();
          return;
        }

        if (code === 400 || code === 404) {
          setErrorMessage("Sorry, we could not find this order.");
        } else {
          setCanRetry(true);
          setErrorMessage(
            code >= 500
              ? "Something went wrong on our side. Please try again."
              : getErrorMessage(error, "Could not load this order.")
          );
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    };

    loadOrder();
    return () => {
      ignore = true;
    };
    // `logout` is left out on purpose (it is a new function on every render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadCount]);

  // The server accepted a status change: show the order it sent back (it is the truth)
  const handleChanged = (updatedOrder, result) => {
    setOrder(updatedOrder);
    const names = new Map(updatedOrder.items.map((item) => [String(item.productId), item.name]));
    const warnings = result.warnings.map(
      (warning) => `${names.get(String(warning.productId)) || "A product"}: ${warning.quantity} to add back`
    );
    setNotice({ type: warnings.length > 0 ? "warning" : "ok", message: result.message, warnings });
  };

  // Someone else changed the order first: load it again quietly (without a "Loading" screen)
  // and say what happened. If loading fails, the message still tells the admin to reload.
  const handleConflict = async (message) => {
    setNotice({ type: "error", message: `${message} The order below has been reloaded.`, warnings: [] });
    try {
      const response = await axiosClient.get(`/admin/orders/${id}`);
      setOrder(response.data.order);
    } catch (error) {
      if (error.response && error.response.status === 401) {
        logout();
        return;
      }
      setNotice({ type: "error", message: `${message} Please reload this page to see the current order.`, warnings: [] });
    }
  };

  if (loading) {
    return (
      <main className="container container-wide">
        {backLink}
        <p className="loading-text" role="status">
          Loading the order...
        </p>
      </main>
    );
  }

  if (errorMessage) {
    return (
      <main className="container container-wide">
        {backLink}
        <div className="message-box message-box-error" role="alert">
          <p>{errorMessage}</p>
          {canRetry && (
            <button type="button" className="button" onClick={() => setReloadCount((count) => count + 1)}>
              Try again
            </button>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="container container-wide">
      {backLink}

      <h1>Order {order.orderNumber}</h1>
      <p className="order-subtitle">
        Placed on {formatOrderDate(order.createdAt)} &middot;{" "}
        <span className={`badge ${getStatusBadgeClass(order.status)}`}>{capitalize(order.status)}</span>
      </p>

      {notice && (
        <div
          className={`status ${notice.type === "ok" ? "status-ok" : notice.type === "warning" ? "status-warning" : "status-error"}`}
          role={notice.type === "ok" ? "status" : "alert"}
        >
          <p>
            <strong>{notice.message}</strong>
          </p>
          {notice.warnings.length > 0 && (
            <>
              <p>The stock of these products could not be restored. Please check it by hand:</p>
              <ul className="notice-list">
                {notice.warnings.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="order-actions">
        <OrderActionPanel order={order} onChanged={handleChanged} onConflict={handleConflict} />
      </div>

      <div className="cart-layout">
        <div className="order-main">
          <section className="checkout-section" aria-labelledby="items-heading">
            <h2 id="items-heading">Items</h2>
            <OrderItemsList items={order.items} />
          </section>

          <section className="checkout-section" aria-labelledby="history-heading">
            <h2 id="history-heading">Status history</h2>
            <ol className="status-history">
              {order.statusHistory.map((entry, index) => (
                <li key={`${entry.status}-${entry.changedAt}-${index}`} className="status-history-item">
                  <p className="status-history-head">
                    <span className={`badge ${getStatusBadgeClass(entry.status)}`}>{capitalize(entry.status)}</span>
                    <span className="status-history-date">{formatOrderDate(entry.changedAt)}</span>
                  </p>
                  <p className="status-history-by">{describeChangedBy(entry.changedBy)}</p>
                  {entry.note && <p className="status-history-note">{entry.note}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>

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
              <dd>
                <span className={`badge ${getPaymentBadgeClass(order.paymentStatus)}`}>
                  {capitalize(order.paymentStatus)}
                </span>
              </dd>
            </dl>
          </section>

          <section className="cart-summary" aria-label="Customer">
            <h2>Customer</h2>
            <p className="order-address">
              {order.customer.name}
              {"\n"}
              {order.customer.email}
            </p>
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
        <Link to={`/admin/orders${listSearch}`} className="button button-link">
          Back to Orders
        </Link>
      </div>
    </main>
  );
}

export default AdminOrderDetails;
