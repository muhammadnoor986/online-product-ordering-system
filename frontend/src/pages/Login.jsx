import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const handleSubmit = async (event) => {
    event.preventDefault();
    setErrorMessage("");
    setSubmitting(true);

    try {
      await login(email, password);
      navigate("/");
    } catch (error) {
      if (error.response?.status === 429) {
        // Too many wrong passwords for this e-mail: the server says how long to wait
        setErrorMessage(error.response.data?.message || "Too many failed attempts. Please wait a while and try again.");
      } else {
        setErrorMessage(
          error.response?.data?.message || "Cannot reach the server. Please try again."
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="container">
      <form className="form-card" onSubmit={handleSubmit}>
        <h1>Login</h1>

        {errorMessage && <p className="status status-error">{errorMessage}</p>}

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />

        <button type="submit" className="button" disabled={submitting}>
          {submitting ? "Logging in..." : "Login"}
        </button>

        <p>
          No account yet? <Link to="/signup">Sign up</Link>
        </p>
      </form>
    </main>
  );
}

export default Login;
