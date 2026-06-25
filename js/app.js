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

import { initUI, setEvents, setMonth, getCurrentView, setCatalogData, setUrgentTaskContext, setUrgentTasks, notify } from "./ui.js";
import { createEvent, updateEvent, softDeleteEvent, subscribeEventsInRange, getCatalogSettings, subscribeUrgentTasks, upsertUrgentTask, completeUrgentTask, deleteUrgentTask } from "./db.js";
import { canUseUrgentTasks, URGENT_TASK_SLOTS } from "./constants.js";
import { startOfMonth, endOfMonth } from "./utils.js";

// Para que las repeticiones aparezcan en meses futuros, cargamos eventos
// "semilla" de meses anteriores. El calendario arrancó en 2026, así que 2 años
// de ventana cubren cualquier recurrencia y reducen ~60% la carga vs. 5 años.
// (Optimización futura: consulta dedicada solo de semillas recurrentes; requiere
//  índices de Firestore y pruebas en vivo.)
const LOOKBACK_YEARS = 2;

/* =========================
   Estado global app
========================= */
let CURRENT_USER = null;           // Firebase user
let USER_EMAIL = "";               // email normalizado
let USER_ROLE = null;              // "administrativo" | "academico" | null
let CAN_WRITE = false;             // permisos derivados
let IS_ADMIN = false;              // dirección o administrativo (ven todo)
let ALLOWED_CATEGORIES = [];       // categorías permitidas para queries

let unsubMonth = null;             // unsubscribe del onSnapshot
let unsubUrgentTasks = null;       // unsubscribe tareas urgentes compartidas
let CURRENT_URGENT_TASKS = [];
let uiInitialized = false;
let catalogsLoaded = false;

/* =========================
   Helpers
========================= */
function safeUnsub() {
  try { unsubMonth?.(); } catch (_) {}
  unsubMonth = null;
}

function safeUnsubUrgentTasks() {
  try { unsubUrgentTasks?.(); } catch (_) {}
  unsubUrgentTasks = null;
  CURRENT_URGENT_TASKS = [];
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

function requireUrgentAccess() {
  requireSession();
  if (!canUseUrgentTasks(USER_ROLE)) {
    throw new Error("Tu rol no tiene acceso a tareas urgentes.");
  }
}

function toast(msg) {
  // Muestra un toast real (definido en ui.js) y deja rastro en consola.
  console.log(msg);
  try { notify(msg, { mode: "toast", ms: 2000 }); } catch (_) {}
}

function activeUrgentTasks() {
  const uid = CURRENT_USER?.uid || "";
  return CURRENT_URGENT_TASKS.filter(task =>
    task.ownerUid === uid &&
    String(task.status || "pending") !== "done"
  );
}

function firstFreeUrgentSlot() {
  const activeSlots = new Set(activeUrgentTasks().map(task => task.slotId || task.id));
  return URGENT_TASK_SLOTS.find(slotId => !activeSlots.has(slotId)) || null;
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
    // Admins (dirección/administrativo) ven todo → sin filtro.
    // Los demás SOLO pueden leer su lista de categorías (las reglas lo exigen).
    { allowedCategories: IS_ADMIN ? [] : ALLOWED_CATEGORIES }
  );
}

async function ensureCatalogsLoaded() {
  if (catalogsLoaded) {
    setCatalogData({ userEmail: USER_EMAIL });
    return;
  }

  try {
    const catalogs = await getCatalogSettings();
    setCatalogData({ ...catalogs, userEmail: USER_EMAIL });
    catalogsLoaded = true;
  } catch (err) {
    console.warn("[app] No se pudieron cargar catálogos compartidos. Se usa cache local.", err);
    setCatalogData({ userEmail: USER_EMAIL });
  }
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

export async function materializeRecurringOccurrence(virtualEvent, patch = {}) {
  if (!virtualEvent?._virtualFromId) throw new Error("La ocurrencia no es recurrente.");

  requireSession();
  requireWrite();

  const payload = {
    title: virtualEvent.title || "",
    category: virtualEvent.category || "otro",
    dateISO: virtualEvent.dateISO || "",
    status: virtualEvent.status || "pending",
    notes: virtualEvent.notes || "",
    assignedTo: virtualEvent.assignedTo || "",
    recurrence: null,
    recurrenceParentId: virtualEvent._virtualFromId,
    recurrenceSkip: false,
    ...patch,
    dateISO: patch.dateISO || virtualEvent.dateISO || ""
  };

  return createEvent(payload, USER_EMAIL);
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

async function handleCreateUrgentTask(payload) {
  try {
    requireUrgentAccess();

    if (activeUrgentTasks().length >= URGENT_TASK_SLOTS.length) {
      alert("Solo puedes tener 2 tareas urgentes. Completa o elimina una para agregar otra.");
      return;
    }

    const slotId = firstFreeUrgentSlot();
    if (!slotId) {
      alert("Solo puedes tener 2 tareas urgentes. Completa o elimina una para agregar otra.");
      return;
    }

    await upsertUrgentTask(CURRENT_USER.uid, slotId, payload, USER_EMAIL);
    toast("Tarea urgente guardada");
  } catch (e) {
    console.error("Create urgent task error:", e);
    alert(e?.message || "No se pudo guardar la tarea urgente.");
  }
}

async function handleUpdateUrgentTask(slotId, payload) {
  try {
    requireUrgentAccess();
    await upsertUrgentTask(CURRENT_USER.uid, slotId, payload, USER_EMAIL);
    toast("Tarea urgente actualizada");
  } catch (e) {
    console.error("Update urgent task error:", e);
    alert(e?.message || "No se pudo actualizar la tarea urgente.");
  }
}

async function handleCompleteUrgentTask(slotId) {
  try {
    requireUrgentAccess();
    await completeUrgentTask(CURRENT_USER.uid, slotId, USER_EMAIL);
    toast("Tarea urgente completada");
  } catch (e) {
    console.error("Complete urgent task error:", e);
    alert(e?.message || "No se pudo completar la tarea urgente.");
  }
}

async function handleDeleteUrgentTask(slotId) {
  try {
    requireUrgentAccess();
    await deleteUrgentTask(CURRENT_USER.uid, slotId);
    toast("Tarea urgente eliminada");
  } catch (e) {
    console.error("Delete urgent task error:", e);
    alert(e?.message || "No se pudo eliminar la tarea urgente.");
  }
}

function handleNavigate({ year, monthIndex }) {
  subscribeMonth(year, monthIndex);
}

async function handleMaterializeOccurrence(virtualEvent, patch = {}) {
  try {
    await materializeRecurringOccurrence(virtualEvent, patch);
    toast("Ocurrencia separada ✅");
  } catch (e) {
    console.error("Materialize occurrence error:", e);
    alert(e?.message || "No se pudo separar esta ocurrencia.");
  }
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
    onDelete: handleDelete,
    onMaterializeOccurrence: handleMaterializeOccurrence,
    onCreateUrgentTask: handleCreateUrgentTask,
    onUpdateUrgentTask: handleUpdateUrgentTask,
    onCompleteUrgentTask: handleCompleteUrgentTask,
    onDeleteUrgentTask: handleDeleteUrgentTask
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
    IS_ADMIN = false;
    ALLOWED_CATEGORIES = [];
    catalogsLoaded = false;

    safeUnsub();
    safeUnsubUrgentTasks();
    setUrgentTaskContext({ visible: false, role: null, uid: "", email: "" });
    setUrgentTasks([]);
    // UI ya queda escondida desde auth.js
    return;
  }

  // Autorizado (con roles)
  CURRENT_USER = user;
  USER_EMAIL = (detail.email || user.email || "").toLowerCase().trim();

  USER_ROLE = detail.role || null;
  CAN_WRITE = !!detail.canWrite;
  IS_ADMIN  = !!detail.isAdmin;
  ALLOWED_CATEGORIES = Array.isArray(detail.allowedCategories) ? detail.allowedCategories : [];

  // UI
  ensureUI();
  ensureCatalogsLoaded().catch(err => console.error("[app] ensureCatalogsLoaded error:", err));

  // Mes actual (el que está mostrando UI)
  const { year, monthIndex } = getCurrentView();
  setMonth(year, monthIndex);
  subscribeMonth(year, monthIndex);

  safeUnsubUrgentTasks();
  if (canUseUrgentTasks(USER_ROLE)) {
    setUrgentTaskContext({ visible: true, role: USER_ROLE, uid: CURRENT_USER.uid, email: USER_EMAIL });
    unsubUrgentTasks = subscribeUrgentTasks(
      CURRENT_USER.uid,
      (tasks) => {
        CURRENT_URGENT_TASKS = Array.isArray(tasks) ? tasks : [];
        setUrgentTasks(CURRENT_URGENT_TASKS);
      },
      (err) => {
        console.error(err);
        alert("No se pudieron cargar las tareas urgentes.");
      }
    );
  } else {
    setUrgentTaskContext({ visible: false, role: USER_ROLE, uid: CURRENT_USER.uid, email: USER_EMAIL });
    setUrgentTasks([]);
  }

  // Opcional: log útil para debug
  console.log("[auth] role:", USER_ROLE, "canWrite:", CAN_WRITE, "cats:", ALLOWED_CATEGORIES);
});

/* =============================================================================
  Nota: al recargar la página, auth.js disparará auth:changed automáticamente.
============================================================================= */
