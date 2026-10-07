import { useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient.js";
import CategoryForm from "../../components/CategoryForm.jsx";
import getErrorMessage from "../../utils/getErrorMessage.js";

function AdminCategories() {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [refreshCount, setRefreshCount] = useState(0); // change it to reload the list

  // null = form closed, { category: null } = adding, { category: {...} } = editing
  const [formState, setFormState] = useState(null);
  const [notice, setNotice] = useState(null); // { type: "success" | "error", text }
  const [busyCategoryId, setBusyCategoryId] = useState(null);

  const reloadList = () => setRefreshCount((count) => count + 1);

  useEffect(() => {
    let ignore = false; // stops an old request from overwriting a newer one

    const loadCategories = async () => {
      setLoading(true);
      setListError("");
      try {
        const response = await axiosClient.get("/categories");
        if (!ignore) setCategories(response.data.categories);
      } catch (error) {
        if (!ignore) setListError(getErrorMessage(error, "Could not load categories."));
      } finally {
        if (!ignore) setLoading(false);
      }
    };

    loadCategories();
    return () => {
      ignore = true;
    };
  }, [refreshCount]);

  const openForm = (category) => {
    setNotice(null);
    setFormState({ category });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const closeForm = () => setFormState(null);

  // Called by CategoryForm. If this throws, the form shows the error and stays open.
  const saveCategory = async (data) => {
    const editedCategory = formState.category;

    if (editedCategory) {
      await axiosClient.put(`/categories/${editedCategory._id}`, data);
      setNotice({ type: "success", text: `"${data.name}" was updated.` });
    } else {
      await axiosClient.post("/categories", data);
      setNotice({ type: "success", text: `"${data.name}" was created.` });
    }

    closeForm();
    reloadList();
  };

  const deleteCategory = async (category) => {
    if (!window.confirm(`Delete the category "${category.name}"? This cannot be undone.`)) return;

    setNotice(null);
    setBusyCategoryId(category._id);
    try {
      await axiosClient.delete(`/categories/${category._id}`);
      setNotice({ type: "success", text: `"${category.name}" was deleted.` });
      reloadList();
    } catch (error) {
      // For example 409: "Cannot delete this category because 3 product(s) still use it..."
      setNotice({ type: "error", text: getErrorMessage(error, "Could not delete the category.") });
    } finally {
      setBusyCategoryId(null);
    }
  };

  return (
    <main className="container container-wide">
      <div className="admin-header">
        <h1>Manage Categories</h1>
        {!formState && (
          <button type="button" className="button" onClick={() => openForm(null)}>
            Add Category
          </button>
        )}
      </div>

      {notice && (
        <p
          className={`status ${notice.type === "success" ? "status-ok" : "status-error"}`}
          role={notice.type === "success" ? "status" : "alert"}
        >
          {notice.text}
        </p>
      )}

      {formState && (
        // key makes React start a fresh form when switching between categories
        <CategoryForm
          key={formState.category ? formState.category._id : "new"}
          category={formState.category}
          onSubmit={saveCategory}
          onCancel={closeForm}
        />
      )}

      {loading && (
        <p className="loading-text" role="status">
          Loading categories...
        </p>
      )}

      {!loading && listError && (
        <div className="message-box message-box-error" role="alert">
          <p>{listError}</p>
          <button type="button" className="button" onClick={reloadList}>
            Try again
          </button>
        </div>
      )}

      {!loading && !listError && categories.length === 0 && (
        <div className="message-box">
          <p>There are no categories yet. Click "Add Category" to create the first one.</p>
        </div>
      )}

      {!loading && categories.length > 0 && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => (
              <tr key={category._id}>
                <td data-label="Name" className="admin-cell-name">
                  {category.name}
                </td>
                <td data-label="Description">{category.description || "—"}</td>
                <td data-label="Actions">
                  <div className="admin-actions">
                    <button
                      type="button"
                      className="button button-small button-secondary"
                      onClick={() => openForm(category)}
                      disabled={busyCategoryId === category._id}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button button-small button-danger"
                      onClick={() => deleteCategory(category)}
                      disabled={busyCategoryId === category._id}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

export default AdminCategories;
