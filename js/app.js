/* =============================================================================
  js/app.js — Orquestador (Auth -> UI -> Firestore)
  - Escucha auth:changed (de auth.js)
  - Inicializa UI
  - Suscribe eventos del mes en tiempo real
  - CRUD (create/update/soft delete) usando db.js
============================================================================= */

import { initUI, setEvents, setMonth, getCurrentView } from "./ui.js";
import { createEvent, updateEvent, softDeleteEvent, subscribeEventsInRange } from "./db.js";
import { startOfMonth, endOfMonth } from "./utils.js";

/* =========================
   Estado global app
========================= */
let CURRENT_USER = null;     // Firebase user
let USER_EMAIL = "";         // email normalizado
let unsubMonth = null;       // función unsubscribe del onSnapshot
let uiInitialized = false;

/* =========================
   Helpers
========================= */
function safeUnsub() {
  try { unsubMonth?.(); } catch (_) {}
  unsubMonth = null;
}

function monthRange(year, monthIndex) {
  return {
    from: startOfMonth(year, monthIndex),
    to: endOfMonth(year, monthIndex)
  };
}

function requireEmail() {
  if (!USER_EMAIL) throw new Error("No hay sesión activa.");
}

function toast(msg) {
  // Minimalista por ahora. Después lo cambiamos por un toast bonito.
  console.log(msg);
}

/* =========================
   Subscribir eventos del mes
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
    }
  );
}

/* =========================
   UI callbacks (CRUD)
========================= */
async function handleCreate(payload) {
  try {
    requireEmail();
    await createEvent(payload, USER_EMAIL);
    toast("Evento creado ✅");
    // No llamamos setEvents manualmente: el realtime snapshot actualiza solo.
  } catch (e) {
    console.error("Create error:", e);
    alert(e?.message || "No se pudo crear el evento.");
  }
}

async function handleUpdate(id, payload) {
  try {
    requireEmail();
    await updateEvent(id, payload, USER_EMAIL);
    toast("Evento actualizado ✅");
  } catch (e) {
    console.error("Update error:", e);
    alert(e?.message || "No se pudo actualizar el evento.");
  }
}

async function handleDelete(id) {
  try {
    requireEmail();
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
  // Re-suscribe al mes nuevo
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

  // Si no hay acceso, corta todo
  if (!user || !allowed) {
    CURRENT_USER = null;
    USER_EMAIL = "";
    safeUnsub();
    // UI queda escondida desde auth.js, no hacemos más.
    return;
  }

  // Autorizado
  CURRENT_USER = user;
  USER_EMAIL = (user.email || "").toLowerCase().trim();

  ensureUI();

  // Mes actual (el que está mostrando UI)
  const { year, monthIndex } = getCurrentView();
  setMonth(year, monthIndex);        // asegura título/grilla
  subscribeMonth(year, monthIndex);  // carga eventos realtime
});

/* =========================
   Extra: al recargar la página,
   auth.js disparará auth:changed automáticamente.
========================= */
