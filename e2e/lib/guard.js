// The safety rules of the E2E tests. Nothing here talks to a database or starts a process:
// these are small pure functions, so every rule can be read (and tested) on its own.
//
// The most important rule: the E2E tests only ever use a database that
//   * has "test" in its name,
//   * is NOT the development database, and
//   * was created for this run (its name follows RUN_DATABASE_PATTERN).

// The ports of the normal development servers. The E2E servers must never use them.
const DEVELOPMENT_PORTS = [5000, 5173];

// online_production_test_e2e_<time>_<random>, for example online_production_test_e2e_mgx4k2_a1b2c3
const RUN_DATABASE_PATTERN = /^online_production_test_e2e_[a-z0-9]+_[a-z0-9]+$/;

// MongoDB uses the database "test" when the connection string does not name one.
const MONGODB_DEFAULT_DATABASE = "test";

const MONGODB_URI_PARTS = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/i;

// The database a connection string points to (the name after the host), or MongoDB's default
const databaseNameOf = (uri) => {
  const match = MONGODB_URI_PARTS.exec(String(uri || "").trim());
  if (!match) return MONGODB_DEFAULT_DATABASE;
  const name = (match[2] || "").replace(/^\//, "");
  return name ? decodeURIComponent(name) : MONGODB_DEFAULT_DATABASE;
};

// The same connection string, but pointing at another database
const withDatabase = (uri, name) => {
  const match = MONGODB_URI_PARTS.exec(String(uri || "").trim());
  if (!match) throw new Error("The MongoDB connection string has an unexpected format (it must start with mongodb:// or mongodb+srv://).");
  return `${match[1]}/${name}${match[3] || ""}`;
};

// Throws unless `name` may be used for E2E data: it contains "test" and is not a development database.
const assertSafeTestDatabase = (name, developmentNames = []) => {
  if (typeof name !== "string" || name === "") {
    throw new Error("E2E safety check failed: no database name.");
  }
  if (!/test/i.test(name)) {
    throw new Error(`E2E safety check failed: the database name "${name}" does not contain "test".`);
  }
  if (developmentNames.includes(name)) {
    throw new Error(`E2E safety check failed: "${name}" is the development database.`);
  }
};

// The strictest check, used before anything is written or dropped: the name must also be one
// of the per-run databases that the E2E runner creates itself.
const assertRunDatabase = (name, developmentNames = []) => {
  assertSafeTestDatabase(name, developmentNames);
  if (!RUN_DATABASE_PATTERN.test(name)) {
    throw new Error(`E2E safety check failed: "${name}" is not a database created by the E2E runner.`);
  }
};

// Throws when a URL points at a development server port (or has no usable port)
const assertNotDevelopmentServer = (url, label) => {
  const port = Number(new URL(url).port);
  if (!port || DEVELOPMENT_PORTS.includes(port)) {
    throw new Error(`E2E safety check failed: ${label} must not use the development port ${port || "(none)"}.`);
  }
};

// Reads KEY=value lines (the .env format) WITHOUT putting anything into process.env.
const parseEnvFile = (text) => {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
};

// Hides secrets in text that is about to be printed: the exact secret values you pass in,
// any MongoDB connection string, and bearer tokens.
const redact = (text, secrets = []) => {
  let result = String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 6) result = result.split(secret).join("[hidden]");
  }
  return result
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "mongodb://[hidden]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/g, "Bearer [hidden]");
};

module.exports = {
  DEVELOPMENT_PORTS,
  RUN_DATABASE_PATTERN,
  databaseNameOf,
  withDatabase,
  assertSafeTestDatabase,
  assertRunDatabase,
  assertNotDevelopmentServer,
  parseEnvFile,
  redact,
};
