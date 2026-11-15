# Submission evidence

Clinic Booking API — appointment booking API (Node.js, Express 5, PostgreSQL) with a bundled web UI.

| Item | Link |
| --- | --- |
| Repository | https://github.com/Timrossid/clinic-booking-api |
| Live deployment | https://clinic-booking-api-kg0q.onrender.com |

## Automated tests

`test-output.txt` is the unedited stdout of `npm test`, captured on 2026-11-15 against a local server with Node.js v24.22.2 and PostgreSQL 16 (`postgres:16-alpine` container, port 55432).

```text
tests 5
pass 5
fail 0
duration_ms 691.618988
```

Coverage: reset/slots/booking flow, auth and validation, double-booking and cancellation (including concurrent create/cancel), idempotency replay and mismatch, cursor pagination with scoping, and the per-email rate limit.

Reproduce:

```bash
npm install
docker run -d --name clinic-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=clinic_test -p 55432:5432 postgres:16-alpine

DATABASE_URL="postgresql://postgres:test@127.0.0.1:55432/clinic_test" \
API_KEY="local-test-key" PORT=3011 npm start   # separate shell

BASE_URL="http://127.0.0.1:3011" API_KEY="local-test-key" npm test
```

Note: `POST /reset` truncates all tables, so the suite runs against a disposable database — never the live deployment.

## Screenshots

Captured with Playwright/Chromium by `capture.js` (`npm run screenshots`). The UI screenshots come from a local instance seeded through the real API, because `/reset` is destructive and the live database must not be wiped. `00-live-deployment-home.png` is taken from the live Render URL (`LIVE_URL=... npm run screenshots`) to show the deployment serving the app.

| File | Description |
| --- | --- |
| `screenshots/00-live-deployment-home.png` | Live Render deployment home page |
| `screenshots/01-home.png` | Landing page (hero, services, how it works) |
| `screenshots/02-booking.png` | Five-step booking wizard with live slot data |
| `screenshots/03-appointments.png` | Look up bookings by email, with cancel action |
| `screenshots/04-api-slots.png` | `GET /slots` → `200`, `available` flags |
| `screenshots/05-api-bookings.png` | `GET /bookings?email=ada@example.com` → `200`, cursor pagination |
| `screenshots/06-api-booking-idempotent-replay.png` | `POST /bookings` with a repeated `Idempotency-Key` → `201`, same booking id |
| `screenshots/07-api-conflict-409.png` | `POST /bookings` on a booked slot → `409 {"error":"slot already booked"}` |
| `screenshots/08-api-unauthorized-401.png` | `GET /slots` with a wrong key → `401 {"error":"unauthorized"}` |

The API screenshots show the real status code and response body returned by the running server; the `X-API-Key` header is redacted.

Live deployment check (no destructive calls):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://clinic-booking-api-kg0q.onrender.com/
curl -s -o /dev/null -w '%{http_code}\n' https://clinic-booking-api-kg0q.onrender.com/api/slots
# 200
# 200
```
