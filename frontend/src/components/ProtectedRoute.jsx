import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

// Wrap a page with this to make it available only to logged-in users:
// <Route path="/x" element={<ProtectedRoute><SomePage /></ProtectedRoute>} />
//
// Add "adminOnly" to also require the admin role:
// <Route path="/admin/x" element={<ProtectedRoute adminOnly><AdminPage /></ProtectedRoute>} />
//
// Add "customerOnly" for pages that only customers use (like the cart). Admins are sent to "/".
// <Route path="/cart" element={<ProtectedRoute customerOnly><Cart /></ProtectedRoute>} />
//
// Note: this only controls what the page shows. The API itself also checks the role,
// so a customer cannot change data by calling the API directly.
function ProtectedRoute({ children, adminOnly = false, customerOnly = false }) {
  const { isAuthenticated, user, loading } = useAuth();

  if (loading) {
    return <p className="container">Loading...</p>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (adminOnly && user.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  if (customerOnly && user.role !== "customer") {
    return <Navigate to="/" replace />;
  }

  return children;
}

export default ProtectedRoute;
