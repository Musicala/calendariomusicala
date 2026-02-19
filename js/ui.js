/* =============================================================================
  js/ui.js — UI del calendario (render + modal + filtros) — vPRO∞ (RECURRENCE PRO)
  -----------------------------------------------------------------------------
  - Render grilla mensual (6x7)
  - Chips de eventos por día (compact + @asignado)
  - ✅ Quick toggle done/pending sin abrir modal (accesible teclado + UX rápida)
  - Modal crear/editar (Asignado a + Repetición PRO)
  - Filtros: categoría, estado, persona
  - Búsqueda: título, notas, persona (con debounce)
  - Vistas: Mes / Lista
  - ✅ Overview: Hoy + Próximos 7 compacto
  - ✅ Recurrentes PRO:
      recurrence: null | { type:"interval", unit:"day|week|month|year", interval:number }
    Backward compatible: "" | "weekly" | "monthly" | "yearly"
  - ✅ Modal limpio + enhancements
============================================================================= */

import {
  getCategories,
  setCategories,
  resetCategories,
  DEFAULT_CATEGORIES,
  getAssignees,
  setAssignees,
  resetAssignees,
  DEFAULT_ASSIGNEES,
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
  escapeHtml,
  debounce
} from "./utils.js";

/* =========================
   DOM refs (index.html)
========================= */
const $currentMonth = qs("#currentMonth");
const $btnPrevMonth = qs("#btnPrevMonth");
const $btnNextMonth = qs("#btnNextMonth");
const $btnToday     = qs("#btnToday");
const $btnNewEvent  = qs("#btnNewEvent");

const $searchEvents = qs("#searchEvents");
const $btnViewMonth = qs("#btnViewMonth");
const $btnViewList  = qs("#btnViewList");
const $monthView    = qs("#monthView");
const $listView     = qs("#listView");
const $listBody     = qs("#listBody");
const $listTitle    = qs("#listTitle");
const $listMeta     = qs("#listMeta");

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

// Asignado + recurrencia (si no existen, no rompe)
const $eventAssignedTo = qs("#eventAssignedTo");
const $eventRecurrence = qs("#eventRecurrence"); // puede ser select o input hidden; lo soportamos igual

const $toastHost = qs("#toastHost");

/* =========================
   Config UI (tuneable)
========================= */
const DAY_MAX_SHOW = Infinity;

const OVERVIEW_TODAY_MAX  = 2;
const OVERVIEW_NEXT_MAX   = 3;
const OVERVIEW_DAYS_AHEAD = 7;

// Search debounce (menos re-render histérico)
const SEARCH_DEBOUNCE_MS = 180;

/* =========================
   Estado UI
========================= */
let UI_STATE = {
  year: new Date().getFullYear(),
  monthIndex: new Date().getMonth(),

  rawEvents: [],    // tal cual viene de db

  categories: getCategories(), // categorías editables (localStorage override)

  events: [],       // incluye expansión recurrentes (rango visible)

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
let CAT_BY_ID = new Map();

function rebuildCategoryMap() {
  const cats = Array.isArray(UI_STATE.categories) ? UI_STATE.categories : getCategories();
  CAT_BY_ID = new Map(cats.map(c => [c.id, c]));
}

function catLabel(id) {
  return CAT_BY_ID.get(id)?.label || id || "Sin categoría";
}
function catColor(id) {
  return CAT_BY_ID.get(id)?.color || "#64748B";
}

function statusLabel(id) {
  return EVENT_STATUS.find(s => s.id === id)?.label || id || "Pendiente";
}

/* =========================
   Recurrence PRO helpers
========================= */
function normTextLocal(v) {
  return String(v ?? "").trim().toLowerCase();
}

function normalizeRecurrence(raw) {
  // vacíos
  if (raw === null || raw === undefined || raw === "") return null;

  // Legacy strings
  if (typeof raw === "string") {
    const s = normTextLocal(raw);

    if (s === "weekly")  return { type: "interval", unit: "week",  interval: 1 };
    if (s === "monthly") return { type: "interval", unit: "month", interval: 1 };
    if (s === "yearly")  return { type: "interval", unit: "year",  interval: 1 };

    // JSON string
    if (s.startsWith("{") && s.endsWith("}")) {
      try {
        return normalizeRecurrence(JSON.parse(raw));
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  // Object
  if (typeof raw === "object") {
    const unit = normTextLocal(raw.unit || raw.everyUnit || raw.frequency || "");
    const interval = parseInt(raw.interval ?? raw.every ?? raw.count ?? 1, 10);

    if (!["day","week","month","year"].includes(unit)) return null;
    if (!Number.isFinite(interval) || interval < 1 || interval > 100) return null;

    return { type: "interval", unit, interval };
  }

  return null;
}

function recurrenceToSelectValue(rec) {
  const r = normalizeRecurrence(rec);
  if (!r) return "";
  // Para select usamos JSON string para opciones avanzadas
  return JSON.stringify({ unit: r.unit, interval: r.interval });
}

function parseRecurrenceFromControlValue(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;

  // Si viene legacy
  if (["weekly","monthly","yearly"].includes(v)) return normalizeRecurrence(v);

  // Si viene JSON
  if (v.startsWith("{") && v.endsWith("}")) {
    try { return normalizeRecurrence(JSON.parse(v)); } catch (_) { return null; }
  }

  // Si viene algo raro: no repetimos
  return null;
}

function recurrenceLabel(rec) {
  const r = normalizeRecurrence(rec);
  if (!r) return "";

  const { unit, interval } = r;

  // Nombres bonitos
  const unitLabel = (u, n) => {
    if (u === "day")   return n === 1 ? "día" : "días";
    if (u === "week")  return n === 1 ? "semana" : "semanas";
    if (u === "month") return n === 1 ? "mes" : "meses";
    if (u === "year")  return n === 1 ? "año" : "años";
    return u;
  };

  // Atajos “humanos”
  if (unit === "week"  && interval === 1) return "Semanal";
  if (unit === "month" && interval === 1) return "Mensual";
  if (unit === "month" && interval === 6) return "Semestral";
  if (unit === "year"  && interval === 1) return "Anual";

  return `Cada ${interval} ${unitLabel(unit, interval)}`;
}

/* =========================
   Init
========================= */
export function initUI({ onNavigate, onCreate, onUpdate, onDelete } = {}) {
  UI_STATE.onNavigate = onNavigate || null;
  UI_STATE.onCreate   = onCreate   || null;
  UI_STATE.onUpdate   = onUpdate   || null;
  UI_STATE.onDelete   = onDelete   || null;

  UI_STATE.categories = getCategories();
  rebuildCategoryMap();
  populateCategorySelects();
  ensureCategoryManagerUI();

  // Responsables editables
  ensureAssigneeManagerUI();

  populateStatusSelects();
  populateRecurrenceSelect();        // 👈 ahora PRO
  ensureRecurrenceAdvancedUI();      // 👈 UI progresiva “cada X”

  // Inicial: no depende de eventos. Mete ASSIGNEES sí o sí.
  populateAssignedSelect([]);
  populateAssignedToModal([]);

  // Toolbar
  $btnPrevMonth?.addEventListener("click", () => shiftMonth(-1));
  $btnNextMonth?.addEventListener("click", () => shiftMonth(+1));
  $btnToday?.addEventListener("click", () => goToday());

  // Nuevo evento inteligente
  $btnNewEvent?.addEventListener("click", () => openModalForNew(getSmartDefaultDateISO()));

  // Vista Mes/Lista
  $btnViewMonth?.addEventListener("click", () => setView("month"));
  $btnViewList?.addEventListener("click", () => setView("list"));

  // Search (debounced)
  const onSearch = debounce(() => {
    UI_STATE.searchQuery = ($searchEvents?.value || "").trim();
    rerender();
  }, SEARCH_DEBOUNCE_MS);

  $searchEvents?.addEventListener("input", onSearch);

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

    if (e.key === "Escape" && modalOpen) {
      e.preventDefault();
      closeModal();
      return;
    }

    // Ctrl/Cmd + Enter => guardar
    if (modalOpen && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      $eventForm?.requestSubmit?.();
      return;
    }

    // Ctrl/Cmd + K => enfocar búsqueda
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

  // =========================
  // Delegación clicks calendario
  // =========================
  $calendarGrid?.addEventListener("click", (e) => {
    // 1) Quick toggle
    const check = e.target.closest("[data-quick-toggle]");
    if (check) {
      e.preventDefault();
      e.stopPropagation();
      const id = check.getAttribute("data-quick-toggle");
      quickToggleDone(id);
      return;
    }

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

    // click celda día => nuevo en ese día
    const dayCell = e.target.closest("[data-date]");
    if (dayCell) {
      const dateISO = dayCell.getAttribute("data-date");
      openModalForNew(dateISO);
    }
  });

  // =========================
  // Quick toggle por teclado (Enter/Espacio) en spans
  // =========================
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (!t || !(t instanceof HTMLElement)) return;
    if (!t.matches("[data-quick-toggle]")) return;

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const id = t.getAttribute("data-quick-toggle");
      quickToggleDone(id);
    }
  });

  // =========================
  // Lista: delegación
  // =========================
  $listBody?.addEventListener("click", (e) => {
    const check = e.target.closest("[data-quick-toggle]");
    if (check) {
      e.preventDefault();
      e.stopPropagation();
      const id = check.getAttribute("data-quick-toggle");
      quickToggleDone(id);
      return;
    }

    const row = e.target.closest("[data-event-id]");
    if (!row) return;
    const id = row.getAttribute("data-event-id");
    const ev = UI_STATE.events.find(x => x.id === id);
    if (!ev) return;

    if (ev._virtualFromId) openModalForNew(ev.dateISO, ev);
    else openModalForEdit(ev);
  });

  // =========================
  // Overview: delegación
  // =========================
  const ovClick = (e) => {
    const check = e.target.closest("[data-quick-toggle]");
    if (check) {
      e.preventDefault();
      e.stopPropagation();
      const id = check.getAttribute("data-quick-toggle");
      quickToggleDone(id);
      return;
    }

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

  // repoblar responsables con base en raw + ASSIGNEES fijo
  populateAssignedSelect(UI_STATE.rawEvents);
  populateAssignedToModal(UI_STATE.rawEvents);
  populateRecurrenceSelect();
  ensureRecurrenceAdvancedUI();

  UI_STATE.events = expandRecurringForVisibleRange(UI_STATE.rawEvents, UI_STATE.year, UI_STATE.monthIndex);

  rerender();
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
  UI_STATE.events = expandRecurringForVisibleRange(UI_STATE.rawEvents, UI_STATE.year, UI_STATE.monthIndex);

  renderOverview();
  renderCalendar(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);

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
      if (aDone !== bDone) return aDone - bDone;

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
    const shown = dayEvents.slice(0, DAY_MAX_SHOW);

    for (const ev of shown) list.appendChild(renderChip(ev));

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
    const rec = recurrenceLabel(ev.recurrence);

    row.innerHTML = `
      <span class="list-dot" style="background:${catColor(cat)}"></span>
      <span class="list-main">
        <span class="list-title">${escapeHtml(ev.title || "(Sin título)")}</span>
        <span class="list-sub">
          <span class="list-pill">${escapeHtml(catLabel(cat))}</span>
          <span class="list-pill status">${escapeHtml(statusLabel(st))}</span>
          ${who ? `<span class="list-pill who">@${escapeHtml(who)}</span>` : ""}
          ${rec ? `<span class="list-pill rec">${escapeHtml(rec)}</span>` : ""}
          ${ev._virtualFromId ? `<span class="list-pill ghost">Ocurrencia</span>` : ""}
        </span>
      </span>
      <span class="list-st" style="color:${STATUS_COLORS[st] || "#64748B"}">${escapeHtml(st === "done" ? "✓" : (st === "cancelled" ? "×" : "•"))}</span>
    `;

    $listBody.appendChild(row);
  }
}

/* =========================
   Overview: Hoy + Próximos 7 (compacto)
========================= */
function renderOverview() {
  const todayISO = toISODateLocal(new Date());
  const endISO = toISODateLocal(addDays(new Date(), OVERVIEW_DAYS_AHEAD));

  const filtered = applyFilters(UI_STATE.events);

  const todayItems = filtered
    .filter(ev => (ev.dateISO || "") === todayISO)
    .slice()
    .sort((a,b) => {
      const aDone = (a.status === "done") ? 1 : 0;
      const bDone = (b.status === "done") ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      return String(a.title||"").localeCompare(String(b.title||""), "es");
    });

  const nextItems = filtered
    .filter(ev => {
      const iso = ev.dateISO || "";
      return iso >= todayISO && iso <= endISO;
    })
    .slice()
    .sort((a,b) => {
      if (a.dateISO !== b.dateISO) return String(a.dateISO||"").localeCompare(String(b.dateISO||""));
      const aDone = (a.status === "done") ? 1 : 0;
      const bDone = (b.status === "done") ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      return String(a.title||"").localeCompare(String(b.title||""), "es");
    });

  // Hoy
  if ($todayList) {
    $todayList.innerHTML = "";
    if (!todayItems.length) {
      $todayList.innerHTML = `<span class="muted">Sin eventos</span>`;
    } else {
      for (const ev of todayItems.slice(0, OVERVIEW_TODAY_MAX)) {
        $todayList.appendChild(renderMiniOverviewItem(ev, { showDate: false, compact: true }));
      }
      if (todayItems.length > OVERVIEW_TODAY_MAX) {
        const m = document.createElement("div");
        m.className = "muted";
        m.textContent = `+${todayItems.length - OVERVIEW_TODAY_MAX} más…`;
        $todayList.appendChild(m);
      }
    }
  }

  // Próximos
  if ($nextList) {
    $nextList.innerHTML = "";
    if (!nextItems.length) {
      $nextList.innerHTML = `<span class="muted">Sin eventos</span>`;
    } else {
      for (const ev of nextItems.slice(0, OVERVIEW_NEXT_MAX)) {
        $nextList.appendChild(renderMiniOverviewItem(ev, { showDate: true, compact: true }));
      }
      if (nextItems.length > OVERVIEW_NEXT_MAX) {
        const m = document.createElement("div");
        m.className = "muted";
        m.textContent = `+${nextItems.length - OVERVIEW_NEXT_MAX} más…`;
        $nextList.appendChild(m);
      }
    }
  }
}

function renderMiniOverviewItem(ev, { showDate = false, compact = false } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = compact ? "ov-item ov-compact" : "ov-item";
  btn.setAttribute("data-event-id", ev.id);

  const cat = ev.category || "otro";
  const who = (ev.assignedTo || "").trim();
  const st  = ev.status || "pending";

  const check = renderQuickToggleHTML(ev, { small: true });

  btn.innerHTML = `
    <span class="ov-dot" style="background:${catColor(cat)}"></span>
    <span class="ov-text">
      ${showDate ? `<span class="ov-date">${escapeHtml(ev.dateISO || "")}</span>` : ""}
      <span class="ov-title">${escapeHtml(ev.title || "(Sin título)")}</span>
      ${who ? `<span class="ov-who">@${escapeHtml(who)}</span>` : ""}
    </span>
    ${check}
    <span class="ov-st" aria-hidden="true" style="color:${STATUS_COLORS[st] || "#64748B"}">${escapeHtml(st === "done" ? "✓" : (st === "cancelled" ? "×" : "•"))}</span>
  `;

  return btn;
}

/* =========================
   Chips (mes)
========================= */
function renderChip(ev) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.setAttribute("data-event-id", ev.id);

  const cat = ev.category || "otro";
  const st  = ev.status || "pending";
  const who = (ev.assignedTo || "").trim();
  const recLabel = recurrenceLabel(ev.recurrence);

  chip.style.borderLeftColor = catColor(cat);
  if (st === "done") chip.classList.add("is-done");
  if (st === "cancelled") chip.classList.add("is-cancelled");

  const titleBits = [
    `${catLabel(cat)} · ${statusLabel(st)}${recLabel ? ` · ${recLabel}` : ""}`,
    who ? `@${who}` : "",
    ev._virtualFromId ? "Ocurrencia (no guardada)" : "",
    ev.notes ? ev.notes : ""
  ].filter(Boolean).join(" · ");

  chip.title = titleBits;

  const check = renderQuickToggleHTML(ev, { small: false });

  chip.innerHTML = `
    <span class="chip-dot" style="color:${STATUS_COLORS[st] || "#64748B"}">${escapeHtml(st === "done" ? "✓" : (st === "cancelled" ? "×" : "•"))}</span>
    <span class="chip-text">${escapeHtml(ev.title || "(Sin título)")}</span>
    ${who ? `<span class="chip-person">@${escapeHtml(who)}</span>` : ""}
    ${check}
  `;

  return chip;
}

function renderQuickToggleHTML(ev, { small = false } = {}) {
  // No permitir “toggle” en ocurrencias virtuales (no guardadas)
  if (ev?._virtualFromId) return "";

  const st = ev.status || "pending";
  const isDone = st === "done";
  const label = isDone ? "Marcar pendiente" : "Marcar hecho";
  const cls = small ? "chip-check chip-check-sm" : "chip-check";

  return `
    <span class="${cls}"
          role="button"
          tabindex="0"
          aria-label="${escapeHtml(label)}"
          title="${escapeHtml(label)}"
          data-quick-toggle="${escapeHtml(ev.id)}">${isDone ? "✓" : ""}</span>
  `;
}

function quickToggleDone(eventId) {
  const id = String(eventId || "").trim();
  if (!id) return;

  // Buscar en rawEvents por ID real
  const raw = UI_STATE.rawEvents.find(e => String(e.id) === id);
  if (!raw) return;

  const st = raw.status || "pending";
  if (st === "cancelled") {
    notify("Este evento está cancelado. No lo marco como hecho.", { mode: "toast" });
    return;
  }

  const next = (st === "done") ? "pending" : "done";

  // Optimistic UI
  raw.status = next;
  rerender();

  // Persistencia real
  UI_STATE.onUpdate?.(id, { status: next });

  notify(next === "done" ? "Hecho ✅" : "Marcado como pendiente ◻️", { mode: "toast", ms: 1400 });
}

/* =========================
   Modal
========================= */
function openModalForNew(dateISO, prefillFromEvent = null) {
  const iso = (dateISO && String(dateISO).trim()) ? String(dateISO).trim() : getSmartDefaultDateISO();

  UI_STATE.editingId = null;
  if ($modalTitle) $modalTitle.textContent = "Nuevo evento";

  const baseCat = (UI_STATE.categories?.[0]?.id) || "otro";

  populateAssignedToModal(UI_STATE.rawEvents);
  populateRecurrenceSelect();
  ensureRecurrenceAdvancedUI();

  if ($eventTitle) $eventTitle.value = prefillFromEvent?.title ? String(prefillFromEvent.title) : "";
  if ($eventCategory) $eventCategory.value = prefillFromEvent?.category ? String(prefillFromEvent.category) : baseCat;
  if ($eventDate) $eventDate.value = iso;
  if ($eventStatus) $eventStatus.value = prefillFromEvent?.status ? String(prefillFromEvent.status) : "pending";
  if ($eventNotes) $eventNotes.value = prefillFromEvent?.notes ? String(prefillFromEvent.notes) : "";

  if ($eventAssignedTo) $eventAssignedTo.value = prefillFromEvent?.assignedTo ? String(prefillFromEvent.assignedTo) : "";

  // Por defecto: ocurrencia virtual NO hereda repetición automáticamente
  setRecurrenceControlsValue(null);

  hide($btnDeleteEvent);

  openModal();
  ensureModalEnhancements();

  setTimeout(() => $eventTitle?.focus(), 0);
}

function openModalForEdit(ev) {
  UI_STATE.editingId = ev.id;
  if ($modalTitle) $modalTitle.textContent = "Editar evento";

  populateAssignedToModal(UI_STATE.rawEvents, ev.assignedTo || "");
  populateRecurrenceSelect();
  ensureRecurrenceAdvancedUI();

  if ($eventTitle) $eventTitle.value = ev.title || "";
  if ($eventCategory) $eventCategory.value = ev.category || (UI_STATE.categories?.[0]?.id || "otro");
  if ($eventDate) $eventDate.value = ev.dateISO || "";
  if ($eventStatus) $eventStatus.value = ev.status || "pending";
  if ($eventNotes) $eventNotes.value = ev.notes || "";

  if ($eventAssignedTo) $eventAssignedTo.value = ev.assignedTo || "";

  setRecurrenceControlsValue(ev.recurrence);

  show($btnDeleteEvent);

  openModal();
  ensureModalEnhancements();

  setTimeout(() => $eventTitle?.focus(), 0);
}

function readModalPayload() {
  const title = ($eventTitle?.value || "").trim();
  const category = ($eventCategory?.value || "").trim();
  const dateISO = ($eventDate?.value || "").trim();
  const status = ($eventStatus?.value || "pending").trim();
  const notes = ($eventNotes?.value || "").trim();

  const assignedTo = ($eventAssignedTo?.value || "").trim();
  const recurrence = readRecurrenceFromModal(); // 👈 objeto o null

  const problems = [];
  if (!title) problems.push("Ponle un título al evento.");
  if (!category) problems.push("Elige una categoría.");
  if (!dateISO) problems.push("Elige una fecha.");

  if (dateISO && !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    problems.push("La fecha debe estar en formato yyyy-mm-dd.");
  }

  // Validación recurrence
  if (recurrence) {
    const u = recurrence.unit;
    const n = recurrence.interval;
    if (!["day","week","month","year"].includes(u)) problems.push("Repetición inválida (unidad).");
    if (!Number.isFinite(n) || n < 1 || n > 100) problems.push("Repetición inválida (intervalo).");
  }

  if (problems.length) {
    notify(problems.join("\n"), { mode: "alert" });
    (problems[0].includes("título") ? $eventTitle :
      problems[0].includes("categoría") ? $eventCategory : $eventDate
    )?.focus?.();
    return null;
  }

  // db.js ya acepta objeto recurrence (y también tolera legacy/JSON).
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
   Recurrence UI (PROGRESIVA)
   - Si #eventRecurrence es select: opciones + JSON values
   - Además inyectamos "Cada X" (input + unidad) si se puede
========================= */
let $recWrap = null;
let $recToggle = null;
let $recEvery = null;
let $recUnit = null;

function ensureRecurrenceAdvancedUI() {
  if (!$eventRecurrence) return;

  // Buscamos contenedor natural
  const parent = $eventRecurrence.parentElement || null;
  if (!parent) return;

  // Evitar duplicar
  if (parent.querySelector(".rec-adv")) {
    // refrescar refs
    $recWrap = parent.querySelector(".rec-adv");
    $recToggle = parent.querySelector("#recToggle");
    $recEvery = parent.querySelector("#recEvery");
    $recUnit = parent.querySelector("#recUnit");
    return;
  }

  // Inyectar UI compacta
  const wrap = document.createElement("div");
  wrap.className = "rec-adv";
  wrap.style.display = "grid";
  wrap.style.gridTemplateColumns = "1fr";
  wrap.style.gap = "8px";
  wrap.style.marginTop = "8px";

  wrap.innerHTML = `
    <label class="rec-adv-row" style="display:flex;align-items:center;gap:10px;">
      <input type="checkbox" id="recToggle" />
      <span style="font-weight:600;">Repetir</span>
      <span class="muted" style="margin-left:auto;font-size:12px;">(cada X)</span>
    </label>

    <div class="rec-adv-controls hidden" id="recControls" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <span class="muted" style="font-size:12px;">Cada</span>
      <input type="number" id="recEvery" min="1" max="100" value="1"
             style="width:90px;padding:10px 12px;border-radius:12px;border:1px solid rgba(11,16,32,.16);background:rgba(255,255,255,.7);" />
      <select id="recUnit"
              style="min-width:160px;padding:10px 12px;border-radius:12px;border:1px solid rgba(11,16,32,.16);background:rgba(255,255,255,.7);">
        <option value="day">Día(s)</option>
        <option value="week">Semana(s)</option>
        <option value="month">Mes(es)</option>
        <option value="year">Año(s)</option>
      </select>

      <button type="button" class="btn ghost tiny" id="recApplyPreset">Aplicar</button>
      <span class="muted" id="recHint" style="font-size:12px;"></span>
    </div>
  `;

  parent.appendChild(wrap);

  // refs
  $recWrap = wrap;
  $recToggle = wrap.querySelector("#recToggle");
  $recEvery = wrap.querySelector("#recEvery");
  $recUnit = wrap.querySelector("#recUnit");
  const $controls = wrap.querySelector("#recControls");
  const $hint = wrap.querySelector("#recHint");
  const $apply = wrap.querySelector("#recApplyPreset");

  const updateHint = () => {
    const on = !!$recToggle?.checked;
    if (!on) { if ($hint) $hint.textContent = ""; return; }
    const unit = $recUnit?.value || "week";
    const n = parseInt($recEvery?.value || "1", 10) || 1;
    const label = recurrenceLabel({ unit, interval: n });
    if ($hint) $hint.textContent = label ? `→ ${label}` : "";
  };

  $recToggle?.addEventListener("change", () => {
    $controls?.classList.toggle("hidden", !$recToggle.checked);
    updateHint();

    if (!$recToggle.checked) {
      // apagar repetición
      setRecurrenceControlsValue(null);
    } else {
      // si prenden, usar lo que esté puesto en los inputs
      const unit = $recUnit?.value || "week";
      const n = parseInt($recEvery?.value || "1", 10) || 1;
      setRecurrenceControlsValue({ unit, interval: n });
    }
  });

  $recEvery?.addEventListener("input", updateHint);
  $recUnit?.addEventListener("change", updateHint);

  $apply?.addEventListener("click", () => {
    if (!$recToggle?.checked) $recToggle.checked = true;
    $controls?.classList.remove("hidden");
    const unit = $recUnit?.value || "week";
    const n = clampInt($recEvery?.value, 1, 100, 1);
    setRecurrenceControlsValue({ unit, interval: n });
    updateHint();
  });

  updateHint();
}

function populateRecurrenceSelect() {
  if (!$eventRecurrence) return;

  // Si no es select, no intentamos poblar options
  const isSelect = ($eventRecurrence.tagName || "").toLowerCase() === "select";
  if (!isSelect) return;

  const prev = String($eventRecurrence.value || "").trim();

  // Opciones base + pro (JSON)
  const opts = [
    { value: "", label: "—" },

    // Atajos legibles (valores JSON)
    { value: JSON.stringify({ unit: "day", interval: 1 }),   label: "Diario" },
    { value: JSON.stringify({ unit: "week", interval: 1 }),  label: "Semanal" },
    { value: JSON.stringify({ unit: "week", interval: 2 }),  label: "Cada 2 semanas" },
    { value: JSON.stringify({ unit: "week", interval: 3 }),  label: "Cada 3 semanas" },
    { value: JSON.stringify({ unit: "month", interval: 1 }), label: "Mensual" },
    { value: JSON.stringify({ unit: "month", interval: 2 }), label: "Cada 2 meses" },
    { value: JSON.stringify({ unit: "month", interval: 3 }), label: "Cada 3 meses" },
    { value: JSON.stringify({ unit: "month", interval: 6 }), label: "Semestral" },
    { value: JSON.stringify({ unit: "year", interval: 1 }),  label: "Anual" },
    { value: JSON.stringify({ unit: "year", interval: 2 }),  label: "Cada 2 años" }
  ];

  $eventRecurrence.innerHTML = "";
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    $eventRecurrence.appendChild(opt);
  }

  // si prev era legacy, conviértelo
  const prevRec = parseRecurrenceFromControlValue(prev);
  const prevVal = recurrenceToSelectValue(prevRec);

  if (opts.some(o => o.value === prevVal)) $eventRecurrence.value = prevVal;
  else $eventRecurrence.value = ""; // fallback

  // Si cambian select, sincroniza advanced UI
  if (!$eventRecurrence._recBound) {
    $eventRecurrence.addEventListener("change", () => {
      const rec = parseRecurrenceFromControlValue($eventRecurrence.value);
      syncAdvancedRecUI(rec);
    });
    $eventRecurrence._recBound = true;
  }
}

function setRecurrenceControlsValue(rec) {
  const r = normalizeRecurrence(rec);

  // select: set value to JSON
  if ($eventRecurrence) {
    const isSelect = ($eventRecurrence.tagName || "").toLowerCase() === "select";
    if (isSelect) {
      $eventRecurrence.value = recurrenceToSelectValue(r);
    } else {
      // si era input/hiddens: guarda JSON string
      $eventRecurrence.value = r ? recurrenceToSelectValue(r) : "";
    }
  }

  // advanced controls
  syncAdvancedRecUI(r);
}

function syncAdvancedRecUI(rec) {
  const r = normalizeRecurrence(rec);

  if (!$recWrap) return;
  const $controls = $recWrap.querySelector("#recControls");
  const $hint = $recWrap.querySelector("#recHint");

  if (!$recToggle || !$recEvery || !$recUnit) return;

  if (!r) {
    $recToggle.checked = false;
    $controls?.classList.add("hidden");
    if ($hint) $hint.textContent = "";
    return;
  }

  $recToggle.checked = true;
  $controls?.classList.remove("hidden");
  $recEvery.value = String(r.interval || 1);
  $recUnit.value = r.unit || "week";
  if ($hint) $hint.textContent = `→ ${recurrenceLabel(r)}`;
}

function readRecurrenceFromModal() {
  // Preferimos advanced UI si existe y está activada
  if ($recToggle && $recEvery && $recUnit && $recToggle.checked) {
    const interval = clampInt($recEvery.value, 1, 100, 1);
    const unit = String($recUnit.value || "week").trim();
    return normalizeRecurrence({ unit, interval });
  }

  // fallback: select/input #eventRecurrence
  if ($eventRecurrence) {
    const v = String($eventRecurrence.value || "").trim();
    return parseRecurrenceFromControlValue(v);
  }

  return null;
}

/* =========================
   Agenda del día (dentro del modal)
========================= */
function buildDayAgendaUI(modalContent){
  const head = modalContent.querySelector(".modal-head");
  const form = modalContent.querySelector("#eventForm");
  if (!head || !form) return;

  if (!modalContent.querySelector("#dayAgendaBar")){
    const bar = document.createElement("div");
    bar.id = "dayAgendaBar";
    bar.className = "day-agenda-bar";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btnViewDayAgenda";
    btn.className = "btn ghost";
    btn.textContent = "Ver eventos del día";
    btn.setAttribute("aria-haspopup","false");

    bar.appendChild(btn);
    head.appendChild(bar);
  }

  if (!modalContent.querySelector("#dayAgendaWrap")){
    const wrap = document.createElement("section");
    wrap.id = "dayAgendaWrap";
    wrap.className = "day-agenda hidden";
    wrap.setAttribute("aria-label", "Eventos del día");

    wrap.innerHTML = `
      <div class="day-agenda-head">
        <div class="day-agenda-title">Eventos del día</div>
        <div class="day-agenda-actions">
          <button type="button" id="btnAgendaToday" class="btn ghost tiny">Hoy</button>
          <button type="button" id="btnAgendaClose" class="btn ghost tiny">Cerrar</button>
        </div>
      </div>
      <div id="dayAgendaMeta" class="day-agenda-meta muted"></div>
      <div id="dayAgendaList" class="day-agenda-list"></div>
    `;

    form.parentNode.insertBefore(wrap, form);
  }
}

function sortAgendaEvents(a,b){
  const sa = String(a?.status || "pending");
  const sb = String(b?.status || "pending");
  const rank = (s)=> (s === "pending" ? 0 : s === "cancelled" ? 1 : 2);
  const ra = rank(sa), rb = rank(sb);
  if (ra !== rb) return ra - rb;
  const ta = String(a?.title || "").toLowerCase();
  const tb = String(b?.title || "").toLowerCase();
  return ta.localeCompare(tb);
}

function renderDayAgenda(dateISO){
  const modalContent = $eventModal?.querySelector(".modal-content");
  const wrap = modalContent?.querySelector("#dayAgendaWrap");
  const meta = modalContent?.querySelector("#dayAgendaMeta");
  const list = modalContent?.querySelector("#dayAgendaList");
  if (!wrap || !meta || !list) return;

  const iso = (dateISO && String(dateISO).trim()) ? String(dateISO).trim() : "";
  const all = (UI_STATE.events || []).filter(ev => String(ev.dateISO || "") === iso);
  all.sort(sortAgendaEvents);

  meta.textContent = iso ? `${iso} · ${all.length} evento${all.length === 1 ? "" : "s"}` : "";

  if (!iso){
    list.innerHTML = `<div class="muted">Elige una fecha para ver la agenda.</div>`;
    return;
  }

  if (!all.length){
    list.innerHTML = `<div class="muted">Sin eventos en este día.</div>`;
    return;
  }

  list.innerHTML = all.map(ev => {
    const title = escapeHtml(ev.title || "(Sin título)");
    const cat = escapeHtml(catLabel(ev.category));
    const who = escapeHtml(String(ev.assignedTo || "").trim() || "Sin asignar");
    const st  = escapeHtml(statusLabel(ev.status));
    const rec = ev._virtualFromId ? `<span class="agenda-pill rec">Recurrente</span>` : "";

    return `
      <button type="button" class="agenda-item" data-agenda-id="${escapeHtml(ev.id)}">
        <div class="agenda-main">
          <div class="agenda-title">${title}</div>
          <div class="agenda-sub">
            <span class="agenda-pill">${cat}</span>
            <span class="agenda-pill status">${st}</span>
            <span class="agenda-pill who">@${who}</span>
            ${rec}
          </div>
        </div>
        <div class="agenda-arrow" aria-hidden="true">›</div>
      </button>
    `;
  }).join("");

  if (!list._agendaBound){
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-agenda-id]");
      if (!btn) return;
      const id = btn.getAttribute("data-agenda-id");
      const ev = (UI_STATE.events || []).find(x => x.id === id);
      if (!ev) return;

      if (ev._virtualFromId) {
        openModalForNew(ev.dateISO, ev);
        return;
      }
      openModalForEdit(ev);
    });
    list._agendaBound = true;
  }
}

function ensureModalEnhancements() {
  const modalContent = $eventModal?.querySelector(".modal-content");
  if (!modalContent) return;

  buildDayAgendaUI(modalContent);

  const wrap = modalContent.querySelector("#dayAgendaWrap");
  const btnView = modalContent.querySelector("#btnViewDayAgenda");
  const btnClose = modalContent.querySelector("#btnAgendaClose");
  const btnToday = modalContent.querySelector("#btnAgendaToday");

  if (btnView && !btnView._agendaBound){
    btnView.addEventListener("click", () => {
      if (!wrap) return;
      wrap.classList.toggle("hidden");
      if (!wrap.classList.contains("hidden")) {
        renderDayAgenda($eventDate?.value || "");
      }
    });
    btnView._agendaBound = true;
  }

  if (btnClose && !btnClose._agendaBound){
    btnClose.addEventListener("click", () => {
      wrap?.classList.add("hidden");
    });
    btnClose._agendaBound = true;
  }

  if (btnToday && !btnToday._agendaBound){
    btnToday.addEventListener("click", () => {
      const iso = toISODateLocal(new Date());
      if ($eventDate) $eventDate.value = iso;
      renderDayAgenda(iso);
      wrap?.classList.remove("hidden");
    });
    btnToday._agendaBound = true;
  }

  if ($eventDate && !($eventDate._agendaBound)){
    $eventDate.addEventListener("change", () => {
      const isOpen = !wrap?.classList.contains("hidden");
      if (isOpen) renderDayAgenda($eventDate.value || "");
    });
    $eventDate._agendaBound = true;
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
        ev.status || "",
        recurrenceLabel(ev.recurrence) || ""
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

    for (const c of (UI_STATE.categories || getCategories())) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.label;
      $filterCategory.appendChild(opt);
    }
  }

  if ($eventCategory) {
    $eventCategory.innerHTML = "";
    for (const c of (UI_STATE.categories || getCategories())) {
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

function getMergedAssigneesFrom(events = []) {
  const fixed = Array.isArray(getAssignees?.()) ? getAssignees() : (Array.isArray(ASSIGNEES) ? ASSIGNEES : []);
  const dynamic = (events || [])
    .map(e => String(e.assignedTo || "").trim())
    .filter(Boolean);

  const map = new Map();
  for (const name of [...fixed, ...dynamic]) {
    const clean = String(name || "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!map.has(key)) map.set(key, clean);
  }

  return Array.from(map.values()).sort((a,b) => a.localeCompare(b, "es"));
}

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

  if (prev && list.includes(prev)) $filterAssignedTo.value = prev;
  else if (prev && prev !== "") $filterAssignedTo.value = "";
}

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
   Recurrentes: expansión en rango visible (PRO)
========================= */
function expandRecurringForVisibleRange(rawEvents, year, monthIndex) {
  const events = Array.isArray(rawEvents) ? rawEvents : [];

  const gridDays = buildMonthGrid(year, monthIndex, CALENDAR_CONFIG.weekStartsOn);
  const fromISO = toISODateLocal(gridDays[0]);
  const toISO   = toISODateLocal(gridDays[gridDays.length - 1]);

  const out = [];

  for (const ev of events) {
    out.push(ev);

    const startISO = String(ev.dateISO || "").trim();
    if (!startISO) continue;

    const rec = normalizeRecurrence(ev.recurrence);
    if (!rec) continue;

    out.push(...expandInterval(ev, startISO, fromISO, toISO, rec.unit, rec.interval));
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

function expandInterval(ev, startISO, fromISO, toISO, unit, interval) {
  const res = [];

  const startD = isoToDate(startISO);
  const fromD = isoToDate(fromISO);
  const toD   = isoToDate(toISO);

  // Vamos generando ocurrencias desde start hasta cubrir rango visible
  let cur = new Date(startD);

  // Adelantar hasta >= fromD (sin bucle infinito)
  let guard = 0;
  while (cur < fromD && guard < 5000) {
    cur = addByUnit(cur, unit, interval, startD);
    guard++;
  }

  // Generar hasta toD
  guard = 0;
  while (cur <= toD && guard < 5000) {
    const iso = toISODateLocal(cur);
    if (iso !== startISO) res.push(makeVirtualOccurrence(ev, iso));
    cur = addByUnit(cur, unit, interval, startD);
    guard++;
  }

  return res;
}

/**
 * addByUnit:
 * - day/week: suma días
 * - month/year: conserva "día objetivo" del start (ej 31 -> clamp al último día del mes)
 */
function addByUnit(date, unit, interval, anchorStartDate) {
  const d = new Date(date);
  const n = Number(interval || 1);

  if (unit === "day") {
    d.setDate(d.getDate() + n);
    return d;
  }

  if (unit === "week") {
    d.setDate(d.getDate() + (n * 7));
    return d;
  }

  const targetDay = (anchorStartDate instanceof Date) ? anchorStartDate.getDate() : d.getDate();

  if (unit === "month") {
    const y = d.getFullYear();
    const m = d.getMonth() + n;
    const base = new Date(y, m, 1, 0,0,0,0);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    base.setDate(Math.min(targetDay, last));
    return base;
  }

  if (unit === "year") {
    const y = d.getFullYear() + n;
    const m = d.getMonth();
    const base = new Date(y, m, 1, 0,0,0,0);
    const last = new Date(y, m + 1, 0).getDate();
    base.setDate(Math.min(targetDay, last));
    return base;
  }

  // fallback
  d.setDate(d.getDate() + (n * 7));
  return d;
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

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/* =========================
   Notificaciones
========================= */
function notify(msg, { mode = "toast", ms = 2200 } = {}) {
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

/* =========================
   Categorías editables (UI)
========================= */
let $categoryModal = null;

function ensureCategoryManagerUI() {
  if ($filterCategory && !$filterCategory.parentElement?.querySelector(".cat-edit-btn")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-edit-btn";
    btn.textContent = "Editar";
    btn.title = "Editar categorías";
    btn.addEventListener("click", openCategoryManager);
    $filterCategory.parentElement?.appendChild(btn);
  }

  if ($eventCategory && !$eventCategory.parentElement?.querySelector(".cat-edit-btn")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-edit-btn";
    btn.textContent = "Editar";
    btn.title = "Editar categorías";
    btn.addEventListener("click", openCategoryManager);
    $eventCategory.parentElement?.appendChild(btn);
  }

  if (document.getElementById("categoryModal")) {
    $categoryModal = document.getElementById("categoryModal");
    return;
  }

  const modal = document.createElement("div");
  modal.id = "categoryModal";
  modal.className = "cat-modal hidden";
  modal.innerHTML = `
    <div class="cat-modal-overlay" data-cat-close></div>
    <div class="cat-modal-card" role="dialog" aria-modal="true" aria-label="Editar categorías">
      <div class="cat-modal-head">
        <h3>Editar categorías</h3>
        <div class="cat-modal-actions">
          <button type="button" class="btn ghost" id="btnCatReset" title="Volver a las categorías por defecto">Restaurar</button>
          <button type="button" class="btn" id="btnCatClose" data-cat-close>Cerrar</button>
        </div>
      </div>

      <p class="cat-modal-hint">Cambias nombres/colores aquí y queda guardado en este navegador. Sí, es un poco humano, pero funciona. 🤝</p>

      <div class="cat-list" id="catList"></div>

      <div class="cat-modal-foot">
        <button type="button" class="btn" id="btnCatAdd">+ Agregar categoría</button>
        <button type="button" class="btn primary" id="btnCatSave">Guardar cambios</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  $categoryModal = modal;

  modal.querySelectorAll("[data-cat-close]").forEach(el => {
    el.addEventListener("click", closeCategoryManager);
  });

  modal.querySelector("#btnCatAdd")?.addEventListener("click", () => {
    const list = modal.querySelector("#catList");
    list?.appendChild(renderCategoryRow({ id: "", label: "", color: "#64748B" }, { isNew: true }));
    list?.querySelector(".cat-row:last-child input")?.focus?.();
  });

  modal.querySelector("#btnCatSave")?.addEventListener("click", saveCategoryManager);
  modal.querySelector("#btnCatReset")?.addEventListener("click", () => {
    const ok = confirm("¿Restaurar las categorías por defecto? (Se pierden tus cambios locales)");
    if (!ok) return;
    UI_STATE.categories = resetCategories();
    rebuildCategoryMap();
    populateCategorySelects();
    rerender();
    renderCategoryManagerList();
    notify("Categorías restauradas ✅");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $categoryModal && !$categoryModal.classList.contains("hidden")) {
      e.preventDefault();
      closeCategoryManager();
    }
  });
}

function openCategoryManager() {
  ensureCategoryManagerUI();
  renderCategoryManagerList();
  $categoryModal?.classList.remove("hidden");
}

function closeCategoryManager() {
  $categoryModal?.classList.add("hidden");
}

function renderCategoryManagerList() {
  if (!$categoryModal) return;
  const list = $categoryModal.querySelector("#catList");
  if (!list) return;

  list.innerHTML = "";
  const cats = Array.isArray(UI_STATE.categories) ? UI_STATE.categories : getCategories();

  for (const c of cats) {
    list.appendChild(renderCategoryRow(c));
  }
}

function renderCategoryRow(cat, { isNew = false } = {}) {
  const row = document.createElement("div");
  row.className = "cat-row";
  row.dataset.catId = String(cat?.id || "");

  const locked = (cat?.id === "otro");

  row.innerHTML = `
    <div class="cat-color">
      <input type="color" value="${escapeHtml(String(cat?.color || "#64748B"))}" aria-label="Color" ${locked ? "disabled" : ""}/>
    </div>
    <div class="cat-main">
      <input class="cat-label" type="text" placeholder="Nombre (ej: Financiero)" value="${escapeHtml(String(cat?.label || ""))}" aria-label="Nombre de categoría" />
      <div class="cat-meta">
        <span class="cat-id">id: <code>${escapeHtml(String(cat?.id || (isNew ? "(se genera)" : "")))}</code></span>
        ${locked ? `<span class="cat-lock">(obligatoria)</span>` : ``}
      </div>
    </div>
    <div class="cat-actions">
      ${locked ? `` : `<button type="button" class="btn danger cat-del" title="Eliminar">Eliminar</button>`}
    </div>
  `;

  row.querySelector(".cat-del")?.addEventListener("click", async () => {
    const label = row.querySelector(".cat-label")?.value?.trim() || cat?.label || cat?.id;
    const id = row.dataset.catId || "";
    const ok = confirm(`¿Eliminar la categoría "${label}"?\n\nLos eventos que la usen se pasarán a "Otro".`);
    if (!ok) return;

    const affected = (UI_STATE.rawEvents || []).filter(e => String(e.category || "") === id);
    if (affected.length && typeof UI_STATE.onUpdate === "function") {
      notify(`Reasignando ${affected.length} evento(s) a "Otro"...`, { ms: 2600 });
      for (const ev of affected) {
        try { await UI_STATE.onUpdate(ev.id, { category: "otro" }); } catch (e) { console.error(e); }
      }
    }

    const cats = (UI_STATE.categories || []).filter(c => c.id !== id);
    UI_STATE.categories = setCategories(cats);
    rebuildCategoryMap();
    populateCategorySelects();
    rerender();
    renderCategoryManagerList();
    notify("Categoría eliminada ✅");
  });

  return row;
}

function saveCategoryManager() {
  if (!$categoryModal) return;
  const list = $categoryModal.querySelector("#catList");
  if (!list) return;

  const rows = Array.from(list.querySelectorAll(".cat-row"));

  const next = [];
  for (const row of rows) {
    const idExisting = String(row.dataset.catId || "").trim();
    const label = String(row.querySelector(".cat-label")?.value || "").trim();
    const color = String(row.querySelector("input[type='color']")?.value || "#64748B").trim();

    if (!label) continue;
    next.push({ id: idExisting || label, label, color });
  }

  const final = next.length ? next : DEFAULT_CATEGORIES;

  UI_STATE.categories = setCategories(final);
  rebuildCategoryMap();
  populateCategorySelects();
  rerender();
  renderCategoryManagerList();

  notify("Categorías guardadas ✅");
  closeCategoryManager();
}

/* =========================
   Responsables editables (UI)
========================= */
let $assigneeModal = null;

function ensureAssigneeManagerUI() {
  if ($filterAssignedTo && !$filterAssignedTo.parentElement?.querySelector(".asg-edit-btn")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-edit-btn asg-edit-btn";
    btn.textContent = "Editar";
    btn.title = "Editar responsables";
    btn.addEventListener("click", openAssigneeManager);
    $filterAssignedTo.parentElement?.appendChild(btn);
  }

  if ($eventAssignedTo && !$eventAssignedTo.parentElement?.querySelector(".asg-edit-btn")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-edit-btn asg-edit-btn";
    btn.textContent = "Editar";
    btn.title = "Editar responsables";
    btn.addEventListener("click", openAssigneeManager);
    $eventAssignedTo.parentElement?.appendChild(btn);
  }

  if (document.getElementById("assigneeModal")) {
    $assigneeModal = document.getElementById("assigneeModal");
    return;
  }

  const modal = document.createElement("div");
  modal.id = "assigneeModal";
  modal.className = "cat-modal hidden";
  modal.innerHTML = `
    <div class="cat-modal-overlay" data-asg-close></div>
    <div class="cat-modal-card" role="dialog" aria-modal="true" aria-label="Editar responsables">
      <div class="cat-modal-head">
        <h3>Editar responsables</h3>
        <div class="cat-modal-actions">
          <button type="button" class="btn ghost" id="btnAsgReset" title="Volver a los responsables por defecto">Restaurar</button>
          <button type="button" class="btn" id="btnAsgClose" data-asg-close>Cerrar</button>
        </div>
      </div>

      <p class="cat-modal-hint">Agrega, renombra o elimina responsables y queda guardado en este navegador. En serio, los humanos inventaron esto y luego se quejan. 🫠</p>

      <div class="cat-list" id="asgList"></div>

      <div class="cat-modal-foot">
        <button type="button" class="btn" id="btnAsgAdd">+ Agregar responsable</button>
        <button type="button" class="btn primary" id="btnAsgSave">Guardar cambios</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  $assigneeModal = modal;

  modal.querySelectorAll("[data-asg-close]").forEach(el => {
    el.addEventListener("click", closeAssigneeManager);
  });

  modal.querySelector("#btnAsgAdd")?.addEventListener("click", () => {
    const list = modal.querySelector("#asgList");
    list?.appendChild(renderAssigneeRow("", { isNew: true }));
    list?.querySelector(".cat-row:last-child input")?.focus?.();
  });

  modal.querySelector("#btnAsgSave")?.addEventListener("click", saveAssigneeManager);
  modal.querySelector("#btnAsgReset")?.addEventListener("click", () => {
    const ok = confirm("¿Restaurar los responsables por defecto? (Se pierden tus cambios locales)");
    if (!ok) return;
    resetAssignees();
    populateAssignedSelect(UI_STATE.rawEvents);
    populateAssignedToModal(UI_STATE.rawEvents, ($eventAssignedTo?.value || "").trim());
    rerender();
    renderAssigneeManagerList();
    notify("Responsables restaurados ✅");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $assigneeModal && !$assigneeModal.classList.contains("hidden")) {
      e.preventDefault();
      closeAssigneeManager();
    }
  });
}

function openAssigneeManager() {
  ensureAssigneeManagerUI();
  renderAssigneeManagerList();
  $assigneeModal?.classList.remove("hidden");
}

function closeAssigneeManager() {
  $assigneeModal?.classList.add("hidden");
}

function renderAssigneeManagerList() {
  if (!$assigneeModal) return;
  const list = $assigneeModal.querySelector("#asgList");
  if (!list) return;

  list.innerHTML = "";
  const names = getAssignees();
  for (const name of names) {
    list.appendChild(renderAssigneeRow(name));
  }
}

function renderAssigneeRow(name, { isNew = false } = {}) {
  const row = document.createElement("div");
  row.className = "cat-row";
  row.dataset.asgName = String(name || "");

  row.innerHTML = `
    <div class="cat-color" aria-hidden="true">
      <div style="width:46px;height:38px;border-radius:12px;border:1px dashed rgba(11,16,32,.16);display:flex;align-items:center;justify-content:center;font-weight:900;color:rgba(11,16,32,.55);background:rgba(255,255,255,.7)">@</div>
    </div>
    <div class="cat-main">
      <input class="cat-label" type="text" placeholder="Nombre (ej: Camila Rodríguez)" value="${escapeHtml(String(name || ""))}" aria-label="Nombre del responsable" />
      <div class="cat-meta">
        <span class="cat-id">tipo: <code>${isNew ? "(nuevo)" : "existente"}</code></span>
      </div>
    </div>
    <div class="cat-actions">
      <button type="button" class="btn danger asg-del" title="Eliminar">Eliminar</button>
    </div>
  `;

  row.querySelector(".asg-del")?.addEventListener("click", async () => {
    const label = row.querySelector(".cat-label")?.value?.trim() || name || "(sin nombre)";
    const current = String(name || row.dataset.asgName || "").trim();
    const ok = confirm(`¿Eliminar a "${label}"?\n\nLos eventos asignados a esta persona quedarán "Sin asignar".`);
    if (!ok) return;

    const affected = (UI_STATE.rawEvents || []).filter(e => String(e.assignedTo || "").trim() === current);
    if (affected.length && typeof UI_STATE.onUpdate === "function") {
      notify(`Quitando responsable en ${affected.length} evento(s)...`, { ms: 2600 });
      for (const ev of affected) {
        try { await UI_STATE.onUpdate(ev.id, { assignedTo: "" }); } catch (e) { console.error(e); }
      }
    }

    row.remove();
  });

  return row;
}

function saveAssigneeManager() {
  if (!$assigneeModal) return;
  const list = $assigneeModal.querySelector("#asgList");
  if (!list) return;

  const rows = Array.from(list.querySelectorAll(".cat-row"));
  const names = rows
    .map(r => r.querySelector(".cat-label")?.value || "")
    .map(s => String(s).trim())
    .filter(Boolean);

  const final = setAssignees(names);
  populateAssignedSelect(UI_STATE.rawEvents);
  populateAssignedToModal(UI_STATE.rawEvents, ($eventAssignedTo?.value || "").trim());
  rerender();
  renderAssigneeManagerList();
  notify(`Responsables guardados ✅ (${final.length})`);
  closeAssigneeManager();
}