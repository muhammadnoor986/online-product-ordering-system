import { useState } from "react";
import { Link } from "react-router-dom";
import getErrorMessage from "../utils/getErrorMessage.js";

// Checks the form values. Returns an object like { price: "message" } (empty = valid).
const validate = (values) => {
  const errors = {};

  if (!values.name.trim()) errors.name = "Name is required.";
  if (!values.description.trim()) errors.description = "Description is required.";

  const price = values.price.trim();
  if (price === "" || !Number.isFinite(Number(price)) || Number(price) < 0) {
    errors.price = "Price must be a number of 0 or more.";
  }

  // Whole number only (digits, no decimal point or minus sign)
  if (!/^\d+$/.test(values.stock.trim())) {
    errors.stock = "Stock must be a whole number of 0 or more.";
  }

  const imageUrl = values.imageUrl.trim();
  if (imageUrl !== "" && !/^https?:\/\/\S+$/i.test(imageUrl)) {
    errors.imageUrl = "Image URL must start with http:// or https://";
  }

  if (!values.category) errors.category = "Please choose a category.";

  return errors;
};

// One form for both "Add product" (product = null) and "Edit product" (product = existing).
// onSubmit(data) must return a promise; if it throws, the message is shown in the form.
function ProductForm({ product = null, categories, onSubmit, onCancel }) {
  const isEditing = Boolean(product);

  const [values, setValues] = useState({
    name: product?.name || "",
    description: product?.description || "",
    price: product ? String(product.price) : "",
    stock: product ? String(product.stock) : "",
    imageUrl: product?.imageUrl || "",
    category: product?.category?._id || "",
    isActive: product ? product.isActive : true,
  });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target;
    setValues((current) => ({ ...current, [name]: type === "checkbox" ? checked : value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setServerError("");

    const foundErrors = validate(values);
    setErrors(foundErrors);
    if (Object.keys(foundErrors).length > 0) return;

    const data = {
      name: values.name.trim(),
      description: values.description.trim(),
      price: Number(values.price),
      stock: Number(values.stock),
      imageUrl: values.imageUrl.trim(),
      category: values.category,
    };
    // New products are always active; the checkbox only appears when editing
    if (isEditing) data.isActive = values.isActive;

    setSubmitting(true);
    try {
      await onSubmit(data);
    } catch (error) {
      setServerError(getErrorMessage(error, "Could not save the product."));
      setSubmitting(false);
    }
    // On success the parent closes this form, so there is nothing more to do here
  };

  const noCategories = categories.length === 0;

  return (
    <form className="admin-form" onSubmit={handleSubmit} noValidate>
      <h2>{isEditing ? "Edit Product" : "Add Product"}</h2>

      {serverError && (
        <p className="status status-error" role="alert">
          {serverError}
        </p>
      )}

      <div className="form-field">
        <label htmlFor="product-name">Name</label>
        <input id="product-name" name="name" type="text" value={values.name} onChange={handleChange} />
        {errors.name && <p className="field-error">{errors.name}</p>}
      </div>

      <div className="form-field">
        <label htmlFor="product-description">Description</label>
        <textarea
          id="product-description"
          name="description"
          rows="4"
          value={values.description}
          onChange={handleChange}
        />
        {errors.description && <p className="field-error">{errors.description}</p>}
      </div>

      <div className="form-row">
        <div className="form-field">
          <label htmlFor="product-price">Price (Rs.)</label>
          <input
            id="product-price"
            name="price"
            type="number"
            step="any"
            inputMode="decimal"
            value={values.price}
            onChange={handleChange}
          />
          {errors.price && <p className="field-error">{errors.price}</p>}
        </div>

        <div className="form-field">
          <label htmlFor="product-stock">Stock</label>
          <input
            id="product-stock"
            name="stock"
            type="number"
            step="1"
            inputMode="numeric"
            value={values.stock}
            onChange={handleChange}
          />
          {errors.stock && <p className="field-error">{errors.stock}</p>}
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="product-category">Category</label>
        <select
          id="product-category"
          name="category"
          value={values.category}
          onChange={handleChange}
          disabled={noCategories}
        >
          <option value="">Select a category</option>
          {categories.map((category) => (
            <option key={category._id} value={category._id}>
              {category.name}
            </option>
          ))}
        </select>
        {noCategories && (
          <p className="field-hint">
            There are no categories yet. <Link to="/admin/categories">Create a category</Link> first.
          </p>
        )}
        {errors.category && <p className="field-error">{errors.category}</p>}
      </div>

      <div className="form-field">
        <label htmlFor="product-imageUrl">Image URL (optional)</label>
        <input
          id="product-imageUrl"
          name="imageUrl"
          type="text"
          placeholder="https://example.com/photo.jpg"
          value={values.imageUrl}
          onChange={handleChange}
        />
        {errors.imageUrl && <p className="field-error">{errors.imageUrl}</p>}
      </div>

      {isEditing && (
        <label className="checkbox-field" htmlFor="product-isActive">
          <input
            id="product-isActive"
            name="isActive"
            type="checkbox"
            checked={values.isActive}
            onChange={handleChange}
          />
          Active (visible to customers)
        </label>
      )}

      <div className="form-actions">
        <button type="submit" className="button" disabled={submitting || noCategories}>
          {submitting ? "Saving..." : isEditing ? "Save Changes" : "Create Product"}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default ProductForm;
