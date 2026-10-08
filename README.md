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
npm test        # 380 backend tests (one is skipped on Windows)
cd ../frontend
npm test        # 37 frontend tests (pure functions)
```

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
  If MongoDB itself cannot be reached the API still starts, so `/api/health` can report the problem; fix the connection and restart.
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
- The checks that exercise the shop in a real browser are not part of this repository yet, and there is no automatic test run (CI).
- Online payments, e-mail and image uploads (products use image addresses) are not built.

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
| `VITE_API_URL` | API base URL (default `http://localhost:5000/api`) |

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
