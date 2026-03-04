/* =============================================================================
  js/constants.js — Constantes globales del Calendario Musicala
  - Categorías (con override editable)
  - Estados
  - Textos base
============================================================================= */

/* =========================
   Categorías del calendario
   - DEFAULT_CATEGORIES: lo que viene “de fábrica”
   - getCategories(): permite override desde localStorage
   - setCategories(): guarda override
========================= */

const CATEGORIES_STORAGE_KEY = "musicala.calendar.categories.v1";

export const DEFAULT_CATEGORIES = [
  { id: "administrativo", label: "Administrativo", color: "#4F46E5" },
  { id: "financiero", label: "Financiero", color: "#F59E0B" },
  { id: "sgsst", label: "SG SST", color: "#EF4444" },
  { id: "atc_ventas", label: "Atención al cliente y ventas", color: "#0EA5E9" },
  { id: "academico", label: "Académico", color: "#22C55E" },
  { id: "eventos", label: "Eventos", color: "#A855F7" },
  { id: "cumpleanos", label: "Cumpleaños", color: "#EC4899" },
  { id: "marketing", label: "Marketing y publicidad", color: "#8B5CF6" },
  // fallback universal, por si el mundo se quema
  { id: "otro", label: "Otro", color: "#64748B" }
];

function safeSlug(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

function sanitizeCategory(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = safeSlug(raw.id || raw.label);
  const label = String(raw.label || "").trim();
  const color = String(raw.color || "#64748B").trim();
  if (!id || !label) return null;
  return { id, label, color };
}

function uniqById(list) {
  const out = [];
  const seen = new Set();
  for (const it of list || []) {
    if (!it?.id) continue;
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

export function getCategories() {
  try {
    const raw = localStorage.getItem(CATEGORIES_STORAGE_KEY);
    if (!raw) return [...DEFAULT_CATEGORIES];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_CATEGORIES];

    const cleaned = uniqById(parsed.map(sanitizeCategory).filter(Boolean));
    // Garantiza que exista "otro"
    const hasOtro = cleaned.some(c => c.id === "otro");
    const final = hasOtro ? cleaned : [...cleaned, DEFAULT_CATEGORIES.find(c => c.id === "otro")];
    return final.length ? final : [...DEFAULT_CATEGORIES];
  } catch (_) {
    return [...DEFAULT_CATEGORIES];
  }
}

export function setCategories(categories) {
  const cleaned = uniqById((categories || []).map(sanitizeCategory).filter(Boolean));
  const hasOtro = cleaned.some(c => c.id === "otro");
  const final = hasOtro ? cleaned : [...cleaned, DEFAULT_CATEGORIES.find(c => c.id === "otro")];

  localStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify(final));
  return final;
}

export function resetCategories() {
  localStorage.removeItem(CATEGORIES_STORAGE_KEY);
  return [...DEFAULT_CATEGORIES];
}

/* Compat: algunos módulos viejos importan CATEGORIES */
export const CATEGORIES = DEFAULT_CATEGORIES;

/* =========================
   Estados posibles de evento
========================= */
export const EVENT_STATUS = [
  { id: "pending", label: "Pendiente" },
  { id: "done", label: "Hecho" },
  { id: "cancelled", label: "Cancelado" }
];

/* =========================
   Colores por estado
========================= */
export const STATUS_COLORS = {
  pending: "#F59E0B",    // amarillo
  done: "#22C55E",       // verde
  cancelled: "#94A3B8"   // gris
};

/* =========================
   Textos reutilizables
========================= */
export const TEXTS = {
  appName: "Calendario Musicala",
  unauthorized: "Este calendario es de uso interno.",
  confirmDelete: "¿Seguro que deseas eliminar este evento?",
  saveError: "No se pudo guardar el evento. Intenta nuevamente.",
  loadError: "No se pudieron cargar los eventos."
};

/* =========================
   Fechas / configuración calendario
========================= */
export const CALENDAR_CONFIG = {
  weekStartsOn: 1, // 0 = domingo, 1 = lunes
  locale: "es-CO"
};

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

/* =========================
   Responsables editables
   - DEFAULT_ASSIGNEES: lista "de fábrica"
   - getAssignees(): permite override desde localStorage
   - setAssignees(): guarda override
========================= */

const ASSIGNEES_STORAGE_KEY = "musicala.calendar.assignees.v1";

export const DEFAULT_ASSIGNEES = [...ASSIGNEES];

function sanitizeAssignee(raw) {
  const name = String(raw || "").trim();
  if (!name) return null;
  return name.slice(0, 64);
}

function uniqNames(list) {
  const out = [];
  const seen = new Set();
  for (const it of list || []) {
    const name = sanitizeAssignee(it);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function getAssignees() {
  try {
    const raw = localStorage.getItem(ASSIGNEES_STORAGE_KEY);
    if (!raw) return [...DEFAULT_ASSIGNEES];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_ASSIGNEES];
    const cleaned = uniqNames(parsed);
    return cleaned.length ? cleaned : [...DEFAULT_ASSIGNEES];
  } catch (_e) {
    return [...DEFAULT_ASSIGNEES];
  }
}

export function setAssignees(names) {
  const cleaned = uniqNames(names);
  localStorage.setItem(ASSIGNEES_STORAGE_KEY, JSON.stringify(cleaned));
  return cleaned;
}

export function resetAssignees() {
  localStorage.removeItem(ASSIGNEES_STORAGE_KEY);
  return [...DEFAULT_ASSIGNEES];
}