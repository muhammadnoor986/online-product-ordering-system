import axios from "axios";

// One shared Axios instance. Every API call in the app will use this.
const axiosClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:5000/api",
  timeout: 10000,
});

export default axiosClient;
