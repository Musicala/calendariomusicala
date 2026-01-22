/* =============================================================================
  js/utils.js — Utilidades generales (fechas, formatos, helpers)
============================================================================= */

import { CALENDAR_CONFIG } from "./constants.js";

/* =========================
   Helpers básicos
========================= */
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function debounce(fn, wait = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =========================
   Fecha: parsing/formatting
========================= */
export function pad2(n) {
  return String(n).padStart(2, "0");
}

/** yyyy-mm-dd local (sin timezone raro) */
export function toISODateLocal(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Devuelve Date a las 00:00:00 local */
export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Devuelve Date a las 23:59:59.999 local */
export function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Devuelve Date del primer día del mes (00:00) */
export function startOfMonth(year, monthIndex) {
  const d = new Date(year, monthIndex, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Devuelve Date del último día del mes (23:59:59.999) */
export function endOfMonth(year, monthIndex) {
  const d = new Date(year, monthIndex + 1, 0);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Devuelve {year, monthIndex} a partir de Date */
export function getYearMonth(date) {
  const d = new Date(date);
  return { year: d.getFullYear(), monthIndex: d.getMonth() };
}

export function formatMonthTitle(date, locale = CALENDAR_CONFIG.locale) {
  const d = new Date(date);
  // Ej: "enero 2026"
  return d.toLocaleDateString(locale, { month: "long", year: "numeric" });
}

export function formatDayLabel(date, locale = CALENDAR_CONFIG.locale) {
  const d = new Date(date);
  // Ej: "lun 21"
  return d.toLocaleDateString(locale, { weekday: "short", day: "2-digit" });
}

export function formatFullDate(date, locale = CALENDAR_CONFIG.locale) {
  const d = new Date(date);
  // Ej: "martes, 21 de enero de 2026"
  return d.toLocaleDateString(locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

/* =========================
   Calendario: grid del mes
========================= */
/**
 * Devuelve índice día semana 0..6 donde 0=domingo
 */
export function getDow0Sun(date) {
  return new Date(date).getDay();
}

/**
 * Construye la grilla del mes en semanas (siempre 6 filas x 7 columnas).
 * weekStartsOn: 0 (domingo) o 1 (lunes)
 * Retorna array de 42 Date objects.
 */
export function buildMonthGrid(year, monthIndex, weekStartsOn = CALENDAR_CONFIG.weekStartsOn) {
  const first = startOfMonth(year, monthIndex);
  const firstDow = getDow0Sun(first); // 0..6 (dom..sab)

  // shift según inicio de semana
  const shift = (firstDow - weekStartsOn + 7) % 7;

  // día inicial visible en la grilla
  const start = new Date(first);
  start.setDate(first.getDate() - shift);
  start.setHours(0, 0, 0, 0);

  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  return days;
}

export function isSameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function isSameMonth(a, year, monthIndex) {
  const d = new Date(a);
  return d.getFullYear() === year && d.getMonth() === monthIndex;
}

/* =========================
   Hash simple (anti-duplicados)
   Útil para importación TSV: mismo evento -> mismo hash
========================= */
export function simpleHash(str) {
  // djb2
  let hash = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i);
    hash = hash >>> 0; // uint32
  }
  return hash.toString(16);
}

/** Genera un hash estable basado en campos clave */
export function eventFingerprint({ title="", dateISO="", category="", notes="" } = {}) {
  const raw = [
    String(title).trim().toLowerCase(),
    String(dateISO).trim(),
    String(category).trim().toLowerCase(),
    String(notes).trim().toLowerCase()
  ].join("|");
  return simpleHash(raw);
}

/* =========================
   Normalizadores
========================= */
export function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function normText(s) {
  return String(s || "").trim();
}

/* =========================
   DOM helpers (por comodidad)
========================= */
export const qs  = (sel, root=document) => root.querySelector(sel);
export const qsa = (sel, root=document) => Array.from(root.querySelectorAll(sel));
