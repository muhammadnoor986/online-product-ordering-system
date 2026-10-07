import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import axiosClient from "../api/axiosClient.js";
import ProductCard from "../components/ProductCard.jsx";
import Pagination from "../components/Pagination.jsx";
import getErrorMessage from "../utils/getErrorMessage.js";

const PAGE_SIZE = 12;

// Empty text is allowed (means "no limit"); otherwise it must be a number of 0 or more
const isValidPriceText = (text) => text === "" || (Number.isFinite(Number(text)) && Number(text) >= 0);

function ProductList() {
  // The applied filters and page number live in the page address, e.g. /?search=shoe&page=2
  // This way the Back button from a product page returns to the same results.
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get("search") || "";
  const category = searchParams.get("category") || "";
  const minPrice = searchParams.get("minPrice") || "";
  const maxPrice = searchParams.get("maxPrice") || "";
  const pageFromUrl = Number(searchParams.get("page"));
  const page = Number.isInteger(pageFromUrl) && pageFromUrl >= 1 ? pageFromUrl : 1;

  // What the user is typing (not applied until they press the button)
  const [searchInput, setSearchInput] = useState(search);
  const [minPriceInput, setMinPriceInput] = useState(minPrice);
  const [maxPriceInput, setMaxPriceInput] = useState(maxPrice);
  const [formError, setFormError] = useState("");

  const [categories, setCategories] = useState([]);
  const [categoriesError, setCategoriesError] = useState("");

  const [products, setProducts] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [productsError, setProductsError] = useState("");

  // Keep the typed values in sync when the address changes (Clear, Back button, ...)
  useEffect(() => {
    setSearchInput(search);
    setMinPriceInput(minPrice);
    setMaxPriceInput(maxPrice);
    setFormError("");
  }, [search, minPrice, maxPrice]);

  // Load categories once
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

  // Load products whenever the applied filters or the page change
  useEffect(() => {
    let ignore = false; // stops an old request from overwriting a newer one

    const loadProducts = async () => {
      setLoading(true);
      setProductsError("");

      // Only send filters that have a value
      const params = { page, limit: PAGE_SIZE };
      if (search) params.search = search;
      if (category) params.category = category;
      if (minPrice) params.minPrice = minPrice;
      if (maxPrice) params.maxPrice = maxPrice;

      try {
        const response = await axiosClient.get("/products", { params });
        if (ignore) return;
        setProducts(response.data.products);
        setPagination(response.data.pagination);
      } catch (error) {
        if (ignore) return;
        setProducts([]);
        setPagination(null);
        setProductsError(getErrorMessage(error, "Could not load products."));
      } finally {
        if (!ignore) setLoading(false);
      }
    };

    loadProducts();
    return () => {
      ignore = true;
    };
  }, [search, category, minPrice, maxPrice, page]);

  // Builds the new address. Any change to filters goes back to page 1.
  const updateFilters = (changes) => {
    const next = { search, category, minPrice, maxPrice, ...changes };
    const newParams = {};
    Object.entries(next).forEach(([key, value]) => {
      if (value) newParams[key] = value;
    });
    setSearchParams(newParams);
  };

  const handleApplyFilters = (event) => {
    event.preventDefault();

    const min = minPriceInput.trim();
    const max = maxPriceInput.trim();

    if (!isValidPriceText(min) || !isValidPriceText(max)) {
      setFormError("Prices must be numbers of 0 or more.");
      return;
    }
    if (min !== "" && max !== "" && Number(min) > Number(max)) {
      setFormError("Minimum price cannot be higher than maximum price.");
      return;
    }

    setFormError("");
    updateFilters({ search: searchInput.trim(), minPrice: min, maxPrice: max });
  };

  const handleCategoryChange = (event) => {
    updateFilters({ category: event.target.value });
  };

  const handleClearFilters = () => {
    setSearchParams({});
  };

  const goToPage = (newPage) => {
    const newParams = new URLSearchParams(searchParams);
    if (newPage <= 1) {
      newParams.delete("page");
    } else {
      newParams.set("page", String(newPage));
    }
    setSearchParams(newParams);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const hasActiveFilters = Boolean(search || category || minPrice || maxPrice);

  return (
    <main className="container container-wide">
      <h1>Products</h1>

      <form className="filters" onSubmit={handleApplyFilters} noValidate>
        <div className="filters-search">
          <label htmlFor="search" className="visually-hidden">
            Search products
          </label>
          <input
            id="search"
            type="search"
            placeholder="Search products..."
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <button type="submit" className="button">
            Search
          </button>
        </div>

        <div className="filters-row">
          <div className="filter-field">
            <label htmlFor="category">Category</label>
            <select id="category" value={category} onChange={handleCategoryChange}>
              <option value="">All Categories</option>
              {categories.map((item) => (
                <option key={item._id} value={item._id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-field">
            <label htmlFor="minPrice">Minimum price (Rs.)</label>
            <input
              id="minPrice"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={minPriceInput}
              onChange={(event) => setMinPriceInput(event.target.value)}
            />
          </div>

          <div className="filter-field">
            <label htmlFor="maxPrice">Maximum price (Rs.)</label>
            <input
              id="maxPrice"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={maxPriceInput}
              onChange={(event) => setMaxPriceInput(event.target.value)}
            />
          </div>

          <div className="filter-buttons">
            <button type="submit" className="button">
              Apply Filters
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={handleClearFilters}
              disabled={!hasActiveFilters && !searchInput && !minPriceInput && !maxPriceInput}
            >
              Clear Filters
            </button>
          </div>
        </div>

        {formError && (
          <p className="status status-error" role="alert">
            {formError}
          </p>
        )}
        {categoriesError && (
          <p className="status status-error" role="alert">
            {categoriesError} You can still browse all products.
          </p>
        )}
      </form>

      {loading && (
        <p className="loading-text" role="status">
          Loading products...
        </p>
      )}

      {!loading && productsError && (
        <div className="message-box message-box-error" role="alert">
          <p>{productsError}</p>
        </div>
      )}

      {!loading && !productsError && products.length === 0 && (
        <div className="message-box">
          {pagination && pagination.total > 0 ? (
            <>
              <p>There are no products on this page.</p>
              <button type="button" className="button" onClick={() => goToPage(1)}>
                Go to first page
              </button>
            </>
          ) : hasActiveFilters ? (
            <>
              <p>No products match your search or filters.</p>
              <button type="button" className="button" onClick={handleClearFilters}>
                Clear Filters
              </button>
            </>
          ) : (
            <p>No products are available yet. Please check back soon.</p>
          )}
        </div>
      )}

      {!loading && products.length > 0 && (
        <>
          <p className="results-count">
            {pagination.total} {pagination.total === 1 ? "product" : "products"} found
          </p>

          <div className="product-grid">
            {products.map((product) => (
              <ProductCard key={product._id} product={product} />
            ))}
          </div>

          <Pagination pagination={pagination} onPageChange={goToPage} />
        </>
      )}
    </main>
  );
}

export default ProductList;
