const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
const API_KEY = process.env.API_KEY;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required (PostgreSQL connection string).");
  process.exit(1);
}
if (!API_KEY) {
  console.error("API_KEY is required.");
  process.exit(1);
}

// Render's managed Postgres presents a certificate we do not verify here;
// local connections skip TLS entirely.
const isLocalDb = /(^|@)(localhost|127\.0\.0\.1)/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
});

const app = express();
app.use(express.json({ limit: "1mb" }));

// Browser-facing proxy: the API key stays on the server. The UI calls /api/*
// and we inject the key so the existing handlers/auth still apply unchanged.
app.use((req, _res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    req.headers["x-api-key"] = API_KEY;
    req.url = req.originalUrl.slice(4) || "/";
  }
  next();
});

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS slots (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    start_text TEXT NOT NULL,
    end_text TEXT NOT NULL,
    start_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_slots_start ON slots(start_at);

  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    seq BIGSERIAL
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_email_seq ON bookings(email, seq);
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_confirmed_slot
    ON bookings(slot_id) WHERE status = 'confirmed';

  CREATE TABLE IF NOT EXISTS rate_limits (
    email TEXT PRIMARY KEY,
    window_start BIGINT NOT NULL,
    attempts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE idempotency ADD COLUMN IF NOT EXISTS slot_id TEXT;
  ALTER TABLE idempotency ADD COLUMN IF NOT EXISTS name TEXT;
  ALTER TABLE idempotency ADD COLUMN IF NOT EXISTS email TEXT;
`;

const DEMO_PROVIDERS = ["Dr Ade", "Dr Bello", "Dr Chen"];

async function insertDemoSlots() {
  const { rows } = await pool.query("SELECT max(start_at) AS latest FROM slots");
  const latest = rows[0] && rows[0].latest ? new Date(rows[0].latest) : new Date();
  const from = new Date(Math.max(latest.getTime(), Date.now()));
  const dayStart = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate()
  );

  const stamp = Date.now();
  let i = 0;
  for (let day = 1; day <= 3; day++) {
    for (const hour of [9, 11, 14]) {
      const start = new Date(dayStart + day * 86400000 + hour * 3600000);
      const end = new Date(start.getTime() + 30 * 60000);
      await pool.query(
        `INSERT INTO slots (id, provider, start_text, end_text, start_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [
          `demo-${stamp}-${i}`,
          DEMO_PROVIDERS[i % DEMO_PROVIDERS.length],
          start.toISOString(),
          end.toISOString(),
          start.toISOString(),
        ]
      );
      i += 1;
    }
  }
  return i;
}

async function seedDemoSlotsIfEmpty() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM slots s
     WHERE s.start_at > now()
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE b.slot_id = s.id AND b.status = 'confirmed'
       )`
  );
  if (rows[0].n > 0) return;
  console.log("seeded " + (await insertDemoSlots()) + " demo slots");
}

async function initDb() {
  await pool.query(SCHEMA);
  await seedDemoSlotsIfEmpty();
}

let idCounter = 0;
function randId() {
  idCounter += 1;
  return (
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36) +
    idCounter.toString(36).padStart(3, "0")
  );
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireAuth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

function parseSlots(payload) {
  if (!Array.isArray(payload)) return null;
  const out = [];
  for (const s of payload) {
    if (!s || typeof s !== "object") return null;
    if (!s.id || !s.provider || !s.start || !s.end) return null;
    out.push({
      id: String(s.id).trim(),
      provider: String(s.provider).trim(),
      start: String(s.start),
      end: String(s.end),
    });
  }
  return out;
}

function normalizeNewBooking(payload) {
  if (!payload || typeof payload !== "object") return null;
  return {
    slot_id: typeof payload.slot_id === "string" ? payload.slot_id.trim() : "",
    name: typeof payload.name === "string" ? payload.name.trim() : "",
    email:
      typeof payload.email === "string"
        ? payload.email.trim().toLowerCase()
        : "",
  };
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseISO(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function shapeBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

const BOOKING_COLUMNS = "id, slot_id, name, email, status, created_at";

async function getBooking(id) {
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`,
    [id]
  );
  return rows[0] ? shapeBooking(rows[0]) : null;
}

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function idemLockKey(key) {
  const h = crypto.createHash("sha256").update(key).digest();
  // Two signed 32-bit ints for pg_advisory_xact_lock(int,int)
  return [h.readInt32BE(0), h.readInt32BE(4)];
}

function sameIdemRequest(row, body) {
  return (
    row &&
    row.slot_id === body.slot_id &&
    row.name === body.name &&
    row.email === body.email
  );
}

function idemMismatch() {
  return { error: "idempotency key reuse with different request" };
}

// --- /reset ---------------------------------------------------------------
app.post(
  "/reset",
  requireAuth,
  asyncHandler(async (req, res) => {
    const slots = parseSlots(req.body && req.body.slots);
    if (!slots) return send(res, 400, { error: "invalid_slots" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "TRUNCATE slots, bookings, rate_limits, idempotency RESTART IDENTITY"
      );
      for (const s of slots) {
        const startAt = parseISO(s.start);
        await client.query(
          `INSERT INTO slots (id, provider, start_text, end_text, start_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            s.id,
            s.provider,
            s.start,
            s.end,
            startAt === null ? null : new Date(startAt).toISOString(),
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return res.json({ done: true });
  })
);

// --- GET /slots -----------------------------------------------------------
app.get(
  "/slots",
  requireAuth,
  asyncHandler(async (req, res) => {
    const provider = req.query.provider;
    const params = [];
    let where = "";
    if (provider) {
      params.push(String(provider));
      where = "WHERE s.provider = $1";
    }

    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_text, s.end_text,
         EXISTS (
           SELECT 1 FROM bookings b
           WHERE b.slot_id = s.id AND b.status = 'confirmed'
         ) AS booked
       FROM slots s
       ${where}
       ORDER BY s.start_at ASC NULLS LAST, s.start_text ASC`,
      params
    );

    return res.json({
      slots: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        start: r.start_text,
        end: r.end_text,
        available: !r.booked,
      })),
    });
  })
);

// --- POST /demo-slots -----------------------------------------------------
app.post(
  "/demo-slots",
  requireAuth,
  asyncHandler(async (req, res) => {
    const added = await insertDemoSlots();
    return res.status(201).json({ added });
  })
);

// --- POST /bookings -------------------------------------------------------
app.post(
  "/bookings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = normalizeNewBooking(req.body);
    if (!body) return send(res, 400, { error: "invalid body" });

    const { slot_id, name, email } = body;
    if (!slot_id) return send(res, 400, { error: "missing slot_id" });
    if (!name) return send(res, 400, { error: "missing name" });
    if (!email) return send(res, 400, { error: "missing email" });
    if (!validEmail(email)) return send(res, 400, { error: "invalid email" });

    const idemKey = req.headers["idempotency-key"];
    const idem = typeof idemKey === "string" && idemKey.trim() ? idemKey.trim() : null;

    // Fast path: replay an identical request without consuming rate limit.
    if (idem) {
      const prior = await pool.query(
        "SELECT booking_id, slot_id, name, email FROM idempotency WHERE key = $1",
        [idem]
      );
      if (prior.rowCount) {
        if (!sameIdemRequest(prior.rows[0], body)) return send(res, 409, idemMismatch());
        const replay = await getBooking(prior.rows[0].booking_id);
        if (replay) return res.status(201).json(replay);
      }
    }

    const now = Date.now();
    const windowStart =
      Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (idem) {
        const [k1, k2] = idemLockKey(idem);
        await client.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [k1, k2]);
        const prior = await client.query(
          "SELECT booking_id, slot_id, name, email FROM idempotency WHERE key = $1",
          [idem]
        );
        if (prior.rowCount) {
          await client.query("ROLLBACK");
          if (!sameIdemRequest(prior.rows[0], body)) return send(res, 409, idemMismatch());
          const replay = await getBooking(prior.rows[0].booking_id);
          if (replay) return res.status(201).json(replay);
          return send(res, 409, { error: "slot already booked" });
        }
      }

      // Rate limit per email: 5 requests / 60s. The row lock serialises
      // concurrent attempts for the same email so the count is exact.
      await client.query(
        `INSERT INTO rate_limits (email, window_start, attempts)
         VALUES ($1, $2, 0)
         ON CONFLICT (email) DO NOTHING`,
        [email, windowStart]
      );
      const rl = (
        await client.query(
          "SELECT attempts, window_start FROM rate_limits WHERE email = $1 FOR UPDATE",
          [email]
        )
      ).rows[0];

      if (now - Number(rl.window_start) < RATE_LIMIT_WINDOW_MS) {
        if (Number(rl.attempts) >= RATE_LIMIT_MAX) {
          await client.query("ROLLBACK");
          const retryAfter = Math.max(
            1,
            Math.ceil((Number(rl.window_start) + RATE_LIMIT_WINDOW_MS - now) / 1000)
          );
          return res
            .status(429)
            .set("Retry-After", String(retryAfter))
            .json({ error: "too many requests", retry_after: retryAfter });
        }
        await client.query(
          "UPDATE rate_limits SET attempts = attempts + 1 WHERE email = $1",
          [email]
        );
      } else {
        await client.query(
          "UPDATE rate_limits SET attempts = 1, window_start = $1 WHERE email = $2",
          [windowStart, email]
        );
      }

      const slot = (
        await client.query("SELECT id, start_at FROM slots WHERE id = $1", [
          slot_id,
        ])
      ).rows[0];
      if (!slot) {
        await client.query("ROLLBACK");
        return send(res, 404, { error: "slot not found" });
      }

      const slotStart = slot.start_at ? new Date(slot.start_at).getTime() : null;
      if (slotStart !== null && slotStart <= now) {
        await client.query("ROLLBACK");
        return send(res, 422, { error: "slot is in the past" });
      }

      const existing = await client.query(
        "SELECT id FROM bookings WHERE slot_id = $1 AND status = 'confirmed' LIMIT 1",
        [slot_id]
      );
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return send(res, 409, { error: "slot already booked" });
      }

      const id = randId();
      await client.query(
        `INSERT INTO bookings (id, slot_id, name, email, status, created_at)
         VALUES ($1, $2, $3, $4, 'confirmed', now())`,
        [id, slot_id, name, email]
      );

      if (idem) {
        const claimed = await client.query(
          `INSERT INTO idempotency (key, booking_id, slot_id, name, email)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (key) DO NOTHING
           RETURNING booking_id`,
          [idem, id, slot_id, name, email]
        );
        if (claimed.rowCount === 0) {
          await client.query("ROLLBACK");
          const prior = await pool.query(
            "SELECT booking_id, slot_id, name, email FROM idempotency WHERE key = $1",
            [idem]
          );
          if (prior.rowCount) {
            if (!sameIdemRequest(prior.rows[0], body)) return send(res, 409, idemMismatch());
            const replay = await getBooking(prior.rows[0].booking_id);
            if (replay) return res.status(201).json(replay);
          }
          return send(res, 409, { error: "slot already booked" });
        }
      }

      await client.query("COMMIT");
      return res.status(201).json(await getBooking(id));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err && err.code === "23505") {
        return send(res, 409, { error: "slot already booked" });
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

// --- GET /bookings --------------------------------------------------------
app.get(
  "/bookings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const email =
      typeof req.query.email === "string"
        ? req.query.email.trim().toLowerCase()
        : "";
    if (!email) return send(res, 400, { error: "missing email" });

    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return send(res, 400, { error: "invalid limit" });
    }

    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    let rows;
    if (cursor) {
      const cur = await pool.query(
        "SELECT seq FROM bookings WHERE id = $1 AND email = $2",
        [cursor, email]
      );
      if (!cur.rowCount) return send(res, 400, { error: "invalid cursor" });
      ({ rows } = await pool.query(
        `SELECT ${BOOKING_COLUMNS} FROM bookings
         WHERE email = $1 AND seq > $2
         ORDER BY seq ASC
         LIMIT $3`,
        [email, cur.rows[0].seq, limit + 1]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT ${BOOKING_COLUMNS} FROM bookings
         WHERE email = $1
         ORDER BY seq ASC
         LIMIT $2`,
        [email, limit + 1]
      ));
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return res.json({
      bookings: page.map(shapeBooking),
      next_cursor: hasMore ? page[page.length - 1].id : null,
    });
  })
);

// --- GET /bookings/:id ----------------------------------------------------
app.get(
  "/bookings/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const booking = await getBooking(req.params.id);
    if (!booking) return send(res, 404, { error: "booking not found" });
    return res.json(booking);
  })
);

// --- DELETE /bookings/:id -------------------------------------------------
app.delete(
  "/bookings/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `UPDATE bookings SET status = 'cancelled'
       WHERE id = $1 AND status = 'confirmed'
       RETURNING ${BOOKING_COLUMNS}`,
      [req.params.id]
    );
    if (result.rowCount) return res.json(shapeBooking(result.rows[0]));

    const booking = await getBooking(req.params.id);
    if (!booking) return send(res, 404, { error: "booking not found" });
    return send(res, 409, { error: "already cancelled" });
  })
);

// Static site (after API routes so /api/* never resolves to files).
app.use(express.static(path.join(__dirname, "public")));

// JSON 404/500 instead of Express HTML error pages.
app.use((req, res) => res.status(404).json({ error: "not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const port = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log("booking-api listening on " + port);
    });
  })
  .catch((err) => {
    console.error("database initialisation failed:", err.message);
    process.exit(1);
  });
