import { useEffect, useState } from "react";
import axiosClient from "../api/axiosClient.js";

function HealthPage() {
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const response = await axiosClient.get("/health");
        setHealth(response.data);
      } catch (error) {
        // The API may answer with an error body (e.g. 503), or not answer at all
        if (error.response) {
          setHealth(error.response.data);
        } else {
          setErrorMessage("Cannot reach the API. Is the backend running?");
        }
      } finally {
        setLoading(false);
      }
    };

    checkHealth();
  }, []);

  return (
    <main className="container">
      <h1>Online Product Ordering</h1>
      <h2>API status</h2>

      {loading && <p>Checking API...</p>}

      {errorMessage && <p className="status status-error">{errorMessage}</p>}

      {health && (
        <div className={`status ${health.status === "ok" ? "status-ok" : "status-error"}`}>
          <p>{health.message}</p>
          <p>Database: {health.database}</p>
        </div>
      )}
    </main>
  );
}

export default HealthPage;
