import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import axiosClient from "../../api/axiosClient.js";
import { useAuth } from "../../context/AuthContext.jsx";
import Pagination from "../../components/Pagination.jsx";
import formatPrice from "../../utils/formatPrice.js";
import getErrorMessage from "../../utils/getErrorMessage.js";
import {
  capitalize,
  formatOrderDate,
  getPaymentBadgeClass,
  getPaymentMethodName,
  getStatusBadgeClass,
  ORDER_STATUS_TABS,
  PAYMENT_FILTER_OPTIONS,
} from "../../utils/orderDisplay.js";

const PAGE_SIZE = 10;
const MAX_SEARCH_LENGTH = 100; // the server refuses longer searches

// All orders of all customers, for the admin. Everything the admin chose (status, payment,
// search, sort, page) lives in the address, so the Back button and a reload keep it.
// The server decides who may see this page; the route only hides it from other people.
function AdminOrders() {
  const { user, logout } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  // Read the choices from the address. Anything the server would not accept is ignored.
  const pageFromUrl = Number(searchParams.get("page"));
  const page = Number.isInteger(pageFromUrl) && pageFromUrl >= 1 ? pageFromUrl : 1;
  const statusFromUrl = searchParams.get("status");
  const status = ORDER_STATUS_TABS.includes(statusFromUrl) ? statusFromUrl : "";
  const paymentFromUrl = searchParams.get("paymentStatus");
  const paymentStatus = PAYMENT_FILTER_OPTIONS.some((option) => option.value && option.value === paymentFromUrl)
    ? paymentFromUrl
    : "";
  const sort = searchParams.get("sort") === "oldest" ? "oldest" : "newest";
  const search = (searchParams.get("search") || "").trim().slice(0, MAX_SEARCH_LENGTH);

  const [searchText, setSearchText] = useState(search); // what is typed in the box
  const [orders, setOrders] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [statusCounts, setStatusCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [reloadCount, setReloadCount] = useState(0); // change it to load the list again

  // When the address changes (Back button, Clear filters), show the same search in the box
  useEffect(() => {
    setSearchText(search);
  }, [search]);

  useEffect(() => {
    let ignore = false; // stops an old request from overwriting a newer one

    const loadOrders = async () => {
      setLoading(true);
      setErrorMessage("");

      const params = { page, limit: PAGE_SIZE };
      if (status) params.status = status;
      if (paymentStatus) params.paymentStatus = paymentStatus;
      if (search) params.search = search;
      if (sort === "oldest") params.sort = "oldest";

      try {
        const response = await axiosClient.get("/admin/orders", { params });
        if (ignore) return;
        setOrders(response.data.orders);
        setPagination(response.data.pagination);
        setStatusCounts(response.data.statusCounts);
      } catch (error) {
        if (ignore) return;
        const code = error.response ? error.response.status : undefined;

        // The saved login no longer works: log out, and the route sends the admin to /login
        if (code === 401) {
          logout();
          return;
        }

        setOrders([]);
        setPagination(null);
        setErrorMessage(
          code >= 500
            ? "Something went wrong on our side. Please try again."
            : getErrorMessage(error, "Could not load the orders.")
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
  }, [page, status, paymentStatus, search, sort, user ? user._id : null, reloadCount]);

  // Change some choices in the address. Any change except the page itself goes back to page 1.
  // A value of "" removes that choice from the address.
  const updateParams = (changes) => {
    const newParams = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === "" || value === null || value === undefined) {
        newParams.delete(key);
      } else {
        newParams.set(key, String(value));
      }
    }
    if (!Object.hasOwn(changes, "page")) newParams.delete("page");
    setSearchParams(newParams);
  };

  const goToPage = (newPage) => {
    updateParams({ page: newPage <= 1 ? "" : newPage });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSearch = (event) => {
    event.preventDefault();
    updateParams({ search: searchText.trim() });
  };

  const filtersActive = Boolean(status || paymentStatus || search || sort === "oldest");
  const allCount = statusCounts ? Object.values(statusCounts).reduce((sum, count) => sum + count, 0) : null;

  const clearFilters = () => {
    setSearchText("");
    setSearchParams(new URLSearchParams());
  };

  let results;
  if (loading) {
    results = (
      <p className="loading-text" role="status">
        Loading orders...
      </p>
    );
  } else if (errorMessage) {
    results = (
      <div className="message-box message-box-error" role="alert">
        <p>{errorMessage}</p>
        <button type="button" className="button" onClick={() => setReloadCount((count) => count + 1)}>
          Try again
        </button>
      </div>
    );
  } else if (pagination.total === 0) {
    results = (
      <div className="message-box">
        {filtersActive ? (
          <>
            <p>No orders match your search or filters.</p>
            <button type="button" className="button" onClick={clearFilters}>
              Clear filters
            </button>
          </>
        ) : (
          <p>No orders have been placed yet.</p>
        )}
      </div>
    );
  } else if (orders.length === 0) {
    // Orders exist, but not on this page (for example a page number typed into the address)
    results = (
      <div className="message-box">
        <p>There are no orders on this page.</p>
        <button type="button" className="button" onClick={() => goToPage(1)}>
          Go to first page
        </button>
      </div>
    );
  } else {
    results = (
      <>
        <p className="results-count">
          {pagination.total} {pagination.total === 1 ? "order" : "orders"}
        </p>

        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Customer</th>
              <th scope="col">Placed</th>
              <th scope="col">Items</th>
              <th scope="col">Total</th>
              <th scope="col">Payment</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order._id}>
                <td data-label="Order" className="admin-cell-name">
                  {order.orderNumber}
                </td>
                <td data-label="Customer">
                  <div className="admin-customer">
                    <span className="admin-customer-name">{order.customer.name}</span>
                    <span className="admin-customer-email">{order.customer.email}</span>
                  </div>
                </td>
                <td data-label="Placed">{formatOrderDate(order.createdAt)}</td>
                <td data-label="Items">{order.itemCount}</td>
                <td data-label="Total">{formatPrice(order.total)}</td>
                <td data-label="Payment">
                  <div className="admin-payment">
                    <span>{getPaymentMethodName(order.paymentMethod)}</span>
                    <span className={`badge ${getPaymentBadgeClass(order.paymentStatus)}`}>
                      {capitalize(order.paymentStatus)}
                    </span>
                  </div>
                </td>
                <td data-label="Status">
                  <span className={`badge ${getStatusBadgeClass(order.status)}`}>{capitalize(order.status)}</span>
                </td>
                <td data-label="Actions">
                  <div className="admin-actions">
                    <Link
                      to={`/admin/orders/${order._id}`}
                      state={{ listSearch: location.search }}
                      className="button button-small button-link"
                      aria-label={`View order ${order.orderNumber}`}
                    >
                      View
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <Pagination pagination={pagination} onPageChange={goToPage} />
      </>
    );
  }

  return (
    <main className="container container-wide">
      <div className="admin-header">
        <h1>Manage Orders</h1>
      </div>

      <div className="status-tabs" role="group" aria-label="Filter by order status">
        <button
          type="button"
          className={`status-tab ${status === "" ? "status-tab-active" : ""}`}
          aria-pressed={status === ""}
          onClick={() => updateParams({ status: "" })}
        >
          All{allCount !== null ? ` (${allCount})` : ""}
        </button>
        {ORDER_STATUS_TABS.map((name) => (
          <button
            key={name}
            type="button"
            className={`status-tab ${status === name ? "status-tab-active" : ""}`}
            aria-pressed={status === name}
            onClick={() => updateParams({ status: name })}
          >
            {capitalize(name)}
            {statusCounts ? ` (${statusCounts[name]})` : ""}
          </button>
        ))}
      </div>

      <div className="filters">
        <form className="filters-search" onSubmit={handleSearch} role="search">
          <label htmlFor="order-search" className="visually-hidden">
            Search orders
          </label>
          <input
            id="order-search"
            type="search"
            placeholder="Order number, customer, e-mail or phone"
            value={searchText}
            maxLength={MAX_SEARCH_LENGTH}
            onChange={(event) => setSearchText(event.target.value)}
          />
          <button type="submit" className="button">
            Search
          </button>
        </form>

        <div className="filters-row-orders">
          <div className="filter-field">
            <label htmlFor="order-payment">Payment</label>
            <select
              id="order-payment"
              value={paymentStatus}
              onChange={(event) => updateParams({ paymentStatus: event.target.value })}
            >
              {PAYMENT_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="order-sort">Sort</label>
            <select
              id="order-sort"
              value={sort}
              onChange={(event) => updateParams({ sort: event.target.value === "oldest" ? "oldest" : "" })}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>
          <div className="filter-buttons">
            <button type="button" className="button button-secondary" onClick={clearFilters} disabled={!filtersActive}>
              Clear filters
            </button>
          </div>
        </div>
      </div>

      {results}
    </main>
  );
}

export default AdminOrders;
