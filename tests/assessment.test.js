const test = require("node:test");
const assert = require("node:assert/strict");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3011";
const KEY = process.env.API_KEY;

if (!KEY) {
  throw new Error("API_KEY is required to run tests.");
}

const H = {
  "Content-Type": "application/json",
  "X-API-Key": KEY,
};

async function req(method, path, { body, headers = {}, auth = true } = {}) {
  const h = { ...headers };
  if (auth) h["X-API-Key"] = KEY;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data, text };
}

function futureSlot(id, dayOffset, hour, provider = "Dr Test") {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, 0, 0, 0);
  const end = new Date(d.getTime() + 30 * 60000);
  return {
    id,
    provider,
    start: d.toISOString(),
    end: end.toISOString(),
  };
}

async function reset(slots) {
  const r = await req("POST", "/reset", { body: { slots } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { done: true });
}

async function book(slot_id, email, name = "Ada", extraHeaders = {}) {
  return req("POST", "/bookings", {
    body: { slot_id, name, email },
    headers: extraHeaders,
  });
}

test("Level 1: reset, list slots, create booking, get booking", async () => {
  const slots = [futureSlot("s1", 10, 9, "Dr Ade"), futureSlot("s2", 10, 10, "Dr Bello")];
  await reset(slots);

  let r = await req("GET", "/slots");
  assert.equal(r.status, 200);
  assert.equal(r.data.slots.length, 2);
  assert.ok(r.data.slots.every((s) => s.available === true));

  r = await req("GET", "/slots?provider=Dr%20Ade");
  assert.equal(r.status, 200);
  assert.equal(r.data.slots.length, 1);
  assert.equal(r.data.slots[0].id, "s1");

  r = await book("s1", "ada@example.com", "Ada Lovelace");
  assert.equal(r.status, 201);
  assert.equal(r.data.slot_id, "s1");
  assert.equal(r.data.email, "ada@example.com");
  assert.equal(r.data.name, "Ada Lovelace");
  assert.equal(r.data.status, "confirmed");
  assert.ok(r.data.id);
  assert.ok(r.data.created_at);

  const bookingId = r.data.id;
  r = await req("GET", `/bookings/${bookingId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.id, bookingId);
  assert.equal(r.data.status, "confirmed");

  r = await req("GET", "/slots");
  const s1 = r.data.slots.find((s) => s.id === "s1");
  const s2 = r.data.slots.find((s) => s.id === "s2");
  assert.equal(s1.available, false);
  assert.equal(s2.available, true);
});

test("Level 2: auth and validation errors", async () => {
  const slots = [futureSlot("s1", 11, 9), futureSlot("s2", 11, 10)];
  await reset(slots);

  let r = await req("GET", "/slots", { auth: false });
  assert.equal(r.status, 401);
  r = await req("GET", "/slots", { headers: { "X-API-Key": "wrong-key" }, auth: false });
  assert.equal(r.status, 401);

  r = await book("", "ada@example.com");
  assert.equal(r.status, 400);

  r = await req("POST", "/bookings", { body: { slot_id: "s1", name: "", email: "ada@example.com" } });
  assert.equal(r.status, 400);

  r = await req("POST", "/bookings", { body: { slot_id: "s1", name: "Ada", email: "" } });
  assert.equal(r.status, 400);

  r = await book("s1", "not-an-email");
  assert.equal(r.status, 400);

  r = await book("does-not-exist", "ada@example.com");
  assert.equal(r.status, 404);

  const past = {
    id: "past1",
    provider: "Dr Past",
    start: "2020-01-01T09:00:00.000Z",
    end: "2020-01-01T09:30:00.000Z",
  };
  await reset([past]);
  r = await book("past1", "ada@example.com");
  assert.equal(r.status, 422);
});

test("Level 3: no double booking, cancellation frees slot, re-cancel conflict", async () => {
  const slots = [futureSlot("s1", 12, 9), futureSlot("s2", 12, 10), futureSlot("s3", 12, 11)];
  await reset(slots);

  let r = await book("s1", "a@example.com", "A");
  assert.equal(r.status, 201);
  r = await book("s1", "b@example.com", "B");
  assert.equal(r.status, 409);

  const race = await Promise.all(
    Array.from({ length: 6 }, (_, i) => book("s2", `u${i}@example.com`, `U${i}`))
  );
  const created = race.filter((x) => x.status === 201).length;
  const conflicts = race.filter((x) => x.status === 409).length;
  assert.equal(created, 1);
  assert.equal(conflicts, 5);

  r = await book("s3", "c@example.com", "C");
  assert.equal(r.status, 201);
  const id = r.data.id;

  r = await req("DELETE", `/bookings/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "cancelled");
  assert.equal(r.data.id, id);

  r = await req("DELETE", `/bookings/${id}`);
  assert.equal(r.status, 409);

  r = await req("GET", "/slots");
  const s3 = r.data.slots.find((s) => s.id === "s3");
  assert.equal(s3.available, true);

  r = await book("s3", "d@example.com", "D");
  assert.equal(r.status, 201);

  r = await req("DELETE", "/bookings/does-not-exist");
  assert.equal(r.status, 404);

  // Concurrent cancellation: only one request should succeed.
  await reset([futureSlot("cx", 12, 14)]);
  r = await book("cx", "racecancel@example.com", "R");
  assert.equal(r.status, 201);
  const cancelId = r.data.id;
  const cancels = await Promise.all(
    Array.from({ length: 5 }, () => req("DELETE", `/bookings/${cancelId}`))
  );
  assert.equal(cancels.filter((x) => x.status === 200).length, 1);
  assert.equal(cancels.filter((x) => x.status === 409).length, 4);
});

test("Level 4: idempotency replay, mismatch rejection, list and pagination", async () => {
  const slots = Array.from({ length: 15 }, (_, i) => futureSlot(`p${i + 1}`, 13, 8 + (i % 8)));
  await reset(slots);

  let r = await book("p1", "idem@example.com", "Idem", { "Idempotency-Key": "same-key-1" });
  assert.equal(r.status, 201);
  const first = r.data;

  r = await book("p1", "idem@example.com", "Idem", { "Idempotency-Key": "same-key-1" });
  assert.equal(r.status, 201);
  assert.equal(r.data.id, first.id);

  // Same key with a different request must not replay or create another booking.
  r = await book("p2", "idem@example.com", "Idem", { "Idempotency-Key": "same-key-1" });
  assert.equal(r.status, 409);

  r = await book("p3", "idem@example.com", "OtherName", { "Idempotency-Key": "same-key-1" });
  assert.equal(r.status, 409);

  // Create four bookings for pagination. Four stays inside the 5-per-60s limit.
  const mine = [];
  for (let i = 2; i <= 5; i++) {
    const b = await book(`p${i}`, "page@example.com", `P${i}`);
    assert.equal(b.status, 201);
    mine.push(b.data.id);
  }

  r = await req("GET", "/bookings?email=page@example.com&limit=2");
  assert.equal(r.status, 200);
  assert.equal(r.data.bookings.length, 2);
  assert.ok(r.data.next_cursor);

  const seen = new Set(r.data.bookings.map((b) => b.id));
  let cursor = r.data.next_cursor;
  let pages = 1;
  while (cursor) {
    pages += 1;
    r = await req("GET", `/bookings?email=page@example.com&limit=2&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(r.status, 200);
    for (const b of r.data.bookings) {
      assert.ok(!seen.has(b.id), "duplicate booking across pages");
      seen.add(b.id);
    }
    cursor = r.data.next_cursor;
  }
  assert.equal(seen.size, mine.length);
  assert.equal(pages, 2);

  r = await req("GET", "/bookings");
  assert.equal(r.status, 400);
  r = await req("GET", "/bookings?email=page@example.com&limit=0");
  assert.equal(r.status, 400);
  r = await req("GET", "/bookings?email=page@example.com&limit=51");
  assert.equal(r.status, 400);

  // Cursor must be scoped to the requesting email.
  const other = await book("p6", "other@example.com", "Other");
  assert.equal(other.status, 201);
  r = await req("GET", `/bookings?email=page@example.com&cursor=${encodeURIComponent(other.data.id)}`);
  assert.equal(r.status, 400);

  r = await req("GET", "/bookings?email=page@example.com&cursor=not-a-real-cursor");
  assert.equal(r.status, 400);
});

test("Level 5: rate limit 5 per email per 60s with Retry-After", async () => {
  const slots = Array.from({ length: 10 }, (_, i) => futureSlot(`r${i + 1}`, 14, 8 + (i % 8)));
  await reset(slots);

  // 5 successful bookings for the same email should be allowed.
  for (let i = 1; i <= 5; i++) {
    const r = await book(`r${i}`, "limited@example.com", `L${i}`);
    assert.equal(r.status, 201, `booking ${i} should succeed`);
  }

  // 6th attempt in the same window must be rate limited even if it would be valid.
  const sixth = await book("r6", "limited@example.com", "L6");
  assert.equal(sixth.status, 429);
  assert.ok(sixth.headers.get("retry-after"));
  const retry = Number(sixth.headers.get("retry-after"));
  assert.ok(Number.isFinite(retry) && retry >= 1);

  // A different email is not affected.
  const other = await book("r6", "other-limit@example.com", "O1");
  assert.equal(other.status, 201);
});
