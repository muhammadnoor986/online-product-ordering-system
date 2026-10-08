import { useState } from "react";
import { Link } from "react-router-dom";
import { useCart } from "../context/CartContext.jsx";
import ProductImage from "../components/ProductImage.jsx";
import QuantityControls from "../components/QuantityControls.jsx";
import formatPrice from "../utils/formatPrice.js";
import getStockStatus from "../utils/getStockStatus.js";

const MAX_QUANTITY = 99; // same limit as the server

// What to tell the customer about a line that cannot be bought right now
const getProblemText = (item) => {
  switch (item.problem) {
    case "inactive":
      return "This product is no longer available. Please remove it from your cart.";
    case "out_of_stock":
      return "This product is out of stock. Please remove it from your cart.";
    case "insufficient_stock":
      return `Only ${item.stock} in stock, but you have ${item.quantity} in your cart.`;
    case "not_found":
      return "This product no longer exists. Please remove it from your cart.";
    default:
      return "";
  }
};

function Cart() {
  const { cart, loading, updating, error, updateCartItem, removeCartItem, clearCart, refreshCart } = useCart();
  const [notice, setNotice] = useState(null); // { type: "success" | "error", text }

  // Runs a cart change and shows the result. The context already reloads the cart if the server refused.
  const runAction = async (action, successText) => {
    setNotice(null);
    const result = await action();
    setNotice(result.ok ? { type: "success", text: successText } : { type: "error", text: result.message });
  };

  const handleQuantityChange = (item, newQuantity) =>
    runAction(() => updateCartItem(item.productId, newQuantity), `Quantity of "${item.name}" updated.`);

  const handleRemove = (item) =>
    runAction(() => removeCartItem(item.productId), `"${item.name}" was removed from your cart.`);

  const handleClear = () => {
    if (!window.confirm("Remove everything from your cart?")) return;
    runAction(() => clearCart(), "Your cart is now empty.");
  };

  const hasItems = cart.items.length > 0;

  // 1. First load
  if (loading && !hasItems) {
    return (
      <main className="container container-wide">
        <h1>Shopping Cart</h1>
        <p className="loading-text" role="status">
          Loading your cart...
        </p>
      </main>
    );
  }

  // 2. Could not load, and there is nothing to show
  if (error && !hasItems) {
    return (
      <main className="container container-wide">
        <h1>Shopping Cart</h1>
        <div className="message-box message-box-error" role="alert">
          <p>{error}</p>
          <button type="button" className="button" onClick={refreshCart}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  // 3. Empty cart
  if (!hasItems) {
    return (
      <main className="container container-wide">
        <h1>Shopping Cart</h1>
        {notice && (
          <p className={`status ${notice.type === "success" ? "status-ok" : "status-error"}`} role={notice.type === "success" ? "status" : "alert"}>
            {notice.text}
          </p>
        )}
        <div className="message-box">
          <p>Your cart is empty.</p>
          <Link to="/" className="button button-link">
            Continue Shopping
          </Link>
        </div>
      </main>
    );
  }

  // 4. The cart
  return (
    <main className="container container-wide">
      <h1>Shopping Cart</h1>

      {error && (
        <p className="status status-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={`status ${notice.type === "success" ? "status-ok" : "status-error"}`} role={notice.type === "success" ? "status" : "alert"}>
          {notice.text}
        </p>
      )}

      <div className="cart-layout">
        <ul className="cart-items">
          {cart.items.map((item) => {
            const problemText = getProblemText(item);
            const canAdjust = item.problem === null; // +/- only for lines that can be bought
            const maxQuantity = Math.min(MAX_QUANTITY, item.stock);
            const stockStatus = getStockStatus(item.stock);

            return (
              <li key={item.productId} className={`cart-item ${item.problem ? "cart-item-problem" : ""}`}>
                <ProductImage imageUrl={item.imageUrl} name={item.name} className="cart-item-image" />

                <div className="cart-item-info">
                  <h2 className="cart-item-name">
                    {item.isActive ? <Link to={`/products/${item.productId}`}>{item.name}</Link> : item.name}
                  </h2>
                  {item.problem !== "not_found" && <p className="cart-item-price">{formatPrice(item.price)} each</p>}
                  {!item.problem && <span className={`badge ${stockStatus.className}`}>{stockStatus.label}</span>}

                  {problemText && (
                    <p className="cart-item-warning" role="alert">
                      {problemText}
                    </p>
                  )}
                  {item.problem === "insufficient_stock" && (
                    <button
                      type="button"
                      className="button button-small button-secondary"
                      onClick={() => handleQuantityChange(item, item.stock)}
                      disabled={updating}
                    >
                      Change to {item.stock}
                    </button>
                  )}
                </div>

                <div className="cart-item-actions">
                  <QuantityControls
                    productName={item.name}
                    quantity={item.quantity}
                    max={maxQuantity}
                    disabled={updating || !canAdjust}
                    onChange={(newQuantity) => handleQuantityChange(item, newQuantity)}
                  />
                  {/* a line that cannot be bought is not part of the subtotal, so its total is struck through */}
                  <p className={`cart-item-total ${item.problem ? "cart-item-total-excluded" : ""}`}>
                    <span className="visually-hidden">Line total: </span>
                    {item.problem === "not_found" ? "-" : formatPrice(item.lineTotal)}
                  </p>
                  <button
                    type="button"
                    className="button button-small button-danger"
                    onClick={() => handleRemove(item)}
                    disabled={updating}
                    aria-label={`Remove ${item.name} from cart`}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <aside className="cart-summary" aria-label="Order summary">
          <h2>Summary</h2>
          <div className="summary-row">
            <span>Subtotal</span>
            <strong>{formatPrice(cart.subtotal)}</strong>
          </div>
          <p className="summary-label">
            {cart.itemCount} {cart.itemCount === 1 ? "item" : "items"} in your cart
          </p>

          {cart.hasProblems && (
            <p className="cart-summary-warning" role="alert">
              Some items need your attention and are not included in the subtotal.
            </p>
          )}

          {cart.hasProblems ? (
            <>
              <button type="button" className="button" disabled aria-describedby="checkout-note">
                Proceed to Checkout
              </button>
              <p id="checkout-note" className="cart-summary-note">
                Please fix the items that need attention first.
              </p>
            </>
          ) : (
            <Link to="/checkout" className="button button-link">
              Proceed to Checkout
            </Link>
          )}

          <Link to="/" className="button button-link button-secondary">
            Continue Shopping
          </Link>
          <button type="button" className="button button-secondary" onClick={handleClear} disabled={updating}>
            Clear Cart
          </button>
        </aside>
      </div>
    </main>
  );
}

export default Cart;
