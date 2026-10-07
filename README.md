# Online Product Ordering System

An e-commerce app built step by step.

- **frontend/** – React + Vite + React Router + Axios
- **backend/** – Node.js + Express + Mongoose (MongoDB Atlas)

Current status: **Phase 1** (project skeleton and health check only).

## Prerequisites

- Node.js 18 or newer
- A free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster

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

Open `backend/.env` and paste your real `MONGODB_URI`. This file is ignored by Git, so never commit it.

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

Auth endpoints: `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/auth/me` (needs `Authorization: Bearer <token>`).
New signups are always `customer`; only the seed script creates an `admin`.

### Cart API (Phase 4A)

All cart endpoints need a logged-in **customer** (admins get 403). The cart belongs to the logged-in user; ids are never taken from the request.

| Endpoint | Purpose |
|---|---|
| `GET /api/cart` | the cart with current product data, line totals, subtotal and per-item `problem` flags |
| `POST /api/cart/items` | add `{ "productId": "...", "quantity": 1 }` (adds to the quantity if already in the cart) |
| `PUT /api/cart/items/:productId` | set `{ "quantity": 2 }` |
| `DELETE /api/cart/items/:productId` | remove one product |
| `DELETE /api/cart` | clear the cart |

### Running the backend tests

```bash
cd backend
npm test
```

The tests use Node's built-in test runner and run against a **separate database**
(`online_production_test` on the same MongoDB server), never your normal data.
You can change the name with `TEST_DB_NAME` in `backend/.env`, but the tests refuse to run
if the name does not contain "test" or equals your development database.
Test data is removed when the run finishes.

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

| File | Variable | Purpose |
|---|---|---|
| backend/.env | `PORT` | API port (default 5000) |
| backend/.env | `MONGODB_URI` | Atlas connection string |
| backend/.env | `CLIENT_URL` | Allowed frontend origin for CORS |
| frontend/.env | `VITE_API_URL` | API base URL |

## Folder structure

```
backend/src/
  config/        database connection
  controllers/   route logic
  middleware/    error handling (auth comes in Phase 2)
  routes/        URL definitions
  app.js         Express setup
  server.js      starts the server
frontend/src/
  api/           shared Axios client
  pages/         one file per page
  styles/        CSS
```
