import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useCart } from "../context/CartContext.jsx";

// The one "Add to Cart" button, used on the product cards and on the product page.
// All cart work happens in CartContext; this component only decides what to show.
function AddToCartButton({ product, quantity = 1 }) {
  const navigate = useNavigate();
  const { isAuthenticated, user } = useAuth();
  const { cart, addToCart, updating } = useCart();

  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type: "success" | "error", text }

  // The "added" message disappears by itself
  useEffect(() => {
    if (!feedback || feedback.type !== "success") return undefined;
    const timer = setTimeout(() => setFeedback(null), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);

  // Only customers shop. Admins never see the button.
  if (isAuthenticated && user.role !== "customer") {
    return null;
  }

  const unavailable = product.isActive === false || product.stock <= 0;
  // How many of this product are already in the cart (only a hint: the server decides)
  const inCart = cart.items.find((item) => item.productId === product._id)?.quantity ?? 0;
  const atLimit = !unavailable && inCart + quantity > product.stock;

  let label = "Add to Cart";
  if (unavailable) label = "Out of stock";
  else if (atLimit) label = "Maximum in cart";
  else if (adding) label = "Adding...";

  const handleClick = async () => {
    // Not logged in: go and log in, without calling the cart API
    if (!isAuthenticated) {
      navigate("/login");
      return;
    }

    setFeedback(null);
    setAdding(true);
    const result = await addToCart(product._id, quantity);
    setAdding(false);

    if (result.ok) {
      setFeedback({ type: "success", text: "Added to cart." });
    } else if (result.status === 401) {
      navigate("/login"); // the session had expired
    } else {
      setFeedback({ type: "error", text: result.message });
    }
  };

  return (
    <div className="add-to-cart">
      <button
        type="button"
        className="button"
        onClick={handleClick}
        disabled={unavailable || atLimit || adding || updating}
      >
        {label}
      </button>

      {feedback && feedback.type === "success" && (
        <p className="add-to-cart-message add-to-cart-success" role="status">
          {feedback.text} <Link to="/cart">View cart</Link>
        </p>
      )}
      {feedback && feedback.type === "error" && (
        <p className="add-to-cart-message add-to-cart-error" role="alert">
          {feedback.text}
        </p>
      )}
    </div>
  );
}

export default AddToCartButton;
