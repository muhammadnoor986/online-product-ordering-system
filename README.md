# Online Product Ordering System

An e-commerce app built step by step.

- **frontend/** – React + Vite + React Router + Axios
- **backend/** – Node.js + Express + Mongoose (MongoDB Atlas)

Current status: a working shop. Customers can browse products, keep a cart, check out (Cash on Delivery),
follow and cancel their orders, and manage their profile and password. Admins manage products, categories
and orders. Online payments are not built yet. The server checks its own configuration when it starts,
sends basic security headers, logs requests safely and shuts down cleanly (see "Production notes").

## Prerequisites

- **Node.js 20.19 or newer** (22.12 or newer also works). Older versions, including Node 18, do not work:
  the backend uses Mongoose 9 and the frontend uses Vite 8. Check with `node --version`.
- A MongoDB database: a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster, or a MongoDB you run yourself
  (for example `mongodb://127.0.0.1:27017/online_production`).

## 1. MongoDB Atlas setup

1. Create a free cluster in Atlas.
2. **Database Access** → add a database user (username + password).
3. **Network Access** → add your current IP address.
4. **Connect → Drivers** → copy the connection string.
5. Put your database name in it, e.g. `.../online_production?retryWrites=true&w=majority`.
   If your password has special characters (`@ : / ?`), URL-encode them.

## 2. Run the backend

```bash
cd backend
npm install
copy .env.example .env      # Windows (macOS/Linux: cp .env.example .env)
```

Open `backend/.env` and fill in your real values. This file is ignored by Git, so never commit it.
The two settings you **must** provide are:

- `MONGODB_URI` – your MongoDB connection string (it must start with `mongodb://` or `mongodb+srv://`).
- `JWT_SECRET` – a long random secret, **at least 32 characters**. The placeholder from `.env.example` is refused.
  Generate one with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

When the server starts it checks the whole configuration first. If something is wrong it prints **every** problem
(never the secret values) and stops with exit code 1, for example:

```
The server cannot start because backend/.env has problems:
  - JWT_SECRET is too short. Use at least 32 characters
  - PORT must be a whole number between 1 and 65535
Fix backend/.env (see backend/.env.example) and start the server again.
```

```bash
npm run dev
```

You should see `MongoDB connected` and `Server running on http://localhost:5000`.
Test it: open http://localhost:5000/api/health

### Authentication setup (Phase 2)

Add these to `backend/.env` (see `backend/.env.example`):

- `JWT_SECRET` – a long random string. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `JWT_EXPIRES_IN` – token lifetime, e.g. `1d`
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` – your first admin account

Then create the admin (safe to run again; it never creates a duplicate):

```bash
npm run seed:admin
```

Auth endpoints (the protected ones need `Authorization: Bearer <token>`):

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/signup` | create a customer account (new signups are always `customer`; only the seed script creates an `admin`) |
| `POST /api/auth/login` | log in, returns a token |
| `GET /api/auth/me` | the logged-in user |
| `PATCH /api/auth/me` | change **your own name**: body `{ "name": "..." }`. Any other field is refused (400). |
| `POST /api/auth/change-password` | body `{ "currentPassword": "...", "newPassword": "..." }` (see below) |

### Account security (Phase 7C and 8)

- **Profile**: the name in the menu opens `/profile` (customers and admins). Only the name can be edited. Email and role cannot be changed.
  Old orders keep the name they were placed with.
- **Changing the password** needs the current password. The new one must be at least 8 characters (at most 72 bytes) and different from the current one.
  Passwords that already exist, even if shorter, keep working for login. The 8-character rule is only for new passwords.
- **Other devices are signed out.** Every login token carries a "token version" (`tv`). A password change raises the user's `tokenVersion`,
  so every older token stops working (401). The browser that changed the password receives a fresh token and stays logged in.
  Tokens made before this feature have no `tv` and count as version 0, so nobody is logged out by the upgrade.
- **Too many wrong passwords are slowed down.** After **10 failed attempts within 15 minutes** for the same IP + e-mail,
  `POST /api/auth/login` and `POST /api/auth/change-password` answer `429` (with a `Retry-After` header), even if the right password is then used.
  A successful login or password change resets the counter.
  **Limitation:** the counters live in the memory of one server process. They are lost on restart and are not shared between several server
  instances, so this is **not enough for a production deployment with more than one instance** (a shared store such as Redis would be needed).
  One IP trying many different e-mails is also not slowed down by this limiter.

### Cart API (Phase 4A)

All cart endpoints need a logged-in **customer** (admins get 403). The cart belongs to the logged-in user; ids are never taken from the request.

| Endpoint | Purpose |
|---|---|
| `GET /api/cart` | the cart with current product data, line totals, subtotal and per-item `problem` flags |
| `POST /api/cart/items` | add `{ "productId": "...", "quantity": 1 }` (adds to the quantity if already in the cart) |
| `PUT /api/cart/items/:productId` | set `{ "quantity": 2 }` |
| `DELETE /api/cart/items/:productId` | remove one product |
| `DELETE /api/cart` | clear the cart |

### Orders and checkout API (Phase 4B)

Customer-only (admins get 403, logged-out users get 401). A customer only ever sees their own orders.

| Endpoint | Purpose |
|---|---|
| `POST /api/orders` | checkout: turns the cart into an order (see the body below) |
| `GET /api/orders` | my orders, newest first (`?page=`, `?limit=` up to 50, `?status=`); no phone or address in the list |
| `GET /api/orders/:id` | one of my orders, with delivery details and status history |
| `POST /api/orders/:id/cancel` | cancel my order while it is `pending` (the stock is given back) |

Checkout body (everything else is ignored; prices, totals, status and payment are always set by the server):

```json
{
  "delivery": {
    "fullName": "Ayesha Khan", "phone": "+92 300 1234567",
    "addressLine1": "House 12, Street 5", "addressLine2": "", "city": "Lahore",
    "postalCode": "54000", "notes": ""
  },
  "paymentMethod": "cod",
  "expectedTotal": 801.77
}
```

- `paymentMethod` must be `"cod"` (cash on delivery) for now. COD orders start with `paymentStatus: "pending"`.
- `expectedTotal` is optional: the total the customer saw. If prices changed meanwhile the API answers `409` with the new total instead of placing the order.
- Shipping is Rs. 0, so `total = subtotal`.
- Stock is taken when the order is placed, and given back when a pending order is cancelled. If any product is inactive, missing or short of stock the whole checkout fails with `409` and a `details` list, and nothing is deducted.
- Order statuses: `pending → confirmed → processing → shipped → delivered`, or `cancelled`. Customers can only cancel while `pending`.
- Order numbers look like `ORD-20261007-K7QX2M` and are generated by the server.

### Admin orders API (Phase 5)

Admin-only (customers get 403, logged-out users get 401). An admin sees the orders of **all** customers.

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/orders` | list orders (see the query options below) |
| `GET /api/admin/orders/:id` | the full order: customer, delivery details, items, payment, status history (with who changed it) |
| `PATCH /api/admin/orders/:id/status` | move the order **one step forward**: body `{ "status": "confirmed", "note": "optional" }` |
| `POST /api/admin/orders/:id/cancel` | cancel the order and give its stock back: body `{ "note": "optional" }` |

**List options** (all optional): `page`, `limit` (default 10, at most 50), `status`, `paymentStatus`, `search`, `sort` (`newest` is the default, or `oldest`).
- `search` finds orders by order number, customer name, customer e-mail, delivery name or phone (capital letters do not matter; a phone number is found with or without spaces and dashes). It is limited to 100 characters.
- The answer also has `statusCounts`: how many orders there are in each of the six statuses for the same search. The `status` filter itself is ignored there, so filter tabs can keep their numbers.

**Status rules** (one step at a time, nothing else is accepted):

```
pending -> confirmed -> processing -> shipped -> delivered
```

- You cannot skip a step, go backwards, repeat a status, or change a `delivered` or `cancelled` order (answer `409`).
- Cancelling is only possible from `pending`, `confirmed` or `processing`, and only through the cancel endpoint. The stock goes back **exactly once**. If the stock of some product could not be restored (for example the product was deleted), the order is still cancelled and the answer lists it in `warnings` so you can fix the stock by hand.
- **Cash on Delivery:** the payment status changes from `pending` to `paid` at the same moment the order becomes `delivered`, in one atomic step. A cancelled order stays unpaid.
- Two people changing the same order at the same moment: one wins, the other gets `409` (and the order is never changed twice).
- A `note` (up to 300 characters, no control characters) is kept in the status history together with the admin who made the change.
- Prices, totals, items, customer, delivery details and the payment status can never be edited through these endpoints.

### Admin orders screens (Phase 6)

Log in as the admin and open **Admin Orders** in the menu (`/admin/orders`). Customers never see these links, and the API refuses them anyway.

- **List**: status tabs with counts, search (order number, customer, e-mail, phone), payment filter (All / Pending / Paid), sort (newest or oldest) and pages of 10. Your choices are kept in the address, so the Back button and a reload return to the same view.
- **Order page** (`/admin/orders/:id`): items, summary, customer, delivery details and the status history (who changed it, and the note).
- **Update order**: the buttons come from the server (`allowedNextStatuses` and `canCancel`), so the status rules live only in the backend. Every change asks for a confirmation with an optional note (up to 300 characters). Cancelling warns that the stock goes back to the shop. If some stock could not be restored, a yellow notice lists the products to check by hand. That notice is shown once, right after cancelling.
- If someone else changes the order first, you get a message and the page reloads the current order.

### Editing product stock (admin)

Orders change stock all the time, so an admin form that was opened earlier may show an old number.
To change `stock` with `PUT /api/products/:id`, also send `previousStock` (the stock you saw):
`{ "stock": 20, "previousStock": 7 }`. If the real stock is no longer 7 the API answers `409` and changes nothing.
Leave `stock` out to edit other fields without touching it.

### Running the tests

```bash
cd backend
npm test        # the backend tests (latest verified local run: 411 tests, 410 passed, 1 skipped on Windows, 0 failed)
cd ../frontend
npm test        # the frontend tests (latest verified local run: 53 passed, 0 failed; pure functions and the Vercel rewrite file)
```

**Latest verified results (local runs on the Phase 11 branch, after the Vercel preparation changes):**

| Suite | Result |
|---|---|
| Backend (`npm test` in `backend/`) | 411 tests: **410 passed, 1 skipped, 0 failed** |
| Frontend (`npm test` in `frontend/`) | **53 passed, 0 failed** |
| End-to-end (`npm run test:e2e` from the repository root) | 12 suites, 111 test sections, **813 checks passed, 0 failed**; the runner's own cleanup completed |

The one skipped backend test is the real `SIGTERM` test: it sends an actual stop signal to the server process, which Windows cannot deliver, so it is skipped there (a separate test covers the same shutdown wiring on every operating system).

The backend run used a separate, uniquely named test database on a local MongoDB (never the development database), and the E2E runner created and dropped its own temporary database. Two of the backend files need no database at all and can be run alone: `node --test tests/dbStartup.test.js tests/serverless.test.js` (31 tests: the startup retry and the Vercel wiring).

**These are local test results only. The application has not been deployed to Vercel**, so how it behaves on Vercel (and on Atlas through the temporary network rule) is still unverified, and nothing here means the site is ready for real customers.
The backend tests include real-process checks of `server.js` (bad configuration exits with code 1; a good start logs safe request lines and shuts down
cleanly); they use the separate test database only. The one test that sends a real SIGTERM is skipped on Windows, which cannot deliver that signal.
The frontend tests check the browser's validators against the server's real validators, so the two cannot drift apart.
There is no React/DOM testing library. The real-browser checks used during development are scripts kept outside this repository.

The tests use Node's built-in test runner and run against a **separate database**
(`online_production_test` on the same MongoDB server), never your normal data.
You can change the name with `TEST_DB_NAME` in `backend/.env`, but the tests refuse to run
if the name does not contain "test" or equals your development database.
Test data is removed when the run finishes.

### Production notes (Phase 9)

- **Startup check.** `MONGODB_URI` and `JWT_SECRET` are required; `JWT_EXPIRES_IN` (like `1d`, `12h`, `30m`; a bare number is refused),
  `PORT`, `CLIENT_URL` (an address with no path and no trailing slash, because a trailing slash silently breaks CORS), `TRUST_PROXY`
  and `LOG_REQUESTS` are checked when set. The check lives in `backend/src/config/env.js` and runs only when `server.js` starts.
  If MongoDB cannot be reached when the server starts, it tries **5 times** (each try waits at most 10 seconds, with pauses of 1, 2, 4 and 8 seconds in between), then prints a safe message
  (never the connection string) and **stops with exit code 1** without listening, so a host that restarts failed processes can start it again. (On Vercel this file is not used: see "Deploying to Vercel".) It used to keep running without a database,
  which could never recover because Mongoose does not repeat the first connection. `/api/health` still reports `503` if the database connection is lost while the server is running.
- **Security headers.** Every API answer gets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`,
  and `X-Powered-By` is removed. Answers under `/api/auth` also get `Cache-Control: no-store`. This is a small, hand-written set, not a full
  hardening package: there is no HSTS or Content-Security-Policy, so serve the site over HTTPS through your host or reverse proxy.
- **Behind a reverse proxy: `TRUST_PROXY`.** The login and password limiters use the visitor's IP address. Behind a proxy every request seems to
  come from the proxy, so set `TRUST_PROXY` to the **number of proxies** in front of the server (usually `1`), or to a list of trusted proxy addresses.
  The default is `false`: the `X-Forwarded-For` header is ignored, so nobody can fake an address. Do not set it when visitors reach the API directly.
  The value `true` is refused on purpose, because it would trust whatever address a visitor claims.
- **Request log.** One line per request on the console, for example `GET /api/products 200 18ms`: only the method, the path, the status and the time.
  Never request bodies, headers, tokens, cookies, passwords or query strings. Switch it off with `LOG_REQUESTS=false`. There are no log files or rotation.
- **Clean shutdown.** On Ctrl+C (SIGINT) or a stop request (SIGTERM) the server stops taking new requests, lets running ones finish,
  closes the database connection and exits. If that takes longer than 10 seconds it exits anyway; a second Ctrl+C exits at once.
- **Database indexes.** Products have an index for the product list (active products, newest first) next to the category index. Orders, users, carts and
  categories already had theirs. Indexes are created by Mongoose when the server connects; this changes the database's structure, never its data.
- **Search and scale.** Product search and the admin order search match text with a case-insensitive pattern over several fields. That is fine for
  hundreds or a few thousand records, but such a search cannot use an index. With a much larger shop it would need a real search solution
  (for example MongoDB text or Atlas Search indexes).

**Known limitations**

- The login limiter keeps its counts in the memory of one server process (see "Account security"); several server instances need a shared store.
- There is no signup throttling and no e-mail verification or password reset.
- Twelve browser (E2E) suites are in this repository (see "End-to-end browser tests" below), but that work is still in progress: Phase 10 is not complete, and there is no automatic test run (CI).
- Online payments, e-mail and image uploads (products use image addresses) are not built.

### Deploying to Vercel (staging / demo, Vercel Hobby + MongoDB Atlas Free)

> **Status: prepared, not deployed.** Nothing has been deployed to Vercel or Atlas yet, and none of the Vercel steps below has been tried. The code side is covered by
> tests that need no Vercel account and no database (see "What was checked"), but it has **not** run on Vercel itself.
>
> **Decision recorded:** this demo uses Vercel Hobby (website and API), an Atlas Free database in a separate project, and a **temporary** Atlas `0.0.0.0/0` access-list entry (option B below), added only when you are ready to test. **Nothing has been created or configured yet:** no Atlas project, user or network rule, and no Vercel project.
>
> **This is a personal learning/demo setup, not production.** Vercel's Hobby plan is for **personal, non-commercial use only** (its fair-use rules say so), so it
> must **not** be treated as approved free hosting for a commercial shop. Taking real customers means a paid plan or another host, backups, monitoring and the other
> points in the project audit.

**What runs where**

| Part | Where | Notes |
|---|---|---|
| Website (React + Vite) | Vercel project **1**, Root Directory `frontend` | Vite is detected automatically (`npm run build`, output `dist`). `frontend/vercel.json` makes deep links work |
| API (Express) | Vercel project **2**, Root Directory `backend` | The Express app becomes **one Vercel Function**; no `vercel.json` is needed |
| Database | MongoDB **Atlas Free**, in a **separate Atlas project** made only for this deployment | Never your local database, never a connection string you use anywhere else |

Both Vercel projects are created from the **same GitHub repository**; each one only builds its own folder.

#### Your local data stays local
The deployed database is its **own** Atlas database and starts **empty**. Nothing from the MongoDB on your computer (the one you see in MongoDB Compass, such as the `test` database with
your accounts and orders) will appear there. Nothing in this repository copies, exports or seeds data. Getting local data onto the deployment would be a separate, deliberate step
(for example `mongodump` and `mongorestore`, with the target checked first), and you should think twice before copying real people's data. **Never** use `localhost` or
`mongodb://localhost:27017` as a hosted setting: on Vercel that address is Vercel's own machine, which has no database.

#### How the API works on Vercel (what the code does)
- On your computer, `npm start` runs `src/server.js`: it connects to MongoDB (5 tries), then listens. That is unchanged.
- Vercel starts no server. It loads `backend/src/app.js` (the Express app, exported with `module.exports`; Vercel's docs list `src/app.js` among the files it looks for) and
  calls it for each request. When Vercel runs it (Vercel sets `VERCEL=1`), `app.js` adds one small step in front of the routes (`src/utils/ensureDatabase.js`):
  - the first request of a function instance **connects** to MongoDB; every later request **reuses** that connection, and requests that arrive meanwhile share the same attempt;
  - the pool is small (5 connections) because every instance opens its own and a free Atlas cluster allows 500 connections in all;
  - if MongoDB cannot be reached, that request gets **HTTP 503** and the process keeps running; the next request tries again (nothing calls `process.exit`);
  - the settings are checked once; a missing or wrong `MONGODB_URI`, `JWT_SECRET` or `CLIENT_URL` gives HTTP 503 and a log line naming the setting (never its value).
- If Vercel were to start `src/server.js` instead of `src/app.js`, the API would still work (that file connects first, then listens), but check the build log (Step 2) to see which file it uses.

#### The database network question (Atlas Network Access)
Atlas only accepts connections from addresses on its **IP access list**. A Vercel Function does **not** have a fixed address (Vercel documents fixed outgoing addresses only as
**Static IPs, a Pro/Enterprise feature that costs $100/month per project plus data transfer**). So on the free plans the realistic options are:

| Option | Cost | Security | Verdict for this demo |
|---|---|---|---|
| **A. Allow `0.0.0.0/0`** ("access from anywhere") | free | The database **endpoint** is reachable from the whole internet. Only the database user's password (and TLS) protects it, so anyone can try to guess it or exploit a driver/server weakness. | Works with everything free, but it is a real exposure. **Not configured by default, and not recommended unless you consciously accept it.** If you do: strong random password, a user limited to the one deployment database, no real customer data, and remove the entry when the demo ends |
| **B. A temporary `0.0.0.0/0` entry** (Atlas lets an entry expire after a set time, up to 7 days) | free | Same exposure as A, but only until the entry expires. **It is not secure and not production-ready** | **Chosen for this personal demo.** The site loses database access when the entry expires, until you add a new entry |
| **C. Vercel Static IPs** | $100/month per project + transfer, Pro/Enterprise plan | Narrow allow list | Not free; **out of scope** |
| **D. Private endpoint / VPC peering** (Atlas) or Vercel Secure Compute | paid cluster tiers / Enterprise | Strongest | Not available on free tiers (as far as I can tell: check Atlas's pages); **out of scope** |
| **E. The MongoDB Atlas integration in the Vercel Marketplace** | "plans starting at $0" | Not documented where I could read it: **I could not confirm how it handles network access, and it would create its own Atlas account/cluster** | Check the integration's own guide before using it. Not used in this plan |
| **F. Host the API somewhere with fixed outgoing addresses** (for example Render's free web service, whose outbound ranges are shared per region) and keep Vercel for the website only | free (with its own limits) | Narrower than A, not a perfect lock | Would change this plan; ask before going this way |

**Chosen: option B**, for a temporary, personal learning/demo deployment only, with **no real customer data**. What that means in practice:
- **The risk:** while the entry exists, anyone on the internet can *try* to connect to your database endpoint. The database user's password and TLS are the only protection. Use a long random password and a user limited to the one demo database. Do not reuse that password anywhere.
- **Add it late, keep it short:** add the entry only when you are ready to test the deployed site, and choose the **shortest duration Atlas offers** at that moment (Atlas documents temporary entries as expiring within a limit of up to 7 days; the exact choices in its form were not checked here). If you finish earlier, delete the entry yourself instead of waiting for it to expire.
- **When it expires:** Atlas removes the entry and new connections from Vercel are refused. The API then answers **HTTP 503 "The database is not reachable right now"** (the Runtime Logs show `Database connection failed`) and the website's data screens show errors. Nothing is lost: add a new temporary entry and the next request reconnects. What happens to a connection that is already open at the moment of expiry is not documented here, so expect errors soon after.
- **Nothing about this makes the setup safe for real customers.** A permanent allow-from-anywhere rule, or this rule renewed again and again, would be the same exposure for longer.

#### Before you start
- A GitHub account with this repository, a Vercel account (Hobby) and an Atlas account. Do not add a payment method or start a trial. Check each provider's **current** free-plan terms yourself.
- **No real customer data.** Use only made-up accounts and products on the deployed demo, because its database is reachable from anywhere while the temporary rule exists.
- Use a **new Atlas project** and database user for this deployment (for example database name `online_production_staging`), with a new strong password.
- Never paste a connection string, password or secret into a file in this repository, into an issue or into a chat.

#### Step 1: the database (Atlas)
1. Create a **new Atlas project** and a free cluster in it. Choose a region near where the API will run.
2. **Database Access** → add a database user with a strong, new password, limited to **only the deployment database** (read and write on `online_production_staging`, not "Atlas admin").
3. Copy the connection string and put the database name in it (`.../online_production_staging?retryWrites=true&w=majority`). URL-encode special characters in the password and keep it private.
4. **Network Access:** do **not** add anything yet. When you are ready to test the deployed site (after Steps 2 and 3), add **one temporary** entry for `0.0.0.0/0` with the shortest expiry Atlas offers, as described above. Do not add a permanent entry. If you later switch to a narrower rule (a different host with fixed addresses, or a paid plan), remove this entry.

#### Step 2: the API project on Vercel
1. In Vercel choose **Add New → Project**, import this repository, and set **Root Directory** to `backend`. Vercel's Express support needs no other configuration.
2. **Node.js version:** `backend/package.json` says `>=20.19.0`; Vercel's documentation says such a range deploys the **newest 24.x**, and that `engines` overrides the project setting. This code was tested locally on Node 26 and
   not on 24, so read the build log (`node -v`) and check that the bcrypt module loads. This is not verified.
3. **Function region:** Settings → **Functions** → *Function Regions* (Hobby allows one region). Pick the one nearest to your Atlas cluster. The default is Washington, D.C.
4. **Environment Variables** (put the real values in Vercel's dashboard, never in Git; use the **Production** environment):

   | Variable | Value (placeholders only) |
   |---|---|
   | `MONGODB_URI` | the Atlas connection string from Step 1 (`mongodb+srv://...`), **never `localhost`** |
   | `JWT_SECRET` | a new random secret of at least 32 characters: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Do not reuse your local one |
   | `JWT_EXPIRES_IN` | `1d` |
   | `CLIENT_URL` | the exact address of the website, for example `https://<website-project>.vercel.app` (**no path, no slash at the end**). Set it after Step 3, then redeploy this project |
   | `TRUST_PROXY` | `1` (Vercel's proxy is in front of the API; check that the login limiter sees different visitors as different addresses) |
   | `LOG_REQUESTS` | `true` |

5. Deploy. Open `https://<api-project>.vercel.app/api/health`: it should show `"database":"connected"`. Check the **Runtime Logs** for lines starting with `The API is not configured correctly` or `Database connection failed`.
   Use the project's stable production address, not the per-deployment addresses, and test it in a private browser window: Hobby projects have Deployment Protection, which can put a login in front of some deployment URLs.

#### Step 3: the website project on Vercel
1. **Add New → Project**, import the **same** repository again and set **Root Directory** to `frontend`. Vite is detected (build `npm run build`, output `dist`).
2. **Environment Variable** `VITE_API_URL` = `https://<api-project>.vercel.app/api` (the API's address **with `/api`**). It is written into the site when it is **built**, so set it before the first build and
   **redeploy** after any change. A production build **stops with a clear message** if it is missing, not `https://`, points to `localhost` or contains a user name or password
   (`frontend/config/validateApiUrl.js`). Every non-production deployment that Vercel builds is also a production-mode build, so it needs the variable in the **Preview** environment too, or it fails by design.
3. `frontend/vercel.json` contains one rewrite (every path → `/index.html`), so `/orders`, `/admin/products` and other deep links work when opened directly or refreshed. Check by opening `/cart` directly.
4. Deploy, then put the website's address into `CLIENT_URL` on the API project and redeploy the API.

#### How the pieces must match (CORS and the API address)
- `CLIENT_URL` (on the API) must be **exactly** the website's address in the browser's address bar: same `https://`, same name, no trailing slash. The API refuses to run with a `CLIENT_URL` that has a slash or a path, and it refuses to run without one on Vercel.
- `VITE_API_URL` (on the website) must be the API's `https://` address **ending in `/api`**.
- A different address for the same project (a preview or per-deployment URL) is a different origin and is blocked until `CLIENT_URL` is changed to it. Use the project's production address.
- For a local test build use `npm run build -- --mode development` (not checked; uses the local API address by default).

#### Create the admin (only after the deployment is checked)
Do this **only** after the checks below pass. Vercel has no shell for this, so you run the seed on your own computer, pointing at the **deployed** database, and you must make sure it cannot touch your local database:
1. Open a terminal in an **empty folder** (not in `backend/`), so the seed script cannot read your local `backend/.env`.
2. Set the values only for this terminal (PowerShell, with your own placeholders replaced):
   ```powershell
   $env:MONGODB_URI = "<the Atlas connection string of the deployment database>"
   $env:ADMIN_EMAIL = "<admin e-mail>"
   $env:ADMIN_PASSWORD = "<a strong, new password>"
   $env:ADMIN_NAME = "Admin"
   ```
3. Check which database you are about to change, **before** running anything (this prints only the host and the database name, never the password):
   ```powershell
   node -e "const u=new URL(process.env.MONGODB_URI); console.log(u.host, u.pathname)"
   ```
   The host must be the Atlas cluster of the deployment and the name must be the deployment database. If it shows `localhost` or your normal database, stop.
4. Run it with the full path to the script: `node <path-to-this-repository>\backend\src\scripts\seedAdmin.js`. It prints `Admin created (...)`.
5. Close the terminal (this clears the values) and check that you can log in on the deployed site.

If the seed is started in the wrong folder, or without `MONGODB_URI`, it stops with an error instead of using another database.

#### Check the deployed site
Open the website address and go through this list. Tick nothing as done until you really saw it work:
1. `https://<api-project>.vercel.app/api/health` shows "API is working" and `"database":"connected"`.
2. The product list loads. (A new database is empty: create a category and a product as the admin, using an `https://` image address.)
3. Sign up as a customer, log out, log in, reload the page, and reload a deep link such as `/orders`.
4. Add a product to the cart and place an order with Cash on Delivery.
5. Log in as the admin, open the order and move it through the statuses; look at it again as the customer (timeline).
6. Cancel a pending order and check that the stock comes back.
7. In the browser's developer tools (Console and Network): no CORS errors, no "mixed content" warnings, and no request to `localhost`.

#### Deploys, rollback and recovery
- **Deploys are automatic.** Vercel builds every push to the connected branch(es): the Production Branch becomes the production deployment, other branches become preview deployments. Vercel's monorepo
  "skip unaffected projects" feature needs a package-manager workspace, which this repository is not, so both projects will normally build on each push. Choose the Production Branch deliberately,
  and use the projects' *Ignored Build Step* setting if you want to stop builds. (This was not tried.)
- **Rollback:** each deployment is kept, and Vercel's *Instant Rollback* can point the production address at an earlier deployment (Deployments list in the dashboard; check Vercel's current instructions).
- **API 503 "database is not reachable":** the connection string or the database user is wrong, the Atlas free cluster is paused, or (most likely with this plan) the **temporary network entry has expired**: add a new one, as described above. The reason is in the Runtime Logs (never the password).
- **API 503 "not configured correctly":** the log names the setting. Fix it in Vercel and redeploy (environment variable changes apply to new deployments only).
- **Every request fails in the browser (CORS):** `CLIENT_URL` is not exactly the website's address. **Requests go to the wrong place:** `VITE_API_URL` was wrong when the site was built; fix it and redeploy the website.
- **The deployed data is disposable.** Starting again means deleting the database in the deployment's own Atlas project, never anything else.

#### Limits of this setup (why it is not production)
- **Vercel Hobby is for personal, non-commercial use only**, with fixed free usage limits (at the time of writing: 1,000,000 function invocations, 4 hours of active CPU, 100 deployments per day,
  one function region) and no payment method. If you go over, features pause for about 30 days. A function can run for at most 5 minutes and a request or response body can be at most 4.5 MB.
- A function that has been idle starts slowly (a "cold start"): the first request also has to connect to the database.
- **The login limiter is per function instance and lives in memory.** Vercel may run many instances and restarts them, so the 10-attempts limit is much weaker than on a single server.
- A free Atlas cluster has 512 MB of storage, 500 connections, a limit on data transfer, **no automatic backups** (take a `mongodump` yourself if the data matters), and with this plan its network rule is a **temporary allow-from-anywhere entry** (see above): the site stops reaching the database when the entry expires.
- There is no custom domain, e-mail, monitoring or alerting.
- Prices and limits change: check Vercel's and Atlas's current pages before you rely on anything above.

#### What was checked, and what was not
- Checked (no database, no Vercel account): the serverless wiring (`backend/tests/serverless.test.js`), the startup retry (`backend/tests/dbStartup.test.js`), the production `VITE_API_URL` check
  and the rewrite file (`frontend/tests/`), and production builds with and without `VITE_API_URL`.
- The full backend, frontend and E2E suites were also run locally after these changes and passed (see "Running the tests" for the exact numbers). They run on your computer against local and throwaway test databases, so they say nothing about Vercel or Atlas.
- **Not checked:** a real Vercel build or deployment, which entry file Vercel picks, Node 24 on Vercel, `TRUST_PROXY=1` behind Vercel, Atlas network access, and Vercel Deployment Protection settings. **Nothing has been deployed.** If you change the code again before deploying, run the suites again.

### End-to-end browser tests (Phase 10, work in progress)

These tests open the real website in a headless Edge or Chrome and click through it. They are being moved
into this repository step by step: **so far twelve suites are migrated**. Admin orders screens: `step3List` (the orders list),
`step4Details` (one order's page), `step5Actions` (changing an order's status and cancelling it). Admin product and category screens:
`phase3cE2E` (who may open them, lists, forms, deactivating, failures, screen widths), `staleFormE2E` (the edit form never brings back sold stock). Customer screens:
`phase3bE2E` (the product listing, search, filters, paging, product details, sign up and login),
`step7aCancel` (cancelling your own order), `step7bTimeline` (the order progress timeline), `step7cProfile` (the profile page), `myOrdersE2E` (the My Orders list and its details links), `cartE2E` (the shopping cart), `checkoutE2E` (checkout and the order page, including lost answers and server refusals).
The checkout suite was migrated with state-based waits instead of the old sleeps (it waits for the cart count, the Place Order button,
the order page and the browser's own "network quiet" signal). **Phase 10 is still in progress**; it is not marked complete.
One check, `phase3cE2E` section G (failed requests), failed once in a complete run and has not failed since. It was made stricter
(it now waits for the page to settle and for the exact "Try again" button), but the cause was never reproduced, so it is **not** known to be
permanently fixed. If it fails again, the failure message shows the address, the page text and the latest API calls.

From the repository root, three shortcuts exist (they are defined in the root `package.json`):

```bash
npm run test:backend                # the backend tests (runs "npm test" in backend/)
npm run test:frontend               # the frontend tests (runs "npm test" in frontend/)
npm run test:e2e                    # all migrated browser suites (currently twelve)
npm run test:e2e -- step4Details    # only the suites whose file name contains this text
```

(Run it from the repository root. There is no `npm install` for this: it uses Node's built-in features and the
packages the backend and frontend already have.)

- **Needs:** Node.js 22 or newer, Microsoft Edge or Google Chrome (set `E2E_BROWSER` to the program's full path if it is not found automatically),
  the backend and frontend dependencies installed, and a running MongoDB server (the one in `backend/.env` is used, or set `E2E_MONGODB_URI`).
- **It never touches your development setup.** Every run starts its **own** backend and frontend on free ports (never 5000 or 5173),
  with a random JWT secret, and creates a **new** MongoDB database named `online_production_test_e2e_<id>` on the same server.
  That database (and the temporary browser profile) is deleted when the run ends. The runner refuses to continue if the database name
  does not contain "test", equals the development database, or is not one of its own per-run databases.
  Your `.env` is only read to find the MongoDB server; nothing is written to it.
- On a slow or very busy machine, `E2E_TIMEOUT_SCALE=3` (or more) multiplies every waiting limit. Waits still end as soon as their event happens.
- `E2E_SCREENSHOTS=1` saves screenshots into `e2e/artifacts/` (ignored by Git).
- **Cleanup limits.** A normal end, a failing test and Ctrl+C (`SIGINT`) or `SIGTERM` all stop the servers and browser, drop the run's
  database and remove the temporary folder. Cleanup is not guaranteed, though. If the runner itself is killed without warning (closing the
  terminal window, Task Manager, `taskkill /F`, a crash or power loss) nothing runs, and these can remain: the run's database
  `online_production_test_e2e_<id>`, a folder `online-e2e-...` in your temporary folder (browser profiles, nothing else), and possibly
  a backend, frontend or browser process of that run. A database that cannot be dropped, or a folder Windows still holds open,
  is reported at the end of the run; the folder is only a warning, so a run can still pass with a folder left behind.
- **Cleaning up a leftover test database.** The development database is never touched by a run, and it must never be dropped by hand.
  1. Make sure no E2E run is still going (otherwise end it with Ctrl+C) and that no leftover `node` or browser process of an old run is
     still running; a running backend keeps its database open.
  2. List the databases (for example `mongosh "<your connection string>" --eval "db.adminCommand({listDatabases:1,nameOnly:true}).databases.map(d=>d.name)"`).
     A name that matches **exactly** `online_production_test_e2e_<letters-and-digits>_<letters-and-digits>` is only a *candidate*.
     **Never drop a database because of its name alone.** These are protected and must never be dropped by hand: the development
     database (the one named in `backend/.env`, or MongoDB's default `test` when that file names none), the plain
     `online_production_test` database used by the backend tests, and any name you do not recognise or that does not match exactly.
  3. Before dropping a candidate, look inside it and confirm it holds only test data: its users should have e-mails such as
     `zze2e....@example.com`, and its products and categories should have names starting with `ZZE2E`. An empty database is fine.
     If anything looks like real data, or you are unsure, stop and do not drop it.
  4. Drop only that one database. Open a shell on exactly that database (`mongosh "<your connection string>/<that exact name>"`), run
     `db.getName()` and check that it prints the leftover's name, and only then run `db.dropDatabase()`.
  5. Delete the matching `online-e2e-*` folders in your temporary folder (`%TEMP%` on Windows). They only contain browser profiles,
     but close any browser still using them first.

  The runner uses the same rule before it drops anything, but this rule only checks the name: it cannot prove who created a database.
  Do not give other databases names of this form.

## 3. Run the frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The page shows whether the API and database are working.
The frontend `.env` is optional; the default API address is `http://localhost:5000/api`.

## Environment variables

Backend (`backend/.env`, template: `backend/.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | yes | MongoDB connection string (`mongodb://` or `mongodb+srv://`) |
| `JWT_SECRET` | yes | Signs login tokens. At least 32 characters, random, never shared. The example placeholder is refused |
| `JWT_EXPIRES_IN` | no (`1d`) | How long a login lasts: a number with a unit, like `30m`, `12h`, `1d` |
| `PORT` | no (`5000`) | API port, 1 to 65535 |
| `CLIENT_URL` | no (`http://localhost:5173`) | The one frontend address allowed by CORS. No path, no trailing slash |
| `TRUST_PROXY` | no (`false`) | Number of reverse proxies in front of the API (for example `1`), or a list of trusted proxy addresses. See "Production notes" |
| `LOG_REQUESTS` | no (`true`) | `false` switches the request log off |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | only for `npm run seed:admin` | The first admin account |
| `TEST_DB_NAME` | no (`online_production_test`) | Name of the separate test database (must contain "test") |

Frontend (`frontend/.env`, optional):

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | API base URL (default `http://localhost:5000/api` while developing; **required** for a production build, which stops without a valid `https://` address) |

## Folder structure

```
backend/src/
  config/        database connection, startup configuration check (env.js)
  constants/     order statuses (the one status table) and payment constants
  controllers/   route logic (auth, products, categories, cart, orders, admin orders)
  middleware/    login check, roles, error handling, failed-attempt limiter, security headers, request log
  models/        User, Category, Product, Cart, Order
  routes/        URL definitions
  services/      cart, order/checkout and stock logic
  scripts/       seedAdmin.js
  utils/         small helpers (query parsing, password rules, tokens, graceful shutdown, ...)
  app.js         Express setup
  server.js      starts the server
backend/tests/   automated tests (separate test database)
frontend/src/
  api/           shared Axios client
  components/    reusable parts (navbar, order timeline, action panels, forms, ...)
  context/       Auth and Cart state
  pages/         one file per page (pages/admin/ for the admin screens)
  utils/         display helpers and validators that mirror the server
  styles/        CSS
frontend/tests/  pure-function tests
```
