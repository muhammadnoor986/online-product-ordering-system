import ProductImage from "./ProductImage.jsx";
import formatPrice from "../utils/formatPrice.js";

// The list of products in an order (picture, name, quantity x price, line total).
// Used by the customer's order page and by the admin's order page, so both look the same.
// `items` is the `items` array of an order as the server sends it.
function OrderItemsList({ items }) {
  return (
    <ul className="order-items">
      {items.map((item) => (
        <li key={item.productId} className="order-item">
          <ProductImage imageUrl={item.imageUrl} name={item.name} className="order-item-image" />
          <div className="order-item-info">
            <p className="order-item-name">{item.name}</p>
            <p className="order-item-detail">
              {item.quantity} &times; {formatPrice(item.price)}
            </p>
          </div>
          <p className="order-item-total">{formatPrice(item.lineTotal)}</p>
        </li>
      ))}
    </ul>
  );
}

export default OrderItemsList;
