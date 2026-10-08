import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useCart } from "../context/CartContext.jsx";

function Navbar() {
  const { user, isAuthenticated, logout } = useAuth();
  const { cart } = useCart();
  const isCustomer = isAuthenticated && user.role === "customer";

  return (
    <header className="navbar">
      <Link to="/" className="navbar-brand">
        Online Ordering
      </Link>

      <nav className="navbar-links">
        <Link to="/">Products</Link>
        {isCustomer && (
          <>
            <Link
              to="/cart"
              aria-label={cart.itemCount > 0 ? `Cart, ${cart.itemCount} ${cart.itemCount === 1 ? "item" : "items"}` : "Cart"}
            >
              Cart{cart.itemCount > 0 ? ` (${cart.itemCount})` : ""}
            </Link>
            <Link to="/orders">My Orders</Link>
          </>
        )}
        {isAuthenticated && user.role === "admin" && (
          <>
            <Link to="/admin/products">Admin Products</Link>
            <Link to="/admin/categories">Admin Categories</Link>
          </>
        )}
        {isAuthenticated ? (
          <>
            <span className="navbar-user">
              {user.name} ({user.role})
            </span>
            <button type="button" className="button button-small" onClick={logout}>
              Logout
            </button>
          </>
        ) : (
          <>
            <Link to="/login">Login</Link>
            <Link to="/signup">Sign up</Link>
          </>
        )}
      </nav>
    </header>
  );
}

export default Navbar;
