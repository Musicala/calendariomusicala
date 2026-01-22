/* =============================================================================
  js/ui.js — UI del calendario (render + modal + filtros) — vPRO++
  -----------------------------------------------------------------------------
  - Render grilla mensual (6x7)
  - Chips de eventos por día
  - Modal crear/editar
  - Filtros
  - Callbacks para app.js

  ✅ Fix: "Nuevo evento" inteligente:
     - Si estás viendo el mes actual => usa HOY
     - Si estás en otro mes => usa día 1 del mes en pantalla
  ✅ "+N más" abre el modal en ese día
  ✅ Modal muestra "Eventos del día" (mini lista) para no ir a ciegas
  ✅ Botón "Duplicar" evento (crea uno nuevo mismo contenido)
  ✅ Atajos: ESC cierra, Ctrl/Cmd+Enter guarda, Ctrl/Cmd+K enfoca filtros
============================================================================= */

import { CATEGORIES, EVENT_STATUS, STATUS_COLORS, CALENDAR_CONFIG } from "./constants.js";
import {
  buildMonthGrid,
  formatMonthTitle,
  isSameMonth,
  isSameDay,
  toISODateLocal,
  qs,
  qsa,
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

const $filterCategory = qs("#filterCategory");
const $filterStatus   = qs("#filterStatus");

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

/* =========================
   Estado UI
========================= */
let UI_STATE = {
  year: new Date().getFullYear(),
  monthIndex: new Date().getMonth(),
  events: [],

  // filtros
  filterCategory: "",
  filterStatus: "",

  // modal
  editingId: null,

  // callbacks (inyectados por app.js)
  onNavigate: null,      // ({year, monthIndex}) => void
  onCreate: null,        // (payload) => void
  onUpdate: null,        // (id, payload) => void
  onDelete: null,        // (id) => void
};

/* =========================
   Helpers categorías/labels
========================= */
const CAT_BY_ID = new Map(CATEGORIES.map(c => [c.id, c]));
function catLabel(id){
  return CAT_BY_ID.get(id)?.label || id || "Sin categoría";
}
function catColor(id){
  return CAT_BY_ID.get(id)?.color || "#64748B";
}
function statusLabel(id){
  return EVENT_STATUS.find(s => s.id === id)?.label || id || "Pendiente";
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

  // Toolbar
  $btnPrevMonth?.addEventListener("click", () => shiftMonth(-1));
  $btnNextMonth?.addEventListener("click", () => shiftMonth(+1));
  $btnToday?.addEventListener("click", () => goToday());

  // ✅ Nuevo evento inteligente
  $btnNewEvent?.addEventListener("click", () => {
    openModalForNew(getSmartDefaultDateISO());
  });

  // Filters
  $filterCategory?.addEventListener("change", () => {
    UI_STATE.filterCategory = $filterCategory.value || "";
    renderCalendar(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);
  });
  $filterStatus?.addEventListener("change", () => {
    UI_STATE.filterStatus = $filterStatus.value || "";
    renderCalendar(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);
  });

  // Modal
  $btnCancelModal?.addEventListener("click", closeModal);
  $modalOverlay?.addEventListener("click", closeModal);

  document.addEventListener("keydown", (e) => {
    const modalOpen = !$eventModal?.classList.contains("hidden");

    // ESC cierra modal
    if (e.key === "Escape" && modalOpen) {
      closeModal();
      return;
    }

    // Ctrl/Cmd + Enter => guardar (submit)
    if (modalOpen && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      $eventForm?.requestSubmit?.();
      return;
    }

    // Ctrl/Cmd + K => enfocar filtro (categoría primero)
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "k")) {
      e.preventDefault();
      ($filterCategory || $filterStatus)?.focus?.();
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
    // click chip => editar
    const chip = e.target.closest("[data-event-id]");
    if (chip) {
      const id = chip.getAttribute("data-event-id");
      const ev = UI_STATE.events.find(x => x.id === id);
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

  renderCalendar(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);
}

/* =========================
   Public state setters
========================= */
export function setMonth(year, monthIndex) {
  UI_STATE.year = year;
  UI_STATE.monthIndex = monthIndex;
  renderCalendar(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);
}

export function setEvents(events = []) {
  UI_STATE.events = Array.isArray(events) ? events : [];
  renderCalendar(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);

  // Si el modal está abierto, refresca el “Eventos del día”
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
    status: UI_STATE.filterStatus || ""
  };
}

/* =========================
   Render principal
========================= */
export function renderCalendar(year, monthIndex, events = []) {
  UI_STATE.year = year;
  UI_STATE.monthIndex = monthIndex;

  const monthDate = new Date(year, monthIndex, 1);
  if ($currentMonth) $currentMonth.textContent = capitalize(formatMonthTitle(monthDate));

  const gridDays = buildMonthGrid(year, monthIndex, CALENDAR_CONFIG.weekStartsOn);

  // agrupar eventos por dateISO
  const filteredEvents = applyFilters(events);
  const byDay = new Map();

  for (const ev of filteredEvents) {
    const dateISO = ev.dateISO || (ev.dateStart?.toDate ? toISODateLocal(ev.dateStart.toDate()) : "");
    if (!dateISO) continue;
    if (!byDay.has(dateISO)) byDay.set(dateISO, []);
    byDay.get(dateISO).push(ev);
  }

  // ordenar eventos dentro del día (updated desc, title asc)
  for (const [k, arr] of byDay.entries()) {
    arr.sort((a, b) => {
      const au = a.updatedAt?.toMillis ? a.updatedAt.toMillis() : 0;
      const bu = b.updatedAt?.toMillis ? b.updatedAt.toMillis() : 0;
      if (bu !== au) return bu - au;
      return String(a.title||"").localeCompare(String(b.title||""), "es");
    });
  }

  const today = new Date();

  if ($calendarGrid) {
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
      const maxShow = 3;
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
  const color = catColor(cat);

  const st = ev.status || "pending";
  const stDot = st === "done" ? "✓" : (st === "cancelled" ? "×" : "•");

  chip.style.borderLeftColor = color;
  chip.title = `${catLabel(cat)} · ${statusLabel(st)}${ev.notes ? " · " + ev.notes : ""}`;
  chip.innerHTML = `
    <span class="chip-dot" style="color:${STATUS_COLORS[st] || "#64748B"}">${stDot}</span>
    <span class="chip-text">${escapeHtml(ev.title || "(Sin título)")}</span>
  `;
  return chip;
}

/* =========================
   Modal
========================= */
function openModalForNew(dateISO) {
  const iso = (dateISO && String(dateISO).trim()) ? String(dateISO).trim() : getSmartDefaultDateISO();

  UI_STATE.editingId = null;
  if ($modalTitle) $modalTitle.textContent = "Nuevo evento";

  if ($eventTitle) $eventTitle.value = "";
  if ($eventCategory) $eventCategory.value = CATEGORIES[0]?.id || "otro";
  if ($eventDate) $eventDate.value = iso;
  if ($eventStatus) $eventStatus.value = "pending";
  if ($eventNotes) $eventNotes.value = "";

  hide($btnDeleteEvent);

  openModal();
  ensureModalEnhancements();
  renderDayPeek(iso);

  setTimeout(() => $eventTitle?.focus(), 0);
}

function openModalForEdit(ev) {
  UI_STATE.editingId = ev.id;
  if ($modalTitle) $modalTitle.textContent = "Editar evento";

  if ($eventTitle) $eventTitle.value = ev.title || "";
  if ($eventCategory) $eventCategory.value = ev.category || "otro";
  if ($eventDate) $eventDate.value = ev.dateISO || "";
  if ($eventStatus) $eventStatus.value = ev.status || "pending";
  if ($eventNotes) $eventNotes.value = ev.notes || "";

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

  // Validación suave (sin arruinar el mood con 20 alerts)
  const problems = [];
  if (!title) problems.push("Ponle un título al evento.");
  if (!category) problems.push("Elige una categoría.");
  if (!dateISO) problems.push("Elige una fecha.");

  if (dateISO && !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    problems.push("La fecha debe estar en formato yyyy-mm-dd.");
  }

  if (problems.length) {
    alert(problems.join("\n"));
    (problems[0].includes("título") ? $eventTitle :
      problems[0].includes("categoría") ? $eventCategory : $eventDate
    )?.focus?.();
    return null;
  }

  return { title, category, dateISO, status, notes };
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
   Modal Enhancements (inyectado)
   - Bloque "Eventos del día"
   - Botón "Duplicar" en acciones
========================= */
function ensureModalEnhancements() {
  const modalContent = $eventModal?.querySelector(".modal-content");
  if (!modalContent) return;

  // Bloque "Eventos del día" (debajo del título)
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

    const h3 = modalContent.querySelector("h3");
    if (h3?.nextSibling) {
      h3.parentNode.insertBefore(peek, h3.nextSibling);
    } else {
      modalContent.appendChild(peek);
    }
  }

  // Botón duplicar (en acciones derecha, antes de guardar)
  const actionsRight = modalContent.querySelector(".modal-actions-right");
  if (actionsRight && !modalContent.querySelector("#btnDuplicateEvent")) {
    const dup = document.createElement("button");
    dup.type = "button";
    dup.id = "btnDuplicateEvent";
    dup.className = "btn ghost";
    dup.textContent = "Duplicar";

    dup.addEventListener("click", () => {
      // Duplica lo que hay en el formulario, pero fuerza "nuevo"
      const payload = readModalPayload();
      if (!payload) return;

      UI_STATE.editingId = null;
      if ($modalTitle) $modalTitle.textContent = "Nuevo evento (duplicado)";
      hide($btnDeleteEvent);

      // Sutil ajuste al título para no pisar mentalmente
      payload.title = payload.title ? `${payload.title} (copia)` : "Evento (copia)";

      // llama onCreate directo y cierra
      UI_STATE.onCreate?.(payload);
      closeModal();
    });

    // Inserta antes del botón Guardar
    const submitBtn = actionsRight.querySelector("button[type='submit']");
    actionsRight.insertBefore(dup, submitBtn || null);
  }

  // Si cambian la fecha en el modal, refrescar el day peek
  if ($eventDate && !$eventDate.dataset.peekBound) {
    $eventDate.dataset.peekBound = "1";
    $eventDate.addEventListener("change", () => {
      renderDayPeek($eventDate.value);
    });
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

  const items = (UI_STATE.events || [])
    .filter(ev => (ev.dateISO || "") === iso)
    .sort((a, b) => {
      const au = a.updatedAt?.toMillis ? a.updatedAt.toMillis() : 0;
      const bu = b.updatedAt?.toMillis ? b.updatedAt.toMillis() : 0;
      if (bu !== au) return bu - au;
      return String(a.title||"").localeCompare(String(b.title||""), "es");
    });

  $count.textContent = `${items.length} ${items.length === 1 ? "evento" : "eventos"}`;

  if (!items.length) {
    $list.innerHTML = `<div class="day-peek-empty">No hay eventos ese día.</div>`;
    return;
  }

  $list.innerHTML = "";
  for (const ev of items.slice(0, 6)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "day-peek-item";
    row.innerHTML = `
      <span class="day-peek-dot" style="background:${catColor(ev.category || "otro")}"></span>
      <span class="day-peek-text">${escapeHtml(ev.title || "(Sin título)")}</span>
      <span class="day-peek-st">${escapeHtml(statusLabel(ev.status || "pending"))}</span>
    `;
    row.addEventListener("click", () => openModalForEdit(ev));
    $list.appendChild(row);
  }

  if (items.length > 6) {
    const more = document.createElement("div");
    more.className = "day-peek-more";
    more.textContent = `+${items.length - 6} más (mira en el calendario)`;
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
  renderCalendar(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);
}

function goToday() {
  const now = new Date();
  UI_STATE.year = now.getFullYear();
  UI_STATE.monthIndex = now.getMonth();

  UI_STATE.onNavigate?.({ year: UI_STATE.year, monthIndex: UI_STATE.monthIndex });
  renderCalendar(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);
}

/* =========================
   Filtros
========================= */
function applyFilters(events) {
  const cat = UI_STATE.filterCategory || "";
  const st = UI_STATE.filterStatus || "";

  return (events || []).filter(ev => {
    if (cat && ev.category !== cat) return false;
    if (st && ev.status !== st) return false;
    return true;
  });
}

/* =========================
   Selects
========================= */
function populateCategorySelects() {
  // filtro
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

  // modal
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

function buildWeekdayHeaders() {
  const base = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const start = CALENDAR_CONFIG.weekStartsOn || 0;
  const out = [];
  for (let i = 0; i < 7; i++) out.push(base[(start + i) % 7]);
  return out;
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
 * - Si estamos en el mes actual => hoy
 * - Si no => día 1 del mes en pantalla
 */
function getSmartDefaultDateISO() {
  const now = new Date();
  const viewingThisMonth = (UI_STATE.year === now.getFullYear() && UI_STATE.monthIndex === now.getMonth());
  return viewingThisMonth
    ? toISODateLocal(now)
    : toISODateLocal(new Date(UI_STATE.year, UI_STATE.monthIndex, 1));
}
