import { Routes, Route } from "react-router-dom";
import Navbar from "./components/Navbar.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import ProductList from "./pages/ProductList.jsx";
import ProductDetails from "./pages/ProductDetails.jsx";
import HealthPage from "./pages/HealthPage.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import AdminProducts from "./pages/admin/AdminProducts.jsx";
import AdminCategories from "./pages/admin/AdminCategories.jsx";

function App() {
  return (
    <>
      <Navbar />
      <Routes>
        <Route path="/" element={<ProductList />} />
        <Route path="/products/:id" element={<ProductDetails />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />

        <Route
          path="/admin/products"
          element={
            <ProtectedRoute adminOnly>
              <AdminProducts />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/categories"
          element={
            <ProtectedRoute adminOnly>
              <AdminCategories />
            </ProtectedRoute>
          }
        />
      </Routes>
    </>
  );
}

export default App;
