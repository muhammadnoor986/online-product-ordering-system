import { useRef, useState } from "react";
import axiosClient from "../api/axiosClient.js";
import { useAuth } from "../context/AuthContext.jsx";
import getErrorMessage from "../utils/getErrorMessage.js";

// Lets a customer cancel their own order (customer order page).
//
// The page only shows this panel when the SERVER says `order.canCancel`, so this file knows
// no cancellation rules. The server checks everything again. There is no note field because
// the customer cancel endpoint does not take one.
//
// Props:
//   order       the order as the customer API returns it
//   onCancelled (updatedOrder, message) called after the server cancelled the order
//   onConflict  (message) called when the order can no longer be cancelled (HTTP 409);
//               the page then reloads the order and shows the message
function CancelOrderPanel({ order, onCancelled, onConflict }) {
  const { logout } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false); // blocks a second click before the screen has updated

  const close = () => {
    setConfirming(false);
    setErrorMessage("");
  };

  const handleCancel = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setErrorMessage("");

    try {
      const response = await axiosClient.post(`/orders/${order._id}/cancel`);
      close();
      onCancelled(response.data.order, response.data.message);
    } catch (error) {
      const code = error.response ? error.response.status : undefined;

      // The saved login no longer works: log out, and the route sends the customer to /login
      if (code === 401) {
        logout();
        return;
      }

      if (code === 409) {
        // For example the shop confirmed the order a moment ago
        close();
        onConflict(getErrorMessage(error, "This order can no longer be cancelled."));
        return;
      }

      if (code === 404) {
        setErrorMessage("We could not find this order any more.");
      } else if (code >= 500) {
        setErrorMessage("Something went wrong on our side. Your order was not cancelled. Please try again.");
      } else {
        setErrorMessage(getErrorMessage(error, "Could not cancel the order. Nothing was changed."));
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <section className="checkout-section cancel-panel" aria-labelledby="cancel-heading">
      <h2 id="cancel-heading">Cancel this order</h2>

      {!confirming ? (
        <div className="form-actions">
          <button type="button" className="button button-danger" onClick={() => setConfirming(true)}>
            Cancel order
          </button>
        </div>
      ) : (
        <div className="action-confirm">
          <p className="action-confirm-title">Are you sure you want to cancel this order?</p>
          <p className="cart-summary-warning">
            The order will be cancelled and the items you ordered will be returned to available stock. This cannot be
            undone.
          </p>

          {errorMessage && (
            <p className="status status-error" role="alert">
              {errorMessage}
            </p>
          )}

          <div className="form-actions">
            <button type="button" className="button button-danger" onClick={handleCancel} disabled={submitting}>
              {submitting ? "Cancelling..." : "Yes, cancel order"}
            </button>
            <button type="button" className="button button-secondary" onClick={close} disabled={submitting}>
              Keep order
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export default CancelOrderPanel;
