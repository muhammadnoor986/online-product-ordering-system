// Checks the delivery details typed at checkout.
//
// These rules MIRROR the server (backend/src/services/orderService.js) so that customers get
// instant feedback. The SERVER stays the authority: it checks everything again, and its answer
// is what counts. A test (frontend/tests/validateDelivery.test.js) feeds both the same inputs
// and fails if they ever disagree, so keep the two in step.

// Not allowed in any delivery field:
//   \u0000-\u001F and \u007F-\u009F   all control characters
//   \u2028 \u2029                     Unicode line / paragraph separators (they act like newlines)
//   \u202A-\u202E \u2066-\u2069       text-direction overrides (can make an address look different)
// Allowed on purpose: the zero-width joiners U+200C / U+200D and the marks U+200E / U+200F,
// because Urdu and Persian text needs them.
const ANY_CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
// The delivery notes may also contain ordinary line breaks (LF and CR)
const CONTROL_CHARACTER_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
const PHONE_PATTERN = /^\+?[0-9\s\-()]{7,20}$/;
const POSTAL_CODE_PATTERN = /^[A-Za-z0-9\s-]+$/;

export const NOTES_MAX_LENGTH = 300;

export const DELIVERY_FIELDS = [
  { key: "fullName", label: "Full name", required: true, min: 2, max: 100 },
  { key: "phone", label: "Phone number", required: true, min: 7, max: 20, pattern: PHONE_PATTERN, digits: [7, 15] },
  { key: "addressLine1", label: "Address", required: true, min: 5, max: 200 },
  { key: "addressLine2", label: "Address line 2", required: false, max: 200 },
  { key: "city", label: "City", required: true, min: 2, max: 60 },
  { key: "postalCode", label: "Postal code", required: false, max: 12, pattern: POSTAL_CODE_PATTERN },
  { key: "notes", label: "Delivery notes", required: false, max: NOTES_MAX_LENGTH, multiline: true },
];

// values: { fullName, phone, addressLine1, addressLine2, city, postalCode, notes } (all text)
// Returns { errors, delivery }:
//   errors    { fieldName: "message" } for every field that is not valid (empty object = all fine)
//   delivery  the cleaned-up values to send to the server (trimmed, line breaks tidied)
export const validateDelivery = (values) => {
  const errors = {};
  const delivery = {};
  const input = values && typeof values === "object" ? values : {};

  for (const spec of DELIVERY_FIELDS) {
    const raw = Object.hasOwn(input, spec.key) ? input[spec.key] : undefined;

    if (raw === undefined && !spec.required) {
      delivery[spec.key] = "";
      continue;
    }
    if (typeof raw !== "string") {
      errors[spec.key] = raw === undefined ? `${spec.label} is required` : `${spec.label} must be text`;
      continue;
    }

    let value = raw.trim();
    if (spec.multiline) value = value.replace(/\r\n/g, "\n");

    const badCharacters = spec.multiline ? CONTROL_CHARACTER_EXCEPT_NEWLINE : ANY_CONTROL_CHARACTER;
    if (badCharacters.test(value)) {
      errors[spec.key] = `${spec.label} contains invalid characters`;
      continue;
    }
    if (spec.required && value === "") {
      errors[spec.key] = `${spec.label} is required`;
      continue;
    }
    if (value !== "" && spec.min && value.length < spec.min) {
      errors[spec.key] = `${spec.label} must be at least ${spec.min} characters`;
      continue;
    }
    if (value.length > spec.max) {
      errors[spec.key] = `${spec.label} must be at most ${spec.max} characters`;
      continue;
    }
    if (value !== "" && spec.pattern && !spec.pattern.test(value)) {
      errors[spec.key] = `${spec.label} is not valid`;
      continue;
    }
    if (value !== "" && spec.digits) {
      const digitCount = value.replace(/\D/g, "").length;
      if (digitCount < spec.digits[0] || digitCount > spec.digits[1]) {
        errors[spec.key] = `${spec.label} is not valid`;
        continue;
      }
    }
    delivery[spec.key] = value;
  }

  return { errors, delivery };
};

// An admin's note on an order status change (optional, up to 300 characters, line breaks allowed).
// Mirrors validateNote in backend/src/services/orderService.js, with the same messages.
// Returns { error, note }: error is "" when fine, note is the cleaned text to send.
export const validateNote = (raw) => {
  if (raw === undefined) return { error: "", note: "" };
  if (typeof raw !== "string") return { error: "Note must be text", note: "" };

  const note = raw.trim().replace(/\r\n/g, "\n");
  if (CONTROL_CHARACTER_EXCEPT_NEWLINE.test(note)) return { error: "Note contains invalid characters", note: "" };
  if (note.length > NOTES_MAX_LENGTH) return { error: `Note must be at most ${NOTES_MAX_LENGTH} characters`, note: "" };
  return { error: "", note };
};

// A person's name on the profile page (only the name can be edited there).
// Mirrors updateMe in backend/src/controllers/authController.js, with the same messages and the
// same character rule as the delivery fields. The server stays the authority.
// Returns { error, name }: error is "" when fine, name is the cleaned text to send.
export const NAME_MAX_LENGTH = 100;

export const validateName = (raw) => {
  if (typeof raw !== "string") return { error: "Name is required", name: "" };

  const name = raw.trim();
  if (!name) return { error: "Name is required", name: "" };
  if (ANY_CONTROL_CHARACTER.test(name)) return { error: "Name contains invalid characters", name: "" };
  if (name.length > NAME_MAX_LENGTH) return { error: `Name must be at most ${NAME_MAX_LENGTH} characters`, name: "" };
  return { error: "", name };
};
