// Shared helpers for every page.
window.HH = (function () {
  async function request(path, options = {}) {
    const headers = { "Content-Type": "application/json" };
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    let res;
    try {
      res = await fetch("/api" + path, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      const e = new Error("We could not reach the booking service. Check your connection and try again.");
      e.network = true;
      throw e;
    }
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    return { status: res.status, data, retryAfter: res.headers.get("Retry-After") };
  }

  function message(res) {
    const err = res.data && res.data.error;
    if (res.status === 429) {
      const wait = res.retryAfter || (res.data && res.data.retry_after);
      return "Too many booking attempts for this email. Please try again in " + (wait || 60) + " seconds.";
    }
    if (res.status === 409) return "That time was just taken by someone else. Please choose another slot.";
    if (res.status === 404) return "We could not find that record. It may have been removed.";
    if (res.status === 422) return "That slot is no longer in the future, so it cannot be booked.";
    if (res.status === 400) {
      if (err === "invalid email") return "That email address does not look right.";
      if (err === "missing email") return "Please enter your email address.";
      if (err === "invalid limit") return "Invalid page size.";
      return "Some details were missing or invalid. Please review the form.";
    }
    if (res.status === 401) return "The booking service rejected the request. Please refresh and try again.";
    return "Something went wrong on our side. Please try again in a moment.";
  }

  function toDate(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function fmtDate(value) {
    const d = toDate(value);
    if (!d) return String(value);
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  function fmtShortDate(value) {
    const d = toDate(value);
    if (!d) return String(value);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  function fmtTime(value) {
    const d = toDate(value);
    if (!d) return String(value);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function fmtTimeRange(start, end) {
    return fmtTime(start) + " – " + fmtTime(end);
  }

  function dayKey(value) {
    const d = toDate(value);
    if (!d) return "";
    return (
      d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  function initials(name) {
    return String(name || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("");
  }

  function notice(el, kind, text) {
    if (!el) return;
    if (!text) {
      el.innerHTML = "";
      el.hidden = true;
      return;
    }
    const icon =
      kind === "ok"
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
        : kind === "err"
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg>';
    el.className = "notice " + kind;
    el.innerHTML = icon + "<div>" + text + "</div>";
    el.hidden = false;
  }

  // Sticky nav shadow + small-screen menu.
  document.addEventListener("DOMContentLoaded", function () {
    const nav = document.querySelector(".nav");
    if (nav) {
      const onScroll = () => nav.classList.toggle("is-stuck", window.scrollY > 8);
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
    }
    const toggle = document.querySelector(".nav-toggle");
    const menu = document.querySelector(".mobile-menu");
    if (toggle && menu) {
      toggle.addEventListener("click", function () {
        const open = menu.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", String(open));
      });
    }
    const year = document.querySelector("[data-year]");
    if (year) year.textContent = new Date().getFullYear();
  });

  return {
    request,
    message,
    fmtDate,
    fmtShortDate,
    fmtTime,
    fmtTimeRange,
    dayKey,
    initials,
    notice,
  };
})();
