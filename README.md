# Clinic Booking API

Appointment booking API built with Node.js, Express 5, and PostgreSQL, with a small web UI served by the same process.

- **Live app & API:** https://clinic-booking-api-kg0q.onrender.com
- **Repository:** https://github.com/Timrossid/clinic-booking-api

## Requirements

- Node.js 18+ (Node 20+ recommended; the test suite uses `node --test`)
- PostgreSQL
- Environment variables:
  - `DATABASE_URL` (required): PostgreSQL connection string
  - `API_KEY` (required): secret key expected in the `X-API-Key` request header
  - `PORT` (optional, default `3000`)

The server exits on startup if `DATABASE_URL` or `API_KEY` is missing. Tables are created/migrated automatically on boot.

## Run locally

```bash
npm install
DATABASE_URL="postgresql://user:pass@host:5432/dbname" API_KEY="your-secret-key" npm start
# open http://localhost:3000
```

## Authentication

Every API endpoint requires:

```http
X-API-Key: <your API key>
```

Missing or invalid keys return `401` with `{ "error": "unauthorized" }`.

The bundled web UI calls same-origin `/api/*` paths. A server-side middleware strips the `/api` prefix and injects `X-API-Key` from the server environment, so the key is never exposed to browser code.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/reset` | Replace all data with the provided `slots` array |
| `GET` | `/slots` | List slots (optional `?provider=` filter) with `available` flag |
| `POST` | `/demo-slots` | Append future demo slots without changing existing slots/bookings |
| `POST` | `/bookings` | Create a booking |
| `GET` | `/bookings?email=...` | List bookings for an email (cursor paginated) |
| `GET` | `/bookings/{id}` | Fetch one booking |
| `DELETE` | `/bookings/{id}` | Cancel a booking |

### `POST /reset`

Body:

```json
{
  "slots": [
    {
      "id": "s1",
      "provider": "Dr Ade",
      "start": "2026-12-10T09:00:00Z",
      "end": "2026-12-10T09:30:00Z"
    }
  ]
}
```

- `200` `{ "done": true }` on success
- `400` `{ "error": "invalid_slots" }` for an invalid payload

Resets slots, bookings, rate limits, and idempotency records.

### `GET /slots`

- Optional query: `provider`
- `200` `{ "slots": [ { "id", "provider", "start", "end", "available" } ] }`
- `available` is `false` when the slot has a confirmed booking

### `POST /demo-slots`

- `201` `{ "added": <number> }`
- Appends demo slots after the latest existing slot; does not remove bookings

### `POST /bookings`

Body:

```json
{
  "slot_id": "s1",
  "name": "Ada Lovelace",
  "email": "ada@example.com"
}
```

Optional header: `Idempotency-Key: <key>`

Success: `201` with the booking object

```json
{
  "id": "…",
  "slot_id": "s1",
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "status": "confirmed",
  "created_at": "2026-01-01T12:00:00.000Z"
}
```

Errors:
- `400` missing/invalid body, `slot_id`, `name`, or `email`
- `404` `{ "error": "slot not found" }`
- `409` `{ "error": "slot already booked" }`
- `409` `{ "error": "idempotency key reuse with different request" }` when the same `Idempotency-Key` is sent with a different booking payload
- `422` `{ "error": "slot is in the past" }`
- `429` `{ "error": "too many requests", "retry_after": <seconds> }` with a `Retry-After` header when an email exceeds 5 booking attempts in 60 seconds

Idempotency: repeating the same `Idempotency-Key` with the **same** request payload returns the original booking (`201`) without creating a duplicate.

### `GET /bookings`

- Required query: `email`
- Optional: `limit` (default `10`, allowed `1`–`50`), `cursor`
- `200` `{ "bookings": [ ... ], "next_cursor": "<id>" | null }`
- `400` for missing/invalid `email`, invalid `limit`, or an invalid cursor
- A cursor is only valid for the same `email` that owns the referenced booking

### `GET /bookings/{id}`

- `200` booking object
- `404` `{ "error": "booking not found" }`

### `DELETE /bookings/{id}`

- `200` cancelled booking object (`status: "cancelled"`)
- `404` `{ "error": "booking not found" }`
- `409` `{ "error": "already cancelled" }`

Cancellation is handled atomically so only one concurrent cancel request succeeds.

## Behaviour notes

- **Double-booking prevention:** confirmed bookings are protected by a partial unique index on `bookings(slot_id)` where `status = 'confirmed'`, with conflict handling to guarantee a single `201` under concurrency.
- **Idempotency:** keys are stored with the request payload (`slot_id`, `name`, normalized `email`) and replay only for identical requests; reuse with different data is rejected.
- **Rate limiting:** 5 booking attempts per email per 60-second window, enforced transactionally with a `Retry-After` response on `429`.
- **Pagination:** cursor-based (`next_cursor`), scoped to the requested email.
- **Persistence:** all state is stored in PostgreSQL and survives restarts/redeploys.

## Automated tests

The test suite covers all five assessment levels (reset/slots/booking flow, auth & validation, double-booking & cancellation, idempotency & pagination, rate limiting) plus cursor scoping, idempotency mismatch rejection, and concurrent cancellation.

```bash
npm install
DATABASE_URL="postgresql://user:pass@host:5432/dbname" \
API_KEY="your-secret-key" \
PORT=3011 \
npm start
# in another shell:
BASE_URL="http://127.0.0.1:3011" API_KEY="your-secret-key" npm test
```

Notes:
- `POST /reset` is **destructive** (it clears slots/bookings/rate-limits/idempotency). Run tests against a disposable/local database or a dedicated test environment, not against production data.
- `BASE_URL` defaults to `http://127.0.0.1:3011`.

### Latest test result

Run on 2026-11-15 against Node.js v24 and PostgreSQL 16 (local Docker container):

```text
✔ Level 1: reset, list slots, create booking, get booking
✔ Level 2: auth and validation errors
✔ Level 3: no double booking, cancellation frees slot, re-cancel conflict
✔ Level 4: idempotency replay, mismatch rejection, list and pagination
✔ Level 5: rate limit 5 per email per 60s with Retry-After
tests 5  pass 5  fail 0
```

Full output: [`docs/evidence/test-output.txt`](docs/evidence/test-output.txt).

## Evidence

All evidence lives in [`docs/evidence/`](docs/evidence/), with an index in [`docs/evidence/README.md`](docs/evidence/README.md).

| Screenshot | What it shows |
| --- | --- |
| [Live deployment](docs/evidence/screenshots/00-live-deployment-home.png) | Home page served from the Render URL above |
| [Home](docs/evidence/screenshots/01-home.png) | Landing page |
| [Booking wizard](docs/evidence/screenshots/02-booking.png) | Five-step booking flow using live `/api` slot data |
| [Appointments](docs/evidence/screenshots/03-appointments.png) | Look up and cancel an existing booking |
| [`GET /slots`](docs/evidence/screenshots/04-api-slots.png) | `200` with `available` flags |
| [`GET /bookings?email=`](docs/evidence/screenshots/05-api-bookings.png) | `200` cursor-paginated list |
| [`POST /bookings`](docs/evidence/screenshots/06-api-booking-idempotent-replay.png) | `201` replay for a repeated `Idempotency-Key` |
| [`POST /bookings` conflict](docs/evidence/screenshots/07-api-conflict-409.png) | `409 slot already booked` |
| [`GET /slots` unauthenticated](docs/evidence/screenshots/08-api-unauthorized-401.png) | `401 unauthorized` |

Regenerate the screenshots (needs a local server with seeded data):

```bash
npm install
npx playwright install chromium   # one-time browser download
BASE_URL="http://127.0.0.1:3011" API_KEY="your-secret-key" \
LIVE_URL="https://clinic-booking-api-kg0q.onrender.com" \
npm run screenshots
```

## Web app

Three static pages are served from `public/` on the same origin as the API:

| Page | Path |
| --- | --- |
| Home (hero, services, how it works, trust) | `/` |
| Five-step booking wizard | `/book.html` |
| Look up, check, or cancel bookings | `/appointments.html` |

No build step. The UI uses live `/api/*` data (no hardcoded appointment data) and the server injects the API key; the browser never receives it.

## Deploy (Render)

`Dockerfile` and `render.yaml` are included.

- `DATABASE_URL` is wired from the `clinic-booking-db` blueprint database.
- `API_KEY` is marked `sync: false` in `render.yaml` — set/rotate it in the Render service environment (or via the Render API) and **never commit a real key**. After changing `API_KEY`, redeploy so the running instance picks it up.
- Health check path: `/`

The live deployment is https://clinic-booking-api-kg0q.onrender.com.
