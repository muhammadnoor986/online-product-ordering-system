import { createContext, useContext, useEffect, useRef, useState } from "react";
import axiosClient from "../api/axiosClient.js";
import getErrorMessage from "../utils/getErrorMessage.js";
import { useAuth } from "./AuthContext.jsx";

const CartContext = createContext(null);

const EMPTY_CART = { items: [], itemCount: 0, subtotal: 0, hasProblems: false };

// Turns an Axios error into a message that is safe to show. Server messages for
// "not enough stock" and similar are already written for people, so we show them;
// our own server errors (5xx) get a generic message.
const toFriendlyMessage = (error, fallbackMessage) => {
  if (error.response && error.response.status >= 500) {
    return "Something went wrong on our side. Please try again.";
  }
  return getErrorMessage(error, fallbackMessage);
};

// The cart lives here, in ONE place. Pages ask this context for the cart and never keep
// their own copy. Every number shown (prices, line totals, subtotal) comes from the server.
//
// Only a logged-in CUSTOMER has a cart. Anonymous visitors and admins never trigger a cart request.
export function CartProvider({ children }) {
  const { user, isAuthenticated, logout } = useAuth();
  const customerId = isAuthenticated && user.role === "customer" ? user._id : null;

  // The cart is stored together with the id of the customer it belongs to. If somebody else
  // logs in, the stored cart no longer matches and is never shown (so carts cannot leak).
  const [stored, setStored] = useState({ ownerId: null, cart: EMPTY_CART });
  const [fetching, setFetching] = useState(false); // a cart is being loaded from the server
  const [updating, setUpdating] = useState(false); // a change (add / update / remove / clear) is in progress
  const [error, setError] = useState(""); // problem while LOADING the cart

  // Always holds the id of the customer who is logged in right now. Answers that arrive
  // after a logout or a user switch are checked against it and thrown away.
  const customerIdRef = useRef(customerId);
  const latestLoadRef = useRef(0);
  useEffect(() => {
    customerIdRef.current = customerId;
  }, [customerId]);

  const cart = customerId && stored.ownerId === customerId ? stored.cart : EMPTY_CART;
  // true until the first answer (or error) for this customer has arrived
  const loading = fetching || Boolean(customerId && stored.ownerId !== customerId && !error);

  const storeCart = (ownerId, newCart) => {
    if (customerIdRef.current === ownerId) {
      setStored({ ownerId, cart: newCart });
    }
  };

  // Loads the cart from the server. `silent` = do not show the loading state (used to
  // quietly refresh after a change was refused).
  const fetchCart = async (ownerId, { silent = false } = {}) => {
    const loadId = ++latestLoadRef.current;
    if (!silent) {
      setError("");
      setFetching(true);
    }

    try {
      const response = await axiosClient.get("/cart");
      storeCart(ownerId, response.data.cart);
      return { ok: true };
    } catch (loadError) {
      if (customerIdRef.current !== ownerId) return { ok: false };
      if (loadError.response && loadError.response.status === 401) {
        logout(); // the saved login is no longer valid
        return { ok: false, message: "Your session has expired. Please log in again." };
      }
      const message = toFriendlyMessage(loadError, "Could not load your cart.");
      if (!silent) setError(message);
      return { ok: false, message };
    } finally {
      if (!silent && loadId === latestLoadRef.current) setFetching(false);
    }
  };

  // Load the cart when a customer logs in; forget it when they log out (or an admin / nobody is logged in)
  useEffect(() => {
    if (!customerId) {
      setStored({ ownerId: null, cart: EMPTY_CART });
      setFetching(false);
      setError("");
      return;
    }
    fetchCart(customerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // Runs one change to the cart. Always answers { ok, message, status } and never throws,
  // so the page decides how to show the result.
  const runChange = async (sendRequest, fallbackMessage) => {
    const ownerId = customerIdRef.current;
    if (!ownerId) {
      return { ok: false, status: 401, message: "Please log in as a customer to use the cart." };
    }

    setUpdating(true);
    try {
      const response = await sendRequest();
      storeCart(ownerId, response.data.cart); // the server sends back the whole updated cart
      return { ok: true, message: response.data.message };
    } catch (changeError) {
      const status = changeError.response ? changeError.response.status : undefined;

      if (status === 401) {
        logout();
        return { ok: false, status, message: "Your session has expired. Please log in again." };
      }
      if (status === 403) {
        return { ok: false, status, message: "Only customer accounts can use the cart." };
      }

      const message = toFriendlyMessage(changeError, fallbackMessage);
      // The server refused (for example: not enough stock now). Reload the cart so that what
      // is on screen is what the server really has.
      if (changeError.response) {
        await fetchCart(ownerId, { silent: true });
      }
      return { ok: false, status, message };
    } finally {
      setUpdating(false);
    }
  };

  const addToCart = (productId, quantity = 1) =>
    runChange(() => axiosClient.post("/cart/items", { productId, quantity }), "Could not add this product to your cart.");

  const updateCartItem = (productId, quantity) =>
    runChange(() => axiosClient.put(`/cart/items/${productId}`, { quantity }), "Could not update the quantity.");

  const removeCartItem = (productId) =>
    runChange(() => axiosClient.delete(`/cart/items/${productId}`), "Could not remove this item.");

  const clearCart = () => runChange(() => axiosClient.delete("/cart"), "Could not clear your cart.");

  const refreshCart = () => (customerIdRef.current ? fetchCart(customerIdRef.current) : Promise.resolve({ ok: false }));

  const value = {
    cart,
    loading,
    updating,
    error,
    addToCart,
    updateCartItem,
    removeCartItem,
    clearCart,
    refreshCart,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

// Shortcut: const { cart, addToCart } = useCart();
export function useCart() {
  return useContext(CartContext);
}
