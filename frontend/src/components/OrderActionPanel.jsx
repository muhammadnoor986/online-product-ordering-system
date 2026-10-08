import { useEffect, useRef, useState } from "react";
import axiosClient from "../api/axiosClient.js";
import { useAuth } from "../context/AuthContext.jsx";
import getErrorMessage from "../utils/getErrorMessage.js";
import { capitalize, getStatusActionLabel } from "../utils/orderDisplay.js";
import { NOTES_MAX_LENGTH, validateNote } from "../utils/validateDelivery.js";

// The buttons that change an order's status (admin order page).
//
// Which buttons appear is decided by the SERVER: `order.allowedNextStatuses` and `order.canCancel`
// come with the order. This file knows no status rules, only how to word the buttons.
// (The server lists "cancelled" among the next statuses too, but cancelling has its own button
// and its own endpoint because it must give the stock back, so it is left out of the forward buttons.)
// Every change asks for a confirmation first, with an optional note for the status history.
//
// Props:
//   order      the order as the admin API returns it
//   onChanged  (updatedOrder, { message, warnings }) called after the server accepted the change
//   onConflict (message) called when the order was changed by someone else meanwhile (HTTP 409);
//              the page then reloads the order and shows the message
function OrderActionPanel({ order, onChanged, onConflict }) {
  const { logout } = useAuth();

  // null, { type: "status", status } or { type: "cancel" }: what the admin is about to confirm
  const [mode, setMode] = useState(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const noteRef = useRef(null);
  const submittingRef = useRef(false); // blocks a second click before the screen has updated

  const forwardStatuses = order.allowedNextStatuses.filter((status) => status !== "cancelled");

  // Ignore a confirmation that no longer fits the order (it was changed meanwhile)
  const activeMode =
    mode && (mode.type === "cancel" ? order.canCancel : forwardStatuses.includes(mode.status)) ? mode : null;

  useEffect(() => {
    if (activeMode && noteRef.current) noteRef.current.focus();
  }, [activeMode ? `${activeMode.type}:${activeMode.status || ""}` : ""]);

  const open = (newMode) => {
    setMode(newMode);
    setNote("");
    setNoteError("");
    setErrorMessage("");
  };

  const close = () => {
    setMode(null);
    setNote("");
    setNoteError("");
    setErrorMessage("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!activeMode || submittingRef.current) return;

    // Instant feedback only. The server checks the note again.
    const checked = validateNote(note);
    if (checked.error) {
      setNoteError(checked.error);
      return;
    }
    setNoteError("");
    setErrorMessage("");

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const body = checked.note ? { note: checked.note } : {};
      const response =
        activeMode.type === "cancel"
          ? await axiosClient.post(`/admin/orders/${order._id}/cancel`, body)
          : await axiosClient.patch(`/admin/orders/${order._id}/status`, { ...body, status: activeMode.status });

      close();
      onChanged(response.data.order, {
        message: response.data.message,
        warnings: Array.isArray(response.data.warnings) ? response.data.warnings : [],
      });
    } catch (error) {
      const code = error.response ? error.response.status : undefined;

      // The saved login no longer works: log out, and the route sends the admin to /login
      if (code === 401) {
        logout();
        return;
      }

      if (code === 409) {
        // Someone else changed this order first (or the change is no longer allowed)
        close();
        onConflict(getErrorMessage(error, "This order was changed by someone else."));
        return;
      }

      if (code === 404) {
        setErrorMessage("This order no longer exists.");
      } else if (code >= 500) {
        setErrorMessage("Something went wrong on our side. The order was not changed. Please try again.");
      } else {
        setErrorMessage(getErrorMessage(error, "Could not update the order. Nothing was changed."));
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const isCancel = activeMode && activeMode.type === "cancel";
  const hasActions = forwardStatuses.length > 0 || order.canCancel;

  return (
    <section className="checkout-section" aria-labelledby="actions-heading">
      <h2 id="actions-heading">Update order</h2>

      {!hasActions && (
        <p className="field-hint">
          This order is {order.status}. It is final and can no longer be changed.
        </p>
      )}

      {hasActions && !activeMode && (
        <div className="form-actions">
          {forwardStatuses.map((nextStatus) => (
            <button
              key={nextStatus}
              type="button"
              className="button"
              onClick={() => open({ type: "status", status: nextStatus })}
            >
              {getStatusActionLabel(nextStatus)}
            </button>
          ))}
          {order.canCancel && (
            <button type="button" className="button button-danger" onClick={() => open({ type: "cancel" })}>
              Cancel order
            </button>
          )}
        </div>
      )}

      {activeMode && (
        <form className="action-confirm" onSubmit={handleSubmit} noValidate>
          <p className="action-confirm-title">
            {isCancel ? "Cancel this order?" : `Change the status to ${capitalize(activeMode.status)}?`}
          </p>

          {isCancel ? (
            <p className="cart-summary-warning">
              This cannot be undone. The stock of every item in this order is returned to the shop.
            </p>
          ) : (
            <p className="field-hint">
              The customer will see the new status on their order page.
              {activeMode.status === "delivered" && order.paymentMethod === "cod"
                ? " The Cash on Delivery payment will be marked as paid."
                : ""}
            </p>
          )}

          <div className="form-field">
            <label htmlFor="order-note">Note (optional)</label>
            <textarea
              id="order-note"
              ref={noteRef}
              rows={3}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteError("");
              }}
              aria-invalid={noteError ? "true" : "false"}
              aria-describedby={noteError ? "order-note-error" : "order-note-hint"}
              disabled={submitting}
            />
            {noteError ? (
              <p id="order-note-error" className="field-error">
                {noteError}
              </p>
            ) : (
              <p id="order-note-hint" className="field-hint">
                Saved in the status history with your name.
              </p>
            )}
            <p className="field-hint notes-counter">
              {note.length}/{NOTES_MAX_LENGTH}
            </p>
          </div>

          {errorMessage && (
            <p className="status status-error" role="alert">
              {errorMessage}
            </p>
          )}

          <div className="form-actions">
            <button type="submit" className={`button ${isCancel ? "button-danger" : ""}`} disabled={submitting}>
              {submitting ? "Saving..." : isCancel ? "Yes, cancel order" : "Confirm"}
            </button>
            <button type="button" className="button button-secondary" onClick={close} disabled={submitting}>
              {isCancel ? "Keep order" : "Back"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export default OrderActionPanel;
