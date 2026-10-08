import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import getErrorMessage from "../utils/getErrorMessage.js";
import { capitalize } from "../utils/orderDisplay.js";
import { NAME_MAX_LENGTH, validateName } from "../utils/validateDelivery.js";

// "October 8, 2026" in the user's own language settings (empty if the date is missing)
const formatMemberSince = (isoDate) => {
  const date = new Date(isoDate);
  return isoDate && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { dateStyle: "long" }) : "-";
};

// The logged-in person's account page (customers and admins). Only the NAME can be changed
// here. The email, role and member-since date are shown as plain text.
function Profile() {
  const { user, logout, updateUser } = useAuth();

  const [name, setName] = useState(user.name);
  const [nameError, setNameError] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false); // blocks a second click before the screen has updated

  const unchanged = name.trim() === user.name;

  const handleChange = (event) => {
    setName(event.target.value);
    setNameError("");
    setErrorMessage("");
    setSuccessMessage("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submittingRef.current) return;

    // Instant feedback only. The server checks the name again.
    const checked = validateName(name);
    if (checked.error) {
      setNameError(checked.error);
      setSuccessMessage("");
      return;
    }

    setNameError("");
    setErrorMessage("");
    setSuccessMessage("");
    submittingRef.current = true;
    setSubmitting(true);

    try {
      const updatedUser = await updateUser(checked.name);
      setName(updatedUser.name);
      setSuccessMessage("Your name has been updated.");
    } catch (error) {
      const code = error.response ? error.response.status : undefined;

      // The saved login no longer works: log out, and the route sends the user to /login
      if (code === 401) {
        logout();
        return;
      }

      setErrorMessage(
        code >= 500
          ? "Something went wrong on our side. Your name was not changed. Please try again."
          : getErrorMessage(error, "Could not update your name.")
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <main className="container">
      <h1>My Profile</h1>

      <section className="checkout-section profile-card" aria-labelledby="account-heading">
        <h2 id="account-heading">Account details</h2>

        <dl className="profile-info">
          <dt>Email</dt>
          <dd>{user.email}</dd>
          <dt>Role</dt>
          <dd>{capitalize(user.role)}</dd>
          <dt>Member since</dt>
          <dd>{formatMemberSince(user.createdAt)}</dd>
        </dl>
        <p className="field-hint">Your email and role cannot be changed here.</p>
      </section>

      <form className="checkout-section profile-card" onSubmit={handleSubmit} noValidate aria-labelledby="name-heading">
        <h2 id="name-heading">Your name</h2>

        <div className="form-field">
          <label htmlFor="profile-name">Name</label>
          <input
            id="profile-name"
            type="text"
            value={name}
            onChange={handleChange}
            autoComplete="name"
            aria-invalid={nameError ? "true" : "false"}
            aria-describedby={nameError ? "profile-name-error" : undefined}
            disabled={submitting}
          />
          {nameError && (
            <p id="profile-name-error" className="field-error">
              {nameError}
            </p>
          )}
          <p className="field-hint notes-counter">
            {name.length}/{NAME_MAX_LENGTH}
          </p>
        </div>

        {errorMessage && (
          <p className="status status-error" role="alert">
            {errorMessage}
          </p>
        )}
        {successMessage && (
          <p className="status status-ok" role="status">
            {successMessage}
          </p>
        )}

        <div className="form-actions">
          <button type="submit" className="button" disabled={submitting || unchanged}>
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </form>

      <div className="order-footer">
        {user.role === "admin" ? (
          <Link to="/admin/orders" className="button button-link">
            Admin Orders
          </Link>
        ) : (
          <Link to="/orders" className="button button-link">
            My Orders
          </Link>
        )}
      </div>
    </main>
  );
}

export default Profile;
