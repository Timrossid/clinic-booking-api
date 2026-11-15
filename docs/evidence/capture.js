// Captures submission screenshots: app pages + API responses.
// Usage: BASE_URL=http://127.0.0.1:3011 API_KEY=local-test-key node docs/evidence/capture.js
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3011";
const KEY = process.env.API_KEY;
const OUT = path.join(__dirname, "screenshots");

if (!KEY) throw new Error("API_KEY is required");

const H = { "Content-Type": "application/json", "X-API-Key": KEY };

function slot(id, dayOffset, hour, provider) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, 0, 0, 0);
  return {
    id,
    provider,
    start: d.toISOString(),
    end: new Date(d.getTime() + 30 * 60000).toISOString(),
  };
}

async function api(method, p, body, headers = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...H, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function seed() {
  const slots = [
    slot("s1", 3, 9, "Dr Ade"),
    slot("s2", 3, 11, "Dr Bello"),
    slot("s3", 4, 14, "Dr Chen"),
    slot("s4", 5, 9, "Dr Ade"),
    slot("s5", 5, 11, "Dr Bello"),
    slot("s6", 6, 14, "Dr Chen"),
  ];
  const reset = await api("POST", "/reset", { slots });
  console.log("reset", reset.status, reset.text);

  const booking = await api(
    "POST",
    "/bookings",
    { slot_id: "s2", name: "Ada Lovelace", email: "ada@example.com" },
    { "Idempotency-Key": "demo-key-1" }
  );
  console.log("booking", booking.status, booking.text);
  return JSON.parse(booking.text);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await seed();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(OUT, "01-home.png"), fullPage: true });

  await page.goto(BASE + "/book.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "02-booking.png"), fullPage: true });

  await page.goto(BASE + "/appointments.html", { waitUntil: "networkidle" });
  await page.fill("#lookup-email", "ada@example.com");
  await page.click("#lookup-btn");
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, "03-appointments.png"), fullPage: true });

  // API responses: the real status and body for each request, rendered on a
  // readable page. Request headers show the key redacted.
  async function responseShot(title, method, p, body, headers, file) {
    const r = await api(method, p, body, headers || {});
    let pretty = r.text;
    try {
      pretty = JSON.stringify(JSON.parse(r.text), null, 2);
    } catch {}
    const reqHeaders = { "X-API-Key": "••••••••", ...(headers || {}) };
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.setContent(
      `<!doctype html><meta charset="utf-8">
       <body style="margin:0;background:#0f172a;color:#e2e8f0;font:14px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace">
         <div style="padding:28px 32px">
           <div style="color:#94a3b8;font-size:11px;letter-spacing:.12em;text-transform:uppercase">${title}</div>
           <div style="margin-top:12px;font-size:15px;color:#f8fafc">${method} ${BASE}${p}</div>
           <div style="margin-top:6px;color:#94a3b8;font-size:12px">headers: ${JSON.stringify(reqHeaders)}</div>
           <div style="margin-top:16px;color:#7dd3fc;font-size:13px">HTTP ${r.status}${r.status >= 200 && r.status < 300 ? " OK" : ""}</div>
           <pre style="margin:10px 0 0;padding:18px;background:#1e293b;border:1px solid #334155;border-radius:10px;white-space:pre-wrap;color:#e2e8f0">${pretty
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")}</pre>
         </div>
       </body>`
    );
    await page.screenshot({ path: path.join(OUT, file), fullPage: true });
    console.log(file, r.status, r.text);
  }

  await responseShot(
    "List slots",
    "GET",
    "/slots",
    undefined,
    {},
    "04-api-slots.png"
  );
  await responseShot(
    "List bookings for one email (cursor paginated)",
    "GET",
    "/bookings?email=ada@example.com",
    undefined,
    {},
    "05-api-bookings.png"
  );
  await responseShot(
    "Create booking - idempotency replay returns the same booking",
    "POST",
    "/bookings",
    { slot_id: "s2", name: "Ada Lovelace", email: "ada@example.com" },
    { "Idempotency-Key": "demo-key-1" },
    "06-api-booking-idempotent-replay.png"
  );
  await responseShot(
    "Duplicate booking rejected",
    "POST",
    "/bookings",
    { slot_id: "s2", name: "Grace Hopper", email: "grace@example.com" },
    {},
    "07-api-conflict-409.png"
  );
  await responseShot(
    "Authentication required",
    "GET",
    "/slots",
    undefined,
    { "X-API-Key": "wrong-key" },
    "08-api-unauthorized-401.png"
  );

  // Optional: capture the live deployment home page.
  if (process.env.LIVE_URL) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(process.env.LIVE_URL, { waitUntil: "networkidle", timeout: 90000 });
    await page.screenshot({
      path: path.join(OUT, "00-live-deployment-home.png"),
      fullPage: true,
    });
    console.log("00-live-deployment-home.png", process.env.LIVE_URL);
  }

  await browser.close();
  console.log("screenshots written to", OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
