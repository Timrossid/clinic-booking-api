const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));


const API_KEY = process.env.API_KEY || "clinic-book-api-key-2026";

// In-memory SQLite keeps state for the life of the process.
const db = new Database(":memory:");

db.exec(`
  CREATE TABLE slots (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_slots_start ON slots(start);
  CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot_id, status);
  CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(email);
  CREATE TABLE rate_limits (
    email TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL
  );
  CREATE TABLE idempotency (
    key TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60000;

function nowIso() {
  return new Date().toISOString();
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

function getBooking(id) {
  return db
    .prepare(
      "SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = ?"
    )
    .get(id);
}

function send(res, status, payload) {
  return res.status(status).json(payload);
}

const insertSlot = db.prepare(
  "INSERT OR REPLACE INTO slots (id, provider, start, end) VALUES (?, ?, ?, ?)"
);
const insertBooking = db.prepare(
  "INSERT INTO bookings (id, slot_id, name, email, status, created_at) VALUES (?, ?, ?, ?, 'confirmed', ?)"
);

// --- /reset ---------------------------------------------------------------
app.post("/reset", requireAuth, (req, res) => {
  const slots = parseSlots(req.body && req.body.slots);
  if (!slots) return send(res, 400, { error: "invalid_slots" });

  db.transaction(() => {
    db.exec("DELETE FROM slots");
    db.exec("DELETE FROM bookings");
    db.exec("DELETE FROM rate_limits");
    db.exec("DELETE FROM idempotency");
    for (const s of slots) insertSlot.run(s.id, s.provider, s.start, s.end);
  })();

  return res.json({ done: true });
});

// --- GET /slots -----------------------------------------------------------
app.get("/slots", requireAuth, (req, res) => {
  const provider = req.query.provider;
  const sql = `
    SELECT s.id, s.provider, s.start, s.end,
      EXISTS (
        SELECT 1 FROM bookings b
        WHERE b.slot_id = s.id AND b.status = 'confirmed'
      ) AS booked
    FROM slots s
    ${provider ? "WHERE s.provider = ?" : ""}
    ORDER BY s.start ASC
  `;
  const rows = provider
    ? db.prepare(sql).all(String(provider))
    : db.prepare(sql).all();

  return res.json({
    slots: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start,
      end: r.end,
      available: !r.booked,
    })),
  });
});

// --- POST /bookings -------------------------------------------------------
app.post("/bookings", requireAuth, (req, res) => {
  const body = normalizeNewBooking(req.body);
  if (!body) return send(res, 400, { error: "invalid body" });

  const { slot_id, name, email } = body;
  if (!slot_id) return send(res, 400, { error: "missing slot_id" });
  if (!name) return send(res, 400, { error: "missing name" });
  if (!email) return send(res, 400, { error: "missing email" });
  if (!validEmail(email)) return send(res, 400, { error: "invalid email" });

  // Idempotency replay comes first so a retried request is never charged
  // against the rate limit or reported as a conflict.
  const idemKey = req.headers["idempotency-key"];
  if (typeof idemKey === "string" && idemKey.trim()) {
    const prior = db
      .prepare("SELECT booking_id FROM idempotency WHERE key = ?")
      .get(idemKey.trim());
    if (prior) {
      const replay = getBooking(prior.booking_id);
      if (replay) return res.status(201).json(replay);
    }
  }

  // Rate limit per email: 5 requests / 60s sliding fixed window.
  const now = Date.now();
  const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  const rl = db
    .prepare("SELECT attempts, window_start FROM rate_limits WHERE email = ?")
    .get(email);

  if (rl && now - rl.window_start < RATE_LIMIT_WINDOW_MS) {
    if (rl.attempts >= RATE_LIMIT_MAX) {
      const retryAfter = Math.max(
        1,
        Math.ceil((rl.window_start + RATE_LIMIT_WINDOW_MS - now) / 1000)
      );
      return res
        .status(429)
        .set("Retry-After", String(retryAfter))
        .json({ error: "too many requests", retry_after: retryAfter });
    }
    db.prepare("UPDATE rate_limits SET attempts = attempts + 1 WHERE email = ?").run(
      email
    );
  } else if (rl) {
    db.prepare(
      "UPDATE rate_limits SET attempts = 1, window_start = ? WHERE email = ?"
    ).run(windowStart, email);
  } else {
    db.prepare(
      "INSERT INTO rate_limits (email, window_start, attempts) VALUES (?, ?, 1)"
    ).run(email, windowStart);
  }

  const slot = db.prepare("SELECT id, start FROM slots WHERE id = ?").get(slot_id);
  if (!slot) return send(res, 404, { error: "slot not found" });

  const slotStart = parseISO(slot.start);
  if (slotStart !== null && slotStart <= now) {
    return send(res, 422, { error: "slot is in the past" });
  }

  const existing = db
    .prepare(
      "SELECT id FROM bookings WHERE slot_id = ? AND status = 'confirmed' LIMIT 1"
    )
    .get(slot_id);
  if (existing) return send(res, 409, { error: "slot already booked" });

  const id = randId();
  const created = db.transaction(() => {
    insertBooking.run(id, slot_id, name, email, nowIso());
    if (typeof idemKey === "string" && idemKey.trim()) {
      db.prepare(
        "INSERT OR IGNORE INTO idempotency (key, booking_id, created_at) VALUES (?, ?, ?)"
      ).run(idemKey.trim(), id, nowIso());
    }
    return getBooking(id);
  })();

  return res.status(201).json(created);
});

// --- GET /bookings --------------------------------------------------------
app.get("/bookings", requireAuth, (req, res) => {
  const email =
    typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  if (!email) return send(res, 400, { error: "missing email" });

  const rawLimit = req.query.limit;
  const limit = rawLimit === undefined ? 10 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return send(res, 400, { error: "invalid limit" });
  }

  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const rows = cursor
    ? db
        .prepare(
          `SELECT id, slot_id, name, email, status, created_at
           FROM bookings
           WHERE email = ? AND created_at > (
             SELECT created_at FROM bookings WHERE id = ?
           )
           ORDER BY created_at ASC, id ASC
           LIMIT ?`
        )
        .all(email, cursor, limit + 1)
    : db
        .prepare(
          `SELECT id, slot_id, name, email, status, created_at
           FROM bookings
           WHERE email = ?
           ORDER BY created_at ASC, id ASC
           LIMIT ?`
        )
        .all(email, limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  return res.json({ bookings: page, next_cursor: nextCursor });
});

// --- GET /bookings/:id ----------------------------------------------------
app.get("/bookings/:id", requireAuth, (req, res) => {
  const booking = getBooking(req.params.id);
  if (!booking) return send(res, 404, { error: "booking not found" });
  return res.json(booking);
});

// --- DELETE /bookings/:id -------------------------------------------------
app.delete("/bookings/:id", requireAuth, (req, res) => {
  const booking = getBooking(req.params.id);
  if (!booking) return send(res, 404, { error: "booking not found" });
  if (booking.status === "cancelled") {
    return send(res, 409, { error: "already cancelled" });
  }
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(
    booking.id
  );
  return res.json(getBooking(booking.id));
});

// JSON 404/500 instead of Express HTML error pages.
app.use((req, res) => res.status(404).json({ error: "not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("booking-api listening on " + port);
});
