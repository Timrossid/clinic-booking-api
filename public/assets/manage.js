(function () {
  const H = window.HH;

  const state = {
    email: "",
    bookings: [],
    cursor: null,
    slotCache: new Map(),
    slotsLoaded: false,
  };

  const el = (id) => document.getElementById(id);
  const results = el("results");
  const noteBox = el("results-note");

  function skeleton() {
    el("load-more").hidden = true;
    results.innerHTML =
      '<div class="skeleton skel-row" style="height:92px"></div>' +
      '<div class="skeleton skel-row" style="height:92px"></div>' +
      '<div class="skeleton skel-row" style="height:92px"></div>';
  }

  function errorState(text, retry) {
    results.innerHTML = "";
    const box = document.createElement("div");
    box.className = "state error";
    box.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg><h3>Something went wrong</h3><p>' +
      text +
      "</p>";
    if (retry) {
      const btn = document.createElement("button");
      btn.className = "btn btn-ghost btn-sm";
      btn.type = "button";
      btn.textContent = "Try again";
      btn.addEventListener("click", retry);
      box.appendChild(btn);
    }
    results.appendChild(box);
  }

  function emptyState() {
    results.innerHTML = "";
    const box = document.createElement("div");
    box.className = "state";
    box.style.background = "#fff";
    box.style.borderStyle = "solid";
    box.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3.5V7M16 3.5V7M3.5 10h17"/></svg><h3>No bookings for this email</h3><p>We could not find an appointment for <strong>' +
      escapeHtml(state.email) +
      "</strong>. Check the spelling, or book a new appointment.</p>";
    const link = document.createElement("a");
    link.className = "btn btn-primary btn-sm";
    link.href = "/book.html";
    link.textContent = "Book an appointment";
    box.appendChild(link);
    results.appendChild(box);
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function statusClass(status) {
    if (status === "confirmed") return "status-confirmed";
    if (status === "cancelled" || status === "canceled") return "status-cancelled";
    if (status === "pending") return "status-pending";
    return "status-cancelled";
  }

  async function ensureSlots() {
    if (state.slotsLoaded) return;
    const res = await H.request("/slots");
    if (res.status === 200 && res.data) {
      for (const s of res.data.slots || []) state.slotCache.set(s.id, s);
    }
    state.slotsLoaded = true;
  }

  function renderRow(booking) {
    const slot = state.slotCache.get(booking.slot_id);
    const row = document.createElement("article");
    row.className = "booking-row";
    const heading = slot ? slot.provider : booking.slot_id;
    const when = slot
      ? H.fmtDate(slot.start) + " · " + H.fmtTimeRange(slot.start, slot.end)
      : "Time no longer published";
    row.innerHTML =
      '<div class="b-main"><h3>' + escapeHtml(heading) + "</h3><p>" + escapeHtml(when) + "</p>" +
      '<span class="b-meta">Ref ' + escapeHtml(booking.id) + "</span></div>" +
      '<div class="b-actions"><span class="status-pill ' + statusClass(booking.status) + '">' +
      escapeHtml(booking.status) + "</span></div>";

    if (booking.status === "confirmed") {
      const cancel = document.createElement("button");
      cancel.className = "btn btn-ghost btn-sm";
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => openCancel(booking, slot, cancel));
      row.querySelector(".b-actions").appendChild(cancel);
    }
    return row;
  }

  function renderList(append) {
    if (!append) results.innerHTML = "";
    const list = document.createElement("div");
    list.className = "booking-list";
    for (const b of state.bookings) list.appendChild(renderRow(b));
    results.appendChild(list);
    el("load-more").hidden = !state.cursor;
  }

  async function lookup({ append = false } = {}) {
    if (!state.email) return;
    el("lookup-btn").disabled = true;
    if (!append) skeleton();
    await ensureSlots();
    const query =
      "/bookings?email=" + encodeURIComponent(state.email) + "&limit=10" +
      (append && state.cursor ? "&cursor=" + encodeURIComponent(state.cursor) : "");
    const res = await H.request(query);
    el("lookup-btn").disabled = false;

    if (res.status !== 200 || !res.data) {
      if (!append) errorState(H.message(res), () => lookup());
      H.notice(noteBox, "err", H.message(res));
      return;
    }

    const page = res.data.bookings || [];
    state.bookings = append ? state.bookings.concat(page) : page;
    state.cursor = res.data.next_cursor || null;

    if (!state.bookings.length) {
      emptyState();
      el("load-more").hidden = true;
      H.notice(noteBox, "", "");
      return;
    }

    el("lookup-btn").disabled = false;
    renderList(append);
    const confirmed = state.bookings.filter((b) => b.status === "confirmed").length;
    H.notice(
      noteBox,
      "info",
      confirmed +
        " confirmed appointment" + (confirmed === 1 ? "" : "s") +
        " for " + escapeHtml(state.email) + ". Cancelling frees the slot immediately."
    );
  }

  function openCancel(booking, slot, trigger) {
    const dialog = el("cancel-dialog");
    el("cancel-target").innerHTML =
      '<div class="review-row"><span>Reference</span><strong>' + escapeHtml(booking.id) + "</strong></div>" +
      '<div class="review-row"><span>Appointment</span><strong>' +
      (slot ? escapeHtml(H.fmtShortDate(slot.start) + " · " + H.fmtTimeRange(slot.start, slot.end)) : "—") +
      "</strong></div>" +
      '<div class="review-row"><span>Clinician</span><strong>' + escapeHtml(slot ? slot.provider : "—") + "</strong></div>";
    dialog.dataset.booking = booking.id;
    dialog.dataset.trigger = "1";
    dialog.showModal();
    dialog.addEventListener(
      "close",
      async function handler() {
        dialog.removeEventListener("close", handler);
        if (dialog.returnValue !== "confirm") {
          if (trigger) trigger.focus();
          return;
        }
        await cancelBooking(booking.id);
      },
      { once: true }
    );
  }

  async function cancelBooking(id) {
    const res = await H.request("/bookings/" + encodeURIComponent(id), { method: "DELETE" });
    if (res.status === 200 && res.data) {
      state.bookings = state.bookings.map((b) => (b.id === id ? res.data : b));
      H.notice(noteBox, "ok", "Appointment " + escapeHtml(id) + " has been cancelled. The time is available again.");
      renderList(false);
      return;
    }
    H.notice(noteBox, "err", H.message(res));
    if (res.status === 409) {
      // Already cancelled elsewhere — refresh so the UI matches the server.
      await lookup();
    }
  }

  el("lookup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = el("lookup-email");
    const email = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      input.classList.add("is-error");
      el("lookup-error").textContent = email
        ? "That email address does not look right."
        : "Please enter the email you booked with.";
      input.focus();
      return;
    }
    input.classList.remove("is-error");
    el("lookup-error").textContent = "";
    state.email = email.toLowerCase();
    state.cursor = null;
    lookup();
  });

  el("load-more").addEventListener("click", () => lookup({ append: true }));

  (function prefill() {
    const params = new URLSearchParams(location.search);
    const email = params.get("email");
    if (!email) return;
    el("lookup-email").value = email;
    state.email = email.trim().toLowerCase();
    lookup();
  })();
})();
