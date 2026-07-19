/* =============================================================================
  js/ui.js — UI del calendario (render + modal + filtros) — vPRO∞+
  -----------------------------------------------------------------------------
  Mejoras:
  - Render grilla mensual (6x7)
  - Chips de eventos por día (compact + @asignado)
  - Quick toggle done/pending (accesible) solo si hay permisos de escritura
  - Modal crear/editar (Asignado a + Repetición PRO)
  - Filtros: categoría, estado, persona
  - Búsqueda: título, notas, persona (con debounce)
  - Vistas: Mes / Lista
  - Overview: Hoy + Próximos 7 compacto
  - Recurrentes PRO:
      recurrence:
        null
        | { type:"interval", unit:"day|week|month|year", interval:number }
        | { type:"interval", unit:"month", interval:number, mode:"dayOfMonth", dayOfMonth:number }
    Backward compatible: "" | "weekly" | "monthly" | "yearly"
  - Recurrence UI PRO+:
      * Presets
      * Toggle “Repetir”
      * Cada X unidad
      * Para mes: mismo día / día fijo del mes
  - Categorías:
      * Guardado robusto con slug id
      * Evita duplicados por id
      * Mantiene “otro”
  - RBAC / Readonly:
      * ui escucha auth:changed (opcional) y deshabilita acciones si canWrite=false
============================================================================= */

import {
  getCategories,
  setCategories,
  hydrateCategories,
  resetCategories,
  DEFAULT_CATEGORIES,
  getAssignees,
  setAssignees,
  hydrateAssignees,
  resetAssignees,
  EVENT_STATUS,
  STATUS_COLORS,
  CALENDAR_CONFIG,
  ASSIGNEES,
  URGENT_TASK_SLOTS
} from "./constants.js";
import { saveCatalogSettings } from "./db.js";

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
const $overviewUrgent = qs("#overviewUrgent");
const $urgentList = qs("#urgentList");
const $btnAddUrgentTask = qs("#btnAddUrgentTask");
const $birthdayBanner = qs("#birthdayBanner");
const $birthdayBannerList = qs("#birthdayBannerList");
const $festivityBanner = qs("#festivityBanner");
const $festivityBannerList = qs("#festivityBannerList");

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

const $eventAssignedTo = qs("#eventAssignedTo");
const $eventRecurrence = qs("#eventRecurrence");

const $toastHost = qs("#toastHost");

let $eventHoverCard = null;
let hoverShowTimer = null;
let hoverHideTimer = null;
let hoverAnchorEl = null;

/* =========================
   Config UI
========================= */
const DAY_MAX_SHOW = Infinity;

const OVERVIEW_TODAY_MAX  = 2;
const OVERVIEW_NEXT_MAX   = 3;
const OVERVIEW_DAYS_AHEAD = 7;

const SEARCH_DEBOUNCE_MS = 180;

/* =========================
   Estado UI
========================= */
let UI_STATE = {
  year: new Date().getFullYear(),
  monthIndex: new Date().getMonth(),

  rawEvents: [],
  categories: getCategories(),
  events: [],

  filterCategory: "",
  filterStatus: "",
  filterAssignedTo: "",
  searchQuery: "",

  view: "month", // "month" | "list"

  editingId: null,
  modalSourceOccurrence: null,

  // Permissions (client-side)
  canWrite: true,
  userEmail: "",

  onNavigate: null,
  onCreate: null,
  onUpdate: null,
  onUpdateSeries: null,
  onDelete: null,
  onDeleteSeries: null,
  onMaterializeOccurrence: null,
  onCreateUrgentTask: null,
  onUpdateUrgentTask: null,
  onCompleteUrgentTask: null,
  onDeleteUrgentTask: null,

  urgentContext: { visible: false, role: null, uid: "", email: "" },
  urgentTasks: [],

  _initialized: false,
  _globalKeysBound: false
};

/* =============================================================================
   Listener de permisos (auth:changed)
   ────────────────────────────────────
   IMPORTANTE: se registra al CARGAR el módulo, NO dentro de initUI(). Si se
   registrara dentro de initUI() y initUI() se invocara desde el propio handler
   de auth:changed de app.js, este listener se añadiría DURANTE el despacho del
   evento y, por las reglas del DOM, no se ejecutaría para ese primer evento.
   Resultado: en la primera carga nunca se aplicaban writeCategories/
   allowedCategories y el rol veía TODAS las categorías (bug de permisos).
============================================================================= */
if (typeof window !== "undefined" && !window.__uiAuthBound) {
  window.addEventListener("auth:changed", (ev) => {
    const d = ev?.detail || {};
    // Categorías que el rol puede EDITAR (para filtrar el form de evento).
    UI_STATE.writeCategories = Array.isArray(d.writeCategories) ? d.writeCategories : [];
    // Categorías que el rol puede VER (para filtrar el dropdown de filtro y la leyenda).
    UI_STATE.allowedCategories = Array.isArray(d.allowedCategories) ? d.allowedCategories : [];
    UI_STATE.isAdmin = !!d.isAdmin;
    if (typeof d.canWrite === "boolean") {
      UI_STATE.canWrite = d.canWrite;
    }
    populateCategorySelects();
    applyPermissionGates();
    rerender();
  });
  window.__uiAuthBound = true;
}

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

/* Primera categoría que el rol puede EDITAR (write). Se usa como valor por
   defecto del formulario de evento, para no preseleccionar una categoría que
   el rol no puede crear (p. ej. "Administrativo" para una asesora). */
function getDefaultWritableCategoryId() {
  const cats = Array.isArray(UI_STATE.categories) ? UI_STATE.categories : getCategories();
  const writable = Array.isArray(UI_STATE.writeCategories) ? UI_STATE.writeCategories : [];
  if (writable.length > 0) {
    const first = cats.find(c => writable.includes(c.id));
    if (first) return first.id;
  }
  return cats[0]?.id || "otro";
}

/* =========================
   Permissions gating
========================= */
function applyPermissionGates() {
  const can = !!UI_STATE.canWrite;

  // En solo lectura ocultamos del todo el botón de crear (antes solo se veía
  // "apagado" pero seguía clickeable) y mostramos un distintivo claro.
  if ($btnNewEvent) {
    $btnNewEvent.classList.toggle("hidden", !can);
    $btnNewEvent.setAttribute("aria-disabled", can ? "false" : "true");
  }

  if ($btnDeleteEvent) {
    $btnDeleteEvent.classList.toggle("disabled", !can);
    $btnDeleteEvent.setAttribute("aria-disabled", can ? "false" : "true");
  }

  if ($eventForm) {
    $eventForm.classList.toggle("readonly", !can);
  }

  ensureReadonlyBadge(!can);
}

/* Distintivo "Solo lectura" en el encabezado, junto al correo del usuario. */
function ensureReadonlyBadge(show) {
  let badge = document.getElementById("roleBadge");
  if (!badge) {
    const anchor = document.getElementById("userEmail");
    if (!anchor || !anchor.parentElement) return;
    badge = document.createElement("span");
    badge.id = "roleBadge";
    badge.className = "role-badge hidden";
    badge.textContent = "Solo lectura";
    badge.title = "Tu rol puede ver el calendario pero no editarlo.";
    anchor.parentElement.insertBefore(badge, anchor.nextSibling);
  }
  badge.classList.toggle("hidden", !show);
}

/* =========================
   Recurrence helpers
========================= */
function normTextLocal(v) {
  return String(v ?? "").trim().toLowerCase();
}

function normalizeRecurrence(raw) {
  if (raw === null || raw === undefined || raw === "") return null;

  if (typeof raw === "string") {
    const s = normTextLocal(raw);

    if (s === "weekly")  return { type: "interval", unit: "week",  interval: 1 };
    if (s === "monthly") return { type: "interval", unit: "month", interval: 1 };
    if (s === "yearly")  return { type: "interval", unit: "year",  interval: 1 };

    if (s.startsWith("{") && s.endsWith("}")) {
      try { return normalizeRecurrence(JSON.parse(raw)); } catch (_) { return null; }
    }
    return null;
  }

  if (typeof raw === "object") {
    const unit = normTextLocal(raw.unit || raw.everyUnit || raw.frequency || "");
    const interval = parseInt(raw.interval ?? raw.every ?? raw.count ?? 1, 10);

    if (!["day","week","month","year"].includes(unit)) return null;
    if (!Number.isFinite(interval) || interval < 1 || interval > 100) return null;

    const normalized = { type: "interval", unit, interval };

    if (unit === "month") {
      const mode = normTextLocal(raw.mode || raw.monthMode || "");
      const dayOfMonth = parseInt(raw.dayOfMonth ?? raw.day ?? "", 10);

      if (mode === "dayofmonth" && Number.isFinite(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31) {
        normalized.mode = "dayOfMonth";
        normalized.dayOfMonth = dayOfMonth;
      }
    }

    const untilISO = String(raw.untilISO ?? raw.endDate ?? raw.recurrenceEnd ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(untilISO)) normalized.untilISO = untilISO;

    return normalized;
  }

  return null;
}

function recurrenceToSelectValue(rec) {
  const r = normalizeRecurrence(rec);
  if (!r) return "";

  const payload = { unit: r.unit, interval: r.interval };
  if (r.unit === "month" && r.mode === "dayOfMonth" && Number.isFinite(r.dayOfMonth)) {
    payload.mode = "dayOfMonth";
    payload.dayOfMonth = r.dayOfMonth;
  }
  return JSON.stringify(payload);
}

function parseRecurrenceFromControlValue(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;

  if (["weekly","monthly","yearly"].includes(v)) return normalizeRecurrence(v);

  if (v.startsWith("{") && v.endsWith("}")) {
    try { return normalizeRecurrence(JSON.parse(v)); } catch (_) { return null; }
  }
  return null;
}

function recurrenceLabel(rec) {
  const r = normalizeRecurrence(rec);
  if (!r) return "";

  const { unit, interval } = r;

  const unitLabel = (u, n) => {
    if (u === "day")   return n === 1 ? "día" : "días";
    if (u === "week")  return n === 1 ? "semana" : "semanas";
    if (u === "month") return n === 1 ? "mes" : "meses";
    if (u === "year")  return n === 1 ? "año" : "años";
    return u;
  };

  if (r.untilISO) {
    const names = { day: "día", week: "semana", month: "mes", year: "año" };
    const cadence = interval === 1 ? `Cada ${names[unit] || unit}` : `Cada ${interval} ${names[unit] || unit}s`;
    return `${cadence} hasta el ${r.untilISO}`;
  }

  if (unit === "week"  && interval === 1) return "Semanal";
  if (unit === "month" && interval === 1 && r.mode === "dayOfMonth" && Number.isFinite(r.dayOfMonth)) {
    return `Cada mes el día ${r.dayOfMonth}`;
  }
  if (unit === "month" && interval === 1) return "Mensual";
  if (unit === "month" && interval === 6) return "Semestral";

  if (unit === "year"  && interval === 1) return "Anual";

  if (unit === "month" && r.mode === "dayOfMonth" && Number.isFinite(r.dayOfMonth)) {
    return `Cada ${interval} meses el día ${r.dayOfMonth}`;
  }

  return `Cada ${interval} ${unitLabel(unit, interval)}`;
}

function getEventDateDayOfMonth() {
  const iso = String($eventDate?.value || "").trim();
  if (!iso) return 1;
  const d = isoToDate(iso);
  return Math.max(1, Math.min(31, d.getDate()));
}

/* =========================
   Init
========================= */
export function initUI({ onNavigate, onCreate, onUpdate, onUpdateSeries, onDelete, onDeleteSeries, onMaterializeOccurrence, onCreateUrgentTask, onUpdateUrgentTask, onCompleteUrgentTask, onDeleteUrgentTask } = {}) {
  UI_STATE.onNavigate = onNavigate || null;
  UI_STATE.onCreate   = onCreate   || null;
  UI_STATE.onUpdate   = onUpdate   || null;
  UI_STATE.onUpdateSeries = onUpdateSeries || null;
  UI_STATE.onDelete   = onDelete   || null;
  UI_STATE.onDeleteSeries = onDeleteSeries || null;
  UI_STATE.onMaterializeOccurrence = onMaterializeOccurrence || null;
  UI_STATE.onCreateUrgentTask = onCreateUrgentTask || null;
  UI_STATE.onUpdateUrgentTask = onUpdateUrgentTask || null;
  UI_STATE.onCompleteUrgentTask = onCompleteUrgentTask || null;
  UI_STATE.onDeleteUrgentTask = onDeleteUrgentTask || null;

  UI_STATE.categories = getCategories();
  rebuildCategoryMap();
  populateCategorySelects();
  ensureCategoryManagerUI();

  ensureAssigneeManagerUI();

  populateStatusSelects();

  populateRecurrenceSelect();
  ensureRecurrenceSectionUI();
  ensureHoverCard();

  populateAssignedSelect([]);
  populateAssignedToModal([]);

  if (!UI_STATE._initialized) {
    $btnPrevMonth?.addEventListener("click", () => shiftMonth(-1));
    $btnNextMonth?.addEventListener("click", () => shiftMonth(+1));
    $btnToday?.addEventListener("click", () => goToday());

    $btnNewEvent?.addEventListener("click", () => {
      if (!UI_STATE.canWrite) {
        notify("Modo solo lectura: no puedes crear eventos.", { mode: "toast" });
        return;
      }
      openModalForNew(getSmartDefaultDateISO());
    });

    $btnViewMonth?.addEventListener("click", () => setView("month"));
    $btnViewList?.addEventListener("click", () => setView("list"));

    const onSearch = debounce(() => {
      UI_STATE.searchQuery = ($searchEvents?.value || "").trim();
      rerender();
    }, SEARCH_DEBOUNCE_MS);

    $searchEvents?.addEventListener("input", onSearch);

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

    $btnCancelModal?.addEventListener("click", closeModal);
    $modalOverlay?.addEventListener("click", closeModal);

    $btnDeleteEvent?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!UI_STATE.canWrite) {
        notify("Modo solo lectura: no puedes eliminar.", { mode: "toast" });
        return;
      }
      const occurrence = UI_STATE.modalSourceOccurrence;
      const edited = UI_STATE.rawEvents.find(event => String(event.id) === String(UI_STATE.editingId));
      const parentId = occurrence?._virtualFromId || edited?.recurrenceParentId || (edited?.recurrence ? edited.id : "");
      if (parentId && confirm("¿Deseas eliminar toda la serie recurrente?\n\nAceptar: toda la serie.\nCancelar: solo esta ocurrencia.")) {
        await UI_STATE.onDeleteSeries?.(parentId);
        closeModal();
        return;
      }
      if (occurrence?._virtualFromId) {
        const ok = confirm("¿Eliminar solo esta ocurrencia recurrente?");
        if (!ok) return;
        try {
          await UI_STATE.onMaterializeOccurrence?.(occurrence, { recurrenceSkip: true });
          closeModal();
        } catch (err) {
          console.error("Delete occurrence error:", err);
          notify("No se pudo eliminar esta ocurrencia.", { mode: "alert" });
        }
        return;
      }
      const id = UI_STATE.editingId;
      if (!id) return;
      UI_STATE.onDelete?.(id);
      closeModal();
    });

    $eventForm?.addEventListener("submit", async (e) => {
      e.preventDefault();

      if (!UI_STATE.canWrite) {
        notify("Modo solo lectura: no puedes guardar.", { mode: "toast" });
        return;
      }

      const payload = readModalPayload();
      if (!payload) return;

      const occurrence = UI_STATE.modalSourceOccurrence;
      const edited = UI_STATE.rawEvents.find(event => String(event.id) === String(UI_STATE.editingId));
      const parentId = occurrence?._virtualFromId || edited?.recurrenceParentId || (edited?.recurrence ? edited.id : "");

      if (parentId && confirm("¿Deseas aplicar los cambios a toda la serie recurrente?\n\nAceptar: toda la serie.\nCancelar: solo esta ocurrencia.")) {
        const seriesPayload = (occurrence?._virtualFromId || edited?.recurrenceParentId)
          ? {
              title: payload.title,
              category: payload.category,
              status: payload.status,
              notes: payload.notes,
              assignedTo: payload.assignedTo
            }
          : payload;
        await UI_STATE.onUpdateSeries?.(parentId, seriesPayload);
      } else if (occurrence?._virtualFromId) {
        await UI_STATE.onMaterializeOccurrence?.(occurrence, payload);
      } else if (UI_STATE.editingId) {
        await UI_STATE.onUpdate?.(UI_STATE.editingId, payload);
      } else {
        await UI_STATE.onCreate?.(payload);
      }

      closeModal();
    });

    $calendarGrid?.addEventListener("click", (e) => {
      const check = e.target.closest("[data-quick-toggle]");
      if (check) {
        e.preventDefault();
        e.stopPropagation();
        if (!UI_STATE.canWrite) {
          notify("Modo solo lectura.", { mode: "toast", ms: 1400 });
          return;
        }
        const id = check.getAttribute("data-quick-toggle");
        quickToggleDone(id);
        return;
      }
      if (handleEventOpenClick(e.target)) return;

      const dayCell = e.target.closest("[data-date]");
      if (dayCell) {
        if (!UI_STATE.canWrite) {
          notify("Modo solo lectura.", { mode: "toast", ms: 1400 });
          return;
        }
        const dateISO = dayCell.getAttribute("data-date");
        openModalForNew(dateISO);
      }
    });

    $listBody?.addEventListener("click", (e) => {
      const check = e.target.closest("[data-quick-toggle]");
      if (check) {
        e.preventDefault();
        e.stopPropagation();
        if (!UI_STATE.canWrite) {
          notify("Modo solo lectura.", { mode: "toast", ms: 1400 });
          return;
        }
        const id = check.getAttribute("data-quick-toggle");
        quickToggleDone(id);
        return;
      }
      handleEventOpenClick(e.target);
    });

    const ovClick = (e) => {
      const check = e.target.closest("[data-quick-toggle]");
      if (check) {
        e.preventDefault();
        e.stopPropagation();
        if (!UI_STATE.canWrite) {
          notify("Modo solo lectura.", { mode: "toast", ms: 1400 });
          return;
        }
        const id = check.getAttribute("data-quick-toggle");
        quickToggleDone(id);
        return;
      }
      handleEventOpenClick(e.target);
    };
    $todayList?.addEventListener("click", ovClick);
    $nextList?.addEventListener("click", ovClick);

    $btnAddUrgentTask?.addEventListener("click", () => openUrgentTaskModal());
    $urgentList?.addEventListener("click", handleUrgentTaskClick);

    if (!UI_STATE._globalKeysBound) {
      document.addEventListener("keydown", (e) => {
        const urgentModalOpen = !!document.getElementById("urgentTaskModal");
        const modalOpen = !$eventModal?.classList.contains("hidden");
        const tag = (e.target?.tagName || "").toLowerCase();
        const typing = ["input","textarea","select"].includes(tag) || e.target?.isContentEditable;

        if (e.key === "Escape" && urgentModalOpen) {
          e.preventDefault();
          closeUrgentTaskModal();
          return;
        }

        if (e.key === "Escape" && modalOpen) {
          e.preventDefault();
          closeModal();
          return;
        }

        if (modalOpen && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          if (!UI_STATE.canWrite) {
            notify("Modo solo lectura: no puedes guardar cambios.", { mode: "toast" });
            return;
          }
          $eventForm?.requestSubmit?.();
          return;
        }

        if (!typing && (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "k")) {
          e.preventDefault();
          ($searchEvents || $filterCategory || $filterStatus)?.focus?.();
          return;
        }

        const t = e.target;
        if (!t || !(t instanceof HTMLElement)) return;
        if (!t.matches("[data-quick-toggle]")) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!UI_STATE.canWrite) {
            notify("Modo solo lectura.", { mode: "toast", ms: 1400 });
            return;
          }
          const id = t.getAttribute("data-quick-toggle");
          quickToggleDone(id);
        }
      });

      UI_STATE._globalKeysBound = true;
    }

    UI_STATE._initialized = true;
  }

  setView("month", { silent: true });
  applyPermissionGates();
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

  populateAssignedSelect(UI_STATE.rawEvents);
  populateAssignedToModal(UI_STATE.rawEvents);

  populateRecurrenceSelect();
  ensureRecurrenceSectionUI();
  setRecurrenceControlsValue(null);

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

export function setCanWrite(canWrite) {
  UI_STATE.canWrite = !!canWrite;
  applyPermissionGates();
  rerender();
}

export function setCatalogData({ categories, assignees, userEmail } = {}) {
  if (typeof userEmail === "string") UI_STATE.userEmail = userEmail;

  if (Array.isArray(categories)) {
    UI_STATE.categories = hydrateCategories(categories);
    rebuildCategoryMap();
    populateCategorySelects();
  }

  if (Array.isArray(assignees)) {
    hydrateAssignees(assignees);
    populateAssignedSelect(UI_STATE.rawEvents);
    populateAssignedToModal(UI_STATE.rawEvents, ($eventAssignedTo?.value || "").trim());
  }

  rerender();
}

export function setUrgentTaskContext({ visible = false, role = null, uid = "", email = "" } = {}) {
  UI_STATE.urgentContext = {
    visible: !!visible,
    role,
    uid: String(uid || ""),
    email: String(email || "")
  };
  renderUrgentTasks();
}

export function setUrgentTasks(tasks = []) {
  UI_STATE.urgentTasks = Array.isArray(tasks) ? tasks : [];
  renderUrgentTasks();
}

/* =========================
   Render orchestrator
========================= */
function rerender() {
  UI_STATE.events = expandRecurringForVisibleRange(UI_STATE.rawEvents, UI_STATE.year, UI_STATE.monthIndex);

  renderWeeklyCategoryBanner({
    bannerEl: $birthdayBanner,
    listEl: $birthdayBannerList,
    categoryId: "cumpleanos",
    fallbackTitle: "Cumpleaños"
  });
  renderWeeklyCategoryBanner({
    bannerEl: $festivityBanner,
    listEl: $festivityBannerList,
    categoryId: "festividades",
    fallbackTitle: "Festividad"
  });
  renderOverview();
  renderCalendar(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);

  if (UI_STATE.view === "list") renderList(UI_STATE.year, UI_STATE.monthIndex, UI_STATE.events);
}

function renderWeeklyCategoryBanner({ bannerEl, listEl, categoryId, fallbackTitle }) {
  if (!bannerEl || !listEl) return;
  const now = new Date();
  const day = now.getDay(); // 0 dom, 1 lun ... 6 sab

  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));

  const nextSunday = new Date(monday);
  nextSunday.setDate(monday.getDate() + 13);
  const fromISO = toISODateLocal(monday);
  const toISO = toISODateLocal(nextSunday);

  const items = applyFilters(UI_STATE.events)
    .filter(ev => eventMatchesCategoryGroup(ev, categoryId))
    .filter(ev => {
      const iso = String(ev.dateISO || "").trim();
      return iso && iso >= fromISO && iso <= toISO;
    })
    .slice()
    .sort((a, b) => {
      if (a.dateISO !== b.dateISO) return String(a.dateISO || "").localeCompare(String(b.dateISO || ""));
      return String(a.title || "").localeCompare(String(b.title || ""), "es");
    });

  if (!items.length) {
    hide(bannerEl);
    listEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = items.map(ev => {
    const date = formatBirthdayShort(ev.dateISO);
    const weekLabel = String(ev.dateISO || "") <= toISODateLocal(new Date(monday.getTime() + 6 * 86400000))
      ? "Esta semana"
      : "Próxima semana";
    return `
      <div class="birthday-banner-item">
        <span class="birthday-banner-week">${escapeHtml(weekLabel)}</span>
        <span class="birthday-banner-date">${escapeHtml(date)}</span>
        <span>${escapeHtml(ev.title || fallbackTitle)}</span>
      </div>
    `;
  }).join("");

  show(bannerEl);
}

function eventMatchesCategoryGroup(ev, categoryId) {
  const rawId = String(ev?.category || "").trim().toLowerCase();
  const label = String(catLabel(ev?.category || "") || "").trim().toLowerCase();
  const normalizedLabel = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (categoryId === "cumpleanos") {
    return rawId === "cumpleanos" || normalizedLabel.includes("cumpleanos");
  }

  if (categoryId === "festividades") {
    return (
      rawId === "festividades" ||
      rawId === "festividad" ||
      rawId === "festivos" ||
      normalizedLabel.includes("festividades") ||
      normalizedLabel.includes("festividad") ||
      normalizedLabel.includes("festivo")
    );
  }

  return rawId === String(categoryId || "").trim().toLowerCase();
}

function formatBirthdayShort(dateISO) {
  const d = isoToDate(dateISO);
  return d.toLocaleDateString("es-CO", {
    weekday: "short",
    day: "numeric",
    month: "short"
  });
}

function findVisibleEventById(eventId) {
  const id = String(eventId || "").trim();
  if (!id) return null;
  return UI_STATE.events.find(ev => String(ev.id) === id) || null;
}

function resolveEventFromTarget(target) {
  const trigger = target?.closest?.("[data-event-id]");
  if (!trigger) return { trigger: null, event: null };
  const eventId = trigger.getAttribute("data-event-id");
  return { trigger, event: findVisibleEventById(eventId) };
}

function handleEventOpenClick(target) {
  const { event: ev } = resolveEventFromTarget(target);
  if (!ev) return false;

  if (ev._virtualFromId) {
    if (!UI_STATE.canWrite) {
      notify("Modo solo lectura.", { mode: "toast", ms: 1400 });
      return true;
    }
    openModalForNew(ev.dateISO, ev);
    return true;
  }

  openModalForEdit(ev);
  return true;
}

function buildHoverCardData(ev) {
  const st = ev.status || "pending";
  const cat = ev.category || "otro";
  const who = String(ev.assignedTo || "").trim();
  const rec = recurrenceLabel(ev.recurrence);
  const date = String(ev.dateISO || "").trim();
  const notes = String(ev.notes || "").trim();

  return {
    title: ev.title || "(Sin título)",
    meta: [
      catLabel(cat),
      statusLabel(st),
      date,
      rec,
      ev._virtualFromId ? "Serie recurrente" : ""
    ].filter(Boolean).join(" · "),
    extra: who ? `Responsable: ${who}` : "",
    notes: notes ? notes.slice(0, 180) : ""
  };
}

function applyHoverCardAttrs(el, ev) {
  if (!el || !ev) return;
  const info = buildHoverCardData(ev);
  el.removeAttribute("title");
  el.dataset.hoverTitle = info.title;
  el.dataset.hoverMeta = info.meta;
  el.dataset.hoverExtra = info.extra;
  el.dataset.hoverNotes = info.notes;
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

  const byDay = new Map();
  for (const ev of filteredEvents) {
    const dateISO = ev.dateISO || "";
    if (!dateISO) continue;
    if (!byDay.has(dateISO)) byDay.set(dateISO, []);
    byDay.get(dateISO).push(ev);
  }

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

  const headers = buildWeekdayHeaders();
  for (const h of headers) {
    const el = document.createElement("div");
    el.className = "cal-head";
    el.textContent = h;
    $calendarGrid.appendChild(el);
  }

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
    applyHoverCardAttrs(row, ev);

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
   Overview: Hoy + Próximos 7
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

function getActiveUrgentTasks() {
  return (UI_STATE.urgentTasks || [])
    .filter(task => String(task.status || "pending") !== "done")
    .sort((a, b) => URGENT_TASK_SLOTS.indexOf(a.slotId || a.id) - URGENT_TASK_SLOTS.indexOf(b.slotId || b.id))
    .sort((a, b) => {
      const currentUid = UI_STATE.urgentContext?.uid || "";
      const aOwn = a.ownerUid === currentUid ? 0 : 1;
      const bOwn = b.ownerUid === currentUid ? 0 : 1;
      if (aOwn !== bOwn) return aOwn - bOwn;
      return String(a.ownerEmail || "").localeCompare(String(b.ownerEmail || ""), "es");
    });
}

function getUrgentTaskBySlot(slotId) {
  const id = String(slotId || "");
  return (UI_STATE.urgentTasks || []).find(task =>
    (task.slotId || task.id) === id &&
    task.ownerUid === UI_STATE.urgentContext?.uid
  ) || null;
}

function getActiveOwnUrgentTasks() {
  const uid = UI_STATE.urgentContext?.uid || "";
  return getActiveUrgentTasks().filter(task => task.ownerUid === uid);
}

function getFreeUrgentSlot() {
  const activeSlots = new Set(getActiveOwnUrgentTasks().map(task => task.slotId || task.id));
  return URGENT_TASK_SLOTS.find(slotId => !activeSlots.has(slotId)) || null;
}

function renderUrgentTasks() {
  if (!$overviewUrgent || !$urgentList) return;

  const visible = !!UI_STATE.urgentContext?.visible;
  $overviewUrgent.classList.toggle("hidden", !visible);

  if (!visible) {
    $urgentList.innerHTML = `<span class="muted">Sin tareas urgentes</span>`;
    if ($btnAddUrgentTask) $btnAddUrgentTask.disabled = true;
    return;
  }

  const active = getActiveUrgentTasks();
  const isFull = getActiveOwnUrgentTasks().length >= URGENT_TASK_SLOTS.length;

  if ($btnAddUrgentTask) {
    $btnAddUrgentTask.disabled = isFull;
    $btnAddUrgentTask.setAttribute("aria-disabled", isFull ? "true" : "false");
    $btnAddUrgentTask.title = isFull
      ? "Solo puedes tener 2 tareas urgentes. Completa o elimina una para agregar otra."
      : "Agregar tarea urgente";
  }

  $urgentList.innerHTML = "";
  if (!active.length) {
    $urgentList.innerHTML = `<span class="muted">Sin tareas urgentes</span>`;
    return;
  }

  for (const task of active) {
    const item = document.createElement("div");
    item.className = "urgent-task";
    item.dataset.slotId = task.slotId || task.id || "";
    item.innerHTML = `
      <div class="urgent-task-title">${escapeHtml(task.title || "(Sin titulo)")}</div>
      ${task.ownerEmail ? `<div class="urgent-task-desc">De ${escapeHtml(task.ownerEmail)}</div>` : ""}
      ${task.description ? `<div class="urgent-task-desc">${escapeHtml(task.description)}</div>` : ""}
      <div class="urgent-task-actions">
        ${task.ownerUid === UI_STATE.urgentContext?.uid ? `
          <button type="button" class="btn tiny ghost urgent-task-action" data-urgent-action="edit">Editar</button>
          <button type="button" class="btn tiny ghost urgent-task-action" data-urgent-action="complete">Completar</button>
          <button type="button" class="btn tiny danger urgent-task-action" data-urgent-action="delete">Eliminar</button>
        ` : ""}
      </div>
    `;
    $urgentList.appendChild(item);
  }
}

function handleUrgentTaskClick(e) {
  const actionBtn = e.target?.closest?.("[data-urgent-action]");
  if (!actionBtn) return;

  const item = actionBtn.closest("[data-slot-id]");
  const slotId = item?.getAttribute("data-slot-id") || "";
  const action = actionBtn.getAttribute("data-urgent-action");
  const task = (UI_STATE.urgentTasks || []).find(item =>
    (item.slotId || item.id) === slotId &&
    item.ownerUid === UI_STATE.urgentContext?.uid
  ) || null;
  if (!slotId || !task) return;

  if (action === "edit") {
    openUrgentTaskModal(task);
    return;
  }

  if (action === "complete") {
    UI_STATE.onCompleteUrgentTask?.(slotId);
    return;
  }

  if (action === "delete") {
    const ok = confirm("¿Eliminar esta tarea urgente?");
    if (!ok) return;
    UI_STATE.onDeleteUrgentTask?.(slotId);
  }
}

function openUrgentTaskModal(task = null) {
  if (!UI_STATE.urgentContext?.visible) return;

  if (!task && getActiveOwnUrgentTasks().length >= URGENT_TASK_SLOTS.length) {
    notify("Solo puedes tener 2 tareas urgentes. Completa o elimina una para agregar otra.", { mode: "toast", ms: 3200 });
    return;
  }

  const existing = document.getElementById("urgentTaskModal");
  existing?.remove();

  const modal = document.createElement("div");
  modal.id = "urgentTaskModal";
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-content urgent-modal-card" role="dialog" aria-modal="true" aria-labelledby="urgentTaskModalTitle">
      <div class="modal-head">
        <h3 id="urgentTaskModalTitle">${task ? "Editar tarea urgente" : "Nueva tarea urgente"}</h3>
        <p class="muted">Máximo 2 tareas activas por usuario.</p>
      </div>
      <form id="urgentTaskForm" class="form-grid">
        <label>
          <span>Título</span>
          <input id="urgentTaskTitle" type="text" maxlength="120" required />
        </label>
        <label>
          <span>Descripción</span>
          <textarea id="urgentTaskDescription" maxlength="500" rows="4"></textarea>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-urgent-close>Cancelar</button>
          <button type="submit" class="btn primary">Guardar</button>
        </div>
      </form>
    </div>
  `;

  const overlay = document.createElement("div");
  overlay.id = "urgentTaskOverlay";
  overlay.className = "overlay";

  document.body.appendChild(overlay);
  document.body.appendChild(modal);
  document.body.classList.add("modal-open");

  const titleInput = modal.querySelector("#urgentTaskTitle");
  const descInput = modal.querySelector("#urgentTaskDescription");
  titleInput.value = task?.title || "";
  descInput.value = task?.description || "";
  titleInput.focus();

  const close = () => closeUrgentTaskModal();
  overlay.addEventListener("click", close);
  modal.querySelector("[data-urgent-close]")?.addEventListener("click", close);
  modal.querySelector("#urgentTaskForm")?.addEventListener("submit", (ev) => {
    ev.preventDefault();

    const title = titleInput.value.trim();
    const description = descInput.value.trim();

    if (!title) {
      notify("El titulo de la tarea urgente es obligatorio.", { mode: "toast" });
      titleInput.focus();
      return;
    }
    if (title.length > 120 || description.length > 500) {
      notify("Revisa la longitud del titulo o la descripcion.", { mode: "toast" });
      return;
    }

    if (task) {
      UI_STATE.onUpdateUrgentTask?.(task.slotId || task.id, { title, description });
    } else {
      const slotId = getFreeUrgentSlot();
      if (!slotId) {
        notify("Solo puedes tener 2 tareas urgentes. Completa o elimina una para agregar otra.", { mode: "toast", ms: 3200 });
        return;
      }
      UI_STATE.onCreateUrgentTask?.({ title, description });
    }

    closeUrgentTaskModal();
  });
}

function closeUrgentTaskModal() {
  document.getElementById("urgentTaskModal")?.remove();
  document.getElementById("urgentTaskOverlay")?.remove();
  if (!$eventModal || $eventModal.classList.contains("hidden")) {
    document.body.classList.remove("modal-open");
  }
}

function renderMiniOverviewItem(ev, { showDate = false, compact = false } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = compact ? "ov-item ov-compact" : "ov-item";
  btn.setAttribute("data-event-id", ev.id);
  applyHoverCardAttrs(btn, ev);

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
    ${UI_STATE.canWrite ? "" : `<span class="ov-st" aria-hidden="true" style="color:${STATUS_COLORS[st] || "#64748B"}">${escapeHtml(st === "done" ? "✓" : (st === "cancelled" ? "×" : "•"))}</span>`}
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
  applyHoverCardAttrs(chip, ev);

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

  applyHoverCardAttrs(chip, ev);
  return chip;
}

function renderQuickToggleHTML(ev, { small = false } = {}) {
  if (!UI_STATE.canWrite) return "";

  const st = ev.status || "pending";
  const isDone = st === "done";
  const label = ev?._virtualFromId
    ? (isDone ? "Separar ocurrencia como pendiente" : "Separar ocurrencia y marcar hecho")
    : (isDone ? "Marcar pendiente" : "Marcar hecho");
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

async function quickToggleDone(eventId) {
  const id = String(eventId || "").trim();
  if (!id) return;

  if (!UI_STATE.canWrite) {
    notify("Modo solo lectura.", { mode: "toast", ms: 1400 });
    return;
  }

  const raw = UI_STATE.rawEvents.find(e => String(e.id) === id);
  const visible = UI_STATE.events.find(e => String(e.id) === id);
  const target = raw || visible;
  if (!target) return;

  if (target._virtualFromId) {
    const next = (target.status === "done") ? "pending" : "done";
    try {
      await UI_STATE.onMaterializeOccurrence?.(target, { status: next });
      notify(next === "done" ? "Ocurrencia marcada como hecha ✅" : "Ocurrencia creada como pendiente ◻️", { mode: "toast", ms: 1600 });
    } catch (err) {
      console.error("quickToggleDone materialize error:", err);
      notify("No se pudo separar esta ocurrencia.", { mode: "alert" });
    }
    return;
  }

  const st = target.status || "pending";
  if (st === "cancelled") {
    notify("Este evento está cancelado. No lo marco como hecho.", { mode: "toast" });
    return;
  }

  const next = (st === "done") ? "pending" : "done";

  target.status = next;
  rerender();

  UI_STATE.onUpdate?.(id, { status: next });

  notify(next === "done" ? "Hecho ✅" : "Marcado como pendiente ◻️", { mode: "toast", ms: 1400 });
}

/* =========================
   Modal
========================= */
function openModalForNew(dateISO, prefillFromEvent = null) {
  if (!UI_STATE.canWrite) {
    notify("Modo solo lectura: no puedes crear eventos.", { mode: "toast" });
    return;
  }

  const iso = (dateISO && String(dateISO).trim()) ? String(dateISO).trim() : getSmartDefaultDateISO();

  UI_STATE.editingId = null;
  UI_STATE.modalSourceOccurrence = prefillFromEvent?._virtualFromId ? prefillFromEvent : null;
  if ($modalTitle) $modalTitle.textContent = UI_STATE.modalSourceOccurrence ? "Editar ocurrencia" : "Nuevo evento";

  const baseCat = getDefaultWritableCategoryId();

  populateAssignedToModal(UI_STATE.rawEvents);
  populateRecurrenceSelect();
  ensureRecurrenceSectionUI();

  if ($eventTitle) $eventTitle.value = prefillFromEvent?.title ? String(prefillFromEvent.title) : "";
  if ($eventCategory) $eventCategory.value = prefillFromEvent?.category ? String(prefillFromEvent.category) : baseCat;
  if ($eventDate) $eventDate.value = iso;
  if ($eventStatus) $eventStatus.value = prefillFromEvent?.status ? String(prefillFromEvent.status) : "pending";
  if ($eventNotes) $eventNotes.value = prefillFromEvent?.notes ? String(prefillFromEvent.notes) : "";
  if ($eventAssignedTo) $eventAssignedTo.value = prefillFromEvent?.assignedTo ? String(prefillFromEvent.assignedTo) : "";

  setRecurrenceControlsValue(prefillFromEvent?._virtualFromId ? null : prefillFromEvent?.recurrence || null);

  if (UI_STATE.canWrite && UI_STATE.modalSourceOccurrence) show($btnDeleteEvent);
  else hide($btnDeleteEvent);

  openModal();
  ensureModalEnhancements();

  setTimeout(() => $eventTitle?.focus(), 0);
}

function openModalForEdit(ev) {
  UI_STATE.editingId = ev.id;
  UI_STATE.modalSourceOccurrence = null;
  if ($modalTitle) $modalTitle.textContent = "Editar evento";

  populateAssignedToModal(UI_STATE.rawEvents, ev.assignedTo || "");
  populateRecurrenceSelect();
  ensureRecurrenceSectionUI();

  if ($eventTitle) $eventTitle.value = ev.title || "";
  if ($eventCategory) $eventCategory.value = ev.category || getDefaultWritableCategoryId();
  if ($eventDate) $eventDate.value = ev.dateISO || "";
  if ($eventStatus) $eventStatus.value = ev.status || "pending";
  if ($eventNotes) $eventNotes.value = ev.notes || "";
  if ($eventAssignedTo) $eventAssignedTo.value = ev.assignedTo || "";

  setRecurrenceControlsValue(ev.recurrence);

  if (UI_STATE.canWrite) show($btnDeleteEvent);
  else hide($btnDeleteEvent);

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
  const recurrence = readRecurrenceFromModal();
  const recurrenceParentId = UI_STATE.modalSourceOccurrence?._virtualFromId
    ? String(UI_STATE.modalSourceOccurrence._virtualFromId)
    : "";

  const problems = [];
  if (!title) problems.push("Ponle un título al evento.");
  if (!category) problems.push("Elige una categoría.");
  if (!dateISO) problems.push("Elige una fecha.");

  if (dateISO && !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    problems.push("La fecha debe estar en formato yyyy-mm-dd.");
  }

  if (recurrence) {
    const u = recurrence.unit;
    const n = recurrence.interval;
    if (!["day","week","month","year"].includes(u)) problems.push("Repetición inválida (unidad).");
    if (!Number.isFinite(n) || n < 1 || n > 100) problems.push("Repetición inválida (intervalo).");
    if (recurrence.untilISO && (!/^\d{4}-\d{2}-\d{2}$/.test(recurrence.untilISO) || recurrence.untilISO < dateISO)) {
      problems.push("La fecha final debe ser igual o posterior a la fecha del evento.");
    }
    if (u === "month" && recurrence.mode === "dayOfMonth") {
      if (!Number.isFinite(recurrence.dayOfMonth) || recurrence.dayOfMonth < 1 || recurrence.dayOfMonth > 31) {
        problems.push("El día del mes para la repetición es inválido.");
      }
    }
  }

  if (problems.length) {
    notify(problems.join("\n"), { mode: "alert" });
    (problems[0].includes("título") ? $eventTitle :
      problems[0].includes("categoría") ? $eventCategory : $eventDate
    )?.focus?.();
    return null;
  }

  return { title, category, dateISO, status, notes, assignedTo, recurrence, recurrenceParentId };
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
  UI_STATE.modalSourceOccurrence = null;
}

function ensureHoverCard() {
  if ($eventHoverCard) return $eventHoverCard;

  const card = document.createElement("div");
  card.className = "event-hover-card hidden";
  card.setAttribute("aria-hidden", "true");
  card.innerHTML = `
    <div class="event-hover-title" id="eventHoverTitle"></div>
    <div class="event-hover-meta" id="eventHoverMeta"></div>
    <div class="event-hover-extra hidden" id="eventHoverExtra"></div>
    <div class="event-hover-notes hidden" id="eventHoverNotes"></div>
  `;

  card.addEventListener("mouseenter", () => {
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
  });
  card.addEventListener("mouseleave", () => scheduleHideHoverCard());

  document.body.appendChild(card);
  $eventHoverCard = card;

  document.addEventListener("mouseover", handleHoverIntentStart);
  document.addEventListener("focusin", handleHoverIntentStart);
  document.addEventListener("mouseout", handleHoverIntentEnd);
  document.addEventListener("focusout", handleHoverIntentEnd);
  window.addEventListener("scroll", repositionHoverCard, true);
  window.addEventListener("resize", repositionHoverCard);

  return card;
}

function handleHoverIntentStart(event) {
  const trigger = event.target?.closest?.("[data-hover-title]");
  if (!trigger) return;

  if (hoverShowTimer) clearTimeout(hoverShowTimer);
  if (hoverHideTimer) clearTimeout(hoverHideTimer);
  hoverAnchorEl = trigger;

  const delay = event.type === "focusin" ? 150 : 900;
  hoverShowTimer = setTimeout(() => showHoverCard(trigger), delay);
}

function handleHoverIntentEnd(event) {
  const related = event.relatedTarget;
  if (related && (related.closest?.(".event-hover-card") || related.closest?.("[data-hover-title]"))) return;
  scheduleHideHoverCard();
}

function scheduleHideHoverCard() {
  if (hoverShowTimer) clearTimeout(hoverShowTimer);
  if (hoverHideTimer) clearTimeout(hoverHideTimer);
  hoverHideTimer = setTimeout(hideHoverCard, 120);
}

function showHoverCard(trigger) {
  ensureHoverCard();
  if (!$eventHoverCard || !trigger) return;

  hoverAnchorEl = trigger;

  const title = String(trigger.dataset.hoverTitle || "").trim();
  const meta = String(trigger.dataset.hoverMeta || "").trim();
  const extra = String(trigger.dataset.hoverExtra || "").trim();
  const notes = String(trigger.dataset.hoverNotes || "").trim();

  $eventHoverCard.querySelector("#eventHoverTitle").textContent = title;
  $eventHoverCard.querySelector("#eventHoverMeta").textContent = meta;

  const $extra = $eventHoverCard.querySelector("#eventHoverExtra");
  const $notes = $eventHoverCard.querySelector("#eventHoverNotes");
  $extra.textContent = extra;
  $notes.textContent = notes;
  $extra.classList.toggle("hidden", !extra);
  $notes.classList.toggle("hidden", !notes);

  $eventHoverCard.classList.remove("hidden");
  $eventHoverCard.classList.add("visible");
  $eventHoverCard.setAttribute("aria-hidden", "false");
  repositionHoverCard();
}

function repositionHoverCard() {
  if (!$eventHoverCard || !$eventHoverCard.classList.contains("visible") || !hoverAnchorEl) return;

  const rect = hoverAnchorEl.getBoundingClientRect();
  const cardRect = $eventHoverCard.getBoundingClientRect();
  const gap = 10;
  const maxLeft = Math.max(8, window.innerWidth - cardRect.width - 8);

  let top = rect.bottom + gap;
  let left = rect.left;

  if (top + cardRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - cardRect.height - gap);
  }

  left = Math.min(Math.max(8, left), maxLeft);

  $eventHoverCard.style.top = `${top + window.scrollY}px`;
  $eventHoverCard.style.left = `${left + window.scrollX}px`;
}

function hideHoverCard() {
  if (!$eventHoverCard) return;
  $eventHoverCard.classList.remove("visible");
  $eventHoverCard.classList.add("hidden");
  $eventHoverCard.setAttribute("aria-hidden", "true");
  hoverAnchorEl = null;
}

/* =============================================================================
   RECURRENCE UI PRO+
============================================================================= */
let $recUI = {
  wrap: null,
  toggle: null,
  every: null,
  unit: null,
  monthlyMode: null,
  dayOfMonth: null,
  until: null,
  summary: null,
  hint: null
};

function ensureRecurrenceSectionUI() {
  if (!$eventRecurrence) return;

  const baseRow = $eventRecurrence.closest(".form-row") || $eventRecurrence.closest(".form-2col") || $eventRecurrence.parentElement;
  if (!baseRow) return;

  const existing = baseRow.querySelector(".recurrence-pro");
  if (existing) {
    $recUI.wrap = existing;
    $recUI.toggle = existing.querySelector("#recProToggle");
    $recUI.every = existing.querySelector("#recProEvery");
    $recUI.unit = existing.querySelector("#recProUnit");
    $recUI.monthlyMode = existing.querySelector("#recProMonthlyMode");
    $recUI.dayOfMonth = existing.querySelector("#recProDayOfMonth");
    $recUI.until = existing.querySelector("#recProUntil");
    $recUI.summary = existing.querySelector("#recProSummary");
    $recUI.hint = existing.querySelector("#recProHint");
    bindRecurrenceUIOnce();
    updateRecurrenceSummary();
    return;
  }

  const slot = (baseRow.classList?.contains("form-2col"))
    ? baseRow.querySelector('div[aria-hidden="true"]')
    : null;

  const wrap = document.createElement("section");
  wrap.className = "recurrence-pro";
  wrap.setAttribute("aria-label", "Repetición del evento");

  wrap.innerHTML = `
    <div class="recurrence-pro-head">
      <div class="recurrence-pro-title">Repetición</div>
      <div class="recurrence-pro-sub muted">Haz que este evento se repita automáticamente.</div>
    </div>

    <div class="recurrence-pro-grid">
      <div class="recurrence-pro-left">
        <div class="recurrence-pro-field">
          <div class="recurrence-pro-label">Preset</div>
          <div class="recurrence-pro-control" data-rec-pro-anchor></div>
          <div class="recurrence-pro-help muted">Puedes usar un preset o personalizar abajo.</div>
        </div>
      </div>

      <div class="recurrence-pro-right">
        <label class="recurrence-pro-toggle">
          <input type="checkbox" id="recProToggle" />
          <span>Repetir</span>
        </label>

        <div class="recurrence-pro-controls hidden" id="recProControls">
          <div class="recurrence-pro-every">
            <span class="muted">Cada</span>
            <input id="recProEvery" type="number" min="1" max="100" value="1" inputmode="numeric" />
            <select id="recProUnit">
              <option value="day">Día(s)</option>
              <option value="week">Semana(s)</option>
              <option value="month">Mes(es)</option>
              <option value="year">Año(s)</option>
            </select>
          </div>

          <div class="recurrence-pro-month hidden" id="recProMonthConfig">
            <label class="recurrence-pro-inline">
              <span class="muted">En mes:</span>
              <select id="recProMonthlyMode">
                <option value="sameDate">Mismo día del evento</option>
                <option value="dayOfMonth">Día fijo del mes</option>
              </select>
            </label>

            <label class="recurrence-pro-inline hidden" id="recProDayWrap">
              <span class="muted">Día</span>
              <input id="recProDayOfMonth" type="number" min="1" max="31" value="1" inputmode="numeric" />
            </label>
          </div>

          <label class="recurrence-pro-inline">
            <span class="muted">Hasta</span>
            <input id="recProUntil" type="date" aria-label="Repetir hasta esta fecha" />
          </label>

          <div class="recurrence-pro-hint muted" id="recProHint"></div>
        </div>

        <div class="recurrence-pro-summary" id="recProSummary"></div>
      </div>
    </div>
  `;

  const anchor = wrap.querySelector("[data-rec-pro-anchor]");
  if (anchor) anchor.appendChild($eventRecurrence);

  if (slot) slot.replaceWith(wrap);
  else $eventRecurrence.insertAdjacentElement("afterend", wrap);

  $recUI.wrap = wrap;
  $recUI.toggle = wrap.querySelector("#recProToggle");
  $recUI.every = wrap.querySelector("#recProEvery");
  $recUI.unit = wrap.querySelector("#recProUnit");
  $recUI.monthlyMode = wrap.querySelector("#recProMonthlyMode");
  $recUI.dayOfMonth = wrap.querySelector("#recProDayOfMonth");
  $recUI.until = wrap.querySelector("#recProUntil");
  $recUI.summary = wrap.querySelector("#recProSummary");
  $recUI.hint = wrap.querySelector("#recProHint");

  bindRecurrenceUIOnce();
  updateRecurrenceSummary();
}

function bindRecurrenceUIOnce() {
  if (!$recUI.wrap || $recUI.wrap._bound) return;
  $recUI.wrap._bound = true;

  const $controls = $recUI.wrap.querySelector("#recProControls");
  const $monthCfg = $recUI.wrap.querySelector("#recProMonthConfig");
  const $dayWrap = $recUI.wrap.querySelector("#recProDayWrap");

  const syncMonthUI = () => {
    const isMonth = ($recUI.unit?.value || "") === "month";
    $monthCfg?.classList.toggle("hidden", !isMonth);

    const mode = $recUI.monthlyMode?.value || "sameDate";
    const showDay = isMonth && mode === "dayOfMonth";
    $dayWrap?.classList.toggle("hidden", !showDay);

    if (showDay && $recUI.dayOfMonth && (!$recUI.dayOfMonth.value || $recUI.dayOfMonth.value === "1")) {
      $recUI.dayOfMonth.value = String(getEventDateDayOfMonth());
    }
  };

  const updateFromAdvanced = () => {
    if (!$recUI.toggle?.checked) return;
    syncMonthUI();
    setRecurrenceControlsValue(readAdvancedRecurrence());
    updateRecurrenceSummary();
  };

  const onToggle = () => {
    const on = !!$recUI.toggle?.checked;
    $controls?.classList.toggle("hidden", !on);

    if (!on) {
      setRecurrenceControlsValue(null);
    } else {
      syncMonthUI();
      setRecurrenceControlsValue(readAdvancedRecurrence() || { unit: "week", interval: 1 });
    }
    updateRecurrenceSummary();
  };

  $recUI.toggle?.addEventListener("change", onToggle);
  $recUI.every?.addEventListener("input", updateFromAdvanced);
  $recUI.unit?.addEventListener("change", updateFromAdvanced);
  $recUI.monthlyMode?.addEventListener("change", updateFromAdvanced);
  $recUI.dayOfMonth?.addEventListener("input", updateFromAdvanced);
  $recUI.until?.addEventListener("change", updateFromAdvanced);

  if ($eventDate && !$eventDate._recDateBound) {
    $eventDate.addEventListener("change", () => {
      if (($recUI.unit?.value || "") === "month" && ($recUI.monthlyMode?.value || "") === "dayOfMonth" && $recUI.dayOfMonth) {
        if (!$recUI.dayOfMonth.value || Number($recUI.dayOfMonth.value) < 1) {
          $recUI.dayOfMonth.value = String(getEventDateDayOfMonth());
        }
      }
      updateRecurrenceSummary();
    });
    $eventDate._recDateBound = true;
  }

  if ($eventRecurrence && !$eventRecurrence._recBound) {
    $eventRecurrence.addEventListener("change", () => {
      const rec = parseRecurrenceFromControlValue($eventRecurrence.value);
      syncAdvancedRecUI(rec);
      updateRecurrenceSummary();
    });
    $eventRecurrence._recBound = true;
  }

  syncMonthUI();
}

function readAdvancedRecurrence() {
  if (!($recUI.toggle && $recUI.every && $recUI.unit && $recUI.toggle.checked)) return null;

  const interval = clampInt($recUI.every.value, 1, 100, 1);
  const unit = String($recUI.unit.value || "week").trim();
  const untilISO = String($recUI.until?.value || "").trim();

  if (unit === "month") {
    const monthlyMode = String($recUI.monthlyMode?.value || "sameDate").trim();
    if (monthlyMode === "dayOfMonth") {
      const dayOfMonth = clampInt($recUI.dayOfMonth?.value, 1, 31, getEventDateDayOfMonth());
      return normalizeRecurrence({ unit, interval, mode: "dayOfMonth", dayOfMonth, untilISO });
    }
  }

  return normalizeRecurrence({ unit, interval, untilISO });
}

function updateRecurrenceSummary() {
  if (!$recUI.wrap || !$recUI.summary || !$recUI.hint) return;

  const rec = readRecurrenceFromModal();
  const label = recurrenceLabel(rec);

  if (!rec) {
    $recUI.summary.textContent = "Sin repetición";
    $recUI.summary.classList.remove("on");
    $recUI.hint.textContent = "";
    return;
  }

  $recUI.summary.textContent = `Se repetirá: ${label}`;
  $recUI.summary.classList.add("on");

  if (rec.unit === "month" && rec.mode === "dayOfMonth" && Number.isFinite(rec.dayOfMonth)) {
    $recUI.hint.textContent = `→ Se intentará crear cada ${rec.interval === 1 ? "mes" : `${rec.interval} meses`} el día ${rec.dayOfMonth}.`;
    return;
  }

  if (rec.unit === "month") {
    const sourceDay = getEventDateDayOfMonth();
    $recUI.hint.textContent = `→ Mantendrá la referencia del día ${sourceDay} del evento original cuando sea posible.`;
    return;
  }

  $recUI.hint.textContent = label ? `→ ${label}` : "";
}

function populateRecurrenceSelect() {
  if (!$eventRecurrence) return;

  const isSelect = ($eventRecurrence.tagName || "").toLowerCase() === "select";
  if (!isSelect) return;

  const prev = String($eventRecurrence.value || "").trim();

  const opts = [
    { value: "", label: "—" },
    { value: JSON.stringify({ unit: "day", interval: 1 }),   label: "Diario" },
    { value: JSON.stringify({ unit: "week", interval: 1 }),  label: "Semanal" },
    { value: JSON.stringify({ unit: "week", interval: 2 }),  label: "Cada 2 semanas" },
    { value: JSON.stringify({ unit: "week", interval: 3 }),  label: "Cada 3 semanas" },
    { value: JSON.stringify({ unit: "month", interval: 1 }), label: "Mensual" },
    { value: JSON.stringify({ unit: "month", interval: 1, mode: "dayOfMonth", dayOfMonth: getEventDateDayOfMonth() }), label: "Cada mes el día actual" },
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

  const prevRec = parseRecurrenceFromControlValue(prev);
  const prevVal = recurrenceToSelectValue(prevRec);

  if (opts.some(o => o.value === prevVal)) $eventRecurrence.value = prevVal;
  else $eventRecurrence.value = "";
}

function setRecurrenceControlsValue(rec) {
  const r = normalizeRecurrence(rec);

  if ($eventRecurrence) {
    const isSelect = ($eventRecurrence.tagName || "").toLowerCase() === "select";
    if (isSelect) $eventRecurrence.value = recurrenceToSelectValue(r);
    else $eventRecurrence.value = r ? recurrenceToSelectValue(r) : "";
  }

  syncAdvancedRecUI(r);
  updateRecurrenceSummary();
}

function syncAdvancedRecUI(rec) {
  const r = normalizeRecurrence(rec);

  if (!$recUI.wrap || !$recUI.toggle || !$recUI.every || !$recUI.unit) return;
  const $controls = $recUI.wrap.querySelector("#recProControls");
  const $monthCfg = $recUI.wrap.querySelector("#recProMonthConfig");
  const $dayWrap = $recUI.wrap.querySelector("#recProDayWrap");

  if (!r) {
    $recUI.toggle.checked = false;
    $controls?.classList.add("hidden");
    $monthCfg?.classList.add("hidden");
    $dayWrap?.classList.add("hidden");
    $recUI.every.value = "1";
    $recUI.unit.value = "week";
    if ($recUI.monthlyMode) $recUI.monthlyMode.value = "sameDate";
    if ($recUI.dayOfMonth) $recUI.dayOfMonth.value = String(getEventDateDayOfMonth());
    if ($recUI.until) $recUI.until.value = "";
    return;
  }

  $recUI.toggle.checked = true;
  $controls?.classList.remove("hidden");
  $recUI.every.value = String(r.interval || 1);
  $recUI.unit.value = r.unit || "week";
  if ($recUI.until) $recUI.until.value = r.untilISO || "";

  const isMonth = r.unit === "month";
  $monthCfg?.classList.toggle("hidden", !isMonth);

  if (isMonth && r.mode === "dayOfMonth" && Number.isFinite(r.dayOfMonth)) {
    if ($recUI.monthlyMode) $recUI.monthlyMode.value = "dayOfMonth";
    if ($recUI.dayOfMonth) $recUI.dayOfMonth.value = String(r.dayOfMonth);
    $dayWrap?.classList.remove("hidden");
  } else {
    if ($recUI.monthlyMode) $recUI.monthlyMode.value = "sameDate";
    if ($recUI.dayOfMonth) $recUI.dayOfMonth.value = String(getEventDateDayOfMonth());
    $dayWrap?.classList.add("hidden");
  }
}

function readRecurrenceFromModal() {
  const advanced = readAdvancedRecurrence();
  if (advanced) return advanced;

  if ($eventRecurrence) {
    const v = String($eventRecurrence.value || "").trim();
    return parseRecurrenceFromControlValue(v);
  }

  return null;
}

/* =========================
   Agenda del día (modal)
========================= */
function buildDayAgendaUI(modalContent) {
  const head = modalContent.querySelector(".modal-head");
  const form = modalContent.querySelector("#eventForm");
  if (!head || !form) return;

  if (!modalContent.querySelector("#dayAgendaBar")) {
    const bar = document.createElement("div");
    bar.id = "dayAgendaBar";
    bar.className = "day-agenda-bar";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btnViewDayAgenda";
    btn.className = "btn ghost";
    btn.textContent = "Ver eventos del día";
    btn.setAttribute("aria-haspopup", "false");

    bar.appendChild(btn);
    head.appendChild(bar);
  }

  if (!modalContent.querySelector("#dayAgendaWrap")) {
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

function sortAgendaEvents(a, b) {
  const sa = String(a?.status || "pending");
  const sb = String(b?.status || "pending");
  const rank = (s) => (s === "pending" ? 0 : s === "cancelled" ? 1 : 2);
  const ra = rank(sa), rb = rank(sb);
  if (ra !== rb) return ra - rb;
  const ta = String(a?.title || "").toLowerCase();
  const tb = String(b?.title || "").toLowerCase();
  return ta.localeCompare(tb);
}

function renderDayAgenda(dateISO) {
  const modalContent = $eventModal?.querySelector(".modal-content");
  const wrap = modalContent?.querySelector("#dayAgendaWrap");
  const meta = modalContent?.querySelector("#dayAgendaMeta");
  const list = modalContent?.querySelector("#dayAgendaList");
  if (!wrap || !meta || !list) return;

  const iso = (dateISO && String(dateISO).trim()) ? String(dateISO).trim() : "";
  const all = (UI_STATE.events || []).filter(ev => String(ev.dateISO || "") === iso);
  all.sort(sortAgendaEvents);

  meta.textContent = iso ? `${iso} · ${all.length} evento${all.length === 1 ? "" : "s"}` : "";

  if (!iso) {
    list.innerHTML = `<div class="muted">Elige una fecha para ver la agenda.</div>`;
    return;
  }
  if (!all.length) {
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

  if (!list._agendaBound) {
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-agenda-id]");
      if (!btn) return;
      const id = btn.getAttribute("data-agenda-id");
      const ev = (UI_STATE.events || []).find(x => x.id === id);
      if (!ev) return;

      if (ev._virtualFromId) {
        if (!UI_STATE.canWrite) {
          notify("Modo solo lectura.", { mode: "toast", ms: 1400 });
          return;
        }
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

  if (btnView && !btnView._agendaBound) {
    btnView.addEventListener("click", () => {
      if (!wrap) return;
      wrap.classList.toggle("hidden");
      if (!wrap.classList.contains("hidden")) renderDayAgenda($eventDate?.value || "");
    });
    btnView._agendaBound = true;
  }

  if (btnClose && !btnClose._agendaBound) {
    btnClose.addEventListener("click", () => wrap?.classList.add("hidden"));
    btnClose._agendaBound = true;
  }

  if (btnToday && !btnToday._agendaBound) {
    btnToday.addEventListener("click", () => {
      const iso = toISODateLocal(new Date());
      if ($eventDate) $eventDate.value = iso;
      renderDayAgenda(iso);
      wrap?.classList.remove("hidden");
    });
    btnToday._agendaBound = true;
  }

  if ($eventDate && !($eventDate._agendaBound)) {
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
    const prev = $filterCategory.value || "";
    $filterCategory.innerHTML = "";
    if (keep) $filterCategory.appendChild(keep);

    // El filtro solo ofrece categorías que el rol puede VER (read). Así una
    // asesora no ve categorías ajenas (p. ej. "Administrativo") que no puede
    // ver, editar ni agregar, y no se confunde. Dirección las tiene todas.
    const readable = Array.isArray(UI_STATE.allowedCategories) ? UI_STATE.allowedCategories : [];
    const restrictFilter = readable.length > 0;
    for (const c of (UI_STATE.categories || getCategories())) {
      if (restrictFilter && !readable.includes(c.id)) continue;
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.label;
      $filterCategory.appendChild(opt);
    }

    if (prev && Array.from($filterCategory.options).some(o => o.value === prev)) {
      $filterCategory.value = prev;
    }
  }

  if ($eventCategory) {
    const prev = $eventCategory.value || "";
    // El formulario de crear/editar solo ofrece categorías que el rol puede
    // EDITAR (coincide con lo que permiten las reglas de Firestore). Dirección
    // tiene todas en su lista, así que no se le filtra ninguna.
    const writable = Array.isArray(UI_STATE.writeCategories) ? UI_STATE.writeCategories : [];
    const restrict = writable.length > 0;
    $eventCategory.innerHTML = "";
    for (const c of (UI_STATE.categories || getCategories())) {
      if (restrict && !writable.includes(c.id)) continue;
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.label;
      $eventCategory.appendChild(opt);
    }
    if (prev && Array.from($eventCategory.options).some(o => o.value === prev)) {
      $eventCategory.value = prev;
    }
  }

  renderCategoryLegend();
}

/* =========================
   Leyenda de categorías (colores)
========================= */
function renderCategoryLegend() {
  const filters = document.querySelector(".filters");
  if (!filters) return;

  let legend = document.getElementById("categoryLegend");
  if (!legend) {
    legend = document.createElement("div");
    legend.id = "categoryLegend";
    legend.className = "category-legend";
    filters.appendChild(legend);
  }

  const allCats = (UI_STATE.categories && UI_STATE.categories.length)
    ? UI_STATE.categories
    : getCategories();

  // La leyenda solo muestra las categorías que el rol puede VER (read).
  const readable = Array.isArray(UI_STATE.allowedCategories) ? UI_STATE.allowedCategories : [];
  const cats = readable.length > 0
    ? allCats.filter(c => readable.includes(c.id))
    : allCats;

  legend.innerHTML = cats.map(c => `
    <span class="legend-item" title="${escapeHtml(c.label)}">
      <span class="legend-dot" style="background:${escapeHtml(c.color || "#64748B")}"></span>
      <span class="legend-label">${escapeHtml(c.label)}</span>
    </span>
  `).join("");
}

function populateStatusSelects() {
  if ($eventStatus) {
    const prev = $eventStatus.value || "";
    $eventStatus.innerHTML = "";
    for (const s of EVENT_STATUS) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.label;
      $eventStatus.appendChild(opt);
    }
    if (prev && Array.from($eventStatus.options).some(o => o.value === prev)) {
      $eventStatus.value = prev;
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
   Recurrentes: expansión visible
========================= */
function expandRecurringForVisibleRange(rawEvents, year, monthIndex) {
  const events = Array.isArray(rawEvents) ? rawEvents : [];

  const gridDays = buildMonthGrid(year, monthIndex, CALENDAR_CONFIG.weekStartsOn);
  const fromISO = toISODateLocal(gridDays[0]);
  const toISO   = toISODateLocal(gridDays[gridDays.length - 1]);

  const out = [];

  for (const ev of events) {
    if (ev?.recurrenceSkip) continue;

    const startISO = String(ev.dateISO || "").trim();
    const rec = normalizeRecurrence(ev.recurrence);
    if (rec && startISO) {
      out.push(...expandInterval(ev, startISO, fromISO, toISO, rec));
      continue;
    }

    out.push(ev);
  }

  const seen = new Set();
  const materializedKeys = new Set(
    events
      .filter(e => e.recurrenceParentId && e.dateISO)
      .map(e => `${e.recurrenceParentId}::${e.dateISO}`)
  );
  const cleaned = [];
  for (const e of out) {
    if (e._virtualFromId && materializedKeys.has(`${e._virtualFromId}::${e.dateISO || ""}`)) continue;
    const key = `${e.id}::${e.dateISO || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(e);
  }

  return cleaned;
}

function expandInterval(ev, startISO, fromISO, toISO, rec) {
  const res = [];

  const startD = isoToDate(startISO);
  const fromD = isoToDate(fromISO);
  const toD   = isoToDate(toISO);
  const untilD = rec?.untilISO ? isoToDate(rec.untilISO) : null;

  let cur = new Date(startD);
  let guard = 0;
  while (cur <= toD && (!untilD || cur <= untilD) && guard < 5000) {
    const iso = toISODateLocal(cur);
    if (cur >= fromD) res.push(makeVirtualOccurrence(ev, iso));
    cur = addByRecurrence(cur, rec, startD);
    guard++;
  }

  return res;
}

function addByRecurrence(date, rec, anchorStartDate) {
  const d = new Date(date);
  const unit = rec?.unit || "week";
  const n = Number(rec?.interval || 1);

  if (unit === "day") {
    d.setDate(d.getDate() + n);
    return d;
  }

  if (unit === "week") {
    d.setDate(d.getDate() + (n * 7));
    return d;
  }

  const anchorDay = (anchorStartDate instanceof Date) ? anchorStartDate.getDate() : d.getDate();

  if (unit === "month") {
    const y = d.getFullYear();
    const m = d.getMonth() + n;
    const base = new Date(y, m, 1, 0,0,0,0);

    let targetDay = anchorDay;
    if (rec?.mode === "dayOfMonth" && Number.isFinite(rec?.dayOfMonth)) {
      targetDay = rec.dayOfMonth;
    }

    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    base.setDate(Math.min(targetDay, last));
    return base;
  }

  if (unit === "year") {
    const y = d.getFullYear() + n;
    const m = d.getMonth();
    const base = new Date(y, m, 1, 0,0,0,0);
    const last = new Date(y, m + 1, 0).getDate();
    base.setDate(Math.min(anchorDay, last));
    return base;
  }

  d.setDate(d.getDate() + (n * 7));
  return d;
}

function makeVirtualOccurrence(ev, dateISO) {
  return {
    ...ev,
    id: `${ev.id}__v__${dateISO}`,
    dateISO,
    _virtualFromId: ev.id,
    recurrenceParentId: ev.id
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
   Tiny date utils
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

function slugifyCategoryId(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function pickUniqueCategoryId(label, used) {
  let base = slugifyCategoryId(label) || "categoria";
  if (base === "otro") base = "categoria_otro";
  let id = base;
  let i = 2;
  while (used.has(id)) {
    id = `${base}_${i}`;
    i++;
  }
  used.add(id);
  return id;
}

/* =========================
   Notificaciones
========================= */
export function notify(msg, { mode = "toast", ms = 2200 } = {}) {
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

      <p class="cat-modal-hint">Cambias nombres y colores aquí. Se guarda en la nube y lo ven todos los usuarios.</p>

      <div class="cat-list" id="catList"></div>

      <div class="cat-modal-foot">
        <button type="button" class="btn" id="btnCatAdd">+ Agregar categoría</button>
        <button type="button" class="btn primary" id="btnCatSave">Guardar cambios</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  $categoryModal = modal;

  modal.querySelectorAll("[data-cat-close]").forEach(el => el.addEventListener("click", closeCategoryManager));

  modal.querySelector("#btnCatAdd")?.addEventListener("click", () => {
    const list = modal.querySelector("#catList");
    list?.appendChild(renderCategoryRow({ id: "", label: "", color: "#64748B" }, { isNew: true }));
    list?.querySelector(".cat-row:last-child .cat-label")?.focus?.();
  });

  modal.querySelector("#btnCatSave")?.addEventListener("click", saveCategoryManager);
  modal.querySelector("#btnCatReset")?.addEventListener("click", () => {
    const ok = confirm("¿Restaurar las categorías por defecto? Esto afecta a todos los usuarios.");
    if (!ok) return;
    UI_STATE.categories = resetCategories();
    rebuildCategoryMap();
    populateCategorySelects();
    rerender();
    renderCategoryManagerList();
    saveCatalogSettings({ categories: UI_STATE.categories }, UI_STATE.userEmail)
      .catch(err => console.error("reset categories sync error:", err));
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
  for (const c of cats) list.appendChild(renderCategoryRow(c));
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
    if (affected.length && typeof UI_STATE.onUpdate === "function" && UI_STATE.canWrite) {
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

async function saveCategoryManager() {
  if (!$categoryModal) return;
  const list = $categoryModal.querySelector("#catList");
  if (!list) return;

  const rows = Array.from(list.querySelectorAll(".cat-row"));
  const used = new Set();
  const next = [];

  for (const row of rows) {
    const idExisting = String(row.dataset.catId || "").trim();
    const label = String(row.querySelector(".cat-label")?.value || "").trim();
    const color = String(row.querySelector("input[type='color']")?.value || "#64748B").trim();

    if (!label) continue;

    let id = idExisting || "";
    if (!id) id = pickUniqueCategoryId(label, used);
    else {
      id = slugifyCategoryId(id) || pickUniqueCategoryId(label, used);
      if (used.has(id)) id = pickUniqueCategoryId(label, used);
      else used.add(id);
    }

    next.push({ id, label, color });
  }

  if (!next.some(c => c.id === "otro")) {
    next.push({ id: "otro", label: "Otro", color: "#64748B" });
  }

  const final = next.length ? next : DEFAULT_CATEGORIES;
  UI_STATE.categories = setCategories(final);
  rebuildCategoryMap();
  populateCategorySelects();

  if ($eventCategory && !$eventCategory.value) $eventCategory.value = "otro";

  rerender();
  renderCategoryManagerList();

  try {
    await saveCatalogSettings({ categories: final }, UI_STATE.userEmail);
  } catch (err) {
    console.error("saveCategoryManager error:", err);
    notify("No se pudieron guardar las categorías en la nube. Revisa tu conexión o permisos.", { ms: 3200 });
    return;
  }

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

      <p class="cat-modal-hint">Agrega, renombra o elimina responsables. Se guarda en la nube y lo ven todos los usuarios.</p>

      <div class="cat-list" id="asgList"></div>

      <div class="cat-modal-foot">
        <button type="button" class="btn" id="btnAsgAdd">+ Agregar responsable</button>
        <button type="button" class="btn primary" id="btnAsgSave">Guardar cambios</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  $assigneeModal = modal;

  modal.querySelectorAll("[data-asg-close]").forEach(el => el.addEventListener("click", closeAssigneeManager));

  modal.querySelector("#btnAsgAdd")?.addEventListener("click", () => {
    const list = modal.querySelector("#asgList");
    list?.appendChild(renderAssigneeRow("", { isNew: true }));
    list?.querySelector(".cat-row:last-child .cat-label")?.focus?.();
  });

  modal.querySelector("#btnAsgSave")?.addEventListener("click", saveAssigneeManager);
  modal.querySelector("#btnAsgReset")?.addEventListener("click", () => {
    const ok = confirm("¿Restaurar los responsables por defecto? Esto afecta a todos los usuarios.");
    if (!ok) return;
    const assignees = resetAssignees();
    populateAssignedSelect(UI_STATE.rawEvents);
    populateAssignedToModal(UI_STATE.rawEvents, ($eventAssignedTo?.value || "").trim());
    rerender();
    renderAssigneeManagerList();
    saveCatalogSettings({ assignees }, UI_STATE.userEmail)
      .catch(err => console.error("reset assignees sync error:", err));
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
  for (const name of names) list.appendChild(renderAssigneeRow(name));
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
    if (affected.length && typeof UI_STATE.onUpdate === "function" && UI_STATE.canWrite) {
      notify(`Quitando responsable en ${affected.length} evento(s)...`, { ms: 2600 });
      for (const ev of affected) {
        try { await UI_STATE.onUpdate(ev.id, { assignedTo: "" }); } catch (e) { console.error(e); }
      }
    }

    row.remove();
  });

  return row;
}

async function saveAssigneeManager() {
  if (!$assigneeModal) return;
  const list = $assigneeModal.querySelector("#asgList");
  if (!list) return;

  const rows = Array.from(list.querySelectorAll(".cat-row"));
  const dedupe = new Map();

  for (const row of rows) {
    const raw = row.querySelector(".cat-label")?.value || "";
    const clean = String(raw).trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!dedupe.has(key)) dedupe.set(key, clean);
  }

  const names = Array.from(dedupe.values()).sort((a,b) => a.localeCompare(b, "es"));
  const final = setAssignees(names);

  populateAssignedSelect(UI_STATE.rawEvents);
  populateAssignedToModal(UI_STATE.rawEvents, ($eventAssignedTo?.value || "").trim());
  rerender();
  renderAssigneeManagerList();

  try {
    await saveCatalogSettings({ assignees: final }, UI_STATE.userEmail);
  } catch (err) {
    console.error("saveAssigneeManager error:", err);
    notify("No se pudieron guardar los responsables en la nube. Revisa tu conexión o permisos.", { ms: 3200 });
    return;
  }

  notify(`Responsables guardados ✅ (${final.length})`);
  closeAssigneeManager();
}
