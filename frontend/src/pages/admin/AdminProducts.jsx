import { useEffect, useState } from "react";
import axiosClient from "../../api/axiosClient.js";
import ProductForm from "../../components/ProductForm.jsx";
import ProductImage from "../../components/ProductImage.jsx";
import Pagination from "../../components/Pagination.jsx";
import formatPrice from "../../utils/formatPrice.js";
import getErrorMessage from "../../utils/getErrorMessage.js";

const PAGE_SIZE = 10;

function AdminProducts() {
  const [products, setProducts] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

  const [categories, setCategories] = useState([]);
  const [categoriesError, setCategoriesError] = useState("");

  const [search, setSearch] = useState(""); // the search that is applied
  const [searchInput, setSearchInput] = useState(""); // what the admin is typing
  const [page, setPage] = useState(1);
  const [refreshCount, setRefreshCount] = useState(0); // change it to reload the list

  // null = form closed, { product: null } = adding, { product: {...} } = editing
  const [formState, setFormState] = useState(null);
  const [notice, setNotice] = useState(null); // { type: "success" | "error", text }
  const [busyProductId, setBusyProductId] = useState(null);

  const reloadList = () => setRefreshCount((count) => count + 1);

  // Load categories once (needed for the form's category dropdown)
  useEffect(() => {
    const loadCategories = async () => {
      try {
        const response = await axiosClient.get("/categories");
        setCategories(response.data.categories);
      } catch (error) {
        setCategoriesError(getErrorMessage(error, "Could not load categories."));
      }
    };
    loadCategories();
  }, []);

  // Load products (active AND inactive) when the search, page or refreshCount changes
  useEffect(() => {
    let ignore = false; // stops an old request from overwriting a newer one

    const loadProducts = async () => {
      setLoading(true);
      setListError("");

      const params = { includeInactive: true, page, limit: PAGE_SIZE };
      if (search) params.search = search;

      try {
        const response = await axiosClient.get("/products", { params });
        if (ignore) return;

        // Asked for a page that no longer exists: go back to the first page
        if (response.data.products.length === 0 && page > 1 && response.data.pagination.total > 0) {
          setPage(1);
          return;
        }
        setProducts(response.data.products);
        setPagination(response.data.pagination);
      } catch (error) {
        if (ignore) return;
        setProducts([]);
        setPagination(null);
        setListError(getErrorMessage(error, "Could not load products."));
      } finally {
        if (!ignore) setLoading(false);
      }
    };

    loadProducts();
    return () => {
      ignore = true;
    };
  }, [search, page, refreshCount]);

  const openForm = (product) => {
    setNotice(null);
    setFormState({ product });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const closeForm = () => setFormState(null);

  // Called by ProductForm. If this throws, the form shows the error and stays open.
  const saveProduct = async (data) => {
    const editedProduct = formState.product;

    if (editedProduct) {
      try {
        await axiosClient.put(`/products/${editedProduct._id}`, data);
      } catch (error) {
        // 409 = the stock changed since this form was opened: refresh the list so that
        // opening Edit again shows the real numbers (the form itself shows the message)
        if (error.response && error.response.status === 409) reloadList();
        throw error;
      }
      setNotice({ type: "success", text: `"${data.name}" was updated.` });
    } else {
      await axiosClient.post("/products", data);
      setNotice({ type: "success", text: `"${data.name}" was created.` });
      setPage(1); // new products appear first
    }

    closeForm();
    reloadList();
  };

  const handleSearch = (event) => {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  };

  const handleClearSearch = () => {
    setSearchInput("");
    setSearch("");
    setPage(1);
  };

  const toggleActive = async (product) => {
    const makeActive = !product.isActive;
    const question = makeActive
      ? `Reactivate "${product.name}"? Customers will be able to see it again.`
      : `Deactivate "${product.name}"? Customers will no longer see it.`;

    if (!window.confirm(question)) return;

    setNotice(null);
    setBusyProductId(product._id);
    try {
      await axiosClient.put(`/products/${product._id}`, { isActive: makeActive });
      setNotice({
        type: "success",
        text: `"${product.name}" was ${makeActive ? "reactivated" : "deactivated"}.`,
      });
      reloadList();
    } catch (error) {
      setNotice({
        type: "error",
        text: getErrorMessage(error, `Could not ${makeActive ? "reactivate" : "deactivate"} the product.`),
      });
    } finally {
      setBusyProductId(null);
    }
  };

  return (
    <main className="container container-wide">
      <div className="admin-header">
        <h1>Manage Products</h1>
        {!formState && (
          <button type="button" className="button" onClick={() => openForm(null)}>
            Add Product
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

      {categoriesError && (
        <p className="status status-error" role="alert">
          {categoriesError} The category list in the form may be empty.
        </p>
      )}

      {formState && (
        // key makes React start a fresh form when switching between products
        <ProductForm
          key={formState.product ? formState.product._id : "new"}
          product={formState.product}
          categories={categories}
          onSubmit={saveProduct}
          onCancel={closeForm}
        />
      )}

      <form className="admin-search" onSubmit={handleSearch}>
        <label htmlFor="admin-search" className="visually-hidden">
          Search products
        </label>
        <input
          id="admin-search"
          type="search"
          placeholder="Search products..."
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <button type="submit" className="button">
          Search
        </button>
        {(search || searchInput) && (
          <button type="button" className="button button-secondary" onClick={handleClearSearch}>
            Clear
          </button>
        )}
      </form>

      {loading && (
        <p className="loading-text" role="status">
          Loading products...
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

      {!loading && !listError && products.length === 0 && (
        <div className="message-box">
          {search ? (
            <p>No products match your search.</p>
          ) : (
            <p>There are no products yet. Click "Add Product" to create the first one.</p>
          )}
        </div>
      )}

      {!loading && products.length > 0 && (
        <>
          <p className="results-count">
            {pagination.total} {pagination.total === 1 ? "product" : "products"} (active and inactive)
          </p>

          <table className="admin-table">
            <thead>
              <tr>
                <th>Image</th>
                <th>Name</th>
                <th>Category</th>
                <th>Price</th>
                <th>Stock</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product._id} className={product.isActive ? "" : "row-inactive"}>
                  <td data-label="Image">
                    <ProductImage imageUrl={product.imageUrl} name={product.name} className="admin-thumb" />
                  </td>
                  <td data-label="Name" className="admin-cell-name">
                    {product.name}
                  </td>
                  <td data-label="Category">{product.category?.name || "Uncategorized"}</td>
                  <td data-label="Price">{formatPrice(product.price)}</td>
                  <td data-label="Stock">{product.stock}</td>
                  <td data-label="Status">
                    <span className={`badge ${product.isActive ? "badge-in" : "badge-inactive"}`}>
                      {product.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td data-label="Actions">
                    <div className="admin-actions">
                      <button
                        type="button"
                        className="button button-small button-secondary"
                        onClick={() => openForm(product)}
                        disabled={busyProductId === product._id}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={`button button-small ${product.isActive ? "button-danger" : "button-success"}`}
                        onClick={() => toggleActive(product)}
                        disabled={busyProductId === product._id}
                      >
                        {product.isActive ? "Deactivate" : "Reactivate"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <Pagination
            pagination={pagination}
            onPageChange={(newPage) => {
              setPage(newPage);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />
        </>
      )}
    </main>
  );
}

export default AdminProducts;
