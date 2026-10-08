// The rules for CHANGING a password. (Signup and login keep their own, older rules, so that
// existing accounts with shorter passwords keep working.)
//
// The browser has a copy of these rules (frontend/src/utils/validatePassword.js) so people get
// instant feedback. A test feeds both the same inputs and fails if they ever disagree.
// The server stays the authority.

const PASSWORD_MIN_LENGTH = 8;
// bcrypt only looks at the first 72 bytes of a password. Longer passwords would be silently cut
// short, so they are refused instead.
const PASSWORD_MAX_BYTES = 72;

// body: { currentPassword, newPassword }
// Returns "" when fine, otherwise ONE message. Nothing here looks at the stored password.
const validatePasswordChange = (body) => {
  const { currentPassword, newPassword } = body && typeof body === "object" ? body : {};

  if (typeof currentPassword !== "string" || currentPassword === "") {
    return "Current password is required";
  }
  if (typeof newPassword !== "string" || newPassword === "") {
    return "New password is required";
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return `New password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (Buffer.byteLength(newPassword, "utf8") > PASSWORD_MAX_BYTES) {
    return `New password must be at most ${PASSWORD_MAX_BYTES} bytes`;
  }
  if (newPassword === currentPassword) {
    return "New password must be different from the current password";
  }
  return "";
};

module.exports = { PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES, validatePasswordChange };
