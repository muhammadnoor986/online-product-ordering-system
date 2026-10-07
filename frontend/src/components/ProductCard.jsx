import { Link } from "react-router-dom";
import ProductImage from "./ProductImage.jsx";
import AddToCartButton from "./AddToCartButton.jsx";
import formatPrice from "../utils/formatPrice.js";
import getStockStatus from "../utils/getStockStatus.js";

function ProductCard({ product }) {
  const stockStatus = getStockStatus(product.stock);
  const detailsPath = `/products/${product._id}`;

  return (
    <article className="product-card">
      <Link to={detailsPath} className="product-card-image-link" tabIndex={-1} aria-hidden="true">
        <ProductImage imageUrl={product.imageUrl} name={product.name} />
      </Link>

      <div className="product-card-body">
        <p className="product-category">{product.category?.name || "Uncategorized"}</p>
        <h3 className="product-name">
          <Link to={detailsPath}>{product.name}</Link>
        </h3>
        <p className="product-price">{formatPrice(product.price)}</p>
        <span className={`badge ${stockStatus.className}`}>{stockStatus.label}</span>

        <div className="product-card-actions">
          <Link to={detailsPath} className="button button-link">
            View Details
          </Link>
          <AddToCartButton product={product} />
        </div>
      </div>
    </article>
  );
}

export default ProductCard;
