# Clinic Booking API

Appointment booking API built with Node.js + Express 5 and SQLite (in-memory).
Includes a small web UI served from the same process.

## Run locally

```bash
npm install
API_KEY=test-key-123 node server.js
# open http://localhost:3000
```

`API_KEY` defaults to `clinic-book-api-key-2026` when unset. `PORT` defaults to `3000`.

## Endpoints

All endpoints require the header `X-API-Key: <key>`; missing/invalid keys return `401`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/reset` | Replace all data with the provided `slots` array |
| GET | `/slots` | List slots (optional `?provider=`) with `available` flag |
| POST | `/bookings` | Create a booking |
| GET | `/bookings?email=...` | List a user's bookings (cursor paginated) |
| GET | `/bookings/{id}` | Fetch one booking |
| DELETE | `/bookings/{id}` | Cancel a booking |

### POST /reset

```json
{ "slots": [ { "id": "s1", "provider": "Dr Ade",
               "start": "2026-12-10T09:00:00Z", "end": "2026-12-10T09:30:00Z" } ] }
```

Responds `{ "done": true }`.

### POST /bookings

```json
{ "slot_id": "s1", "name": "Ada Lovelace", "email": "ada@example.com" }
```

- `201` with the booking object on success
- `400` on missing/invalid fields
- `404` if the slot does not exist
- `409` if the slot is already booked
- `422` if the slot start time is in the past
- `429` with `Retry-After` when an email sends more than 5 booking requests in 60 seconds

Optional `Idempotency-Key` header: repeating the same key returns the original booking
instead of creating a new one.

### GET /bookings

`?email=` is required. `limit` defaults to 10 (1–50). Pass the returned `next_cursor`
as `cursor` to fetch the next page; `next_cursor` is `null` on the last page.

### DELETE /bookings/{id}

Returns the cancelled booking. Cancelling twice returns `409`.

## Behaviour notes

- Bookings are guarded by a unique check on confirmed bookings per slot, so concurrent
  requests for the same slot result in exactly one `201` and the rest `409`.
- Data lives in an in-memory SQLite database: it resets when the process restarts.
  For durable storage, swap `new Database(":memory:")` for a file path or external DB.

## Deploy

`Dockerfile` and `render.yaml` are included. On Render, create a Web Service from this
repo (or use the blueprint) and set the `API_KEY` environment variable.
