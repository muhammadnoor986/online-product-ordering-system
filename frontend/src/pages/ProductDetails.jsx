import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import axiosClient from "../api/axiosClient.js";
import ProductImage from "../components/ProductImage.jsx";
import AddToCartButton from "../components/AddToCartButton.jsx";
import formatPrice from "../utils/formatPrice.js";
import getStockStatus from "../utils/getStockStatus.js";
import getErrorMessage from "../utils/getErrorMessage.js";

function ProductDetails() {
  const { id } = useParams();

  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let ignore = false; // stops an old request from overwriting a newer one

    const loadProduct = async () => {
      setLoading(true);
      setErrorMessage("");
      setProduct(null);

      try {
        const response = await axiosClient.get(`/products/${id}`);
        if (!ignore) setProduct(response.data.product);
      } catch (error) {
        if (ignore) return;
        // 400 = malformed id, 404 = no such (or hidden) product. Same friendly message.
        const status = error.response?.status;
        if (status === 400 || status === 404) {
          setErrorMessage("Sorry, this product was not found or is no longer available.");
        } else {
          setErrorMessage(getErrorMessage(error, "Could not load this product."));
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    };

    loadProduct();
    return () => {
      ignore = true;
    };
  }, [id]);

  if (loading) {
    return (
      <main className="container container-wide">
        <p className="loading-text" role="status">
          Loading product...
        </p>
      </main>
    );
  }

  if (errorMessage) {
    return (
      <main className="container container-wide">
        <div className="message-box message-box-error" role="alert">
          <p>{errorMessage}</p>
          <Link to="/" className="button button-link">
            Back to Products
          </Link>
        </div>
      </main>
    );
  }

  const stockStatus = getStockStatus(product.stock);
  const inStock = product.stock > 0;

  return (
    <main className="container container-wide">
      <Link to="/" className="back-link">
        &larr; Back to Products
      </Link>

      <section className="product-details">
        <ProductImage
          imageUrl={product.imageUrl}
          name={product.name}
          className="product-details-image"
        />

        <div className="product-details-info">
          <p className="product-category">{product.category?.name || "Uncategorized"}</p>
          <h1>{product.name}</h1>
          <p className="product-price product-price-large">{formatPrice(product.price)}</p>

          <p>
            <span className={`badge ${stockStatus.className}`}>
              {inStock ? "Available" : "Currently unavailable"}
            </span>
          </p>
          <p className="product-stock-line">
            Stock: {product.stock} {product.stock === 1 ? "unit" : "units"}
          </p>

          <div className="product-details-cart">
            <AddToCartButton product={product} />
          </div>

          <h2 className="product-description-title">Description</h2>
          <p className="product-description">{product.description}</p>
        </div>
      </section>
    </main>
  );
}

export default ProductDetails;
