// Checks the "change password" form before it is sent.
//
// These rules MIRROR the server (backend/src/utils/passwordRules.js) so that people get instant
// feedback. The SERVER stays the authority: it checks everything again. A test
// (frontend/tests/validatePassword.test.js) feeds both the same inputs and fails if they ever
// disagree, so keep the two in step.

export const PASSWORD_MIN_LENGTH = 8;
// The server refuses longer passwords (only the first 72 bytes would count)
export const PASSWORD_MAX_BYTES = 72;

// values: { currentPassword, newPassword }
// Returns "" when fine, otherwise ONE message (the same text the server would send).
export const validatePasswordChange = (values) => {
  const { currentPassword, newPassword } = values && typeof values === "object" ? values : {};

  if (typeof currentPassword !== "string" || currentPassword === "") {
    return "Current password is required";
  }
  if (typeof newPassword !== "string" || newPassword === "") {
    return "New password is required";
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return `New password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (new TextEncoder().encode(newPassword).length > PASSWORD_MAX_BYTES) {
    return `New password must be at most ${PASSWORD_MAX_BYTES} bytes`;
  }
  if (newPassword === currentPassword) {
    return "New password must be different from the current password";
  }
  return "";
};
