/* =============================================================================
  js/constants.js — Constantes globales del Calendario Musicala
  -----------------------------------------------------------------------------
  - Categorías reales del calendario (NO SE TOCAN, son fuente de verdad)
  - Roles del sistema (5 roles)
  - ROLE_PERMISSIONS: tabla central de permisos por rol
  - Estados, textos, responsables, helpers de categorías
============================================================================= */

/* =========================
   Storage keys
========================= */
const CATEGORIES_STORAGE_KEY = "musicala.calendar.categories.v3";
const ASSIGNEES_STORAGE_KEY   = "musicala.calendar.assignees.v2";

/* =========================
   Helpers base
========================= */
function clone(obj) {
  try { return JSON.parse(JSON.stringify(obj)); }
  catch (_) { return obj; }
}

function safeParseJSON(raw, fallback = null) {
  try { return JSON.parse(raw); }
  catch (_) { return fallback; }
}

function safeGetStorage(key) {
  try { return localStorage.getItem(key); }
  catch (_) { return null; }
}

function safeSetStorage(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch (_) { return false; }
}

function safeRemoveStorage(key) {
  try { localStorage.removeItem(key); return true; }
  catch (_) { return false; }
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

/* =============================================================================
   PERMISOS POR ROL — FUENTE CENTRAL DE VERDAD
   ─────────────────────────────────────────────
   Aquí se define qué puede ver y editar cada rol.
   "canWrite"          → puede crear/editar/eliminar eventos
   "allowedCategories" → ids de categorías visibles para ese rol
                         (array vacío = sin filtro = ve todo; pero aquí
                          siempre ponemos lista explícita para claridad)

   Las categorías reales del calendario son:
     administrativo | financiero | sgsst | atc_ventas
     academico | eventos | cumpleanos | marketing | otro

   Regla de diseño:
   - direccion: acceso total
   - administrativo: acceso operativo amplio (todo menos nada, mismo que dirección)
   - comercial: lo relacionado con ventas, clientes, marketing y eventos
   - docente: lo académico + eventos relevantes, solo lectura
   - comunidad: mínimo, solo lo público/comunitario, solo lectura
============================================================================= */
export const ROLE_PERMISSIONS = Object.freeze({

  direccion: {
    canWrite: true,
    allowedCategories: [
      "administrativo",
      "financiero",
      "sgsst",
      "atc_ventas",
      "academico",
      "eventos",
      "cumpleanos",
      "marketing",
      "otro"
    ]
  },

  administrativo: {
    canWrite: true,
    allowedCategories: [
      "administrativo",
      "financiero",
      "sgsst",
      "atc_ventas",
      "academico",
      "eventos",
      "cumpleanos",
      "marketing",
      "otro"
    ]
  },

  comercial: {
    canWrite: true,
    allowedCategories: [
      "atc_ventas",
      "academico",
      "eventos",
      "cumpleanos",
      "marketing",
      "otro"
    ]
  },

  docente: {
    canWrite: false,
    allowedCategories: [
      "academico",
      "eventos",
      "cumpleanos",
      "otro"
    ]
  },

  comunidad: {
    canWrite: false,
    allowedCategories: [
      "eventos",
      "cumpleanos"
    ]
  }

});

/**
 * Devuelve los permisos del rol dado.
 * Si el rol no existe, retorna permisos de "comunidad" (el más restrictivo).
 * @param {string} role
 * @returns {{ canWrite: boolean, allowedCategories: string[] }}
 */
export function getPermissionsForRole(role) {
  const perms = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS[USER_ROLES.COMUNIDAD];
  return {
    canWrite: !!perms.canWrite,
    allowedCategories: [...perms.allowedCategories]
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
  { id: "eventos",        label: "Eventos",                   color: "#A855F7" },
  { id: "cumpleanos",     label: "Cumpleaños",                color: "#EC4899" },
  { id: "marketing",      label: "Marketing y publicidad",    color: "#8B5CF6" },
  { id: "otro",           label: "Otro",                      color: "#64748B" }
];

/* Categorías extendidas — sugeridas para el futuro, no activas por defecto */
export const EXTENDED_CATEGORIES = [
  { id: "direccion_interna",     label: "Dirección interna",     color: "#312E81" },
  { id: "finanzas_sensibles",    label: "Finanzas sensibles",    color: "#D97706" },
  { id: "eventos_institucionales", label: "Eventos institucionales", color: "#7C3AED" },
  { id: "comunidad_externa",     label: "Comunidad externa",     color: "#14B8A6" }
];

export const ALL_KNOWN_CATEGORIES = uniqBy(
  [...DEFAULT_CATEGORIES, ...EXTENDED_CATEGORIES].map(clone),
  item => item.id
);

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
  const raw = safeGetStorage(CATEGORIES_STORAGE_KEY);
  if (!raw) return clone(DEFAULT_CATEGORIES);
  const parsed = safeParseJSON(raw, null);
  if (!Array.isArray(parsed)) return clone(DEFAULT_CATEGORIES);
  const final = normalizeCategoriesList(parsed);
  return final.length ? final : clone(DEFAULT_CATEGORIES);
}

export function setCategories(categories) {
  const final = normalizeCategoriesList(categories);
  safeSetStorage(CATEGORIES_STORAGE_KEY, JSON.stringify(final));
  return final;
}

export function resetCategories() {
  safeRemoveStorage(CATEGORIES_STORAGE_KEY);
  return clone(DEFAULT_CATEGORIES);
}

export function getCategoryById(categoryId) {
  const id = safeSlug(categoryId);
  if (!id) return clone(FALLBACK_CATEGORY);
  const active = getCategories();
  const match = active.find(item => item.id === id) ||
                ALL_KNOWN_CATEGORIES.find(item => item.id === id);
  return clone(match || FALLBACK_CATEGORY);
}

export function hasCategory(categoryId) {
  const id = safeSlug(categoryId);
  if (!id) return false;
  return getCategories().some(item => item.id === id);
}

export function ensureCategoriesExist(categoryIds = []) {
  const current = getCategories();
  const currentIds = new Set(current.map(item => item.id));
  const toAdd = ensureArray(categoryIds)
    .map(id => safeSlug(id))
    .filter(Boolean)
    .filter(id => !currentIds.has(id))
    .map(id => {
      const known = ALL_KNOWN_CATEGORIES.find(item => item.id === id);
      return known ? clone(known) : null;
    })
    .filter(Boolean);
  if (!toAdd.length) return current;
  return setCategories([...current, ...toAdd]);
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
  const raw = safeGetStorage(ASSIGNEES_STORAGE_KEY);
  if (!raw) return [...DEFAULT_ASSIGNEES];
  const parsed = safeParseJSON(raw, null);
  if (!Array.isArray(parsed)) return [...DEFAULT_ASSIGNEES];
  return normalizeAssigneesList(parsed);
}

export function setAssignees(names) {
  const final = normalizeAssigneesList(names);
  safeSetStorage(ASSIGNEES_STORAGE_KEY, JSON.stringify(final));
  return final;
}

export function resetAssignees() {
  safeRemoveStorage(ASSIGNEES_STORAGE_KEY);
  return [...DEFAULT_ASSIGNEES];
}
