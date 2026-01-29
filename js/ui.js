/* =============================================================================
  js/ui.js — UI del calendario (render + modal + filtros) — vPRO++++ (ASSIGNEES)
  -----------------------------------------------------------------------------
  - Render grilla mensual (6x7)
  - Chips de eventos por día (compact + @asignado)
  - Modal crear/editar (incluye Asignado a + Repetición)
  - Filtros: categoría, estado, persona
  - Búsqueda: título, notas, persona
  - Vistas: Mes / Lista
  - Overview: Hoy + Próximos 7 días

  ✅ FIX NUEVO:
     - Select "Asignado a" (modal) SIEMPRE muestra ASSIGNEES fijo
     - Filtro "Responsable" SIEMPRE muestra ASSIGNEES fijo
     - Merge con responsables existentes en eventos (sin perder lógica anterior)
     - No depende de eventos previos para poblar selects

  Recurrentes (simple):
  - Se guardan como recurrence: "" | "weekly" | "monthly"
  - En UI se expanden SOLO en el rango visible (para no duplicar en Firestore)
============================================================================= */

import {
  CATEGORIES,
  EVENT_STATUS,
  STATUS_COLORS,
  CALENDAR_CONFIG,
  ASSIGNEES
} from "./constants.js";

import {
  buildMonthGrid,
  formatMonthTitle,
  isSameMonth,
  isSameDay,
  toISODateLocal,
  qs,
  escapeHtml
} from "./utils.js";

/* =========================
   DOM refs (index.html)
========================= */
const $currentMonth = qs("#currentMonth");
const $btnPrevMonth = qs("#btnPrevMonth");
const $btnNextMonth = qs("#btnNextMonth");
const $btnToday     = qs("#btnToday");
const $btnNewEvent  = qs("#btnNewEvent");

const $searchEvents   = qs("#searchEvents");
const $btnViewMonth   = qs("#btnViewMonth");
const $btnViewList    = qs("#btnViewList");
const $monthView      = qs("#monthView");
const $listView       = qs("#listView");
const $listBody       = qs("#listBody");
const $listTitle      = qs("#listTitle");
const $listMeta       = qs("#listMeta");

const $todayList = qs("#todayList");
const $nextList  = qs("#nextList");

const $filterCategory   = qs("#filterCategory");
const $filterStatus     = qs("#filterStatus");
const $filterAssignedTo = qs("#filterAssignedTo");

const $calendarGrid = qs("#calendarGrid");

const $eventModal     = qs("#eventModal");
const $modalOverlay   = qs("#modalOverlay");
const $modalTitle     = qs("#modalTitle");
const $eventForm      = qs("#eventForm");
const $btnCancelModal = qs("#btnCancelModal");
const $btnDeleteEvent = qs("#btnDeleteEvent");

const $eventTitle    = qs("#eventTitle");
const $eventCategory = qs("#eventCategory");
const $eventDate     = qs("#eventDate");
const $eventStatus   = qs("#eventStatus");
const $eventNotes    = qs("#eventNotes");

// NUEVOS: asignado + recurrencia (si no existen, no rompe)
const $eventAssignedTo = qs("#eventAssignedTo");
const $eventRecurrence = qs("#eventRecurrence");

const $toastHost = qs("#toastHost");

/* =========================
   Estado UI
========================= */
let UI_STATE = {
  year: new Date().getFullYear(),
  monthIndex: new Date().getMonth(),

  rawEvents: [],    // tal cual viene de db
  events: [],       // incluye expansión recurrentes

  filterCategory: "",
  filterStatus: "",
  filterAssignedTo: "",
  searchQuery: "",

  view: "month", // "month" | "list"

  editingId: null,

  onNavigate: null,
  onCreate: null,
  onUpdate: null,
  onDelete: null
};

/* =========================
   Helpers categorías/labels
========================= */
const CAT_BY_ID = new Map(CATEGORIES.map(c => [c.id, c]));

function catLabel(id) {
  return CAT_BY_ID.get(id)?.label || id || "Sin categoría";
}
function catColor(id) {
  return CAT_BY_ID.get(id)?.color || "#64748B";
}
function statusLabel(id) {
  return EVENT_STATUS.find(s => s.id === id)?.label || id || "Pendiente";
}
function recurrenceLabel(id) {
  const r = String(id || "");
  if (r === "weekly") return "Semanal";
  if (r === "monthly") return "Mensual";
  return "";
}

/* =========================
   Init
========================= */
export function initUI({ onNavigate, onCreate, onUpdate, onDelete } = {}) {
  UI_STATE.onNavigate = onNavigate || null;
  UI_STATE.onCreate   = onCreate   || null;
  UI_STATE.onUpdate   = onUpdate   || null;
  UI_STATE.onDelete   = onDelete   || null;

  populateCategorySelects();
  populateStatusSelects();

  // ✅ Inicial: NO depende de eventos. Solo carga el fijo.
  populateAssignedSelect([]); // ahora mete ASSIGNEES sí o sí
  populateAssignedToModal([]); // idem para modal

  // Toolbar
  $btnPrevMonth?.addEventListener("click", () => shiftMonth(-1));
  $btnNextMonth?.addEventListener("click", () => shiftMonth(+1));
  $btnToday?.addEventListener("click", () => goToday());

  // ✅ Nuevo evento inteligente
  $btnNewEvent?.addEventListener("click", () => openModalForNew(getSmartDefaultDateISO()));

  // Vista Mes/Lista
  $btnViewMonth?.addEventListener("click", () => setView("month"));
  $btnViewList?.addEventListener("click", () => setView("list"));

  // Search
  $searchEvents?.addEventListener("input", () => {
    UI_STATE.searchQuery = ($searchEvents.value || "").trim();
    rerender();
  });

  // Filters
  $filterCategory?.addEventListener("change", () => {
    UI_STATE.filterCategory = $filterCategory.value || "";
    rerender();
  });
  $filterStatus?.addEventListener("change", () => {
    UI_STATE.filterStatus = $filterStatus.value || "";
    rerender();
  });
  $filterAssignedTo?.addEventListener("change", () => {
    UI_STATE.filterAssignedTo = $filterAssignedTo.value || "";
    rerender();
  });

  // Modal
  $btnCancelModal?.addEventListener("click", closeModal);
  $modalOverlay?.addEventListener("click", closeModal);

  document.addEventListener("keydown", (e) => {
    const modalOpen = !$eventModal?.classList.contains("hidden");

    // No secuestrar atajos cuando estás escribiendo
    const tag = (e.target?.tagName || "").toLowerCase();
    const typing = ["input","textarea","select"].includes(tag) || e.target?.isContentEditable;

    // ESC cierra modal
    if (e.key === "Escape" && modalOpen) {
      e.preventDefault();
      closeModal();
      return;
    }

    // Ctrl/Cmd + Enter => guardar (submit)
    if (modalOpen && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      $eventForm?.requestSubmit?.();
      return;
    }

    // Ctrl/Cmd + K => enfocar búsqueda (si no estás escribiendo ya)
    if (!typing && (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "k")) {
      e.preventDefault();
      ($searchEvents || $filterCategory || $filterStatus)?.focus?.();
      return;
    }
  });

  $btnDeleteEvent?.addEventListener("click", (e) => {
    e.preventDefault();
    const id = UI_STATE.editingId;
    if (!id) return;
    UI_STATE.onDelete?.(id);
    closeModal();
  });

  $eventForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const payload = readModalPayload();
    if (!payload) return;

    if (UI_STATE.editingId) {
      UI_STATE.onUpdate?.(UI_STATE.editingId, payload);
    } else {
      UI_STATE.onCreate?.(payload);
    }
    closeModal();
  });

  // Calendar click delegation
  $calendarGrid?.addEventListener("click", (e) => {
    // click chip => editar / virtual => nuevo prefill
    const chip = e.target.closest("[data-event-id]");
    if (chip) {
      const id = chip.getAttribute("data-event-id");
      const ev = UI_STATE.events.find(x => x.id === id);
      if (ev && ev._virtualFromId) {
        openModalForNew(ev.dateISO, ev);
        return;
      }
      if (ev) openModalForEdit(ev);
      return;
    }

    // click "+N más" => abrir modal día
    const moreChip = e.target.closest("[data-more-date]");
    if (moreChip) {
      const dateISO = moreChip.getAttribute("data-more-date");
      openModalForNew(dateISO);
      return;
    }

    // click celda día => nuevo en ese día
    const dayCell = e.target.closest("[data-date]");
    if (dayCell) {
      const dateISO = dayCell.getAttribute("data-date");
      openModalForNew(dateISO);
    }
  });

  // Lista: delegación (más barata que listeners por fila)
  $listBody?.addEventListener("click", (e) => {
    const row = e.target.closest("[data-event-id]");
    if (!row) return;
    const id = row.getAttribute("data-event-id");
    const ev = UI_STATE.events.find(x => x.id === id);
    if (!ev) return;

    if (ev._virtualFromId) openModalForNew(ev.dateISO, ev);
    else openModalForEdit(ev);
  });

  // Overview: delegación
  const ovClick = (e) => {
    const btn = e.target.closest("[data-event-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-event-id");
    const ev = UI_STATE.events.find(x => x.id === id);
    if (!ev) return;

    if (ev._virtualFromId) openModalForNew(ev.dateISO, ev);
    else openModalForEdit(ev);
  };
  $todayList?.addEventListener("click", ovClick);
  $nextList?.addEventListener("click", ovClick);

  // default view
  setView("month", { silent: true });
  rerender();
}

/* =========================
   Public state setters
========================= */
export function setMonth(year, monthIndex) {
  UI_STATE.year = year;
  UI_STATE.monthIndex = monthIndex;
  rerender();
}

export function setEvents(events = []) {
  UI_STATE.rawEvents = Array.isArray(events) ? events : [];

  // ✅ repoblar responsables con base en raw + ASSIGNEES fijo
  populateAssignedSelect(UI_STATE.rawEvents);
  populateAssignedToModal(UI_STATE.rawEvents);

  // expand recurrentes SOLO para el rango visible actual
  UI_STATE.events = expandRecurringForVisibleRange(UI_STATE.rawEvents, UI_STATE.year, UI_STATE.monthIndex);

  rerender();

  // Si el modal está abierto, refresca “Eventos de este día”
  if ($eventDate && !$eventModal?.classList.contains("hidden")) {
    renderDayPeek($eventDate.value);
  }
}

export function getCurrentView() {
  return { year: UI_STATE.year, monthIndex: UI_STATE.monthIndex };
}

export function getFilters() {
  return {
    category: UI_STATE.filterCategory || "",
    status: UI_STATE.filterStatus || "",
    assignedTo: UI_STATE.filterAssignedTo || "",
    q: UI_STATE.searchQuery || ""
  };
}

/* =========================
   Render orchestrator
========================= */
function rerender() {
  // expand recurrentes (por si cambió mes)
  UI_STATE.events = expandRecurringForVisibleRange(UI_STATE.rawEvents, UI_STATE.year, UI_STATE.monthIndex);

  renderOverview();
  renderCalendar(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);

  // Solo lista si estás en vista lista
  if (UI_STATE.view === "list") {
    renderList(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);
  }
}

/* =========================
   Render principal (Mes)
========================= */
export function renderCalendar(year, monthIndex, events = []) {
  UI_STATE.year = year;
  UI_STATE.monthIndex = monthIndex;

  const monthDate = new Date(year, monthIndex, 1);
  if ($currentMonth) $currentMonth.textContent = capitalize(formatMonthTitle(monthDate));

  const gridDays = buildMonthGrid(year, monthIndex, CALENDAR_CONFIG.weekStartsOn);

  const filteredEvents = applyFilters(events);

  // agrupar por dateISO
  const byDay = new Map();
  for (const ev of filteredEvents) {
    const dateISO = ev.dateISO || "";
    if (!dateISO) continue;
    if (!byDay.has(dateISO)) byDay.set(dateISO, []);
    byDay.get(dateISO).push(ev);
  }

  // ordenar eventos dentro del día
  for (const arr of byDay.values()) {
    arr.sort((a, b) => {
      const aDone = (a.status === "done") ? 1 : 0;
      const bDone = (b.status === "done") ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone; // pendientes arriba

      const au = a.updatedAt?.toMillis ? a.updatedAt.toMillis() : 0;
      const bu = b.updatedAt?.toMillis ? b.updatedAt.toMillis() : 0;
      if (bu !== au) return bu - au;

      return String(a.title||"").localeCompare(String(b.title||""), "es");
    });
  }

  const today = new Date();

  if (!$calendarGrid) return;
  $calendarGrid.innerHTML = "";

  // headers
  const headers = buildWeekdayHeaders();
  for (const h of headers) {
    const el = document.createElement("div");
    el.className = "cal-head";
    el.textContent = h;
    $calendarGrid.appendChild(el);
  }

  // days
  for (const d of gridDays) {
    const dateISO = toISODateLocal(d);
    const inMonth = isSameMonth(d, year, monthIndex);
    const isTodayCell = isSameDay(d, today);

    const cell = document.createElement("div");
    cell.className = "day";
    if (!inMonth) cell.classList.add("muted");
    if (isTodayCell) cell.classList.add("today");
    cell.setAttribute("data-date", dateISO);

    const top = document.createElement("div");
    top.className = "day-top";
    top.innerHTML = `<span class="day-num">${d.getDate()}</span>`;
    cell.appendChild(top);

    const list = document.createElement("div");
    list.className = "event-list";

    const dayEvents = byDay.get(dateISO) || [];

    const maxShow = 2;
    const shown = dayEvents.slice(0, maxShow);
    const rest = dayEvents.length - shown.length;

    for (const ev of shown) list.appendChild(renderChip(ev));

    if (rest > 0) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "chip chip-more";
      more.textContent = `+${rest} más`;
      more.setAttribute("data-more-date", dateISO);
      list.appendChild(more);
    }

    cell.appendChild(list);
    $calendarGrid.appendChild(cell);
  }
}

/* =========================
   Vista Lista
========================= */
function renderList(year, monthIndex, events = []) {
  if (!$listBody || !$listView) return;

  const filtered = applyFilters(events).slice();
  filtered.sort((a, b) => {
    if (a.dateISO !== b.dateISO) return String(a.dateISO||"").localeCompare(String(b.dateISO||""));
    const aDone = (a.status === "done") ? 1 : 0;
    const bDone = (b.status === "done") ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    return String(a.title||"").localeCompare(String(b.title||""), "es");
  });

  if ($listTitle) $listTitle.textContent = "Eventos";
  if ($listMeta) {
    const txt = `${filtered.length} ${filtered.length === 1 ? "evento" : "eventos"}`;
    $listMeta.textContent = UI_STATE.searchQuery ? `${txt} · filtro: “${UI_STATE.searchQuery}”` : txt;
  }

  $listBody.innerHTML = "";

  if (!filtered.length) {
    $listBody.innerHTML = `<div class="muted" style="padding:12px 2px;">No hay eventos con estos filtros.</div>`;
    return;
  }

  // agrupar por dateISO
  let currentDate = "";
  for (const ev of filtered) {
    if ((ev.dateISO || "") !== currentDate) {
      currentDate = ev.dateISO || "";
      const h = document.createElement("div");
      h.className = "list-day";
      h.innerHTML = `<div class="list-day-title">${escapeHtml(currentDate || "Sin fecha")}</div>`;
      $listBody.appendChild(h);
    }

    const row = document.createElement("button");
    row.type = "button";
    row.className = "list-item";
    row.setAttribute("data-event-id", ev.id);

    const st = ev.status || "pending";
    const cat = ev.category || "otro";

    const who = (ev.assignedTo || "").trim();
    const rec = (ev.recurrence || "").trim();

    row.innerHTML = `
      <span class="list-dot" style="background:${catColor(cat)}"></span>
      <span class="list-main">
        <span class="list-title">${escapeHtml(ev.title || "(Sin título)")}</span>
        <span class="list-sub">
          <span class="list-pill">${escapeHtml(catLabel(cat))}</span>
          <span class="list-pill status">${escapeHtml(statusLabel(st))}</span>
          ${who ? `<span class="list-pill who">@${escapeHtml(who)}</span>` : ""}
          ${rec ? `<span class="list-pill rec">${escapeHtml(recurrenceLabel(rec))}</span>` : ""}
          ${ev._virtualFromId ? `<span class="list-pill ghost">Ocurrencia</span>` : ""}
        </span>
      </span>
      <span class="list-st" style="color:${STATUS_COLORS[st] || "#64748B"}">${escapeHtml(st === "done" ? "✓" : (st === "cancelled" ? "×" : "•"))}</span>
    `;

    $listBody.appendChild(row);
  }
}

/* =========================
   Overview: Hoy + Próximos 7
========================= */
function renderOverview() {
  const todayISO = toISODateLocal(new Date());
  const endISO = toISODateLocal(addDays(new Date(), 7));

  const filtered = applyFilters(UI_STATE.events);

  const todayItems = filtered
    .filter(ev => (ev.dateISO || "") === todayISO)
    .slice()
    .sort((a,b) => String(a.title||"").localeCompare(String(b.title||""), "es"));

  const nextItems = filtered
    .filter(ev => {
      const iso = ev.dateISO || "";
      return iso >= todayISO && iso <= endISO;
    })
    .slice()
    .sort((a,b) => {
      if (a.dateISO !== b.dateISO) return String(a.dateISO||"").localeCompare(String(b.dateISO||""));
      return String(a.title||"").localeCompare(String(b.title||""), "es");
    });

  if ($todayList) {
    $todayList.innerHTML = "";
    if (!todayItems.length) {
      $todayList.innerHTML = `<span class="muted">Sin eventos</span>`;
    } else {
      for (const ev of todayItems.slice(0, 4)) {
        $todayList.appendChild(renderMiniOverviewItem(ev));
      }
      if (todayItems.length > 4) {
        const m = document.createElement("div");
        m.className = "muted";
        m.textContent = `+${todayItems.length - 4} más…`;
        $todayList.appendChild(m);
      }
    }
  }

  if ($nextList) {
    $nextList.innerHTML = "";
    if (!nextItems.length) {
      $nextList.innerHTML = `<span class="muted">Sin eventos</span>`;
    } else {
      for (const ev of nextItems.slice(0, 6)) {
        $nextList.appendChild(renderMiniOverviewItem(ev, { showDate: true }));
      }
      if (nextItems.length > 6) {
        const m = document.createElement("div");
        m.className = "muted";
        m.textContent = `+${nextItems.length - 6} más…`;
        $nextList.appendChild(m);
      }
    }
  }
}

function renderMiniOverviewItem(ev, { showDate = false } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ov-item";
  btn.setAttribute("data-event-id", ev.id);

  const cat = ev.category || "otro";
  const who = (ev.assignedTo || "").trim();

  btn.innerHTML = `
    <span class="ov-dot" style="background:${catColor(cat)}"></span>
    <span class="ov-text">
      ${showDate ? `<span class="ov-date">${escapeHtml(ev.dateISO || "")}</span>` : ""}
      <span class="ov-title">${escapeHtml(ev.title || "(Sin título)")}</span>
      ${who ? `<span class="ov-who">@${escapeHtml(who)}</span>` : ""}
    </span>
  `;

  return btn;
}

/* =========================
   Chips
========================= */
function renderChip(ev) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.setAttribute("data-event-id", ev.id);

  const cat = ev.category || "otro";
  const st = ev.status || "pending";
  const who = (ev.assignedTo || "").trim();
  const rec = (ev.recurrence || "").trim();

  chip.style.borderLeftColor = catColor(cat);

  const titleBits = [
    `${catLabel(cat)} · ${statusLabel(st)}${rec ? ` · ${recurrenceLabel(rec)}` : ""}`,
    who ? `@${who}` : "",
    ev._virtualFromId ? "Ocurrencia (no guardada)" : "",
    ev.notes ? ev.notes : ""
  ].filter(Boolean).join(" · ");

  chip.title = titleBits;

  chip.innerHTML = `
    <span class="chip-dot" style="color:${STATUS_COLORS[st] || "#64748B"}">${escapeHtml(st === "done" ? "✓" : (st === "cancelled" ? "×" : "•"))}</span>
    <span class="chip-text">${escapeHtml(ev.title || "(Sin título)")}</span>
    ${who ? `<span class="chip-person">@${escapeHtml(who)}</span>` : ""}
  `;

  return chip;
}

/* =========================
   Modal
========================= */
function openModalForNew(dateISO, prefillFromEvent = null) {
  const iso = (dateISO && String(dateISO).trim()) ? String(dateISO).trim() : getSmartDefaultDateISO();

  UI_STATE.editingId = null;
  if ($modalTitle) $modalTitle.textContent = "Nuevo evento";

  const baseCat = CATEGORIES[0]?.id || "otro";

  // ✅ Asegurar selects del modal (por si abres modal antes de cargar eventos)
  populateAssignedToModal(UI_STATE.rawEvents);

  if ($eventTitle) $eventTitle.value = prefillFromEvent?.title ? String(prefillFromEvent.title) : "";
  if ($eventCategory) $eventCategory.value = prefillFromEvent?.category ? String(prefillFromEvent.category) : baseCat;
  if ($eventDate) $eventDate.value = iso;
  if ($eventStatus) $eventStatus.value = prefillFromEvent?.status ? String(prefillFromEvent.status) : "pending";
  if ($eventNotes) $eventNotes.value = prefillFromEvent?.notes ? String(prefillFromEvent.notes) : "";

  if ($eventAssignedTo) $eventAssignedTo.value = prefillFromEvent?.assignedTo ? String(prefillFromEvent.assignedTo) : "";
  if ($eventRecurrence) $eventRecurrence.value = ""; // virtual => no hereda por defecto

  hide($btnDeleteEvent);

  openModal();
  ensureModalEnhancements();
  renderDayPeek(iso);

  setTimeout(() => $eventTitle?.focus(), 0);
}

function openModalForEdit(ev) {
  UI_STATE.editingId = ev.id;
  if ($modalTitle) $modalTitle.textContent = "Editar evento";

  // ✅ Asegurar selects del modal (incluye el valor actual aunque no esté en ASSIGNEES)
  populateAssignedToModal(UI_STATE.rawEvents, ev.assignedTo || "");

  if ($eventTitle) $eventTitle.value = ev.title || "";
  if ($eventCategory) $eventCategory.value = ev.category || (CATEGORIES[0]?.id || "otro");
  if ($eventDate) $eventDate.value = ev.dateISO || "";
  if ($eventStatus) $eventStatus.value = ev.status || "pending";
  if ($eventNotes) $eventNotes.value = ev.notes || "";

  if ($eventAssignedTo) $eventAssignedTo.value = ev.assignedTo || "";
  if ($eventRecurrence) $eventRecurrence.value = ev.recurrence || "";

  show($btnDeleteEvent);

  openModal();
  ensureModalEnhancements();
  renderDayPeek($eventDate?.value || ev.dateISO || "");

  setTimeout(() => $eventTitle?.focus(), 0);
}

function readModalPayload() {
  const title = ($eventTitle?.value || "").trim();
  const category = ($eventCategory?.value || "").trim();
  const dateISO = ($eventDate?.value || "").trim();
  const status = ($eventStatus?.value || "pending").trim();
  const notes = ($eventNotes?.value || "").trim();

  const assignedTo = ($eventAssignedTo?.value || "").trim();
  const recurrence = ($eventRecurrence?.value || "").trim();

  const problems = [];
  if (!title) problems.push("Ponle un título al evento.");
  if (!category) problems.push("Elige una categoría.");
  if (!dateISO) problems.push("Elige una fecha.");

  if (dateISO && !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    problems.push("La fecha debe estar en formato yyyy-mm-dd.");
  }

  if (recurrence && !["weekly","monthly"].includes(recurrence)) {
    problems.push("Repetición inválida (semanal/mensual).");
  }

  if (problems.length) {
    notify(problems.join("\n"), { mode: "alert" });
    (problems[0].includes("título") ? $eventTitle :
      problems[0].includes("categoría") ? $eventCategory : $eventDate
    )?.focus?.();
    return null;
  }

  return { title, category, dateISO, status, notes, assignedTo, recurrence };
}

function openModal() {
  show($eventModal);
  show($modalOverlay);
  document.body.classList.add("modal-open");
}

function closeModal() {
  hide($eventModal);
  hide($modalOverlay);
  document.body.classList.remove("modal-open");
  UI_STATE.editingId = null;
}

/* =========================
   Modal Enhancements
   - Bloque "Eventos del día"
   - Botón "Duplicar"
========================= */
function ensureModalEnhancements() {
  const modalContent = $eventModal?.querySelector(".modal-content");
  if (!modalContent) return;

  // Bloque "Eventos del día"
  let peek = modalContent.querySelector("#dayPeek");
  if (!peek) {
    peek = document.createElement("div");
    peek.id = "dayPeek";
    peek.className = "day-peek";

    peek.innerHTML = `
      <div class="day-peek-head">
        <span class="day-peek-title">Eventos de este día</span>
        <span class="day-peek-sub" id="dayPeekCount">—</span>
      </div>
      <div class="day-peek-list" id="dayPeekList"></div>
    `;

    const head = modalContent.querySelector(".modal-head") || modalContent.querySelector("h3");
    if (head?.nextSibling) head.parentNode.insertBefore(peek, head.nextSibling);
    else modalContent.appendChild(peek);
  }

  // Botón duplicar
  const actionsRight = modalContent.querySelector(".modal-actions-right");
  if (actionsRight && !modalContent.querySelector("#btnDuplicateEvent")) {
    const dup = document.createElement("button");
    dup.type = "button";
    dup.id = "btnDuplicateEvent";
    dup.className = "btn ghost";
    dup.textContent = "Duplicar";

    dup.addEventListener("click", () => {
      const payload = readModalPayload();
      if (!payload) return;

      UI_STATE.editingId = null;
      if ($modalTitle) $modalTitle.textContent = "Nuevo evento (duplicado)";
      hide($btnDeleteEvent);

      payload.title = payload.title ? `${payload.title} (copia)` : "Evento (copia)";
      UI_STATE.onCreate?.(payload);
      closeModal();
    });

    const submitBtn = actionsRight.querySelector("button[type='submit']");
    actionsRight.insertBefore(dup, submitBtn || null);
  }

  // refrescar day peek al cambiar fecha
  if ($eventDate && !$eventDate.dataset.peekBound) {
    $eventDate.dataset.peekBound = "1";
    $eventDate.addEventListener("change", () => renderDayPeek($eventDate.value));
  }
}

function renderDayPeek(dateISO) {
  const $count = qs("#dayPeekCount");
  const $list  = qs("#dayPeekList");
  if (!$count || !$list) return;

  const iso = (dateISO || "").trim();
  if (!iso) {
    $count.textContent = "";
    $list.innerHTML = `<div class="day-peek-empty">Sin fecha.</div>`;
    return;
  }

  const items = applyFilters(UI_STATE.events || [])
    .filter(ev => (ev.dateISO || "") === iso)
    .sort((a, b) => String(a.title||"").localeCompare(String(b.title||""), "es"));

  $count.textContent = `${items.length} ${items.length === 1 ? "evento" : "eventos"}`;

  if (!items.length) {
    $list.innerHTML = `<div class="day-peek-empty">No hay eventos ese día.</div>`;
    return;
  }

  $list.innerHTML = "";
  for (const ev of items.slice(0, 6)) {
    const who = (ev.assignedTo || "").trim();
    const rec = (ev.recurrence || "").trim();

    const row = document.createElement("button");
    row.type = "button";
    row.className = "day-peek-item";
    row.setAttribute("data-event-id", ev.id);

    row.innerHTML = `
      <span class="day-peek-dot" style="background:${catColor(ev.category || "otro")}"></span>
      <span class="day-peek-text">
        ${escapeHtml(ev.title || "(Sin título)")}
        ${who ? `<span class="day-peek-who"> @${escapeHtml(who)}</span>` : ""}
        ${rec ? `<span class="day-peek-rec"> · ${escapeHtml(recurrenceLabel(rec))}</span>` : ""}
        ${ev._virtualFromId ? `<span class="day-peek-ghost"> · ocurrencia</span>` : ""}
      </span>
      <span class="day-peek-st">${escapeHtml(statusLabel(ev.status || "pending"))}</span>
    `;

    $list.appendChild(row);
  }

  if (items.length > 6) {
    const more = document.createElement("div");
    more.className = "day-peek-more";
    more.textContent = `+${items.length - 6} más…`;
    $list.appendChild(more);
  }
}

/* =========================
   Navegación
========================= */
function shiftMonth(delta) {
  const d = new Date(UI_STATE.year, UI_STATE.monthIndex + delta, 1);
  UI_STATE.year = d.getFullYear();
  UI_STATE.monthIndex = d.getMonth();

  UI_STATE.onNavigate?.({ year: UI_STATE.year, monthIndex: UI_STATE.monthIndex });
  rerender();
}

function goToday() {
  const now = new Date();
  UI_STATE.year = now.getFullYear();
  UI_STATE.monthIndex = now.getMonth();

  UI_STATE.onNavigate?.({ year: UI_STATE.year, monthIndex: UI_STATE.monthIndex });
  rerender();
}

/* =========================
   View switch
========================= */
function setView(view, { silent = false } = {}) {
  UI_STATE.view = (view === "list") ? "list" : "month";

  $btnViewMonth?.classList.toggle("active", UI_STATE.view === "month");
  $btnViewList?.classList.toggle("active", UI_STATE.view === "list");

  $btnViewMonth?.setAttribute("aria-selected", UI_STATE.view === "month" ? "true" : "false");
  $btnViewList?.setAttribute("aria-selected", UI_STATE.view === "list" ? "true" : "false");

  $monthView?.classList.toggle("hidden", UI_STATE.view !== "month");
  $listView?.classList.toggle("hidden", UI_STATE.view !== "list");

  if (!silent) rerender();
}

/* =========================
   Filtros + búsqueda
========================= */
function applyFilters(events) {
  const cat = UI_STATE.filterCategory || "";
  const st  = UI_STATE.filterStatus || "";
  const who = UI_STATE.filterAssignedTo || "";
  const q   = (UI_STATE.searchQuery || "").toLowerCase();

  return (events || []).filter(ev => {
    if (cat && ev.category !== cat) return false;
    if (st && ev.status !== st) return false;

    const assigned = String(ev.assignedTo || "").trim();
    if (who && assigned !== who) return false;

    if (q) {
      const hay = [
        ev.title || "",
        ev.notes || "",
        ev.assignedTo || "",
        ev.category || "",
        ev.status || ""
      ].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });
}

/* =========================
   Selects
========================= */
function populateCategorySelects() {
  if ($filterCategory) {
    const keep = $filterCategory.querySelector("option[value='']");
    $filterCategory.innerHTML = "";
    if (keep) $filterCategory.appendChild(keep);

    for (const c of CATEGORIES) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.label;
      $filterCategory.appendChild(opt);
    }
  }

  if ($eventCategory) {
    $eventCategory.innerHTML = "";
    for (const c of CATEGORIES) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.label;
      $eventCategory.appendChild(opt);
    }
  }
}

function populateStatusSelects() {
  if ($eventStatus) {
    $eventStatus.innerHTML = "";
    for (const s of EVENT_STATUS) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.label;
      $eventStatus.appendChild(opt);
    }
  }
}

/**
 * ✅ Lista final de responsables:
 * - ASSIGNEES fijo (si existe)
 * - + responsables encontrados en eventos
 * - sin duplicados (normalizado)
 * - orden alfabético (es)
 */
function getMergedAssigneesFrom(events = []) {
  const fixed = Array.isArray(ASSIGNEES) ? ASSIGNEES : [];

  const dynamic = (events || [])
    .map(e => String(e.assignedTo || "").trim())
    .filter(Boolean);

  // dedup robusto (case-insensitive + trim)
  const map = new Map();
  for (const name of [...fixed, ...dynamic]) {
    const clean = String(name || "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!map.has(key)) map.set(key, clean);
  }

  return Array.from(map.values()).sort((a,b) => a.localeCompare(b, "es"));
}

/**
 * ✅ Filtro por responsable (#filterAssignedTo)
 * - siempre incluye ASSIGNEES fijo
 * - + merge con responsables existentes en eventos
 * - preserva selección si aún existe
 */
function populateAssignedSelect(events) {
  if (!$filterAssignedTo) return;

  const prev = $filterAssignedTo.value || "";
  const keep = $filterAssignedTo.querySelector("option[value='']");

  const list = getMergedAssigneesFrom(events);

  $filterAssignedTo.innerHTML = "";
  if (keep) $filterAssignedTo.appendChild(keep);

  for (const name of list) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    $filterAssignedTo.appendChild(opt);
  }

  // mantener selección si sigue existiendo
  if (prev && list.includes(prev)) $filterAssignedTo.value = prev;
  else if (prev && prev !== "") $filterAssignedTo.value = "";
}

/**
 * ✅ Modal Asignado a (#eventAssignedTo)
 * - siempre incluye ASSIGNEES fijo
 * - + merge con responsables existentes en eventos
 * - asegura que el valor actual exista como option aunque no esté en lista
 */
function populateAssignedToModal(events, ensureValue = "") {
  if (!$eventAssignedTo) return;

  const prev = ($eventAssignedTo.value || "").trim();
  const desired = String(ensureValue || prev || "").trim();

  const keepEmpty =
    $eventAssignedTo.querySelector("option[value='']") ||
    (() => {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "—";
      return opt;
    })();

  const list = getMergedAssigneesFrom(events);

  // si el evento trae un responsable que no está en fijo ni dinámico (raro pero posible),
  // lo garantizamos para no “borrar” visualmente el valor.
  if (desired && !list.includes(desired)) list.push(desired);

  list.sort((a,b) => a.localeCompare(b, "es"));

  $eventAssignedTo.innerHTML = "";
  $eventAssignedTo.appendChild(keepEmpty);

  for (const name of list) {
    if (!name) continue;
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    $eventAssignedTo.appendChild(opt);
  }

  // restaurar selección
  $eventAssignedTo.value = desired || "";
}

function buildWeekdayHeaders() {
  const base = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const start = CALENDAR_CONFIG.weekStartsOn || 0;
  const out = [];
  for (let i = 0; i < 7; i++) out.push(base[(start + i) % 7]);
  return out;
}

/* =========================
   Recurrentes: expansión en rango visible
========================= */
function expandRecurringForVisibleRange(rawEvents, year, monthIndex) {
  const events = Array.isArray(rawEvents) ? rawEvents : [];

  const gridDays = buildMonthGrid(year, monthIndex, CALENDAR_CONFIG.weekStartsOn);
  const fromISO = toISODateLocal(gridDays[0]);
  const toISO   = toISODateLocal(gridDays[gridDays.length - 1]);

  const out = [];

  for (const ev of events) {
    out.push(ev);

    const rec = String(ev.recurrence || "").trim();
    if (!rec) continue;

    const startISO = String(ev.dateISO || "").trim();
    if (!startISO) continue;

    if (rec === "weekly") {
      out.push(...expandWeekly(ev, startISO, fromISO, toISO));
    } else if (rec === "monthly") {
      out.push(...expandMonthly(ev, startISO, fromISO, toISO));
    }
  }

  // Dedup limpio
  const seen = new Set();
  const cleaned = [];
  for (const e of out) {
    const key = `${e.id}::${e.dateISO || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(e);
  }

  return cleaned;
}

function expandWeekly(ev, startISO, fromISO, toISO) {
  const res = [];
  let cur = isoToDate(startISO);
  const fromD = isoToDate(fromISO);
  const toD = isoToDate(toISO);

  while (cur < fromD) cur = addDays(cur, 7);

  while (cur <= toD) {
    const iso = toISODateLocal(cur);
    if (iso !== startISO) res.push(makeVirtualOccurrence(ev, iso));
    cur = addDays(cur, 7);
  }

  return res;
}

function expandMonthly(ev, startISO, fromISO, toISO) {
  const res = [];

  const start = isoToDate(startISO);
  const fromD = isoToDate(fromISO);
  const toD   = isoToDate(toISO);

  // arrancar desde el mes del rango, con el mismo día del start
  let cur = new Date(fromD.getFullYear(), fromD.getMonth(), start.getDate(), 0,0,0,0);

  // No crear ocurrencias antes de la fecha de inicio real del evento
  while (cur < start) cur = addMonthsSafe(cur, 1);

  // entrar al rango visible
  while (cur < fromD) cur = addMonthsSafe(cur, 1);

  while (cur <= toD) {
    const iso = toISODateLocal(cur);
    if (iso !== startISO) res.push(makeVirtualOccurrence(ev, iso));
    cur = addMonthsSafe(cur, 1);
  }

  return res;
}

function makeVirtualOccurrence(ev, dateISO) {
  return {
    ...ev,
    id: `${ev.id}__v__${dateISO}`,
    dateISO,
    _virtualFromId: ev.id
  };
}

/* =========================
   Helpers
========================= */
function show(el){ el?.classList.remove("hidden"); }
function hide(el){ el?.classList.add("hidden"); }

function capitalize(s = "") {
  const str = String(s);
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * ✅ Fecha default inteligente para "Nuevo evento"
 */
function getSmartDefaultDateISO() {
  const now = new Date();
  const viewingThisMonth = (UI_STATE.year === now.getFullYear() && UI_STATE.monthIndex === now.getMonth());
  return viewingThisMonth
    ? toISODateLocal(now)
    : toISODateLocal(new Date(UI_STATE.year, UI_STATE.monthIndex, 1));
}

/* =========================
   Tiny date utils (local)
========================= */
function isoToDate(iso) {
  const [y,m,d] = String(iso || "").split("-").map(n => parseInt(n, 10));
  return new Date(y, (m||1)-1, d||1, 0,0,0,0);
}

function addDays(date, days) {
  const d = (date instanceof Date) ? new Date(date) : new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

function addMonthsSafe(date, months) {
  const d = (date instanceof Date) ? new Date(date) : new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + Number(months || 0));
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

/* =========================
   Notificaciones
========================= */
function notify(msg, { mode = "toast", ms = 2600 } = {}) {
  const text = String(msg || "").trim();
  if (!text) return;

  if (mode === "alert" || !$toastHost) {
    alert(text);
    return;
  }

  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  $toastHost.appendChild(t);

  setTimeout(() => {
    t.classList.add("hide");
    setTimeout(() => t.remove(), 220);
  }, ms);
}
