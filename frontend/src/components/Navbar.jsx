import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

function Navbar() {
  const { user, isAuthenticated, logout } = useAuth();

  return (
    <header className="navbar">
      <Link to="/" className="navbar-brand">
        Online Ordering
      </Link>

      <nav className="navbar-links">
        <Link to="/">Products</Link>
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
