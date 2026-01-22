/* =============================================================================
  js/constants.js — Constantes globales del Calendario Musicala
  - Categorías
  - Colores
  - Estados
  - Textos base
============================================================================= */

/* =========================
   Categorías del calendario
========================= */
export const CATEGORIES = [
  {
    id: "admin",
    label: "Administrativo",
    color: "#6366F1" // indigo
  },
  {
    id: "academico",
    label: "Académico",
    color: "#22C55E" // verde
  },
  {
    id: "ventas",
    label: "Ventas / Seguimiento",
    color: "#F59E0B" // amarillo
  },
  {
    id: "sgsst",
    label: "SG-SST",
    color: "#EF4444" // rojo
  },
  {
    id: "reunion",
    label: "Reuniones",
    color: "#0EA5E9" // azul
  },
  {
    id: "festivo",
    label: "Festivo",
    color: "#A855F7" // morado
  },
  {
    id: "otro",
    label: "Otro",
    color: "#64748B" // gris
  }
];

/* =========================
   Estados posibles de evento
========================= */
export const EVENT_STATUS = [
  {
    id: "pending",
    label: "Pendiente"
  },
  {
    id: "done",
    label: "Hecho"
  },
  {
    id: "cancelled",
    label: "Cancelado"
  }
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
