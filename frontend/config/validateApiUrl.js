// Build-time check of VITE_API_URL, used by vite.config.js.
//
// Why: the app falls back to http://localhost:5000/api when VITE_API_URL is not set (src/api/axiosClient.js). That is right on
// your own computer, but a production build that quietly keeps this fallback would ship a site whose every request goes to
// the visitor's OWN computer. Vite puts VITE_API_URL into the files at build time, so the only place to catch a missing or
// wrong value is the build itself. This runs for `vite build` in production mode only: `npm run dev` and builds made with
// another mode (for example `npm run build -- --mode development`) are not checked.
//
// Pure functions, no Vite and no file access, so they are easy to test.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

// Returns "" when the value is fine for a production build, otherwise ONE sentence that says what is wrong.
// The value itself is never put into the message (it could contain a password by mistake).
const checkApiUrl = (value) => {
  if (typeof value !== "string" || value.trim() === "") {
    return "VITE_API_URL is not set. Set it to the address of your deployed API, for example https://your-api.example.com/api";
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch (error) {
    return "VITE_API_URL is not a valid web address. It must look like https://your-api.example.com/api";
  }

  if (url.protocol !== "https:") {
    return "VITE_API_URL must start with https:// in a production build (a plain http:// site would send logins and tokens unprotected, and browsers block it from an https:// page)";
  }
  if (LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return "VITE_API_URL points to this computer (localhost). A production build needs the address of the deployed API";
  }
  if (url.username || url.password) {
    return "VITE_API_URL must not contain a user name or password: it is written into the public files of the site";
  }
  if (url.search || url.hash) {
    return "VITE_API_URL must be only the API address, without ? or # parts";
  }
  return "";
};

// Throws a clear error when this is a production build and VITE_API_URL is missing or wrong.
//   command  "build" or "serve" (what Vite is doing)
//   mode     "production" for a normal `vite build`
//   env      the VITE_ settings (Vite's loadEnv result)
const assertProductionApiUrl = ({ command, mode, env }) => {
  if (command !== "build" || mode !== "production") return;
  const problem = checkApiUrl(env && env.VITE_API_URL);
  if (problem) {
    throw new Error(
      `The production build was stopped: ${problem}.\n` +
        "Set VITE_API_URL where the build runs (on Vercel: Project Settings > Environment Variables of the frontend project) and build again.\n" +
        "For a local test build that talks to a local API, use: npm run build -- --mode development"
    );
  }
};

export { checkApiUrl, assertProductionApiUrl };
