/* =============================================================================
  js/constants.js — Constantes globales del Calendario Musicala
  -----------------------------------------------------------------------------
  - Categorías reales del calendario (NO SE TOCAN, son fuente de verdad)
  - Roles del sistema (5 roles)
  - ROLE_PERMISSIONS: tabla central de permisos por rol
  - Estados, textos, responsables, helpers de categorías
============================================================================= */

/* =============================================================================
   ESTADO EN MEMORIA (NADA de localStorage)
   ─────────────────────────────────────────
   Catálogos (categorías y responsables) viven solo en memoria durante la
   sesión. La persistencia compartida es Firestore (settings/catalogs):
     - Al iniciar, app.js carga catálogos de Firestore → hydrateCategories /
       hydrateAssignees rellenan estas variables.
     - Los editores guardan en Firestore (saveCatalogSettings) y refrescan estas
       variables. Otros usuarios ven los cambios al recargar.
   Si Firestore no respondió aún, se usan los DEFAULT_* como fallback.
============================================================================= */
let MEM_CATEGORIES = null; // null = aún no hidratado → se usan DEFAULT_CATEGORIES
let MEM_ASSIGNEES  = null; // null = aún no hidratado → se usan DEFAULT_ASSIGNEES

/* =========================
   Helpers base
========================= */
function clone(obj) {
  try { return JSON.parse(JSON.stringify(obj)); }
  catch (_) { return obj; }
}

function safeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function isValidHexColor(value) {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value || "").trim());
}

function normalizeHexColor(value, fallback = "#64748B") {
  const raw = String(value || "").trim();
  if (!isValidHexColor(raw)) return fallback;
  if (raw.length === 4) {
    const [, r, g, b] = raw;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return raw.toUpperCase();
}

function uniqBy(list, getKey) {
  const out = [], seen = new Set();
  for (const item of list || []) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

/* =============================================================================
   ROLES DEL SISTEMA
   ─────────────────
   Estos son los 5 roles posibles en users/{uid}.role
   IMPORTANTE: no confundir con las categorías del calendario.
============================================================================= */
export const USER_ROLES = Object.freeze({
  DIRECCION:     "direccion",
  ADMINISTRATIVO:"administrativo",
  COMERCIAL:     "comercial",
  DOCENTE:       "docente",
  COMUNIDAD:     "comunidad"
});

export const URGENT_TASK_ROLES = Object.freeze([
  USER_ROLES.DIRECCION,
  USER_ROLES.ADMINISTRATIVO,
  USER_ROLES.COMERCIAL
]);

export const URGENT_TASK_SLOTS = Object.freeze([
  "urgent_1",
  "urgent_2"
]);

export function canUseUrgentTasks(role) {
  return URGENT_TASK_ROLES.includes(String(role || "").trim().toLowerCase());
}

/* =============================================================================
   PERMISOS POR ROL — VALORES POR DEFECTO (fallback)
   ─────────────────────────────────────────────────
   IMPORTANTE: a partir de ahora la fuente de verdad EN VIVO es el documento
   Firestore  settings/access.permissions  (editable desde el Panel de
   administración, sin tocar código). Lo de aquí abajo es solo el VALOR INICIAL
   con el que se siembra ese documento y el fallback si Firestore no responde.

   Cada rol define DOS listas de categorías:
     "read"  → categorías que el rol puede VER en el calendario
     "write" → categorías que el rol puede CREAR/EDITAR/ELIMINAR
               (write siempre debe ser un subconjunto de read)

   Categorías reales del calendario:
     administrativo | financiero | sgsst | atc_ventas | academico
     formacion_docente | eventos | cumpleanos | festividades | marketing | otro

   Regla de diseño (afinable desde el panel):
   - direccion:      acceso TOTAL (ve y edita todo, incluido lo delicado)
   - administrativo: casi total, pero NO toca lo ultra-sensible (financiero/sgsst
                     solo lectura) — así dirección y administrativo se diferencian
   - comercial:      ventas, marketing, eventos, académico (lectura)
   - docente:        académico + formación docente + eventos (solo lectura)
   - comunidad:      estudiantes/acudientes — solo lo público (solo lectura)
============================================================================= */

/* Lista completa de ids de categoría — útil para "acceso total" */
export const ALL_CATEGORY_IDS = Object.freeze([
  "administrativo",
  "financiero",
  "sgsst",
  "atc_ventas",
  "academico",
  "formacion_docente",
  "eventos",
  "cumpleanos",
  "festividades",
  "marketing",
  "otro"
]);

export const DEFAULT_ROLE_PERMISSIONS = Object.freeze({

  direccion: {
    read:  [...ALL_CATEGORY_IDS],
    write: [...ALL_CATEGORY_IDS]
  },

  administrativo: {
    read:  [...ALL_CATEGORY_IDS],
    write: [
      "administrativo",
      "atc_ventas",
      "academico",
      "formacion_docente",
      "eventos",
      "cumpleanos",
      "festividades",
      "marketing",
      "otro"
    ] // ve financiero y sgsst, pero NO los edita (solo dirección)
  },

  comercial: {
    read: [
      "atc_ventas",
      "academico",
      "eventos",
      "cumpleanos",
      "festividades",
      "marketing",
      "otro"
    ],
    write: [
      "atc_ventas",
      "eventos",
      "marketing"
    ]
  },

  docente: {
    read: [
      "academico",
      "formacion_docente",
      "eventos",
      "cumpleanos",
      "festividades",
      "otro"
    ],
    write: [] // solo lectura
  },

  comunidad: {
    read: [
      "eventos",
      "cumpleanos",
      "festividades"
    ],
    write: [] // solo lectura
  }

});

/* =============================================================================
   LISTA BLANCA POR CORREO (bootstrap de roles)
   ─────────────────────────────────────────────
   Valor inicial con el que se siembra settings/access.emailRoles.
   Cuando uno de estos correos inicia sesión por primera vez, queda
   automáticamente con su rol. Los correos que NO estén aquí entran como
   "comunidad" (estudiante/acudiente). Editable desde el panel, sin código.
============================================================================= */
export const DEFAULT_EMAIL_ROLES = Object.freeze({
  "alekcaballeromusic@gmail.com":   USER_ROLES.DIRECCION,
  "catalina.medina.leal@gmail.com": USER_ROLES.ADMINISTRATIVO,
  "adminmusicala@gmail.com":        USER_ROLES.ADMINISTRATIVO,
  "musicalaasesor@gmail.com":       USER_ROLES.COMERCIAL
});

/**
 * Normaliza una entrada de permisos {read, write} asegurando arrays válidos
 * y que write ⊆ read.
 */
function normalizePermEntry(entry) {
  const read  = ensureArray(entry && entry.read).map(safeSlug).filter(Boolean);
  let   write = ensureArray(entry && entry.write).map(safeSlug).filter(Boolean);
  const readSet = new Set(read);
  write = write.filter(id => readSet.has(id)); // write nunca excede read
  return {
    read:  Array.from(new Set(read)),
    write: Array.from(new Set(write))
  };
}

/**
 * Normaliza el mapa completo de permisos rol→{read,write}.
 * Rellena con los valores por defecto cualquier rol faltante.
 */
export function normalizePermissionsMap(map) {
  const out = {};
  for (const role of Object.values(USER_ROLES)) {
    const fromMap = map && typeof map === "object" ? map[role] : null;
    out[role] = fromMap
      ? normalizePermEntry(fromMap)
      : clone(DEFAULT_ROLE_PERMISSIONS[role]);
  }
  return out;
}

/**
 * Devuelve los permisos efectivos del rol dado a partir de un mapa de permisos
 * (normalmente el que viene de Firestore). Si no se pasa mapa, usa los defaults.
 *
 * Retorna la forma que el resto de la app ya entiende:
 *   { canWrite, allowedCategories, writeCategories }
 *   - allowedCategories = categorías que puede VER (read)
 *   - writeCategories   = categorías que puede EDITAR (write)
 *   - canWrite          = true si puede editar al menos una categoría
 *
 * @param {string} role
 * @param {Object} [permissionsMap]
 */
export function getPermissionsForRole(role, permissionsMap = null) {
  const map  = permissionsMap ? normalizePermissionsMap(permissionsMap) : normalizePermissionsMap(DEFAULT_ROLE_PERMISSIONS);
  const perms = map[role] || map[USER_ROLES.COMUNIDAD];
  return {
    canWrite:          perms.write.length > 0,
    allowedCategories: [...perms.read],
    writeCategories:   [...perms.write]
  };
}

/* =============================================================================
   CATEGORÍAS DEL CALENDARIO
   ──────────────────────────
   Estas son las categorías de EVENTOS, no de roles.
   No mezclar conceptualmente con roles.
   No modificar los IDs — son la fuente de verdad del sistema.
============================================================================= */
export const DEFAULT_CATEGORIES = [
  { id: "administrativo", label: "Administrativo",            color: "#4F46E5" },
  { id: "financiero",     label: "Financiero",                color: "#F59E0B" },
  { id: "sgsst",          label: "SG-SST",                    color: "#EF4444" },
  { id: "atc_ventas",     label: "Atención al cliente y ventas", color: "#0EA5E9" },
  { id: "academico",      label: "Académico",                 color: "#22C55E" },
  { id: "formacion_docente", label: "Formación docente",      color: "#0D9488" },
  { id: "eventos",        label: "Eventos",                   color: "#A855F7" },
  { id: "cumpleanos",     label: "Cumpleaños",                color: "#EC4899" },
  { id: "festividades",   label: "Festividades",              color: "#F59E0B" },
  { id: "marketing",      label: "Marketing y publicidad",    color: "#8B5CF6" },
  { id: "otro",           label: "Otro",                      color: "#64748B" }
];

const FALLBACK_CATEGORY = DEFAULT_CATEGORIES.find(c => c.id === "otro") || {
  id: "otro", label: "Otro", color: "#64748B"
};

function sanitizeCategory(raw) {
  if (!raw || typeof raw !== "object") return null;
  const label = String(raw.label || "").trim().slice(0, 80);
  const idSource = raw.id || label;
  let id = safeSlug(idSource);
  if (!label) return null;
  if (!id) id = safeSlug(label);
  if (!id) return null;
  const color = normalizeHexColor(raw.color, "#64748B");
  return { id, label, color };
}

function normalizeCategoriesList(list) {
  const sanitized = ensureArray(list).map(sanitizeCategory).filter(Boolean);
  let cleaned = uniqBy(sanitized, item => item.id);
  if (!cleaned.some(c => c.id === "otro")) cleaned = [...cleaned, clone(FALLBACK_CATEGORY)];
  if (!cleaned.length) return clone(DEFAULT_CATEGORIES);
  return cleaned;
}

/* =========================
   API de categorías activas
========================= */
export function getCategories() {
  if (!Array.isArray(MEM_CATEGORIES)) return clone(DEFAULT_CATEGORIES);
  return MEM_CATEGORIES.length ? clone(MEM_CATEGORIES) : clone(DEFAULT_CATEGORIES);
}

export function setCategories(categories) {
  const final = normalizeCategoriesList(categories);
  MEM_CATEGORIES = clone(final);
  return clone(final);
}

export function hydrateCategories(categories) {
  return setCategories(categories);
}

export function resetCategories() {
  MEM_CATEGORIES = clone(DEFAULT_CATEGORIES);
  return clone(DEFAULT_CATEGORIES);
}

export function hasCategory(categoryId) {
  const id = safeSlug(categoryId);
  if (!id) return false;
  return getCategories().some(item => item.id === id);
}

/* Compat */
export const CATEGORIES = DEFAULT_CATEGORIES;

/* =========================
   Estados posibles de evento
========================= */
export const EVENT_STATUS = [
  { id: "pending",   label: "Pendiente" },
  { id: "done",      label: "Hecho" },
  { id: "cancelled", label: "Cancelado" }
];

export const STATUS_COLORS = {
  pending:   "#F59E0B",
  done:      "#22C55E",
  cancelled: "#94A3B8"
};

/* =========================
   Textos reutilizables
========================= */
export const TEXTS = {
  appName:        "Calendario Musicala",
  unauthorized:   "Este calendario es de uso interno.",
  confirmDelete:  "¿Seguro que deseas eliminar este evento?",
  saveError:      "No se pudo guardar el evento. Intenta nuevamente.",
  loadError:      "No se pudieron cargar los eventos.",
  emptyEvents:    "No hay eventos para mostrar.",
  emptyCategory:  "Sin categoría",
  readonlyMode:   "Estás en modo solo lectura."
};

/* =========================
   Configuración del calendario
========================= */
export const CALENDAR_CONFIG = {
  weekStartsOn: 1, // 1 = lunes
  locale: "es-CO"
};

/* =========================
   Responsables base
========================= */
export const ASSIGNEES = [
  "Alek Caballero",
  "Catalina Medina",
  "Camila Rodríguez",
  "Liceth Rincón",
  "Nancy Caballero",
  "Emily Bejarano",
  "Laura Sánchez",
  "Angie Nitola"
];

export const DEFAULT_ASSIGNEES = [...ASSIGNEES];

function sanitizeAssignee(raw) {
  const name = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) return null;
  return name;
}

function normalizeAssigneesList(list) {
  const sanitized = ensureArray(list).map(sanitizeAssignee).filter(Boolean);
  const cleaned = uniqBy(sanitized, name => name.toLowerCase());
  return cleaned.length ? cleaned : [...DEFAULT_ASSIGNEES];
}

export function getAssignees() {
  if (!Array.isArray(MEM_ASSIGNEES)) return [...DEFAULT_ASSIGNEES];
  return MEM_ASSIGNEES.length ? [...MEM_ASSIGNEES] : [...DEFAULT_ASSIGNEES];
}

export function setAssignees(names) {
  const final = normalizeAssigneesList(names);
  MEM_ASSIGNEES = [...final];
  return [...final];
}

export function hydrateAssignees(names) {
  return setAssignees(names);
}

export function resetAssignees() {
  MEM_ASSIGNEES = [...DEFAULT_ASSIGNEES];
  return [...DEFAULT_ASSIGNEES];
}
