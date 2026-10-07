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
