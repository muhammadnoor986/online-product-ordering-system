import { useState } from "react";
import getErrorMessage from "../utils/getErrorMessage.js";

// One form for both "Add category" (category = null) and "Edit category" (category = existing).
// onSubmit(data) must return a promise; if it throws, the message is shown in the form.
function CategoryForm({ category = null, onSubmit, onCancel }) {
  const isEditing = Boolean(category);

  const [name, setName] = useState(category?.name || "");
  const [description, setDescription] = useState(category?.description || "");
  const [nameError, setNameError] = useState("");
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setServerError("");

    if (!name.trim()) {
      setNameError("Category name is required.");
      return;
    }
    setNameError("");

    setSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), description: description.trim() });
    } catch (error) {
      setServerError(getErrorMessage(error, "Could not save the category."));
      setSubmitting(false);
    }
    // On success the parent closes this form
  };

  return (
    <form className="admin-form" onSubmit={handleSubmit} noValidate>
      <h2>{isEditing ? "Edit Category" : "Add Category"}</h2>

      {serverError && (
        <p className="status status-error" role="alert">
          {serverError}
        </p>
      )}

      <div className="form-field">
        <label htmlFor="category-name">Name</label>
        <input
          id="category-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {nameError && <p className="field-error">{nameError}</p>}
      </div>

      <div className="form-field">
        <label htmlFor="category-description">Description (optional)</label>
        <textarea
          id="category-description"
          rows="3"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="form-actions">
        <button type="submit" className="button" disabled={submitting}>
          {submitting ? "Saving..." : isEditing ? "Save Changes" : "Create Category"}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default CategoryForm;
