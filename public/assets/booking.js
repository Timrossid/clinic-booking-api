(function () {
  const H = window.HH;

  const SERVICES = [
    { key: "general", name: "General Consultation", blurb: "Everyday concerns, prescriptions and referrals." },
    { key: "family", name: "Family Medicine", blurb: "One clinician for the whole household." },
    { key: "dental", name: "Dental Care", blurb: "Check-ups, hygiene and restorative care." },
    { key: "mental", name: "Mental Health", blurb: "Confidential talking therapy and support." },
    { key: "paeds", name: "Paediatrics", blurb: "Unhurried care for babies and children." },
    { key: "specialist", name: "Specialist Consultation", blurb: "Cardiology, dermatology, physiotherapy." },
  ];

  const ICONS = {
    general: '<path d="M4.5 7.5v9a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-9"/><path d="M8 7.5V6a4 4 0 0 1 8 0v1.5"/><path d="M12 11v4M10 13h4"/>',
    family: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15 19a4 4 0 0 1 5.5-3.4"/>',
    dental: '<path d="M12 5c-2-1.4-5.5-1.2-5.5 2.4 0 2 .8 3.2 1.2 5.2.3 1.6.2 4.1 1.7 4.1 1.4 0 1.1-3 2.6-3s1.2 3 2.6 3c1.5 0 1.4-2.5 1.7-4.1.4-2 1.2-3.2 1.2-5.2C17.5 3.8 14 3.6 12 5Z"/>',
    mental: '<path d="M12 20s-6-3.6-6-8a3.5 3.5 0 0 1 6-2.4A3.5 3.5 0 0 1 18 12c0 4.4-6 8-6 8Z"/>',
    paeds: '<circle cx="12" cy="9" r="4.2"/><path d="M10 8.4h.01M14 8.4h.01M10.5 11c.8.7 2.2.7 3 0"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    specialist: '<path d="M6 4v5a6 6 0 0 0 12 0V4"/><path d="M12 15v5"/><path d="M9 20h6"/><path d="M18 8h2a2 2 0 0 1 0 4h-2"/>',
  };

  const state = {
    step: 1,
    service: null,
    slots: [],
    day: null,
    slot: null,
    month: new Date(),
    confirmKey: null,
    submitting: false,
  };

  const el = (id) => document.getElementById(id);
  const panels = () => Array.from(document.querySelectorAll("[data-step]"));
  const indicators = () => Array.from(document.querySelectorAll("[data-indicator]"));

  function serviceByKey(key) {
    return SERVICES.find((s) => s.key === key) || null;
  }

  function availableByDay() {
    const map = new Map();
    for (const slot of state.slots) {
      if (!slot.available) continue;
      const key = H.dayKey(slot.start);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(slot);
    }
    return map;
  }

  function renderServices() {
    const grid = el("service-grid");
    grid.innerHTML = "";
    for (const s of SERVICES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pick-card" + (state.service === s.key ? " is-selected" : "");
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(state.service === s.key));
      btn.dataset.service = s.key;
      btn.innerHTML =
        '<span class="pick-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
        ICONS[s.key] +
        "</svg></span><h3>" +
        s.name +
        "</h3><p>" +
        s.blurb +
        "</p>";
      btn.addEventListener("click", () => {
        state.service = s.key;
        state.day = null;
        state.slot = null;
        renderServices();
        syncSummary();
        go(2);
      });
      grid.appendChild(btn);
    }
  }

  function syncSummary() {
    const svc = serviceByKey(state.service);
    el("sum-service").textContent = svc ? svc.name : "Not chosen yet";
    el("sum-date").textContent = state.day ? H.fmtDate(dayIso()) : "Not chosen yet";
    el("sum-time").textContent = state.slot
      ? H.fmtTimeRange(state.slot.start, state.slot.end)
      : "Not chosen yet";
    el("sum-provider").textContent = state.slot ? state.slot.provider : "Not chosen yet";
  }

  function dayIso() {
    if (!state.day) return null;
    const slot = (availableByDay().get(state.day) || [])[0] || null;
    if (slot) return slot.start;
    const parts = state.day.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]).toISOString();
  }

  function go(step) {
    state.step = step;
    for (const panel of panels()) {
      panel.hidden = Number(panel.dataset.step) !== step;
    }
    for (const ind of indicators()) {
      const n = Number(ind.dataset.indicator);
      ind.classList.toggle("is-active", n === step);
      ind.classList.toggle("is-done", n < step);
      ind.querySelector(".pnum").textContent = n < step ? "✓" : String(n);
    }
    if (step === 3) renderSlots();
    if (step === 5) renderReview();
    if (step === 2) renderCalendar();
    syncSummary();
    window.scrollTo({ top: Math.max(0, el("flow").offsetTop - 90), behavior: "smooth" });
  }

  async function loadSlots() {
    const calState = el("cal-state");
    calState.innerHTML =
      '<div class="skeleton skel-row" style="height:52px"></div>';
    const res = await H.request("/slots");
    if (res.status !== 200 || !res.data) {
      calState.innerHTML =
        '<div class="state error"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg><h3>We could not load availability</h3><p>' +
        H.message(res) +
        '</p><button class="btn btn-ghost btn-sm" type="button" onclick="location.reload()">Try again</button></div>';
      return false;
    }
    calState.innerHTML = "";
    state.slots = res.data.slots || [];
    if (!state.slots.some((s) => s.available)) {
      calState.innerHTML =
        '<div class="state" style="margin-bottom:18px"><h3>Every appointment is taken</h3>' +
        '<p>New times are released regularly. Refresh in a moment, or add a fresh demo batch if you are exploring the app.</p>' +
        '<button class="btn btn-ghost btn-sm" type="button" id="add-demo">Add demo slots</button></div>';
      const add = el("add-demo");
      if (add) {
        add.addEventListener("click", async () => {
          add.disabled = true;
          add.textContent = "Adding…";
          await H.request("/demo-slots", { method: "POST" });
          await loadSlots();
          renderCalendar();
        });
      }
    }
    if (state.day && !availableByDay().has(state.day)) {
      state.day = null;
      state.slot = null;
    }
    return true;
  }

  function renderCalendar() {
    const map = availableByDay();
    const year = state.month.getFullYear();
    const month = state.month.getMonth();
    el("cal-label").textContent = state.month.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });

    const dow = el("cal-dow");
    dow.innerHTML = "";
    for (const d of ["S", "M", "T", "W", "T", "F", "S"]) {
      const c = document.createElement("div");
      c.className = "cal-dow";
      c.textContent = d;
      dow.appendChild(c);
    }

    const grid = el("cal-grid");
    grid.innerHTML = "";
    const first = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < first; i++) {
      const pad = document.createElement("div");
      pad.className = "cal-day is-pad";
      grid.appendChild(pad);
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let d = 1; d <= days; d++) {
      const date = new Date(year, month, d);
      const key = H.dayKey(date);
      const open = map.has(key) && date >= today;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-day" + (open ? " is-open" : "") + (state.day === key ? " is-selected" : "");
      btn.textContent = String(d);
      btn.disabled = !open;
      if (open) {
        btn.setAttribute("aria-label", date.toLocaleDateString() + " — " + map.get(key).length + " times available");
        btn.setAttribute("aria-pressed", String(state.day === key));
        btn.addEventListener("click", () => {
          state.day = key;
          state.slot = null;
          renderCalendar();
          updateCalSummary(map);
          syncSummary();
          el("to-time").disabled = false;
        });
      } else {
        btn.setAttribute("aria-label", date.toLocaleDateString() + " — no availability");
      }
      grid.appendChild(btn);
    }
    updateCalSummary(map);
    renderQuickTimes();
    el("to-time").disabled = !state.day;
  }

  // Nearest free slots, for patients who just want the soonest appointment.
  function renderQuickTimes() {
    const panel = el("cal-quick");
    const next = state.slots
      .filter((s) => s.available)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, 3);
    if (!next.length) {
      panel.innerHTML = "";
      return;
    }
    panel.innerHTML = '<div class="qt-head">Next available</div>';
    next.forEach((slot, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-row";
      btn.innerHTML =
        "<span><strong>" + H.fmtShortDate(slot.start) + "</strong> · " + H.fmtTime(slot.start) +
        '</span><span class="muted">' + slot.provider + "</span>";
      btn.addEventListener("click", () => {
        state.day = H.dayKey(slot.start);
        state.slot = slot;
        state.confirmKey = crypto.randomUUID();
        renderCalendar();
        syncSummary();
        go(3);
      });
      panel.appendChild(btn);
    });
  }

  function updateCalSummary(map) {
    const box = el("cal-summary");
    if (!state.day) {
      box.className = "state";
      box.style.background = "";
      box.style.borderStyle = "";
      box.style.borderColor = "";
      box.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3.5V7M16 3.5V7M3.5 10h17"/></svg><h3>Pick a date to continue</h3><p>We will show the exact times and which clinician is free.</p>';
      return;
    }
    const slots = map.get(state.day) || [];
    const providers = Array.from(new Set(slots.map((s) => s.provider)));
    box.className = "state";
    box.style.background = "var(--mint-50)";
    box.style.borderStyle = "solid";
    box.style.borderColor = "var(--mint-200)";
    box.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--sage)"><path d="M20 6 9 17l-5-5"/></svg><h3>' +
      H.fmtDate(dayIso()) +
      "</h3><p>" + slots.length + " time" + (slots.length === 1 ? "" : "s") + " available with " +
      providers.join(", ") + ".</p>";
  }

  function slotsForDay() {
    if (!state.day) return [];
    return state.slots
      .filter((s) => H.dayKey(s.start) === state.day)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  function renderSlots() {
    const list = slotsForDay();
    const pane = el("slot-pane");
    const empty = el("slot-state");
    el("time-sub").textContent = state.day
      ? "Live availability for " + H.fmtDate(dayIso()) + "."
      : "Live availability for your chosen date.";
    if (!list.length) {
      pane.hidden = true;
      empty.innerHTML =
        '<div class="state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg><h3>No times left on this date</h3><p>Every appointment for this day has been taken. Go back and choose another date.</p></div>';
      el("to-details").disabled = true;
      return;
    }
    pane.hidden = false;
    empty.innerHTML = "";
    const grid = el("slot-grid");
    grid.innerHTML = "";
    for (const slot of list) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slot-btn" + (state.slot && state.slot.id === slot.id ? " is-selected" : "");
      btn.disabled = !slot.available;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(Boolean(state.slot && state.slot.id === slot.id)));
      btn.innerHTML =
        '<span class="slot-time">' + H.fmtTime(slot.start) + " – " + H.fmtTime(slot.end) + "</span>" +
        '<span class="slot-meta">' + slot.provider + "</span>";
      btn.addEventListener("click", () => {
        state.slot = slot;
        state.confirmKey = crypto.randomUUID();
        renderSlots();
        syncSummary();
        el("to-details").disabled = false;
      });
      grid.appendChild(btn);
    }
    el("to-details").disabled = !state.slot;
  }

  function validName(v) {
    return v.trim().length >= 2 && /\s/.test(v.trim());
  }
  function validEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  }

  function validateForm(showErrors) {
    const name = el("name");
    const email = el("email");
    let ok = true;
    const nameOk = validName(name.value);
    const emailOk = validEmail(email.value);
    if (!nameOk) {
      ok = false;
      if (showErrors) {
        name.classList.add("is-error");
        el("name-error").textContent = name.value.trim()
          ? "Please enter your first and last name."
          : "Please tell us your name.";
      }
    } else {
      name.classList.remove("is-error");
      el("name-error").textContent = "";
    }
    if (!emailOk) {
      ok = false;
      if (showErrors) {
        email.classList.add("is-error");
        el("email-error").textContent = email.value.trim()
          ? "That email address does not look right."
          : "Please enter your email address.";
      }
    } else {
      email.classList.remove("is-error");
      el("email-error").textContent = "";
    }
    return ok;
  }

  function renderReview() {
    const svc = serviceByKey(state.service);
    const card = el("review-card");
    card.innerHTML =
      '<div class="review-hero"><span class="avatar">' + H.initials(state.slot.provider) + "</span>" +
      '<div><div class="big">' + svc.name + " with " + state.slot.provider + "</div>" +
      '<div class="muted" style="font-size:0.88rem">' + H.fmtDate(state.slot.start) + " · " +
      H.fmtTimeRange(state.slot.start, state.slot.end) + "</div></div></div>" +
      '<div class="review-row"><span>Patient</span><strong>' + escapeHtml(el("name").value.trim()) + "</strong></div>" +
      '<div class="review-row"><span>Email</span><strong>' + escapeHtml(el("email").value.trim()) + "</strong></div>" +
      '<div class="review-row"><span>Appointment</span><strong>' + svc.name + "</strong></div>" +
      '<div class="review-row"><span>Slot reference</span><strong>' + escapeHtml(state.slot.id) + "</strong></div>";
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function showConfirmError(text) {
    const box = el("confirm-error");
    if (!text) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    H.notice(box, "err", text);
  }

  async function submitBooking() {
    if (state.submitting) return;
    const btn = el("confirm-btn");
    state.submitting = true;
    btn.disabled = true;
    btn.innerHTML = "Confirming…";
    showConfirmError("");
    const res = await H.request("/bookings", {
      method: "POST",
      idempotencyKey: state.confirmKey,
      body: {
        slot_id: state.slot.id,
        name: el("name").value.trim(),
        email: el("email").value.trim(),
      },
    });

    state.submitting = false;
    btn.disabled = false;
    btn.innerHTML =
      'Confirm appointment <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

    if (res.status === 201 && res.data) {
      showConfirmation(res.data);
      return;
    }

    showConfirmError(H.message(res));
    if (res.status === 409 || res.status === 404 || res.status === 422) {
      await loadSlots();
      state.slot = null;
      state.confirmKey = null;
      renderCalendar();
      go(3);
      renderSlots();
      syncSummary();
    }
  }

  function showConfirmation(booking) {
    const svc = serviceByKey(state.service);
    const slot = state.slots.find((s) => s.id === booking.slot_id) || state.slot;
    el("flow").hidden = true;
    el("confirmation").hidden = false;
    el("confirm-ref").textContent = booking.id;
    el("confirm-service").textContent = svc ? svc.name : "—";
    el("confirm-provider").textContent = slot ? slot.provider : "—";
    el("confirm-date").textContent = slot ? H.fmtDate(slot.start) : "—";
    el("confirm-time").textContent = slot ? H.fmtTimeRange(slot.start, slot.end) : "—";
    el("confirm-patient").textContent = booking.name + " · " + booking.email;
    el("confirm-status").textContent = booking.status;
    el("view-bookings").href = "/appointments.html?email=" + encodeURIComponent(booking.email);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // --- wiring -------------------------------------------------------------
  document.querySelectorAll("[data-back]").forEach((btn) => {
    btn.addEventListener("click", () => go(Math.max(1, state.step - 1)));
  });

  el("details-form").addEventListener("input", () => {
    if (el("name").classList.contains("is-error") || el("email").classList.contains("is-error")) {
      validateForm(true);
    }
  });

  el("cal-prev").addEventListener("click", () => {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
    renderCalendar();
  });
  el("cal-next").addEventListener("click", () => {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
    renderCalendar();
  });

  el("to-time").addEventListener("click", async () => {
    if (!state.day) return;
    const ok = await loadSlots();
    if (ok) go(3);
  });

  el("to-details").addEventListener("click", () => {
    if (!state.slot) return;
    go(4);
    el("name").focus();
  });

  el("to-review").addEventListener("click", () => {
    if (!validateForm(true)) return;
    go(5);
  });

  el("confirm-btn").addEventListener("click", submitBooking);

  (async function init() {
    renderServices();
    const params = new URLSearchParams(location.search);
    const pre = params.get("service");
    if (pre && serviceByKey(pre)) {
      state.service = pre;
      renderServices();
      syncSummary();
      go(2);
    }
    const ok = await loadSlots();
    if (ok) {
      renderCalendar();
      if (!state.service) {
        // Land on step 1 but have the calendar ready behind it.
        go(1);
      }
    }
  })();
})();
