import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import axiosClient from "../api/axiosClient.js";
import { useAuth } from "../context/AuthContext.jsx";
import Pagination from "../components/Pagination.jsx";
import formatPrice from "../utils/formatPrice.js";
import getErrorMessage from "../utils/getErrorMessage.js";
import { capitalize, formatOrderDate, getStatusBadgeClass, summarizeItems } from "../utils/orderDisplay.js";

const PAGE_SIZE = 10;

// The customer's own orders, newest first. The server only ever returns the orders of the
// logged-in customer, and this page keeps nothing in the browser's storage.
function MyOrders() {
  const { user, logout } = useAuth();

  // The page number lives in the address (/orders?page=2), so the Back button returns to it
  const [searchParams, setSearchParams] = useSearchParams();
  const pageFromUrl = Number(searchParams.get("page"));
  const page = Number.isInteger(pageFromUrl) && pageFromUrl >= 1 ? pageFromUrl : 1;

  const [orders, setOrders] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [reloadCount, setReloadCount] = useState(0); // change it to load the list again

  useEffect(() => {
    let ignore = false; // stops an old request from overwriting a newer one

    const loadOrders = async () => {
      setLoading(true);
      setErrorMessage("");

      try {
        const response = await axiosClient.get("/orders", { params: { page, limit: PAGE_SIZE } });
        if (ignore) return;
        setOrders(response.data.orders);
        setPagination(response.data.pagination);
      } catch (error) {
        if (ignore) return;
        const status = error.response ? error.response.status : undefined;

        // The saved login no longer works: log out, and the route sends the customer to /login
        if (status === 401) {
          logout();
          return;
        }

        setOrders([]);
        setPagination(null);
        setErrorMessage(
          status >= 500
            ? "Something went wrong on our side. Please try again."
            : getErrorMessage(error, "Could not load your orders.")
        );
      } finally {
        if (!ignore) setLoading(false);
      }
    };

    loadOrders();
    return () => {
      ignore = true;
    };
    // `logout` is left out on purpose (it is a new function on every render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, user ? user._id : null, reloadCount]);

  const goToPage = (newPage) => {
    const newParams = new URLSearchParams(searchParams);
    if (newPage <= 1) {
      newParams.delete("page");
    } else {
      newParams.set("page", String(newPage));
    }
    setSearchParams(newParams);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (loading) {
    return (
      <main className="container container-wide">
        <h1>My Orders</h1>
        <p className="loading-text" role="status">
          Loading your orders...
        </p>
      </main>
    );
  }

  if (errorMessage) {
    return (
      <main className="container container-wide">
        <h1>My Orders</h1>
        <div className="message-box message-box-error" role="alert">
          <p>{errorMessage}</p>
          <button type="button" className="button" onClick={() => setReloadCount((count) => count + 1)}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  // No orders at all
  if (pagination && pagination.total === 0) {
    return (
      <main className="container container-wide">
        <h1>My Orders</h1>
        <div className="message-box">
          <p>You haven&apos;t placed any orders yet.</p>
          <Link to="/" className="button button-link">
            Start Shopping
          </Link>
        </div>
      </main>
    );
  }

  // Orders exist, but not on this page (for example a page number typed into the address)
  if (orders.length === 0) {
    return (
      <main className="container container-wide">
        <h1>My Orders</h1>
        <div className="message-box">
          <p>There are no orders on this page.</p>
          <button type="button" className="button" onClick={() => goToPage(1)}>
            Go to first page
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="container container-wide">
      <h1>My Orders</h1>
      <p className="results-count">
        {pagination.total} {pagination.total === 1 ? "order" : "orders"}
      </p>

      <ul className="order-list">
        {orders.map((order) => (
          <li key={order._id} className="order-card">
            <div className="order-card-main">
              <h2 className="order-card-number">{order.orderNumber}</h2>
              <p className="order-card-date">Placed on {formatOrderDate(order.createdAt)}</p>
              <p className="order-card-badges">
                <span className={`badge ${getStatusBadgeClass(order.status)}`}>{capitalize(order.status)}</span>
                <span className="order-card-payment">Payment: {capitalize(order.paymentStatus)}</span>
              </p>
              <p className="order-card-items">{summarizeItems(order.items)}</p>
            </div>

            <div className="order-card-side">
              <p className="order-card-count">
                {order.itemCount} {order.itemCount === 1 ? "item" : "items"}
              </p>
              <p className="order-card-total">{formatPrice(order.total)}</p>
              <Link
                to={`/orders/${order._id}`}
                className="button button-link"
                aria-label={`View details of order ${order.orderNumber}`}
              >
                View Details
              </Link>
            </div>
          </li>
        ))}
      </ul>

      <Pagination pagination={pagination} onPageChange={goToPage} />
    </main>
  );
}

export default MyOrders;
