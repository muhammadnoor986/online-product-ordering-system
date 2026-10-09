import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { assertProductionApiUrl } from "./config/validateApiUrl.js";

export default defineConfig(({ command, mode }) => {
  // A production build refuses to continue without a valid VITE_API_URL (see config/validateApiUrl.js).
  // `npm run dev` is not affected.
  const envDir = fileURLToPath(new URL(".", import.meta.url));
  assertProductionApiUrl({ command, mode, env: loadEnv(mode, envDir, "VITE_") });

  return {
    plugins: [react()],
    server: { port: 5173 },
  };
});
