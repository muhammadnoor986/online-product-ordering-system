import { useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import getErrorMessage from "../utils/getErrorMessage.js";
import { validatePasswordChange } from "../utils/validatePassword.js";

const EMPTY = { currentPassword: "", newPassword: "", confirmPassword: "" };

// Which input a message belongs under (the messages come from validatePasswordChange or the server)
const fieldFor = (message) => (message.startsWith("Current password") ? "currentPassword" : "newPassword");

// The "Change password" part of the profile page (customers and admins).
// After a successful change the server sends a fresh login token. It replaces the old one, so
// this browser stays logged in while every other device is signed out.
function ChangePasswordForm() {
  const { logout, changePassword } = useAuth();

  const [values, setValues] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState({});
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false); // blocks a second click before the screen has updated

  const handleChange = (event) => {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => ({ ...current, [name]: "" }));
    setErrorMessage("");
    setSuccessMessage("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submittingRef.current) return;

    // Instant feedback only. The server checks everything again.
    const problem = validatePasswordChange(values);
    if (problem) {
      setFieldErrors({ [fieldFor(problem)]: problem });
      setSuccessMessage("");
      return;
    }
    if (values.confirmPassword !== values.newPassword) {
      setFieldErrors({ confirmPassword: "The two new passwords do not match" });
      setSuccessMessage("");
      return;
    }

    setFieldErrors({});
    setErrorMessage("");
    setSuccessMessage("");
    submittingRef.current = true;
    setSubmitting(true);

    try {
      await changePassword(values.currentPassword, values.newPassword);
      setValues(EMPTY);
      setSuccessMessage("Your password has been changed. Your other devices have been signed out.");
    } catch (error) {
      const code = error.response ? error.response.status : undefined;

      // The saved login no longer works: log out, and the route sends the user to /login
      if (code === 401) {
        logout();
        return;
      }

      const message = getErrorMessage(error, "Could not change the password.");
      if (code === 429) {
        setErrorMessage(
          error.response.data && error.response.data.message
            ? message
            : "Too many failed attempts. Please wait a while and try again."
        );
      } else if (code === 400 && message === "Current password is incorrect") {
        setFieldErrors({ currentPassword: message });
      } else if (code >= 500) {
        setErrorMessage("Something went wrong on our side. Your password was not changed. Please try again.");
      } else {
        setErrorMessage(message);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const field = (name, label, autoComplete) => (
    <div className="form-field">
      <label htmlFor={`pw-${name}`}>{label}</label>
      <input
        id={`pw-${name}`}
        name={name}
        type="password"
        value={values[name]}
        onChange={handleChange}
        autoComplete={autoComplete}
        aria-invalid={fieldErrors[name] ? "true" : "false"}
        aria-describedby={fieldErrors[name] ? `pw-${name}-error` : undefined}
        disabled={submitting}
      />
      {fieldErrors[name] && (
        <p id={`pw-${name}-error`} className="field-error">
          {fieldErrors[name]}
        </p>
      )}
    </div>
  );

  return (
    <form className="checkout-section profile-card" onSubmit={handleSubmit} noValidate aria-labelledby="password-heading">
      <h2 id="password-heading">Change password</h2>

      {field("currentPassword", "Current password", "current-password")}
      {field("newPassword", "New password", "new-password")}
      <p className="field-hint">Use at least 8 characters.</p>
      {field("confirmPassword", "Confirm new password", "new-password")}

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
        <button type="submit" className="button" disabled={submitting}>
          {submitting ? "Changing..." : "Change password"}
        </button>
      </div>
    </form>
  );
}

export default ChangePasswordForm;
