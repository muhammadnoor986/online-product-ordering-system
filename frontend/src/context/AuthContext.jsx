import { createContext, useContext, useEffect, useState } from "react";
import axiosClient from "../api/axiosClient.js";

const AuthContext = createContext(null);

// Reads saved login data from the browser (returns nulls if none or corrupted)
const loadSavedAuth = () => {
  try {
    const token = localStorage.getItem("token");
    const user = JSON.parse(localStorage.getItem("user"));
    return token && user ? { token, user } : { token: null, user: null };
  } catch (error) {
    return { token: null, user: null };
  }
};

export function AuthProvider({ children }) {
  const saved = loadSavedAuth();
  const [user, setUser] = useState(saved.user);
  const [token, setToken] = useState(saved.token);
  // true while we double-check a saved token with the server
  const [loading, setLoading] = useState(Boolean(saved.token));

  const saveAuth = (newToken, newUser) => {
    localStorage.setItem("token", newToken);
    localStorage.setItem("user", JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  };

  const logout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setToken(null);
    setUser(null);
  };

  // On page load, ask the server whether the saved token is still valid
  useEffect(() => {
    if (!saved.token) return;

    axiosClient
      .get("/auth/me")
      .then((response) => {
        localStorage.setItem("user", JSON.stringify(response.data.user));
        setUser(response.data.user);
      })
      .catch((error) => {
        // Only log out when the server says the token is bad (not if it is just offline)
        if (error.response && error.response.status === 401) {
          logout();
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (email, password) => {
    const response = await axiosClient.post("/auth/login", { email, password });
    saveAuth(response.data.token, response.data.user);
    return response.data.user;
  };

  const signup = async (name, email, password) => {
    const response = await axiosClient.post("/auth/signup", { name, email, password });
    saveAuth(response.data.token, response.data.user);
    return response.data.user;
  };

  // Changes the logged-in user's own name. The server answers with the saved user, which is
  // stored the same way as after login, so the navbar shows the new name straight away.
  // Errors are thrown to the caller (a 401 is handled there with logout(), like on the other pages).
  const updateUser = async (name) => {
    const response = await axiosClient.patch("/auth/me", { name });
    localStorage.setItem("user", JSON.stringify(response.data.user));
    setUser(response.data.user);
    return response.data.user;
  };

  // Changes the password. The server answers with a FRESH login token (all older tokens, on other
  // devices, stop working). It replaces the saved one, so this browser stays logged in.
  // Errors are thrown to the caller, which handles them (401 -> logout()).
  const changePassword = async (currentPassword, newPassword) => {
    const response = await axiosClient.post("/auth/change-password", { currentPassword, newPassword });
    saveAuth(response.data.token, response.data.user);
    return response.data.user;
  };

  const value = {
    user,
    token,
    isAuthenticated: Boolean(token && user),
    loading,
    login,
    signup,
    logout,
    updateUser,
    changePassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Shortcut: const { user, login } = useAuth();
export function useAuth() {
  return useContext(AuthContext);
}
