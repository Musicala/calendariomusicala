/* =============================================================================
  js/app.js — Orquestador (Auth -> UI -> Firestore) — vNEXT (RBAC + READONLY + SAFER SUBS)
  -----------------------------------------------------------------------------
  - Escucha auth:changed (de auth.js)
      detail esperado:
        { user, allowed, email, role, canWrite, allowedCategories }
  - Inicializa UI una sola vez
  - Suscribe eventos del mes en tiempo real (con LOOKBACK para recurrencias “semilla”)
  - CRUD usando db.js, pero:
      ✅ bloquea escrituras si canWrite === false (Académico = solo ver)
      ✅ filtra consultas por allowedCategories (RBAC cliente)
============================================================================= */

import { initUI, setEvents, setMonth, getCurrentView } from "./ui.js";
import { createEvent, updateEvent, softDeleteEvent, subscribeEventsInRange } from "./db.js";
import { startOfMonth, endOfMonth } from "./utils.js";

// Para que repeticiones aparezcan en meses futuros,
// cargamos eventos “semilla” de meses anteriores.
const LOOKBACK_YEARS = 5;

/* =========================
   Estado global app
========================= */
let CURRENT_USER = null;           // Firebase user
let USER_EMAIL = "";               // email normalizado
let USER_ROLE = null;              // "administrativo" | "academico" | null
let CAN_WRITE = false;             // permisos derivados
let ALLOWED_CATEGORIES = [];       // categorías permitidas para queries

let unsubMonth = null;             // unsubscribe del onSnapshot
let uiInitialized = false;

/* =========================
   Helpers
========================= */
function safeUnsub() {
  try { unsubMonth?.(); } catch (_) {}
  unsubMonth = null;
}

function monthRange(year, monthIndex) {
  // Traemos varios años hacia atrás para incluir “semillas” de recurrencia.
  // La UI se encarga de mostrar solo el mes visible.
  const from = startOfMonth(year - LOOKBACK_YEARS, 0); // 1 enero (año - lookback)
  const to   = endOfMonth(year, monthIndex);           // fin del mes visible
  return { from, to };
}

function requireSession() {
  if (!CURRENT_USER || !USER_EMAIL) throw new Error("No hay sesión activa.");
}

function requireWrite() {
  if (!CAN_WRITE) throw new Error("Tu usuario está en modo solo lectura.");
}

function toast(msg) {
  // Minimalista por ahora
  console.log(msg);
}

/* =========================
   Subscribir eventos del mes (con RBAC)
========================= */
function subscribeMonth(year, monthIndex) {
  safeUnsub();

  const { from, to } = monthRange(year, monthIndex);

  unsubMonth = subscribeEventsInRange(
    from,
    to,
    (events) => {
      setEvents(events);
    },
    (err) => {
      console.error(err);
      alert("No se pudieron cargar eventos (revisa permisos o conexión).");
    },
    // opts RBAC cliente (db.js lo usa para filtrar category in allowedCategories)
    { allowedCategories: ALLOWED_CATEGORIES }
  );
}

/* =========================
   UI callbacks (CRUD)
   - Bloquean escritura si CAN_WRITE = false
========================= */
async function handleCreate(payload) {
  try {
    requireSession();
    requireWrite();

    await createEvent(payload, USER_EMAIL);
    toast("Evento creado ✅");
    // El snapshot realtime actualiza solo
  } catch (e) {
    console.error("Create error:", e);
    alert(e?.message || "No se pudo crear el evento.");
  }
}

async function handleUpdate(id, payload) {
  try {
    requireSession();
    requireWrite();

    await updateEvent(id, payload, USER_EMAIL);
    toast("Evento actualizado ✅");
  } catch (e) {
    console.error("Update error:", e);
    alert(e?.message || "No se pudo actualizar el evento.");
  }
}

async function handleDelete(id) {
  try {
    requireSession();
    requireWrite();

    const ok = confirm("¿Seguro que deseas eliminar este evento? (Queda en papelera)");
    if (!ok) return;

    await softDeleteEvent(id, USER_EMAIL);
    toast("Evento eliminado 🗑️");
  } catch (e) {
    console.error("Delete error:", e);
    alert(e?.message || "No se pudo eliminar el evento.");
  }
}

function handleNavigate({ year, monthIndex }) {
  subscribeMonth(year, monthIndex);
}

/* =========================
   Init UI una sola vez
========================= */
function ensureUI() {
  if (uiInitialized) return;

  initUI({
    onNavigate: handleNavigate,
    onCreate: handleCreate,
    onUpdate: handleUpdate,
    onDelete: handleDelete
  });

  uiInitialized = true;
}

/* =========================
   Listener de auth.js
========================= */
window.addEventListener("auth:changed", (ev) => {
  const detail = ev?.detail || {};
  const { user, allowed } = detail;

  // No permitido / logged out
  if (!user || !allowed) {
    CURRENT_USER = null;
    USER_EMAIL = "";
    USER_ROLE = null;
    CAN_WRITE = false;
    ALLOWED_CATEGORIES = [];

    safeUnsub();
    // UI ya queda escondida desde auth.js
    return;
  }

  // Autorizado (con roles)
  CURRENT_USER = user;
  USER_EMAIL = (detail.email || user.email || "").toLowerCase().trim();

  USER_ROLE = detail.role || null;
  CAN_WRITE = !!detail.canWrite;
  ALLOWED_CATEGORIES = Array.isArray(detail.allowedCategories) ? detail.allowedCategories : [];

  // UI
  ensureUI();

  // Mes actual (el que está mostrando UI)
  const { year, monthIndex } = getCurrentView();
  setMonth(year, monthIndex);
  subscribeMonth(year, monthIndex);

  // Opcional: log útil para debug
  console.log("[auth] role:", USER_ROLE, "canWrite:", CAN_WRITE, "cats:", ALLOWED_CATEGORIES);
});

/* =============================================================================
  Nota: al recargar la página, auth.js disparará auth:changed automáticamente.
============================================================================= */